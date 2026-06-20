const vscode =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;
const ICONS_URI = document.body?.dataset.iconsUri ?? "../icons";

const elements = {
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  clearButton: document.getElementById("clearButton"),
  backButton: document.getElementById("backButton"),
  modeChip: document.getElementById("modeChip"),
  loadingState: document.getElementById("loadingState"),
  defaultSection: document.getElementById("defaultSection"),
  allCellsContainer: document.getElementById("allCellsContainer"),
  resultsSection: document.getElementById("resultsSection"),
  topResultsContainer: document.getElementById("topResultsContainer"),
  topResultsSectionTitle: document.getElementById("topResultsSectionTitle"),
  otherResultsContainer: document.getElementById("otherResultsContainer"),
  otherResults: document.getElementById("otherResults"),
  otherCellCount: document.getElementById("otherCellCount"),
};
let allCells = [];
const navigationStack = [];

// ---------------------------------------------------------------------------
// Query mode classification
// ---------------------------------------------------------------------------

/**
 * Classify a query as 'keyword' (code/ctrl+f style) or 'semantic' (AI search).
 * Runs entirely client-side — no backend round-trip needed for the decision.
 */
function classifyQuery(query) {
  const q = query.trim();
  if (!q) return "semantic";

  // Explicit question mark → always semantic
  if (q.endsWith("?")) return "semantic";

  // Question / explanation words → semantic
  const semanticPattern =
    /\b(what|how|why|where|when|which|who|does|do|is|are|can|should|explain|find|show|tell|describe|gives?|returns?|compute|calculate|plots?|visuali[sz]e)\b/i;
  if (semanticPattern.test(q)) return "semantic";

  const words = q.split(/\s+/);
  const wordCount = words.length;

  // Single token (no whitespace) → almost certainly a variable / function name
  if (wordCount === 1) return "keyword";

  // Starts with a Python / code keyword → treat as code search
  const codeKeywordPattern =
    /^(import|from|def|class|for|if|elif|else|return|print|with|try|except|raise|assert|lambda|yield|async|await|not|and|or|in|is)\s/;
  if (codeKeywordPattern.test(q)) return "keyword";

  // Contains code-like punctuation → keyword
  if (/[.()\[\]{}_=<>!@#$%^*]/.test(q)) return "keyword";

  // camelCase or snake_case patterns → keyword
  if (/[a-z][A-Z]|_[a-zA-Z]/.test(q)) return "keyword";

  // Natural-language connective words in multi-word queries → semantic
  const nlPattern =
    /\b(with|using|from|into|about|between|among|across|through|that|and|to|for)\b/i;
  if (wordCount >= 3 && nlPattern.test(q)) return "semantic";

  // Long words (≥ 7 chars) in short queries signal natural-language concept
  // terms ('normalization', 'assignment', 'gradient', 'network'…) rather than
  // the short action verbs and abbreviations typical of code search ('fit',
  // 'load', 'csv', 'df'). Single-token identifiers are already caught above.
  if (wordCount <= 3 && words.some((w) => w.length >= 7)) return "semantic";

  // Short queries (2–3 words) without NL markers → keyword
  if (wordCount <= 3) return "keyword";

  // Default: longer uncategorised queries go to semantic
  return "semantic";
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  elements.searchButton.addEventListener("click", handleSearch);
  elements.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch();
  });
  elements.searchInput.addEventListener("input", () => {
    const val = elements.searchInput.value;
    const hasText = val.length > 0;
    elements.clearButton.style.display = hasText ? "flex" : "none";

    // Live mode chip — updates as the user types
    if (elements.modeChip) {
      if (hasText) {
        const mode = classifyQuery(val);
        elements.modeChip.textContent = mode === "keyword" ? "code" : "AI";
        elements.modeChip.className = `mode-chip ${mode}-chip`;
        elements.modeChip.style.display = "flex";
      } else {
        elements.modeChip.style.display = "none";
      }
    }
  });
  elements.clearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    elements.clearButton.style.display = "none";
    if (elements.modeChip) elements.modeChip.style.display = "none";
    showDefaultView();
  });
  elements.backButton.addEventListener("click", handleBack);
  elements.searchInput.focus();

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "searchResult") {
      displayResults(message.data);
    } else if (message.type === "searchError") {
      hideLoading();
    } else if (message.type === "indexResult") {
      allCells = message.data;
      elements.allCellsContainer.innerHTML = "";
      displayAllCells(message.data);
    } else if (message.type === "cellUpdated") {
      const cell = message.data;
      const existingIndex = allCells.findIndex((c) => c.cellId === cell.cellId);
      if (existingIndex !== -1) {
        allCells[existingIndex] = cell;
      } else {
        allCells.push(cell);
      }
      elements.allCellsContainer.innerHTML = "";
      displayAllCells(allCells);
    } else if (message.type === "cellDeleted") {
      allCells = allCells.filter((c) => c.cellId !== message.data.cellId);
      elements.allCellsContainer.innerHTML = "";
      displayAllCells(allCells);
    } else if (message.type === "cellsReordered") {
      const orderedIds = message.data.cellIds;
      const cellMap = new Map(allCells.map((c) => [c.cellId, c]));
      allCells = orderedIds
        .map((id) => cellMap.get(id))
        .filter((c) => c !== undefined);
      elements.allCellsContainer.innerHTML = "";
      displayAllCells(allCells);
    }
  });
}

// ---------------------------------------------------------------------------
// Search dispatch
// ---------------------------------------------------------------------------

function handleSearch() {
  const query = elements.searchInput.value.trim();
  if (!query) {
    showDefaultView();
    return;
  }

  elements.defaultSection.style.display = "none";

  const mode = classifyQuery(query);

  if (mode === "keyword") {
    // Client-side keyword search — instant, no backend round-trip, no spinner
    elements.loadingState.style.display = "none";
    elements.resultsSection.style.display = "block";
    performKeywordSearch(query);
  } else {
    // Semantic search — needs the backend
    showLoading();
    vscode?.postMessage({ type: "search", query });
  }
}

// ---------------------------------------------------------------------------
// Keyword (ctrl+f style) search
// ---------------------------------------------------------------------------

function performKeywordSearch(query) {
  const ql = query.toLowerCase();

  const matches = allCells.filter((cell) => {
    const source = (cell.cellContent || "").toLowerCase();
    return source.includes(ql);
  });

  displayKeywordResults(matches, query);
}

function escapeHtml(text) {
  return String(text).replace(
    /[<>&"']/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function getMatchSnippet(text, query, contextLen = 100) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return "";
  const start = Math.max(0, idx - contextLen);
  const end = Math.min(text.length, idx + query.length + contextLen);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "\u2026" + snippet;
  if (end < text.length) snippet += "\u2026";
  return snippet;
}

function highlightMatch(escapedText, rawQuery) {
  const escapedQuery = escapeHtml(rawQuery).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  return escapedText.replace(
    new RegExp(escapedQuery, "gi"),
    (m) => `<mark class="keyword-highlight">${m}</mark>`
  );
}

function displayKeywordResults(cells, query) {
  elements.topResultsContainer.innerHTML = "";

  if (elements.topResultsSectionTitle) {
    elements.topResultsSectionTitle.innerHTML =
      `Keyword Matches <span class="mode-badge keyword-mode">code search</span>`;
  }

  if (cells.length === 0) {
    elements.topResultsContainer.innerHTML = `<p class="no-results">No cells contain <em>${escapeHtml(query)}</em></p>`;
  } else {
    cells.forEach((cell) => {
      elements.topResultsContainer.appendChild(createKeywordCard(cell, query));
    });
  }

  elements.otherResults.style.display = "none";
}

function createKeywordCard(cell, query) {
  const card = document.createElement("div");
  card.className = "result-card keyword-match expanded";
  card.dataset.cellId = cell.cellId;
  card.title = `Go to ${cell.cellLabel}`;

  const source = cell.cellContent || "";
  const snippet = getMatchSnippet(source, query);
  const highlightedSnippet = highlightMatch(escapeHtml(snippet), query);

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cell.cellIcon)}" alt="${cell.cellIcon}" class="cell-icon" />
      <div class="card-label-group">
        <div class="card-meta">
          <span class="cell-id">[${escapeHtml(cell.cellId)}]</span>
          <span class="keyword-badge">keyword</span>
        </div>
        <span class="cell-label">${escapeHtml(cell.cellLabel)}</span>
      </div>
      <button class="card-toggle-btn" title="More Info">
        <img src="${ICONS_URI}/dropdown_icon.svg" alt="" class="card-dropdown-icon" />
      </button>
    </div>
    <div class="card-description">
      <code class="match-snippet">${highlightedSnippet}</code>
    </div>
  `;

  card.querySelector(".card-toggle-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("expanded");
  });

  card.addEventListener("click", () => handleCellClick(cell.cellId));
  return card;
}

// ---------------------------------------------------------------------------
// Semantic search results (existing backend path)
// ---------------------------------------------------------------------------

function displayResults(data) {
  hideLoading();

  if (elements.topResultsSectionTitle) {
    elements.topResultsSectionTitle.innerHTML =
      `Top Matches <span class="mode-badge semantic-mode">semantic</span>`;
  }

  elements.topResultsContainer.innerHTML = "";
  data.queryCellsList.forEach((result) => {
    const stored = allCells.find((c) => c.cellId === result.cellId);
    const enriched = {
      ...result,
      ...stored,
      score: result.score,
      distance: result.distance,
    };
    elements.topResultsContainer.appendChild(createResultCard(enriched));
  });

  if (data.otherCellsList?.length > 0) {
    elements.otherResultsContainer.innerHTML = "";
    data.otherCellsList.forEach((cell) => {
      const stored = allCells.find((c) => c.cellId === cell.cellId);
      const enriched = {
        ...cell,
        ...stored,
        score: cell.score,
        distance: cell.distance,
      };
      elements.otherResultsContainer.appendChild(createResultCard(enriched));
    });
    elements.otherResults.style.display = "block";
    elements.otherCellCount.textContent = `(${data.otherCellsList.length})`;
  } else {
    elements.otherResults.style.display = "none";
  }
}

// ---------------------------------------------------------------------------
// Shared view helpers
// ---------------------------------------------------------------------------

function showDefaultView() {
  elements.loadingState.style.display = "none";
  elements.resultsSection.style.display = "none";
  elements.defaultSection.style.display = "block";
  if (elements.topResultsSectionTitle) {
    elements.topResultsSectionTitle.textContent = "Top Matches";
  }
}

function showLoading() {
  elements.resultsSection.style.display = "none";
  elements.loadingState.style.display = "flex";
}

function hideLoading() {
  elements.loadingState.style.display = "none";
  elements.resultsSection.style.display = "block";
}

function displayAllCells(cells) {
  cells.forEach((cell) => {
    elements.allCellsContainer.appendChild(createDefaultCard(cell));
  });
}

// ---------------------------------------------------------------------------
// Card factories
// ---------------------------------------------------------------------------

function createDefaultCard(cell) {
  const card = document.createElement("div");
  card.className = "result-card default";
  card.dataset.cellId = cell.cellId;
  card.title = `Go to ${cell.cellLabel}`;

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cell.cellIcon)}" alt="${cell.cellIcon}" class="cell-icon" />
      <div class="card-label-group">
        <div class="card-meta">
          <span class="cell-id">[${cell.cellId}]</span>
        </div>
        <span class="cell-label">${cell.cellLabel}</span>
      </div>
      <button class="card-toggle-btn" title="More Info">
        <img src="${ICONS_URI}/dropdown_icon.svg" alt="" class="card-dropdown-icon" />
      </button>
    </div>
    <div class="card-description">${cell.cellDescription ?? ""}</div>
  `;

  card.querySelector(".card-toggle-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("expanded");
  });

  card.addEventListener("click", () => handleCellClick(cell.cellId));
  return card;
}

function createResultCard(cell) {
  const card = document.createElement("div");
  const { cls, tier } = getRelevanceInfo(cell.score);
  card.className = `result-card ${cls}`;
  card.dataset.cellId = cell.cellId;
  card.title = `Go to ${cell.cellLabel}`;

  const scoreBadge =
    cell.score != null
      ? `<span class="relevance-badge ${tier}">${Math.round(cell.score * 100)}% match</span>`
      : "";

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cell.cellIcon)}" alt="${cell.cellIcon}" class="cell-icon" />
      <div class="card-label-group">
        <div class="card-meta">
          <span class="cell-id">[${cell.cellId}]</span>
          ${scoreBadge}
        </div>
        <span class="cell-label">${cell.cellLabel}</span>
      </div>
      <button class="card-toggle-btn" title="More Info">
        <img src="${ICONS_URI}/dropdown_icon.svg" alt="" class="card-dropdown-icon" />
      </button>
    </div>
    <div class="card-description">${cell.cellDescription ?? ""}</div>
  `;

  card.querySelector(".card-toggle-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("expanded");
  });

  card.addEventListener("click", () => handleCellClick(cell.cellId));
  return card;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function handleCellClick(cellId) {
  navigationStack.push(cellId);
  elements.backButton.classList.add("active");
  vscode?.postMessage({ type: "jumpToCell", cellId });
}

function handleBack() {
  if (!navigationStack.length) return;
  navigationStack.pop();
  if (!navigationStack.length) elements.backButton.classList.remove("active");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getIconPath(iconType) {
  const iconMap = {
    datapie: `${ICONS_URI}/datapie_icon.svg`,
    table: `${ICONS_URI}/table_icon.svg`,
    upload: `${ICONS_URI}/upload_icon.svg`,
    clean: `${ICONS_URI}/clean_icon.svg`,
  };
  return iconMap[iconType] ?? `${ICONS_URI}/table_icon.svg`;
}

function getRelevanceInfo(score) {
  if (score >= 0.8) return { cls: "high-relevance", tier: "high" };
  if (score >= 0.5) return { cls: "medium-relevance", tier: "medium" };
  return { cls: "low-relevance", tier: "low" };
}

document.addEventListener("DOMContentLoaded", init);

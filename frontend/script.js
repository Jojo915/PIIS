const vscode =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;
const ICONS_URI = document.body?.dataset.iconsUri ?? "../icons";

const elements = {
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  clearButton: document.getElementById("clearButton"),
  caseSensitiveBtn: document.getElementById("caseSensitiveBtn"),
  wholeWordBtn: document.getElementById("wholeWordBtn"),
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
  searchingIndicator: document.getElementById("searchingIndicator"),
};
let allCells = [];
const navigationStack = [];

// Keyword search option state
let isCaseSensitive = false;
let isWholeWord = false;
// Tracks the mode of the currently displayed results so toggles and the
// input listener know how to behave when the query changes.
let lastSearchMode = null;
// Debounce timer for semantic search fired from the input listener.
let semanticDebounceTimer = null;

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

  // Contains code-like punctuation — only a reliable keyword signal for short
  // queries. Longer descriptions often embed code notation (e.g. "x = 3 and
  // two other assignments") while still being conceptual/semantic queries.
  if (wordCount <= 3 && /[.()\[\]{}_=<>!@#$%^*]/.test(q)) return "keyword";

  // camelCase or snake_case — same reasoning: trust it only when short.
  if (wordCount <= 3 && /[a-z][A-Z]|_[a-zA-Z]/.test(q)) return "keyword";

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

    // Live mode chip
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

    // Clear → back to default
    if (!hasText) {
      clearTimeout(semanticDebounceTimer);
      setResultsStale(false);
      lastSearchMode = null;
      showDefaultView();
      return;
    }

    const query = val.trim();
    if (!query) return;

    const mode = classifyQuery(query);
    elements.defaultSection.style.display = "none";

    if (mode === "keyword") {
      // Instant client-side search — cancel any pending semantic request
      clearTimeout(semanticDebounceTimer);
      elements.loadingState.style.display = "none";
      elements.resultsSection.style.display = "block";
      setResultsStale(false);
      performKeywordSearch(query);
      lastSearchMode = "keyword";
    } else {
      // Semantic: keep whatever is currently showing (stale) and debounce
      // the backend call so we don't fire on every keystroke.
      clearTimeout(semanticDebounceTimer);

      if (lastSearchMode !== null) {
        // Results already on screen — mark them stale and show the indicator
        elements.resultsSection.style.display = "block";
        elements.loadingState.style.display = "none";
        setResultsStale(true);
      } else {
        // Nothing shown yet — use the full loading spinner
        showLoading();
      }

      lastSearchMode = "semantic";
      semanticDebounceTimer = setTimeout(() => {
        vscode?.postMessage({ type: "search", query });
      }, 600);
    }
  });
  elements.clearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    elements.clearButton.style.display = "none";
    if (elements.modeChip) elements.modeChip.style.display = "none";
    clearTimeout(semanticDebounceTimer);
    lastSearchMode = null;
    setResultsStale(false);
    showDefaultView();
  });

  elements.caseSensitiveBtn?.addEventListener("click", () => {
    isCaseSensitive = !isCaseSensitive;
    elements.caseSensitiveBtn.classList.toggle("active", isCaseSensitive);
    elements.caseSensitiveBtn.setAttribute("aria-pressed", String(isCaseSensitive));
    refreshKeywordSearch();
  });

  elements.wholeWordBtn?.addEventListener("click", () => {
    isWholeWord = !isWholeWord;
    elements.wholeWordBtn.classList.toggle("active", isWholeWord);
    elements.wholeWordBtn.setAttribute("aria-pressed", String(isWholeWord));
    refreshKeywordSearch();
  });

  elements.backButton.addEventListener("click", handleBack);
  elements.searchInput.focus();

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "searchResult") {
      setResultsStale(false);
      displayResults(message.data);
    } else if (message.type === "searchError") {
      setResultsStale(false);
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
    } else if (message.type === "summarySaved") {
      updateCellSummary(message.data.cellId, message.data.summary);
    } else if (message.type === "summarySaveError") {
      setSummaryEditorStatus(
        message.data.cellId,
        message.data.error || "Failed to save summary.",
        true
      );
    }
  });

  vscode?.postMessage({ type: "webviewReady" });
}

// ---------------------------------------------------------------------------
// Search dispatch
// ---------------------------------------------------------------------------

function handleSearch() {
  const query = elements.searchInput.value.trim();
  if (!query) {
    clearTimeout(semanticDebounceTimer);
    showDefaultView();
    return;
  }

  // Cancel any debounced semantic request — we're firing immediately
  clearTimeout(semanticDebounceTimer);
  elements.defaultSection.style.display = "none";
  const mode = classifyQuery(query);
  lastSearchMode = mode;

  if (mode === "keyword") {
    elements.loadingState.style.display = "none";
    elements.resultsSection.style.display = "block";
    setResultsStale(false);
    performKeywordSearch(query);
  } else {
    setResultsStale(false);
    showLoading();
    vscode?.postMessage({ type: "search", query });
  }
}

// ---------------------------------------------------------------------------
// Keyword (ctrl+f style) search
// ---------------------------------------------------------------------------

/**
 * Build a RegExp from the query string respecting the current toggle state.
 * Always uses the global flag so .match() counts all occurrences per line.
 */
function buildSearchRegex(query) {
  let pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (isWholeWord) pattern = `\\b${pattern}\\b`;
  return new RegExp(pattern, isCaseSensitive ? "g" : "gi");
}

/**
 * Find all line-level match windows in `text` for `regex`.
 * Adjacent/overlapping windows (within contextLines of each other) are merged.
 * Capped at maxWindows; the remainder is reported as hiddenWindows.
 */
function findMatchWindows(text, regex, contextLines = 2, maxWindows = 5) {
  const lines = text.split("\n");
  const matchLineIndices = [];
  let totalMatches = 0;

  for (let i = 0; i < lines.length; i++) {
    regex.lastIndex = 0;
    const hits = lines[i].match(regex);
    if (hits) {
      matchLineIndices.push(i);
      totalMatches += hits.length;
    }
  }

  if (matchLineIndices.length === 0) {
    return { windows: [], lines, totalMatches: 0, hiddenWindows: 0 };
  }

  // Build one window per match line, then merge overlapping ones
  const merged = [];
  for (const idx of matchLineIndices) {
    const w = {
      start: Math.max(0, idx - contextLines),
      end: Math.min(lines.length - 1, idx + contextLines),
      matchLines: new Set([idx]),
    };
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (w.start <= prev.end + 1) {
        prev.end = Math.max(prev.end, w.end);
        prev.matchLines.add(idx);
        continue;
      }
    }
    merged.push(w);
  }

  return {
    windows: merged.slice(0, maxWindows),
    lines,
    totalMatches,
    hiddenWindows: Math.max(0, merged.length - maxWindows),
  };
}

/**
 * Escape HTML in rawLine and wrap every regex match in <mark>.
 * Escaping happens character-by-character before insertion so raw cell source
 * containing `<`, `>`, `&` etc. can never inject HTML into the DOM.
 */
function highlightAndEscape(rawLine, regex) {
  let result = "";
  let lastEnd = 0;
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(rawLine)) !== null) {
    result += escapeHtml(rawLine.slice(lastEnd, match.index));
    result += `<mark class="keyword-highlight">${escapeHtml(match[0])}</mark>`;
    lastEnd = match.index + match[0].length;
    if (match[0].length === 0) regex.lastIndex++; // guard against zero-width matches
  }
  result += escapeHtml(rawLine.slice(lastEnd));
  return result;
}

function escapeHtml(text) {
  return String(text).replace(
    /[<>&"']/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/** Re-run keyword search if the toggle state changes while results are shown. */
function refreshKeywordSearch() {
  if (lastSearchMode !== "keyword") return;
  const query = elements.searchInput.value.trim();
  if (query) performKeywordSearch(query);
}

function performKeywordSearch(query) {
  const regex = buildSearchRegex(query);

  const matches = allCells.filter((cell) => {
    regex.lastIndex = 0;
    return regex.test(cell.cellContent || "");
  });

  displayKeywordResults(matches, query, regex);
}

function displayKeywordResults(cells, query, regex) {
  elements.topResultsContainer.innerHTML = "";

  if (elements.topResultsSectionTitle) {
    elements.topResultsSectionTitle.innerHTML =
      `Keyword Matches <span class="mode-badge keyword-mode">code search</span>`;
  }

  if (cells.length === 0) {
    elements.topResultsContainer.innerHTML =
      `<p class="no-results">No cells contain <em>${escapeHtml(query)}</em></p>`;
  } else {
    cells.forEach((cell) => {
      elements.topResultsContainer.appendChild(createKeywordCard(cell, regex));
    });
  }

  elements.otherResults.style.display = "none";
}

function createKeywordCard(cell, regex) {
  const card = document.createElement("div");
  card.className = "result-card keyword-match expanded";
  card.dataset.cellId = cell.cellId;
  card.title = `Go to ${cell.cellLabel}`;

  const { windows, lines, totalMatches, hiddenWindows } = findMatchWindows(
    cell.cellContent || "",
    regex
  );

  const matchLabel = `${totalMatches} match${totalMatches !== 1 ? "es" : ""}`;

  let windowsHtml = "";
  windows.forEach((win, i) => {
    if (i > 0) windowsHtml += `<div class="match-separator">&middot;&middot;&middot;</div>`;
    windowsHtml += `<div class="match-window">`;
    for (let li = win.start; li <= win.end; li++) {
      const isMatch = win.matchLines.has(li);
      const lineHtml = isMatch
        ? highlightAndEscape(lines[li], regex)
        : escapeHtml(lines[li]);
      windowsHtml += `
        <div class="match-line-row${isMatch ? " is-match" : ""}">
          <span class="line-num">${li + 1}</span>
          <span class="line-content">${lineHtml}</span>
        </div>`;
    }
    windowsHtml += `</div>`;
  });

  if (hiddenWindows > 0) {
    windowsHtml += `<div class="more-matches">+${hiddenWindows} more match window${hiddenWindows !== 1 ? "s" : ""} not shown</div>`;
  }

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cell.cellIcon)}" alt="${cell.cellIcon}" class="cell-icon" />
      <div class="card-label-group">
        <div class="card-meta">
          <span class="cell-id">[${escapeHtml(cell.cellId)}]</span>
          <span class="keyword-badge">keyword</span>
          <span class="match-count-badge">${matchLabel}</span>
        </div>
        <span class="cell-label">${escapeHtml(cell.cellLabel)}</span>
      </div>
      <button class="card-toggle-btn" title="More Info">
        <img src="${ICONS_URI}/dropdown_icon.svg" alt="" class="card-dropdown-icon" />
      </button>
    </div>
    <div class="card-description">
      <div class="match-windows">${windowsHtml}</div>
    </div>
  `;

  card.querySelector(".card-toggle-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("expanded");
  });
  attachSummaryEditor(card, cell);

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

/**
 * Dim the results section and show the "Searching AI…" indicator while a
 * semantic request is in flight but previous results are still visible.
 * Pass false to restore full opacity and hide the indicator.
 */
function setResultsStale(stale) {
  elements.resultsSection.classList.toggle("results-stale", stale);
  if (elements.searchingIndicator) {
    elements.searchingIndicator.style.display = stale ? "flex" : "none";
  }
}

function showDefaultView() {
  elements.loadingState.style.display = "none";
  elements.resultsSection.style.display = "none";
  elements.defaultSection.style.display = "block";
  setResultsStale(false);
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
  if (!cells.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No code cells indexed yet.";
    elements.allCellsContainer.appendChild(emptyState);
    return;
  }

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
    ${createSummaryEditorHtml(cell)}
  `;

  card.querySelector(".card-toggle-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("expanded");
  });
  attachSummaryEditor(card, cell);

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
    ${createSummaryEditorHtml(cell)}
  `;

  card.querySelector(".card-toggle-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("expanded");
  });

  card.addEventListener("click", () => handleCellClick(cell.cellId));
  return card;
}

function createSummaryEditorHtml(cell) {
  const summary = cell.cellDescription ?? "";

  return `
    <div class="card-description summary-editor" data-cell-id="${escapeHtml(cell.cellId)}">
      <div class="summary-display" title="Click to edit summary">${escapeHtml(summary)}</div>
      <div class="summary-edit-panel" style="display: none">
        <textarea class="summary-textarea" rows="4">${escapeHtml(summary)}</textarea>
        <div class="summary-actions">
          <span class="summary-status"></span>
          <button class="summary-save-btn" type="button">Save</button>
        </div>
      </div>
    </div>
  `;
}

function attachSummaryEditor(card, cell) {
  const editor = card.querySelector(".summary-editor");
  const display = card.querySelector(".summary-display");
  const panel = card.querySelector(".summary-edit-panel");
  const textarea = card.querySelector(".summary-textarea");
  const saveButton = card.querySelector(".summary-save-btn");

  if (!editor || !display || !panel || !textarea || !saveButton) return;

  editor.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  display.addEventListener("click", (event) => {
    event.stopPropagation();
    display.style.display = "none";
    panel.style.display = "block";
    textarea.focus();
  });

  saveButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const summary = textarea.value.trim();
    saveButton.disabled = true;
    setSummaryEditorStatus(cell.cellId, "Saving...", false);
    vscode?.postMessage({
      type: "saveSummary",
      cellId: cell.cellId,
      summary,
    });
  });
}

function updateCellSummary(cellId, summary) {
  allCells = allCells.map((cell) =>
    cell.cellId === cellId ? { ...cell, cellDescription: summary } : cell
  );

  document
    .querySelectorAll(`.summary-editor[data-cell-id="${cssEscape(cellId)}"]`)
    .forEach((editor) => {
      const display = editor.querySelector(".summary-display");
      const panel = editor.querySelector(".summary-edit-panel");
      const textarea = editor.querySelector(".summary-textarea");
      const saveButton = editor.querySelector(".summary-save-btn");

      if (display) {
        display.textContent = summary;
        display.style.display = "block";
      }

      if (textarea) textarea.value = summary;
      if (panel) panel.style.display = "none";
      if (saveButton) saveButton.disabled = false;

      setSummaryEditorStatus(cellId, "Saved.", false);
    });
}

function setSummaryEditorStatus(cellId, message, isError) {
  document
    .querySelectorAll(`.summary-editor[data-cell-id="${cssEscape(cellId)}"]`)
    .forEach((editor) => {
      const status = editor.querySelector(".summary-status");
      const saveButton = editor.querySelector(".summary-save-btn");

      if (status) {
        status.textContent = message;
        status.classList.toggle("summary-error", isError);
      }

      if (saveButton && isError) saveButton.disabled = false;
    });
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

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

document.addEventListener("DOMContentLoaded", init);

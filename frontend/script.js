const vscode =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;
const ICONS_URI = document.body?.dataset.iconsUri ?? "../icons";

const elements = {
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  clearButton: document.getElementById("clearButton"),
  caseSensitiveBtn: document.getElementById("caseSensitiveBtn"),
  wholeWordBtn: document.getElementById("wholeWordBtn"),
  regexBtn: document.getElementById("regexBtn"),
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
  replaceRow: document.getElementById("replaceRow"),
  replaceInput: document.getElementById("replaceInput"),
  preserveCaseButton: document.getElementById("preserveCaseButton"),
  replaceAllButton: document.getElementById("replaceAllButton"),
  replaceAllOverlay: document.getElementById("replaceAllOverlay"),
  replaceAllMessage: document.getElementById("replaceAllMessage"),
  replaceAllConfirmButton: document.getElementById("replaceAllConfirmButton"),
  replaceAllCancelButton: document.getElementById("replaceAllCancelButton"),
};

// Debounce windows for re-running search while the user is still typing.
// Keyword search is local/instant work, so it only needs a short debounce to
// avoid rebuilding the whole result list on every keystroke; semantic search
// hits the backend, so it waits longer to avoid firing on every keystroke.
const KEYWORD_DEBOUNCE_MS = 120;
const SEMANTIC_DEBOUNCE_MS = 600;

let allCells = [];

let isCaseSensitive = false;
let isWholeWord = false;
let isRegex = false;
let isPreserveCase = false;
// Tracks the mode of the currently displayed results so toggles and the
// input listener know how to behave when the query changes.
let lastSearchMode = null;
let keywordDebounceTimer = null;
let semanticDebounceTimer = null;
// The cells/regex behind the currently displayed keyword results, kept
// around so the Replace All dialog can report an accurate occurrence count
// without re-running the search.
let lastKeywordCells = [];
let lastKeywordRegex = null;

/**
 * Classify a query as 'keyword' (code/ctrl+f style) or 'semantic' (AI search).
 * Runs entirely client-side — no backend round-trip needed for the decision.
 */
function classifyQuery(query) {
  const q = query.trim();
  if (!q) return "semantic";

  if (q.endsWith("?")) return "semantic";

  const semanticPattern =
    /\b(what|how|why|where|when|which|who|does|do|is|are|can|should|explain|find|show|tell|describe|gives?|returns?|compute|calculate|plots?|visuali[sz]e)\b/i;
  if (semanticPattern.test(q)) return "semantic";

  const words = q.split(/\s+/);
  const wordCount = words.length;

  // Single token (no whitespace) → almost certainly a variable / function name
  if (wordCount === 1) return "keyword";

  const codeKeywordPattern =
    /^(import|from|def|class|for|if|elif|else|return|print|with|try|except|raise|assert|lambda|yield|async|await|not|and|or|in|is)\s/;
  if (codeKeywordPattern.test(q)) return "keyword";

  // Contains code-like punctuation — only a reliable keyword signal for short
  // queries. Longer descriptions often embed code notation (e.g. "x = 3 and
  // two other assignments") while still being conceptual/semantic queries.
  if (wordCount <= 3 && /[.()\[\]{}_=<>!@#$%^*]/.test(q)) return "keyword";

  // camelCase or snake_case — same reasoning: trust it only when short.
  if (wordCount <= 3 && /[a-z][A-Z]|_[a-zA-Z]/.test(q)) return "keyword";

  const nlPattern =
    /\b(with|using|from|into|about|between|among|across|through|that|and|to|for)\b/i;
  if (wordCount >= 3 && nlPattern.test(q)) return "semantic";

  // Long words (≥ 7 chars) in short queries signal natural-language concept
  // terms ('normalization', 'assignment', 'gradient', 'network'…) rather than
  // the short action verbs and abbreviations typical of code search ('fit',
  // 'load', 'csv', 'df'). Single-token identifiers are already caught above.
  if (wordCount <= 3 && words.some((w) => w.length >= 7)) return "semantic";

  if (wordCount <= 3) return "keyword";

  return "semantic";
}

function init() {
  elements.searchButton.addEventListener("click", handleSearch);
  elements.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSearch();
    }
  });
  elements.searchInput.addEventListener("input", () => {
    if (elements.searchInput.value.includes("\n")) {
      elements.searchInput.value = elements.searchInput.value.replace(
        /\n/g,
        " ",
      );
    }
    autoGrowTextarea(elements.searchInput);

    const val = elements.searchInput.value;
    const hasText = val.length > 0;
    elements.clearButton.style.display = hasText ? "flex" : "none";

    if (elements.modeChip) {
      if (hasText) {
        const mode = classifyQuery(val);
        elements.modeChip.className = `mode-chip ${mode}-chip`;
        elements.modeChip.style.display = "flex";
      } else {
        elements.modeChip.style.display = "none";
      }
    }

    if (!hasText) {
      clearTimeout(keywordDebounceTimer);
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
      // Cancel any pending semantic request — keyword search runs locally,
      // so it only needs a short debounce to avoid rebuilding the result
      // list on every keystroke while typing fast.
      clearTimeout(semanticDebounceTimer);
      elements.loadingState.style.display = "none";
      elements.resultsSection.style.display = "block";
      setResultsStale(false);
      lastSearchMode = "keyword";

      clearTimeout(keywordDebounceTimer);
      keywordDebounceTimer = setTimeout(() => {
        performKeywordSearch(query);
      }, KEYWORD_DEBOUNCE_MS);
    } else {
      // Semantic: keep whatever is currently showing (stale) and debounce
      // the backend call so we don't fire on every keystroke.
      clearTimeout(keywordDebounceTimer);
      clearTimeout(semanticDebounceTimer);

      if (lastSearchMode !== null) {
        elements.resultsSection.style.display = "block";
        elements.loadingState.style.display = "none";
        setResultsStale(true);
      } else {
        showLoading();
      }

      lastSearchMode = "semantic";
      semanticDebounceTimer = setTimeout(() => {
        vscode?.postMessage({ type: "search", query });
      }, SEMANTIC_DEBOUNCE_MS);
    }
  });
  elements.clearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    autoGrowTextarea(elements.searchInput);
    elements.clearButton.style.display = "none";
    if (elements.modeChip) elements.modeChip.style.display = "none";
    clearTimeout(keywordDebounceTimer);
    clearTimeout(semanticDebounceTimer);
    lastSearchMode = null;
    setResultsStale(false);
    showDefaultView();
  });

  // A VS Code sidebar webview can be resized independently of the OS window
  // (dragging the view splitter), so watch the actual input wrappers rather
  // than relying on a window-level resize event.
  const resizeObserver = new ResizeObserver(() => {
    autoGrowTextarea(elements.searchInput);
    autoGrowTextarea(elements.replaceInput);
  });
  resizeObserver.observe(elements.searchInput.closest(".search-wrapper"));
  resizeObserver.observe(elements.replaceInput.closest(".replace-wrapper"));

  elements.caseSensitiveBtn?.addEventListener("click", () => {
    isCaseSensitive = !isCaseSensitive;
    elements.caseSensitiveBtn.classList.toggle("active", isCaseSensitive);
    elements.caseSensitiveBtn.setAttribute(
      "aria-pressed",
      String(isCaseSensitive),
    );
    refreshKeywordSearch();
  });

  elements.wholeWordBtn?.addEventListener("click", () => {
    isWholeWord = !isWholeWord;
    elements.wholeWordBtn.classList.toggle("active", isWholeWord);
    elements.wholeWordBtn.setAttribute("aria-pressed", String(isWholeWord));
    refreshKeywordSearch();
  });

  elements.regexBtn?.addEventListener("click", () => {
    isRegex = !isRegex;
    elements.regexBtn.classList.toggle("active", isRegex);
    elements.regexBtn.setAttribute("aria-pressed", String(isRegex));
    refreshKeywordSearch();
  });

  elements.replaceInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleReplace();
    }
  });
  elements.replaceInput?.addEventListener("input", () => {
    if (elements.replaceInput.value.includes("\n")) {
      elements.replaceInput.value = elements.replaceInput.value.replace(
        /\n/g,
        " ",
      );
    }
    autoGrowTextarea(elements.replaceInput);
  });

  elements.preserveCaseButton?.addEventListener("click", () => {
    isPreserveCase = !isPreserveCase;
    elements.preserveCaseButton.classList.toggle("active", isPreserveCase);
    elements.preserveCaseButton.setAttribute(
      "aria-pressed",
      String(isPreserveCase),
    );
  });

  elements.replaceAllButton?.addEventListener("click", showReplaceAllOverlay);
  elements.replaceAllCancelButton?.addEventListener(
    "click",
    hideReplaceAllOverlay,
  );
  elements.replaceAllConfirmButton?.addEventListener("click", () => {
    hideReplaceAllOverlay();
    handleReplace();
  });

  elements.searchInput.focus();

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "searchResult") {
      setResultsStale(false);
      displayResults(message.data);
    } else if (message.type === "searchError") {
      setResultsStale(false);
      hideLoading();
      displaySearchError(message.error);
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

/** Fire a search immediately (Enter / button click) — bypasses both debounces. */
function handleSearch() {
  const query = elements.searchInput.value.trim();
  if (!query) {
    clearTimeout(keywordDebounceTimer);
    clearTimeout(semanticDebounceTimer);
    showDefaultView();
    return;
  }

  clearTimeout(keywordDebounceTimer);
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

/**
 * Build a RegExp from the query string respecting the current toggle state.
 * Always uses the global flag so .match() counts all occurrences per line.
 */
function buildSearchRegex(query) {
  let pattern = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function performKeywordSearch(query) {
  setReplaceVisible(true);

  let regex;
  try {
    regex = buildSearchRegex(query);
  } catch (err) {
    displayInvalidRegex(query);
    return;
  }

  const matches = allCells.filter((cell) => {
    regex.lastIndex = 0;
    return regex.test(cell.cellContent || "");
  });

  lastKeywordCells = matches;
  lastKeywordRegex = regex;

  displayKeywordResults(matches, query, regex);
}

/** Re-run keyword search if the toggle state changes while results are shown. */
function refreshKeywordSearch() {
  if (lastSearchMode !== "keyword") return;
  const query = elements.searchInput.value.trim();
  if (query) performKeywordSearch(query);
}

function getTotalMatchCount() {
  if (!lastKeywordRegex) return 0;
  return lastKeywordCells.reduce(
    (sum, cell) =>
      sum +
      findMatchWindows(cell.cellContent || "", lastKeywordRegex).totalMatches,
    0,
  );
}

function handleReplace() {
  // No-op: lexical search/replace doesn't exist on the backend yet, so
  // there's nothing to actually replace. Wired so Enter (and the Replace All
  // confirmation) behave like VS Code's find/replace widget once that exists.
}

function showReplaceAllOverlay() {
  const count = getTotalMatchCount();
  elements.replaceAllMessage.textContent = `Replace all ${count} occurences in the notebook?`;
  elements.replaceAllOverlay.style.display = "flex";
}

function hideReplaceAllOverlay() {
  elements.replaceAllOverlay.style.display = "none";
}

/**
 * Shared card DOM builder used by every card type (default / semantic
 * result / keyword match). Callers provide the parts that differ: extra
 * header badges (metaHtml), the description body, and an extra class for
 * tier/mode-specific styling.
 */
function createCardElement({
  cellId,
  cellLabel,
  cellIdHtml,
  cellLabelHtml,
  metaHtml,
  descriptionHtml,
  cellIcon,
  extraClass,
}) {
  const card = document.createElement("div");
  card.className = `result-card ${extraClass}`;
  card.dataset.cellId = cellId;
  card.title = `Go to ${cellLabel}`;

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cellIcon)}" alt="${cellIcon}" class="cell-icon icon-16" />
      <div class="card-label-group">
        <div class="card-meta">
          <span class="cell-id">[${cellIdHtml}]</span>
          ${metaHtml ?? ""}
        </div>
        <span class="cell-label">${cellLabelHtml}</span>
      </div>
      <button class="card-toggle-btn" title="More Info">
        <img src="${ICONS_URI}/dropdown_icon.svg" alt="" class="chevron-icon icon-16" />
      </button>
    </div>
    <div class="card-description">${descriptionHtml ?? ""}</div>
  `;

  card.querySelector(".card-toggle-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("expanded");
  });

  card.addEventListener("click", () => handleCellClick(cellId));
  return card;
}

/** Card for the "All Cells" default list and semantic/relevance results. */
function createCellCard(cell, extraClass) {
  return createCardElement({
    cellId: cell.cellId,
    cellLabel: cell.cellLabel,
    cellIdHtml: escapeHtml(cell.cellId),
    cellLabelHtml: escapeHtml(cell.cellLabel),
    descriptionHtml: escapeHtml(cell.cellDescription ?? ""),
    cellIcon: cell.cellIcon,
    extraClass,
  });
}

function createKeywordCard(cell, regex) {
  const { windows, lines, totalMatches, hiddenWindows } = findMatchWindows(
    cell.cellContent || "",
    regex,
  );

  const matchLabel = `${totalMatches} match${totalMatches !== 1 ? "es" : ""}`;

  let windowsHtml = "";
  windows.forEach((win, i) => {
    if (i > 0)
      windowsHtml += `<div class="match-separator">&middot;&middot;&middot;</div>`;
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

  return createCardElement({
    cellId: cell.cellId,
    cellLabel: cell.cellLabel,
    cellIdHtml: escapeHtml(cell.cellId),
    cellLabelHtml: escapeHtml(cell.cellLabel),
    metaHtml: `<span class="keyword-badge">keyword</span><span class="match-count-badge">${matchLabel}</span>`,
    descriptionHtml: `<div class="match-windows">${windowsHtml}</div>`,
    cellIcon: cell.cellIcon,
    extraClass: "keyword-match expanded",
  });
}

function setKeywordSectionTitle() {
  if (elements.topResultsSectionTitle) {
    elements.topResultsSectionTitle.innerHTML = `Keyword Matches <span class="mode-badge keyword-mode">lexical search</span>`;
  }
}

function displayInvalidRegex(query) {
  setKeywordSectionTitle();
  elements.topResultsContainer.innerHTML = `<p class="no-results">Invalid regular expression: <em>${escapeHtml(query)}</em></p>`;
  elements.otherResults.style.display = "none";
}

function displayKeywordResults(cells, query, regex) {
  elements.topResultsContainer.innerHTML = "";
  setKeywordSectionTitle();

  if (cells.length === 0) {
    elements.topResultsContainer.innerHTML = `<p class="no-results">No cells contain <em>${escapeHtml(query)}</em></p>`;
  } else {
    cells.forEach((cell) => {
      elements.topResultsContainer.appendChild(createKeywordCard(cell, regex));
    });
  }

  elements.otherResults.style.display = "none";
}

/**
 * Enrich each result with cached cell data (label/description/icon) looked
 * up from `allCells`, then render a card for it into `container`.
 */
function renderCellList(container, results) {
  container.innerHTML = "";
  results.forEach((result) => {
    const stored = allCells.find((c) => c.cellId === result.cellId);
    const enriched = {
      ...result,
      ...stored,
      score: result.score,
      distance: result.distance,
    };
    container.appendChild(
      createCellCard(enriched, getRelevanceClass(enriched.score)),
    );
  });
}

function displayResults(data) {
  hideLoading();
  setReplaceVisible(false);

  if (elements.topResultsSectionTitle) {
    elements.topResultsSectionTitle.innerHTML = `Top Matches <span class="mode-badge semantic-mode">semantic search</span>`;
  }

  renderCellList(elements.topResultsContainer, data.queryCellsList);

  if (data.otherCellsList?.length > 0) {
    renderCellList(elements.otherResultsContainer, data.otherCellsList);
    elements.otherResults.style.display = "block";
    elements.otherCellCount.textContent = `(${data.otherCellsList.length})`;
  } else {
    elements.otherResults.style.display = "none";
  }
}

function displaySearchError(error) {
  setReplaceVisible(false);

  if (elements.topResultsSectionTitle) {
    elements.topResultsSectionTitle.textContent = "Top Matches";
  }
  elements.topResultsContainer.innerHTML = `<p class="no-results">Search failed: <em>${escapeHtml(error ?? "Unknown error")}</em></p>`;
  elements.otherResults.style.display = "none";
}

function displayAllCells(cells) {
  cells.forEach((cell) => {
    elements.allCellsContainer.appendChild(createCellCard(cell, "default"));
  });
}

function handleCellClick(cellId) {
  vscode?.postMessage({ type: "jumpToCell", cellId });
}

function getIconPath(iconType) {
  const iconMap = {
    datapie: `${ICONS_URI}/datapie_icon.svg`,
    table: `${ICONS_URI}/table_icon.svg`,
    upload: `${ICONS_URI}/upload_icon.svg`,
    clean: `${ICONS_URI}/clean_icon.svg`,
  };
  return iconMap[iconType] ?? `${ICONS_URI}/table_icon.svg`;
}

function getRelevanceClass(score) {
  if (score >= 0.8) return "high-relevance";
  if (score >= 0.5) return "medium-relevance";
  return "low-relevance";
}

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

/**
 * Grow/shrink a search/replace textarea to fit its wrapped content, so long
 * queries break onto additional lines instead of scrolling horizontally.
 * Also invoked by the ResizeObserver in init(), since narrowing the panel
 * changes how much text wraps.
 */
function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * Show/hide the Replace row. Only relevant for keyword (lexical) search —
 * semantic search has no notion of "replace".
 */
function setReplaceVisible(visible) {
  if (!elements.replaceRow) return;
  elements.replaceRow.style.display = visible ? "flex" : "none";
}

function showDefaultView() {
  elements.loadingState.style.display = "none";
  elements.resultsSection.style.display = "none";
  elements.defaultSection.style.display = "block";
  setResultsStale(false);
  setReplaceVisible(false);
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

document.addEventListener("DOMContentLoaded", init);

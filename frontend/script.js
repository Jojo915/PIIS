const vscode =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;
const ICONS_URI =
  typeof document !== "undefined"
    ? (document.body?.dataset.iconsUri ?? "../icons")
    : "../icons";

const elements =
  typeof document !== "undefined"
    ? {
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
        topResultsSectionTitle: document.getElementById(
          "topResultsSectionTitle",
        ),
        otherResultsContainer: document.getElementById(
          "otherResultsContainer",
        ),
        otherResults: document.getElementById("otherResults"),
        otherCellCount: document.getElementById("otherCellCount"),
        searchingIndicator: document.getElementById("searchingIndicator"),
        replaceRow: document.getElementById("replaceRow"),
        replaceInput: document.getElementById("replaceInput"),
        preserveCaseButton: document.getElementById("preserveCaseButton"),
        replaceOneButton: document.getElementById("replaceOneButton"),
        replaceAllButton: document.getElementById("replaceAllButton"),
        replaceAllOverlay: document.getElementById("replaceAllOverlay"),
        replaceAllMessage: document.getElementById("replaceAllMessage"),
        replaceAllConfirmButton: document.getElementById(
          "replaceAllConfirmButton",
        ),
        replaceAllCancelButton: document.getElementById(
          "replaceAllCancelButton",
        ),
        sidebarSummaryViewButton: document.getElementById(
          "sidebarSummaryViewButton",
        ),
        inlineSummaryViewButton: document.getElementById(
          "inlineSummaryViewButton",
        ),
        inlineSummaryNote: document.getElementById("inlineSummaryNote"),
        aiSettingsCard: document.getElementById("aiSettingsCard"),
        aiSettingsApiKeyInput: document.getElementById("aiSettingsApiKeyInput"),
        aiSettingsApiKeyToggle: document.getElementById(
          "aiSettingsApiKeyToggle",
        ),
        aiSettingsModelSelect: document.getElementById("aiSettingsModelSelect"),
        aiSettingsCustomModelField: document.getElementById(
          "aiSettingsCustomModelField",
        ),
        aiSettingsCustomModelInput: document.getElementById(
          "aiSettingsCustomModelInput",
        ),
        aiSettingsDetectStaleCheckbox: document.getElementById(
          "aiSettingsDetectStaleCheckbox",
        ),
        aiSettingsDetectDuplicateCheckbox: document.getElementById(
          "aiSettingsDetectDuplicateCheckbox",
        ),
        aiSettingsDetectDeadCheckbox: document.getElementById(
          "aiSettingsDetectDeadCheckbox",
        ),
        aiSettingsStatus: document.getElementById("aiSettingsStatus"),
        aiSettingsSaveButton: document.getElementById("aiSettingsSaveButton"),
        aiSettingsResetButton: document.getElementById("aiSettingsResetButton"),
      }
    : {};

// Models offered in the AI Settings dropdown. "other" is the sentinel value
// that reveals the custom-model text field below it.
const AI_SETTINGS_KNOWN_MODELS = ["gemini-2.5-flash-lite", "gemini-1.5-flash"];

// Stand-in shown in the API Key field when a key is already saved server
// side (the raw key is never sent to the webview). Left untouched by the
// user, it means "keep the existing key"; any edit means "use this instead".
const AI_SETTINGS_KEY_PLACEHOLDER = "••••••••••••••••";

// Debounce windows for re-running search while the user is still typing.
// Keyword search is local/instant work, so it only needs a short debounce to
// avoid rebuilding the whole result list on every keystroke; semantic search
// hits the backend, so it waits longer to avoid firing on every keystroke.
const KEYWORD_DEBOUNCE_MS = 120;
const SEMANTIC_DEBOUNCE_MS = 600;

let allCells = [];

// Tracks the origin ("ai" | "human") a summary editor intends to save, from
// the moment Save is clicked until the "summarySaved" response applies it —
// see attachSummaryEditor/updateCellDetails.
const pendingSummaryOrigin = new Map();

// Duplicate detection state.
// Each entry is an array of cell IDs forming one detected duplicate group.
// Cleared per-cell when a cell is re-executed (cellUpdated) or deleted.
let activeDuplicateGroups = [];

// Dead-cell detection state.
// The full set of currently-flagged dead cells, keyed by cellId. Unlike
// duplicate groups this is replaced wholesale each time a fresh
// deadCellsDetected message arrives (the backend re-analyses the whole
// notebook). Cleared per-cell optimistically on re-execution / deletion so
// a stale "dead" flag never lingers between the edit and the next analysis.
let deadCellsById = new Map();

// Stale-cell detection state.
// The full set of currently-flagged stale cells, keyed by cellId. Like
// dead cells this is replaced wholesale each time a fresh
// staleCellsDetected message arrives (order-staleness + edit-staleness are
// recomputed together in the extension). A stale cell is greyed out — NOT
// bordered/bannered like dead code or duplicates — because it isn't wrong,
// just out of date: its output no longer reflects its code. Cleared
// per-cell optimistically on re-execution / deletion so a stale grey-out
// never lingers between the re-run and the next analysis.
let staleCellsById = new Map();

let isCaseSensitive = false;
let isWholeWord = false;
let isRegex = false;
let isPreserveCase = false;
let isReplaceInFlight = false;
let currentMatchIndex = 0;

function resetMatchNavigation() {
  currentMatchIndex = 0;
  recentlyReplacedCellIds = new Set();
}
// Tracks the mode of the currently displayed results so toggles and the
// input listener know how to behave when the query changes.
let lastSearchMode = null;
let keywordDebounceTimer = null;
let semanticDebounceTimer = null;
let summaryViewMode = "sidebar";
// The cells/regex behind the currently displayed keyword results, kept
// around so the Replace All dialog can report an accurate occurrence count
// without re-running the search.
let lastKeywordCells = [];
let lastKeywordRegex = null;
let recentlyReplacedCellIds = new Set();

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
      resetMatchNavigation();

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
      handleReplaceOne();
    }
  });
  elements.replaceOneButton?.addEventListener("click", handleReplaceOne);
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
  elements.sidebarSummaryViewButton?.addEventListener("click", () => {
    setSummaryViewMode("sidebar", true);
  });
  elements.inlineSummaryViewButton?.addEventListener("click", () => {
    setSummaryViewMode("inline", true);
  });

  elements.aiSettingsApiKeyToggle?.addEventListener("click", () => {
    const isPassword = elements.aiSettingsApiKeyInput.type === "password";
    elements.aiSettingsApiKeyInput.type = isPassword ? "text" : "password";
    elements.aiSettingsApiKeyToggle.textContent = isPassword ? "Hide" : "Show";
    elements.aiSettingsApiKeyToggle.setAttribute(
      "aria-pressed",
      String(isPassword),
    );
    elements.aiSettingsApiKeyToggle.title = isPassword
      ? "Hide API key"
      : "Show API key";
  });

  elements.aiSettingsModelSelect?.addEventListener(
    "change",
    updateCustomModelFieldVisibility,
  );

  elements.aiSettingsSaveButton?.addEventListener("click", saveAiSettings);
  elements.aiSettingsResetButton?.addEventListener("click", resetAiSettings);

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
      setSummaryViewMode(message.viewMode ?? summaryViewMode, false);
      allCells = message.data;
      // Only reset advisory state for a *genuine* re-index (isFreshIndex),
      // i.e. a (possibly different) notebook that was just (re-)indexed
      // from scratch on the backend. Carrying stale flags forward across a
      // real re-index would let them "leak" across notebooks until the next
      // advisor pass overwrites them, so those are cleared here; the
      // extension re-runs the advisors right after indexing and will
      // repopulate whatever still applies.
      //
      // A non-fresh indexResult is a replay of already-known state (e.g.
      // the extension echoing the current cells after a sidebar/inline
      // view-mode toggle) -- the notebook hasn't actually changed, so
      // clearing here would erase still-valid duplicate/dead/stale flags
      // with nothing to repopulate them until the next real change. This
      // was the bug where toggling to inline view and back dropped all
      // advisory flags.
      if (message.isFreshIndex) {
        activeDuplicateGroups = [];
        deadCellsById = new Map();
        staleCellsById = new Map();
      }
      displayAllCells(message.data);
    } else if (message.type === "cellUpdated") {
      const cell = message.data;
      const existingIndex = allCells.findIndex((c) => c.cellId === cell.cellId);
      if (existingIndex !== -1) {
        allCells[existingIndex] = cell;
      } else {
        allCells.push(cell);
      }
      // The cell has been re-executed — its previous duplicate/dead flags are
      // stale. The extension will send fresh advisories if they still apply.
      clearDuplicateGroupsForCell(cell.cellId);
      deadCellsById.delete(cell.cellId);
      staleCellsById.delete(cell.cellId);
      displayAllCells(allCells);
    } else if (message.type === "cellDeleted") {
      const deletedId = message.data.cellId;
      allCells = allCells.filter((c) => c.cellId !== deletedId);
      clearDuplicateGroupsForCell(deletedId);
      deadCellsById.delete(deletedId);
      staleCellsById.delete(deletedId);
      displayAllCells(allCells);
    } else if (message.type === "deadCellsDetected") {
      // Whole-notebook analysis: replace the entire dead-cell set.
      const cells = message.data.cells || [];
      deadCellsById = new Map(cells.map((c) => [c.cell_id, c]));
      displayAllCells(allCells);
    } else if (message.type === "staleCellsDetected") {
      // Whole-notebook analysis: replace the entire stale-cell set.
      const cells = message.data.cells || [];
      staleCellsById = new Map(cells.map((c) => [c.cell_id, c]));
      displayAllCells(allCells);
    } else if (message.type === "duplicatesDetected") {
      const { group } = message.data;
      // Replace any existing groups that overlap with this one so we never
      // show stale or partial groups after re-execution.
      activeDuplicateGroups = activeDuplicateGroups.filter(
        (g) => !g.some((id) => group.includes(id)),
      );
      activeDuplicateGroups.push(group);
      displayAllCells(allCells);
    } else if (message.type === "duplicatesCleared") {
      // Explicit whole-notebook clear -- posted when "Detect duplicate
      // cells" is turned off via AI Settings, so existing highlights
      // disappear immediately rather than lingering until the next cell
      // edit/execution happens to touch a flagged group.
      activeDuplicateGroups = [];
      displayAllCells(allCells);
    } else if (message.type === "cellsReordered") {
      const orderedIds = message.data.cellIds;
      const cellMap = new Map(allCells.map((c) => [c.cellId, c]));
      allCells = orderedIds
        .map((id) => cellMap.get(id))
        .filter((c) => c !== undefined);
      displayAllCells(allCells);
    } else if (message.type === "summarySaved") {
      updateCellDetails(
        message.data.cellId,
        message.data.label,
        message.data.summary,
      );
    } else if (message.type === "summarySaveError") {
      setSummaryEditorStatus(
        message.data.cellId,
        message.data.error || "Failed to save summary.",
        true,
      );
    } else if (message.type === "summarySuggestion") {
      showSummarySuggestion(
        message.data.cellId,
        message.data.label,
        message.data.summary,
      );
    } else if (message.type === "summarySuggestionError") {
      setSummaryEditorStatus(
        message.data.cellId,
        message.data.error || "Failed to generate AI suggestion.",
        true,
      );
    } else if (message.type === "focusSearch") {
      elements.searchInput.focus();
      elements.searchInput.select();
      showDefaultView();
    } else if (message.type === "replaceAllComplete") {
      recentlyReplacedCellIds = new Set(message.data.cellIds || []);
      setReplaceInFlight(false);
      refreshKeywordSearch(false);
    } else if (message.type === "replaceAllError") {
      setReplaceInFlight(false);
      refreshKeywordSearch(false);
    } else if (message.type === "aiSettingsLoaded") {
      applyAiSettingsToForm(message.data);
    } else if (message.type === "aiSettingsSaved") {
      applyAiSettingsToForm(message.data.settings);
      setAiSettingsStatus("Saved.", false);
      setAiSettingsButtonsDisabled(false);
    } else if (message.type === "aiSettingsSaveError") {
      setAiSettingsStatus(message.error || "Failed to save settings.", true);
      setAiSettingsButtonsDisabled(false);
    } else if (message.type === "aiSettingsReset") {
      applyAiSettingsToForm(message.data);
      setAiSettingsStatus("Reset to defaults.", false);
      setAiSettingsButtonsDisabled(false);
    } else if (message.type === "aiSettingsResetError") {
      setAiSettingsStatus(message.error || "Failed to reset settings.", true);
      setAiSettingsButtonsDisabled(false);
    } else if (message.type === "aiSettingsLoadError") {
      setAiSettingsStatus(message.error || "Failed to load settings.", true);
    }
  });

  vscode?.postMessage({ type: "webviewReady" });
  // Loaded eagerly (not lazily on first expand) so the collapsed card is
  // already populated the moment the user opens it.
  vscode?.postMessage({ type: "getAiSettings" });
}

/** Show/hide the custom-model text field based on the current dropdown value. */
function updateCustomModelFieldVisibility() {
  if (!elements.aiSettingsModelSelect || !elements.aiSettingsCustomModelField)
    return;
  const isOther = elements.aiSettingsModelSelect.value === "other";
  elements.aiSettingsCustomModelField.style.display = isOther
    ? "flex"
    : "none";
}

/** Hydrate every AI Settings form field from a BackendAiSettingsResponse-shaped object. */
function applyAiSettingsToForm(settings) {
  if (!settings) return;

  if (elements.aiSettingsApiKeyInput) {
    // The backend never echoes the raw key back (see has_api_key-only
    // response shape) -- a saved key is represented as a placeholder so the
    // field visibly reflects "a key is set" without exposing or requiring
    // re-entry of the real value on every load.
    elements.aiSettingsApiKeyInput.value = settings.has_api_key
      ? AI_SETTINGS_KEY_PLACEHOLDER
      : "";
  }

  if (elements.aiSettingsModelSelect) {
    const model = settings.model || "gemini-2.5-flash-lite";
    elements.aiSettingsModelSelect.value = AI_SETTINGS_KNOWN_MODELS.includes(
      model,
    )
      ? model
      : "other";
  }

  if (elements.aiSettingsCustomModelInput) {
    elements.aiSettingsCustomModelInput.value = settings.custom_model || "";
  }

  updateCustomModelFieldVisibility();

  if (elements.aiSettingsDetectStaleCheckbox) {
    elements.aiSettingsDetectStaleCheckbox.checked = Boolean(
      settings.detect_stale_cells,
    );
  }
  if (elements.aiSettingsDetectDuplicateCheckbox) {
    elements.aiSettingsDetectDuplicateCheckbox.checked = Boolean(
      settings.detect_duplicate_cells,
    );
  }
  if (elements.aiSettingsDetectDeadCheckbox) {
    elements.aiSettingsDetectDeadCheckbox.checked = Boolean(
      settings.detect_dead_cells,
    );
  }
}

function setAiSettingsStatus(message, isError) {
  if (!elements.aiSettingsStatus) return;
  elements.aiSettingsStatus.textContent = message;
  elements.aiSettingsStatus.classList.toggle("summary-error", isError);
}

function setAiSettingsButtonsDisabled(disabled) {
  if (elements.aiSettingsSaveButton)
    elements.aiSettingsSaveButton.disabled = disabled;
  if (elements.aiSettingsResetButton)
    elements.aiSettingsResetButton.disabled = disabled;
}

function saveAiSettings() {
  if (!elements.aiSettingsModelSelect) return;

  const model = elements.aiSettingsModelSelect.value;
  const apiKeyValue = elements.aiSettingsApiKeyInput?.value ?? "";
  // Only forward a real api key when the user actually typed a new one --
  // an unchanged placeholder must never be sent (it isn't a real key and
  // would overwrite the stored one with garbage), and an empty field means
  // "leave the currently-saved key untouched" per backendClient.ts's
  // documented contract for an omitted/undefined api_key.
  const apiKey =
    apiKeyValue && apiKeyValue !== AI_SETTINGS_KEY_PLACEHOLDER
      ? apiKeyValue
      : undefined;

  setAiSettingsButtonsDisabled(true);
  setAiSettingsStatus("Saving...", false);

  vscode?.postMessage({
    type: "saveAiSettings",
    data: {
      apiKey,
      model,
      customModel:
        model === "other"
          ? (elements.aiSettingsCustomModelInput?.value.trim() ?? "")
          : null,
      detectStaleCells: Boolean(
        elements.aiSettingsDetectStaleCheckbox?.checked,
      ),
      detectDuplicateCells: Boolean(
        elements.aiSettingsDetectDuplicateCheckbox?.checked,
      ),
      detectDeadCells: Boolean(elements.aiSettingsDetectDeadCheckbox?.checked),
    },
  });
}

function resetAiSettings() {
  setAiSettingsButtonsDisabled(true);
  setAiSettingsStatus("Resetting...", false);
  vscode?.postMessage({ type: "resetAiSettings" });
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
    resetMatchNavigation();
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
  if (isWholeWord) pattern = `\\b(?:${pattern})\\b`;
  return new RegExp(pattern, isCaseSensitive ? "gm" : "gim");
}

function partitionKeywordResults(cells, regex, replacedIds) {
  const matches = cells.filter((cell) => {
    regex.lastIndex = 0;
    return regex.test(cell.cellContent || "");
  });

  const matchedIds = new Set(matches.map((cell) => cell.cellId));
  const replacedCells = cells.filter(
    (cell) => replacedIds.has(cell.cellId) && !matchedIds.has(cell.cellId),
  );

  return { matches, replacedCells };
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

  const { matches, replacedCells } = partitionKeywordResults(
    allCells,
    regex,
    recentlyReplacedCellIds,
  );

  lastKeywordCells = matches;
  lastKeywordRegex = regex;

  displayKeywordResults(matches, query, regex, replacedCells);
}

/** Re-run keyword search if the toggle state changes while results are shown. */
function refreshKeywordSearch(resetNavigation = true) {
  if (lastSearchMode !== "keyword") return;
  if (resetNavigation) resetMatchNavigation();
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

function containsUppercaseCharacter(target) {
  if (!target) return false;
  return target.toLowerCase() !== target;
}

function hasMatchingSegments(matchedText, pattern, specialCharacter) {
  const bothContain =
    matchedText.indexOf(specialCharacter) !== -1 &&
    pattern.indexOf(specialCharacter) !== -1;
  return (
    bothContain &&
    matchedText.split(specialCharacter).length ===
      pattern.split(specialCharacter).length
  );
}

function buildReplaceStringForSegments(matchedText, pattern, specialCharacter) {
  const patternSegments = pattern.split(specialCharacter);
  const matchSegments = matchedText.split(specialCharacter);
  return patternSegments
    .map((segment, i) =>
      buildReplaceStringWithCasePreserved(matchSegments[i], segment),
    )
    .join(specialCharacter);
}

function buildReplaceStringWithCasePreserved(matchedText, pattern) {
  if (!matchedText) return pattern;

  const hyphenSegments = hasMatchingSegments(matchedText, pattern, "-");
  const underscoreSegments = hasMatchingSegments(matchedText, pattern, "_");
  if (hyphenSegments && !underscoreSegments) {
    return buildReplaceStringForSegments(matchedText, pattern, "-");
  }
  if (!hyphenSegments && underscoreSegments) {
    return buildReplaceStringForSegments(matchedText, pattern, "_");
  }

  if (matchedText.toUpperCase() === matchedText) {
    return pattern.toUpperCase();
  }
  if (matchedText.toLowerCase() === matchedText) {
    return pattern.toLowerCase();
  }
  if (containsUppercaseCharacter(matchedText[0]) && pattern.length > 0) {
    return pattern[0].toUpperCase() + pattern.substr(1);
  }
  if (!containsUppercaseCharacter(matchedText[0]) && pattern.length > 0) {
    return pattern[0].toLowerCase() + pattern.substr(1);
  }
  return pattern;
}

function computeReplacedContent(text, regex, replacement, preserveCase) {
  regex.lastIndex = 0;
  return text.replace(regex, (matchedText) =>
    preserveCase
      ? buildReplaceStringWithCasePreserved(matchedText, replacement)
      : replacement,
  );
}

let replaceInFlightTimeout = null;

function setReplaceInFlight(inFlight) {
  isReplaceInFlight = inFlight;
  if (elements.replaceOneButton) elements.replaceOneButton.disabled = inFlight;
  if (elements.replaceAllButton) elements.replaceAllButton.disabled = inFlight;
  if (elements.replaceAllConfirmButton)
    elements.replaceAllConfirmButton.disabled = inFlight;

  clearTimeout(replaceInFlightTimeout);
  if (inFlight) {
    replaceInFlightTimeout = setTimeout(() => setReplaceInFlight(false), 5000);
  }
}

function findAllMatchesFlat(cells, regex) {
  const matches = [];
  for (const cell of cells) {
    const text = cell.cellContent || "";
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        cellId: cell.cellId,
        start: match.index,
        end: match.index + match[0].length,
      });
      if (match[0].length === 0) regex.lastIndex++;
    }
  }
  return matches;
}

function replaceOneMatch(text, start, end, replacement, preserveCase) {
  const matchedText = text.slice(start, end);
  const replacementText = preserveCase
    ? buildReplaceStringWithCasePreserved(matchedText, replacement)
    : replacement;
  return text.slice(0, start) + replacementText + text.slice(end);
}

function handleReplaceOne() {
  if (isReplaceInFlight) return;
  if (!lastKeywordRegex || lastKeywordCells.length === 0) return;

  const matches = findAllMatchesFlat(lastKeywordCells, lastKeywordRegex);
  if (matches.length === 0) return;

  const index =
    ((currentMatchIndex % matches.length) + matches.length) % matches.length;
  const match = matches[index];
  const cell = lastKeywordCells.find((c) => c.cellId === match.cellId);
  const replacement = elements.replaceInput.value;
  const newContent = replaceOneMatch(
    cell.cellContent || "",
    match.start,
    match.end,
    replacement,
    isPreserveCase,
  );

  if (newContent === cell.cellContent) return;

  setReplaceInFlight(true);
  vscode?.postMessage({
    type: "replaceAll",
    replacements: [{ cellId: match.cellId, newContent }],
  });
}

function handleReplace() {
  if (isReplaceInFlight) return;
  if (!lastKeywordRegex || lastKeywordCells.length === 0) return;

  const replacement = elements.replaceInput.value;
  const replacements = lastKeywordCells
    .map((cell) => ({
      cellId: cell.cellId,
      newContent: computeReplacedContent(
        cell.cellContent || "",
        lastKeywordRegex,
        replacement,
        isPreserveCase,
      ),
    }))
    .filter((r) => r.newContent !== allCells.find((c) => c.cellId === r.cellId)?.cellContent);

  if (replacements.length === 0) return;

  setReplaceInFlight(true);
  vscode?.postMessage({ type: "replaceAll", replacements });
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
 * Maps a cell's summary origin ("ai" | "human") to the badge class/title
 * shown in the card header. Cards with no origin concept (keyword matches)
 * pass cellOrigin as undefined and simply get no badge.
 */
function getOriginIconMeta(origin) {
  return origin === "human"
    ? { className: "origin-human", title: "Edited by you" }
    : { className: "origin-ai", title: "AI generated" };
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
  cellLabelHtml,
  metaHtml,
  descriptionHtml,
  cellIcon,
  cellOrigin,
  extraClass,
}) {
  const card = document.createElement("div");
  card.className = `result-card ${extraClass}`;
  card.dataset.cellId = cellId;
  card.title = `Go to ${cellLabel}`;

  const originMeta = cellOrigin !== undefined ? getOriginIconMeta(cellOrigin) : null;
  const originBadgeHtml = originMeta
    ? `<span class="cell-origin-icon ${originMeta.className}" title="${originMeta.title}"></span>`
    : "";

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cellIcon)}" alt="${cellIcon}" class="cell-icon icon-16" />
      <div class="card-label-group">
        ${metaHtml ? `<div class="card-meta">${metaHtml}</div>` : ""}
        <span class="cell-label">${cellLabelHtml}</span>
      </div>
      <div class="card-toggle-group">
        ${originBadgeHtml}
        <button class="card-toggle-btn" title="More Info">
          <img src="${ICONS_URI}/dropdown_icon.svg" alt="" class="chevron-icon icon-16" />
        </button>
      </div>
    </div>
    ${descriptionHtml ?? ""}
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
  const group = getDuplicateGroup(cell.cellId);
  const deadInfo = deadCellsById.get(cell.cellId) ?? null;
  const staleInfo = staleCellsById.get(cell.cellId) ?? null;

  const classes = [extraClass];
  if (group) {
    classes.push("duplicate-flagged");
  }
  if (deadInfo) {
    classes.push("dead-flagged");
  }
  // Staleness is shown by greying the card out (see .stale-flagged in the
  // stylesheet) rather than a border + banner — the cell isn't wrong, its
  // output is just out of date and needs a re-run.
  if (staleInfo) {
    classes.push("stale-flagged");
  }

  const card = createCardElement({
    cellId: cell.cellId,
    cellLabel: cell.cellLabel,
    cellLabelHtml: escapeHtml(cell.cellLabel),
    descriptionHtml: createSummaryEditorHtml(cell),
    cellIcon: cell.cellIcon,
    cellOrigin: cell.cellOrigin ?? "ai",
    extraClass: classes.filter(Boolean).join(" "),
  });

  attachSummaryEditor(card, cell);

  if (group) {
    attachDuplicateBanner(card, cell.cellId, group);
  }

  if (deadInfo) {
    attachDeadCellBanner(card, deadInfo);
  }

  if (staleInfo) {
    attachStaleCellNote(card, staleInfo);
  }

  return card;
}

function buildPreviewWindow(text, maxLines = 5) {
  const lines = text.split("\n");
  const end = Math.min(maxLines - 1, lines.length - 1);
  return {
    windows: [{ start: 0, end, matchLines: new Set() }],
    lines,
    totalMatches: 0,
    hiddenWindows: 0,
  };
}

function createKeywordCard(cell, regex, wasReplaced = false) {
  const { windows, lines, totalMatches, hiddenWindows } = wasReplaced
    ? buildPreviewWindow(cell.cellContent || "")
    : findMatchWindows(cell.cellContent || "", regex);

  const matchLabel = wasReplaced
    ? "replaced"
    : `${totalMatches} match${totalMatches !== 1 ? "es" : ""}`;

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
    cellLabelHtml: escapeHtml(cell.cellLabel),
    metaHtml: `<span class="keyword-badge">keyword</span><span class="match-count-badge">${matchLabel}</span>`,
    descriptionHtml: `<div class="card-description"><div class="match-windows">${windowsHtml}</div></div>`,
    cellIcon: cell.cellIcon,
    extraClass: wasReplaced
      ? "keyword-match replaced-match expanded"
      : "keyword-match expanded",
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

function displayKeywordResults(cells, query, regex, replacedCells = []) {
  elements.topResultsContainer.innerHTML = "";
  setKeywordSectionTitle();

  if (cells.length === 0 && replacedCells.length === 0) {
    elements.topResultsContainer.innerHTML = `<p class="no-results">No cells contain <em>${escapeHtml(query)}</em></p>`;
  } else {
    cells.forEach((cell) => {
      elements.topResultsContainer.appendChild(createKeywordCard(cell, regex));
    });
    replacedCells.forEach((cell) => {
      elements.topResultsContainer.appendChild(
        createKeywordCard(cell, regex, true),
      );
    });
  }

  elements.otherResults.style.display = "none";
}

/**
 * Enrich each result with cached cell data (label/description/icon) looked
 * up from `allCells`, then render a card for it into `container`.
 */
function renderCellList(container, results, extraClass) {
  container.innerHTML = "";
  results.forEach((result) => {
    const stored = allCells.find((c) => c.cellId === result.cellId);
    const enriched = { ...result, ...stored };
    container.appendChild(createCellCard(enriched, extraClass));
  });
}

function displayResults(data) {
  hideLoading();
  setReplaceVisible(false);

  if (elements.topResultsSectionTitle) {
    elements.topResultsSectionTitle.innerHTML = `Top Matches <span class="mode-badge semantic-mode">semantic search</span>`;
  }

  renderCellList(
    elements.topResultsContainer,
    data.queryCellsList,
    "semantic-match",
  );

  if (data.otherCellsList?.length > 0) {
    renderCellList(
      elements.otherResultsContainer,
      data.otherCellsList,
      "default",
    );
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

/**
 * Snapshot every currently-open summary editor panel (label/summary text,
 * any pending AI suggestion, and status line) before a full re-render wipes
 * the DOM out from under it.
 *
 * displayAllCells is called constantly for reasons that have nothing to do
 * with the cell a person is actively editing -- an unrelated cell's
 * execution, a whole-notebook advisor re-scan, another cell being deleted,
 * a reorder. None of those should be able to silently discard someone's
 * half-written summary edit just because it happened to be open when the
 * re-render fired. Restored by restoreOpenEditorStates after the cards are
 * rebuilt.
 */
function captureOpenEditorStates() {
  const states = new Map();

  document.querySelectorAll(".summary-editor").forEach((editor) => {
    const panel = editor.querySelector(".summary-edit-panel");
    const cellId = editor.dataset.cellId;
    if (!panel || !cellId || panel.style.display === "none") return;

    const labelInput = editor.querySelector(".summary-label-input");
    const textarea = editor.querySelector(".summary-textarea");
    const suggestion = editor.querySelector(".summary-suggestion");
    const suggestionText = editor.querySelector(".summary-suggestion-text");
    const status = editor.querySelector(".summary-status");

    states.set(cellId, {
      label: labelInput ? labelInput.value : "",
      summary: textarea ? textarea.value : "",
      suggestionVisible: suggestion
        ? suggestion.style.display !== "none"
        : false,
      suggestedLabel: suggestion ? suggestion.dataset.suggestedLabel : "",
      suggestionText: suggestionText ? suggestionText.textContent : "",
      statusText: status ? status.textContent : "",
      statusIsError: status
        ? status.classList.contains("summary-error")
        : false,
    });
  });

  return states;
}

/** Reopen and refill any editor panels captured by captureOpenEditorStates. */
function restoreOpenEditorStates(states) {
  if (!states || states.size === 0) return;

  states.forEach((state, cellId) => {
    const editor = document.querySelector(
      `.summary-editor[data-cell-id="${cssEscape(cellId)}"]`,
    );
    if (!editor) return; // The cell no longer exists (e.g. it was deleted).

    const display = editor.querySelector(".summary-display");
    const panel = editor.querySelector(".summary-edit-panel");
    const labelInput = editor.querySelector(".summary-label-input");
    const textarea = editor.querySelector(".summary-textarea");
    const suggestion = editor.querySelector(".summary-suggestion");
    const suggestionText = editor.querySelector(".summary-suggestion-text");
    const status = editor.querySelector(".summary-status");
    if (!display || !panel) return;

    display.style.display = "none";
    panel.style.display = "block";
    if (labelInput) labelInput.value = state.label;
    if (textarea) textarea.value = state.summary;
    if (suggestion) {
      suggestion.style.display = state.suggestionVisible ? "block" : "none";
      if (state.suggestedLabel) {
        suggestion.dataset.suggestedLabel = state.suggestedLabel;
      }
    }
    if (suggestionText) suggestionText.textContent = state.suggestionText;
    if (status) {
      status.textContent = state.statusText;
      status.classList.toggle("summary-error", state.statusIsError);
    }
  });
}

function displayAllCells(cells) {
  if (summaryViewMode === "inline") {
    elements.allCellsContainer.innerHTML = "";
    return;
  }

  const editorState = captureOpenEditorStates();
  elements.allCellsContainer.innerHTML = "";

  if (!cells.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No code cells indexed yet.";
    elements.allCellsContainer.appendChild(emptyState);
    return;
  }

  cells.forEach((cell) => {
    elements.allCellsContainer.appendChild(createCellCard(cell, "default"));
  });

  restoreOpenEditorStates(editorState);
}

function setSummaryViewMode(mode, notifyExtension) {
  summaryViewMode = mode === "inline" ? "inline" : "sidebar";

  const isInline = summaryViewMode === "inline";
  elements.sidebarSummaryViewButton?.classList.toggle("active", !isInline);
  elements.inlineSummaryViewButton?.classList.toggle("active", isInline);
  elements.sidebarSummaryViewButton?.setAttribute(
    "aria-pressed",
    String(!isInline),
  );
  elements.inlineSummaryViewButton?.setAttribute(
    "aria-pressed",
    String(isInline),
  );

  if (elements.inlineSummaryNote) {
    elements.inlineSummaryNote.style.display = isInline ? "block" : "none";
  }

  if (elements.allCellsContainer) {
    elements.allCellsContainer.style.display = isInline ? "none" : "flex";
    if (!isInline) {
      displayAllCells(allCells);
    }
  }

  if (notifyExtension) {
    vscode?.postMessage({
      type: "setSummaryViewMode",
      mode: summaryViewMode,
    });
  }
}

function handleCellClick(cellId) {
  vscode?.postMessage({ type: "jumpToCell", cellId });
}

// ---------------------------------------------------------------------------
// Duplicate detection helpers
// ---------------------------------------------------------------------------

/** Return the first active duplicate group that contains cellId, or null. */
function getDuplicateGroup(cellId) {
  return activeDuplicateGroups.find((g) => g.includes(cellId)) ?? null;
}

/** Remove all active groups that contain cellId. */
function clearDuplicateGroupsForCell(cellId) {
  activeDuplicateGroups = activeDuplicateGroups.filter(
    (g) => !g.includes(cellId),
  );
}

/** Dismiss a group and re-render the default view without it. */
function ignoreDuplicateGroup(group) {
  activeDuplicateGroups = activeDuplicateGroups.filter((g) => g !== group);
  displayAllCells(allCells);
}

/**
 * Append an amber duplicate banner to a card.
 * The banner shows how many other similar cells exist and provides
 * "Navigate" (jump to the next one) and "Ignore" (dismiss the group) buttons.
 */
function attachDuplicateBanner(card, cellId, group) {
  const otherCount = group.length;
  const banner = document.createElement("div");
  banner.className = "duplicate-banner";
  banner.innerHTML = `
    <span class="duplicate-icon">⚠</span>
    <span class="duplicate-label">Possible duplicates: ${otherCount} similar cell${otherCount !== 1 ? "s" : ""}</span>
    <div class="duplicate-actions">
      <button class="duplicate-ignore-btn" title="Dismiss this notification">Ignore</button>
    </div>
  `;

  banner
    .querySelector(".duplicate-ignore-btn")
    .addEventListener("click", (e) => {
      e.stopPropagation();
      ignoreDuplicateGroup(group);
    });

  card.appendChild(banner);
}

// ---------------------------------------------------------------------------
// Dead-cell detection helpers
// ---------------------------------------------------------------------------

/** Dismiss a single dead-cell flag and re-render the default view. */
function ignoreDeadCell(cellId) {
  deadCellsById.delete(cellId);
  displayAllCells(allCells);
}

/**
 * Append a "possibly dead code" banner to a card. Advisory only: it
 * surfaces the analyzer's reason (which names are unused) and lets the
 * user dismiss it. It never deletes or modifies the cell.
 */
function attachDeadCellBanner(card, deadInfo) {
  const banner = document.createElement("div");
  banner.className = "dead-banner";

  const names = deadInfo.unused_names || [];
  const label =
    names.length > 0
      ? `Possibly dead code: ${names.map((n) => escapeHtml(n)).join(", ")} unused elsewhere`
      : "Possibly dead code";

  banner.innerHTML = `
    <span class="dead-icon">🩹</span>
    <span class="dead-label" title="${escapeHtml(deadInfo.reason || "")}">${label}</span>
    <div class="dead-actions">
      <button class="dead-ignore-btn" title="Dismiss this notification">Ignore</button>
    </div>
  `;

  banner.querySelector(".dead-ignore-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    ignoreDeadCell(deadInfo.cell_id);
  });

  card.appendChild(banner);
}

// ---------------------------------------------------------------------------
// Stale-cell detection helpers
// ---------------------------------------------------------------------------

/**
 * Append a subtle "needs re-run" note to a stale card. Deliberately NOT a
 * bordered banner like dead code / duplicates: staleness is conveyed by
 * greying the whole card out (.stale-flagged), and this note is just a
 * quiet caption explaining why, with the analyzer's full reason on hover.
 * There is no dismiss action — re-running the cell is what clears it.
 */
function attachStaleCellNote(card, staleInfo) {
  const note = document.createElement("div");
  note.className = "stale-note";
  note.title = staleInfo.reason || "";
  note.innerHTML = `
    <span class="stale-icon">↻</span>
    <span class="stale-label">Output may be out of date — re-run this cell</span>
  `;
  card.appendChild(note);
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

function createSummaryEditorHtml(cell) {
  const label = cell.cellLabel ?? "";
  const summary = cell.cellDescription ?? "";

  return `
    <div class="card-description summary-editor" data-cell-id="${escapeHtml(cell.cellId)}">
      <div class="summary-display" title="Click to edit summary">${escapeHtml(summary)}</div>
      <div class="summary-edit-panel" style="display: none">
        <input class="summary-label-input" type="text" value="${escapeHtml(label)}" />
        <textarea class="summary-textarea" rows="4">${escapeHtml(summary)}</textarea>
        <div class="summary-suggestion" style="display: none">
          <div class="summary-suggestion-text"></div>
          <div class="summary-suggestion-actions">
            <button class="summary-accept-btn" type="button">Accept</button>
            <button class="summary-reject-btn" type="button">Reject</button>
          </div>
        </div>
        <div class="summary-actions">
          <span class="summary-status"></span>
          <button class="summary-ai-btn" type="button">Generate new AI suggestion</button>
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
  const labelInput = card.querySelector(".summary-label-input");
  const textarea = card.querySelector(".summary-textarea");
  const suggestion = card.querySelector(".summary-suggestion");
  const suggestionText = card.querySelector(".summary-suggestion-text");
  const acceptButton = card.querySelector(".summary-accept-btn");
  const rejectButton = card.querySelector(".summary-reject-btn");
  const aiButton = card.querySelector(".summary-ai-btn");
  const saveButton = card.querySelector(".summary-save-btn");

  if (
    !editor ||
    !display ||
    !panel ||
    !labelInput ||
    !textarea ||
    !suggestion ||
    !suggestionText ||
    !acceptButton ||
    !rejectButton ||
    !aiButton ||
    !saveButton
  )
    return;

  // Tracks whether the content currently sitting in the editor is
  // AI-authored or hand-typed. Starts from the cell's last known state;
  // flips to "human" only on real keystrokes (the "input" event doesn't
  // fire for the programmatic value assignment the accept handler does).
  let pendingOrigin = cell.cellOrigin === "human" ? "human" : "ai";

  editor.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  display.addEventListener("click", (event) => {
    event.stopPropagation();
    display.style.display = "none";
    panel.style.display = "block";
    labelInput.focus();
  });

  labelInput.addEventListener("input", () => {
    pendingOrigin = "human";
  });

  textarea.addEventListener("input", () => {
    pendingOrigin = "human";
  });

  saveButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const label = labelInput.value.trim();
    const summary = textarea.value.trim();
    saveButton.disabled = true;
    setSummaryEditorStatus(cell.cellId, "Saving...", false);
    pendingSummaryOrigin.set(cell.cellId, pendingOrigin);
    vscode?.postMessage({
      type: "saveSummary",
      cellId: cell.cellId,
      label,
      summary,
      origin: pendingOrigin,
    });
  });

  aiButton.addEventListener("click", (event) => {
    event.stopPropagation();
    aiButton.disabled = true;
    setSummaryEditorStatus(cell.cellId, "Generating AI suggestion...", false);
    vscode?.postMessage({
      type: "suggestSummary",
      cellId: cell.cellId,
    });
  });

  acceptButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const suggestionValue = suggestionText.textContent.trim();
    if (suggestionValue) {
      textarea.value = suggestionValue;
    }
    const suggestedLabel = suggestion.dataset.suggestedLabel;
    if (suggestedLabel) {
      labelInput.value = suggestedLabel;
    }
    pendingOrigin = "ai";
    suggestion.style.display = "none";
    setSummaryEditorStatus(cell.cellId, "AI suggestion accepted.", false);
  });

  rejectButton.addEventListener("click", (event) => {
    event.stopPropagation();
    suggestion.style.display = "none";
    suggestionText.textContent = "";
    delete suggestion.dataset.suggestedLabel;
    setSummaryEditorStatus(cell.cellId, "AI suggestion rejected.", false);
  });
}

function updateCellDetails(cellId, label, summary) {
  const origin = pendingSummaryOrigin.get(cellId) ?? "ai";
  pendingSummaryOrigin.delete(cellId);

  allCells = allCells.map((cell) =>
    cell.cellId === cellId
      ? { ...cell, cellLabel: label, cellDescription: summary, cellOrigin: origin }
      : cell,
  );

  document
    .querySelectorAll(`.result-card[data-cell-id="${cssEscape(cellId)}"]`)
    .forEach((card) => {
      const labelElement = card.querySelector(".cell-label");
      if (labelElement) labelElement.textContent = label;

      const originIcon = card.querySelector(".cell-origin-icon");
      if (originIcon) {
        const meta = getOriginIconMeta(origin);
        originIcon.className = `cell-origin-icon ${meta.className}`;
        originIcon.title = meta.title;
      }
    });

  document
    .querySelectorAll(`.summary-editor[data-cell-id="${cssEscape(cellId)}"]`)
    .forEach((editor) => {
      const display = editor.querySelector(".summary-display");
      const panel = editor.querySelector(".summary-edit-panel");
      const labelInput = editor.querySelector(".summary-label-input");
      const textarea = editor.querySelector(".summary-textarea");
      const saveButton = editor.querySelector(".summary-save-btn");
      const aiButton = editor.querySelector(".summary-ai-btn");

      if (display) {
        display.textContent = summary;
        display.style.display = "block";
      }

      if (labelInput) labelInput.value = label;
      if (textarea) textarea.value = summary;
      if (panel) panel.style.display = "none";
      if (saveButton) saveButton.disabled = false;
      if (aiButton) aiButton.disabled = false;

      setSummaryEditorStatus(cellId, "Saved.", false);
    });
}

function showSummarySuggestion(cellId, label, summary) {
  document
    .querySelectorAll(`.summary-editor[data-cell-id="${cssEscape(cellId)}"]`)
    .forEach((editor) => {
      const suggestion = editor.querySelector(".summary-suggestion");
      const suggestionText = editor.querySelector(".summary-suggestion-text");
      const aiButton = editor.querySelector(".summary-ai-btn");

      if (suggestion) suggestion.dataset.suggestedLabel = label ?? "";
      if (suggestion && suggestionText) {
        suggestionText.textContent = summary || "No AI summary was generated.";
        suggestion.style.display = "block";
      }
      if (aiButton) aiButton.disabled = false;

      setSummaryEditorStatus(cellId, "AI suggestion ready.", false);
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
      const aiButton = editor.querySelector(".summary-ai-btn");
      if (aiButton && isError) aiButton.disabled = false;
    });
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    classifyQuery,
    buildSearchRegex,
    partitionKeywordResults,
    findMatchWindows,
    highlightAndEscape,
    escapeHtml,
    buildReplaceStringWithCasePreserved,
    computeReplacedContent,
    findAllMatchesFlat,
    replaceOneMatch,
    setToggleState: (state) => {
      if ("caseSensitive" in state) isCaseSensitive = state.caseSensitive;
      if ("wholeWord" in state) isWholeWord = state.wholeWord;
      if ("regex" in state) isRegex = state.regex;
      if ("preserveCase" in state) isPreserveCase = state.preserveCase;
    },
  };
}

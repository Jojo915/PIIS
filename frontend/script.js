const vscode =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;
const ICONS_URI = document.body?.dataset.iconsUri ?? "../icons";

const elements = {
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  clearButton: document.getElementById("clearButton"),
  searchInlineOptions: document.getElementById("searchInlineOptions"),
  loadingState: document.getElementById("loadingState"),
  searchErrorState: document.getElementById("searchErrorState"),
  searchErrorMessage: document.getElementById("searchErrorMessage"),
  defaultSection: document.getElementById("defaultSection"),
  allCellsContainer: document.getElementById("allCellsContainer"),
  resultsSection: document.getElementById("resultsSection"),
  exactResultsContainer: document.getElementById("exactResultsContainer"),
  topResultsContainer: document.getElementById("topResultsContainer"),
  mediumResultsContainer: document.getElementById("mediumResultsContainer"),
  lowResultsContainer: document.getElementById("lowResultsContainer"),
  replaceToggleButton: document.getElementById("replaceToggleButton"),
  replaceRow: document.getElementById("replaceRow"),
  replaceInput: document.getElementById("replaceInput"),
};
let allCells = [];

function init() {
  elements.searchButton.addEventListener("click", handleSearch);
  elements.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch();
  });
  elements.searchInput.addEventListener("input", () => {
    const hasText = elements.searchInput.value.length > 0;
    elements.clearButton.style.display = hasText ? "flex" : "none";
    elements.searchInlineOptions.style.display = hasText ? "flex" : "none";
  });
  elements.clearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    elements.clearButton.style.display = "none";
    elements.searchInlineOptions.style.display = "none";
    showDefaultView();
  });
  elements.searchInput.focus();

  elements.replaceToggleButton.addEventListener("click", () => {
    const isExpanded = elements.replaceToggleButton.classList.toggle("expanded");
    elements.replaceRow.style.display = isExpanded ? "flex" : "none";
    elements.replaceToggleButton.setAttribute("aria-expanded", String(isExpanded));
  });
  elements.replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleReplace();
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "searchResult") {
      displayResults(message.data);
    } else if (message.type === "searchError") {
      showError(message.error);
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

function handleSearch() {
  const query = elements.searchInput.value.trim();
  if (!query) {
    showDefaultView();
    return;
  }
  elements.defaultSection.style.display = "none";
  showLoading();
  vscode?.postMessage({ type: "search", query });
}

function showDefaultView() {
  elements.loadingState.style.display = "none";
  elements.searchErrorState.style.display = "none";
  elements.resultsSection.style.display = "none";
  elements.defaultSection.style.display = "block";
}

function showLoading() {
  elements.searchErrorState.style.display = "none";
  elements.resultsSection.style.display = "none";
  elements.loadingState.style.display = "flex";
}

function hideLoading() {
  elements.loadingState.style.display = "none";
  elements.searchErrorState.style.display = "none";
  elements.resultsSection.style.display = "block";
}

function showError(message) {
  elements.loadingState.style.display = "none";
  elements.resultsSection.style.display = "none";
  elements.defaultSection.style.display = "none";
  elements.searchErrorMessage.textContent = message || "Something went wrong while searching.";
  elements.searchErrorState.style.display = "flex";
}

function displayAllCells(cells) {
  cells.forEach((cell) => {
    elements.allCellsContainer.appendChild(createDefaultCard(cell));
  });
}

function enrichResult(result) {
  const stored = allCells.find((c) => c.cellId === result.cellId);
  return {
    ...result,
    ...stored,
    score: result.score,
    distance: result.distance,
  };
}

function renderResultGroup(container, results) {
  container.innerHTML = "";
  if (results.length === 0) {
    container.innerHTML = '<p class="empty-message">No matches.</p>';
    return;
  }
  const sorted = [...results].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  sorted.forEach((result) => {
    container.appendChild(createResultCard(enrichResult(result)));
  });
}

function displayResults(data) {
  hideLoading();
  const allResults = [...data.queryCellsList, ...(data.otherCellsList ?? [])];
  const exactMatches = allResults.filter((r) => r.matchType === "exact");
  const semanticMatches = allResults.filter((r) => r.matchType !== "exact");

  renderResultGroup(elements.exactResultsContainer, exactMatches);
  renderResultGroup(
    elements.topResultsContainer,
    semanticMatches.filter((r) => getRelevanceInfo(r.score) === "high-relevance"),
  );
  renderResultGroup(
    elements.mediumResultsContainer,
    semanticMatches.filter((r) => getRelevanceInfo(r.score) === "medium-relevance"),
  );
  renderResultGroup(
    elements.lowResultsContainer,
    semanticMatches.filter((r) => getRelevanceInfo(r.score) === "low-relevance"),
  );
}

function createDefaultCard(cell) {
  const card = document.createElement("div");
  const label = cell.cellLabel ?? "Unknown Cell";
  card.className = "result-card default";
  card.dataset.cellId = cell.cellId;
  card.title = `Go to ${label}`;

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cell.cellIcon)}" alt="${cell.cellIcon ?? "cell"}" class="cell-icon" />
      <div class="card-label-group">
        <div class="card-meta">
          <span class="cell-id">[${cell.cellId}]</span>
        </div>
        <span class="cell-label">${label}</span>
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
  const cls = getRelevanceInfo(cell.score);
  const label = cell.cellLabel ?? "Unknown Cell";
  card.className = `result-card ${cls}`;
  card.dataset.cellId = cell.cellId;
  card.title = `Go to ${label}`;

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cell.cellIcon)}" alt="${cell.cellIcon ?? "cell"}" class="cell-icon" />
      <div class="card-label-group">
        <div class="card-meta">
          <span class="cell-id">[${cell.cellId}]</span>
        </div>
        <span class="cell-label">${label}</span>
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

function handleReplace() {
  // No-op: lexical search/replace doesn't exist on the backend yet, so there's
  // nothing to actually replace. Wired up so Enter behaves like VS Code's
  // find/replace widget once that exists.
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

// Provisional — calibrated against today's embedding model (all-MiniLM-L6-v2) and
// distance formula (see score computation in webviewProvider.ts). Recalibrate
// against real score data once the backend swaps embedding models.
const HIGH_RELEVANCE_THRESHOLD = 0.8;
const MEDIUM_RELEVANCE_THRESHOLD = 0.5;

function getRelevanceInfo(score) {
  if (score >= HIGH_RELEVANCE_THRESHOLD) return "high-relevance";
  if (score >= MEDIUM_RELEVANCE_THRESHOLD) return "medium-relevance";
  return "low-relevance";
}

document.addEventListener("DOMContentLoaded", init);

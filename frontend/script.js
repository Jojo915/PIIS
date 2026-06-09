const vscode =
  typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;
const ICONS_URI = document.body?.dataset.iconsUri ?? "../icons";

const elements = {
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  clearButton: document.getElementById("clearButton"),
  backButton: document.getElementById("backButton"),
  loadingState: document.getElementById("loadingState"),
  defaultSection: document.getElementById("defaultSection"),
  allCellsContainer: document.getElementById("allCellsContainer"),
  resultsSection: document.getElementById("resultsSection"),
  topResultsContainer: document.getElementById("topResultsContainer"),
  otherResultsContainer: document.getElementById("otherResultsContainer"),
  otherResults: document.getElementById("otherResults"),
  otherCellCount: document.getElementById("otherCellCount"),
};
let allCells = [];
const navigationStack = [];

function init() {
  elements.searchButton.addEventListener("click", handleSearch);
  elements.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch();
  });
  elements.searchInput.addEventListener("input", () => {
    const hasText = elements.searchInput.value.length > 0;
    elements.clearButton.style.display = hasText ? "flex" : "none";
  });
  elements.clearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    elements.clearButton.style.display = "none";
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
  elements.resultsSection.style.display = "none";
  elements.defaultSection.style.display = "block";
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

function displayResults(data) {
  hideLoading();
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
    <div class="card-description">${cell.cellDescription}</div>
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
    <div class="card-description">${cell.cellDescription}</div>
  `;

  card.querySelector(".card-toggle-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("expanded");
  });

  card.addEventListener("click", () => handleCellClick(cell.cellId));
  return card;
}

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

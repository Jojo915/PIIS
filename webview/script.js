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

const navigationStack = [];

function init() {
  elements.searchButton.addEventListener("click", handleSearch);
  elements.searchInput.addEventListener("keypress", (e) => {
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
  displayAllCells(mockAllCells);
}

function handleSearch() {
  const query = elements.searchInput.value.trim();
  if (!query) {
    showDefaultView();
    return;
  }
  elements.defaultSection.style.display = "none";
  showLoading();
  displayResults(mockSearchResults); // Week 2: replace with API call
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
  data.queryCellsList.forEach((cell) => {
    elements.topResultsContainer.appendChild(createResultCard(cell));
  });

  if (data.otherCellsList?.length > 0) {
    elements.otherResultsContainer.innerHTML = "";
    data.otherCellsList.forEach((cell) => {
      elements.otherResultsContainer.appendChild(createResultCard(cell));
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
  card.title = `Go to cell ${cell.cellId}`;

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cell.cellIcon)}" alt="${cell.cellIcon}" class="cell-icon" />
      <div class="card-label-group">
        <span class="cell-id">[${cell.cellId}]</span>
        <span class="cell-label">${cell.cellLabel}</span>
      </div>
      <button class="card-toggle-btn" title="More Info">
        <img src="../icons/dropdown_icon.svg" alt="" class="card-dropdown-icon" />
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
  card.title = `Go to cell ${cell.cellId}`;

  card.innerHTML = `
    <div class="card-header">
      <img src="${getIconPath(cell.cellIcon)}" alt="${cell.cellIcon}" class="cell-icon" />
      <div class="card-label-group">
        <div class="card-meta">
          <span class="cell-id">[${cell.cellId}]</span>
          <span class="relevance-badge ${tier}">${Math.round(cell.score * 100)}% match</span>
        </div>
        <span class="cell-label">${cell.cellLabel}</span>
      </div>
      <button class="card-toggle-btn" title="More Info">
        <img src="../icons/dropdown_icon.svg" alt="" class="card-dropdown-icon" />
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
  // Week 2: vscode.postMessage({ type: "jumpToCell", cellId })
}

function handleBack() {
  if (!navigationStack.length) return;
  navigationStack.pop();
  if (!navigationStack.length) elements.backButton.classList.remove("active");
  // Week 2: vscode.postMessage({ type: "jumpToCell", previous })
}

function getIconPath(iconType) {
  const iconMap = {
    datapie: "../icons/datapie_icon.svg",
    table: "../icons/table_icon.svg",
    upload: "../icons/upload_icon.svg",
    clean: "../icons/clean_icon.svg",
  };
  return iconMap[iconType] ?? "../icons/table_icon.svg";
}

function getRelevanceInfo(score) {
  if (score >= 0.8) return { cls: "high-relevance", tier: "high" };
  if (score >= 0.5) return { cls: "medium-relevance", tier: "medium" };
  return { cls: "low-relevance", tier: "low" };
}

document.addEventListener("DOMContentLoaded", init);

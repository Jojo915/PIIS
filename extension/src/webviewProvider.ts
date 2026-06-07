import * as vscode from "vscode";
import { searchCells } from "./backendClient";
import { BackendSearchResponse } from "./types";

export class SemanticCanvasWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "semanticCanvas.sidebar";

  private _view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    vscode.window.showInformationMessage("Semantic Canvas webview resolved");

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "search":
          await this.handleSearch(message.query);
          break;

        case "jumpToCell":
          await this.jumpToCell(message.cellId);
          break;
      }
    });
  }

  private async handleSearch(query: string): Promise<void> {
    if (!query || query.trim().length === 0) {
      vscode.window.showWarningMessage("Please enter a search query.");
      return;
    }

    try {
      const result: BackendSearchResponse = await searchCells({
        questionId: -1,
        question: query,
      });

      this._view?.webview.postMessage({
        type: "searchResult",
        data: result,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Search failed: ${error}`);

      this._view?.webview.postMessage({
        type: "searchError",
        error: String(error),
      });
    }
  }

  private async jumpToCell(cellId: number): Promise<void> {
    const editor = vscode.window.activeNotebookEditor;

    if (!editor) {
      vscode.window.showWarningMessage("No active notebook editor found.");
      return;
    }

    const cells = editor.notebook.getCells();
    const targetCell = cells.find((cell) => cell.index === cellId);

    if (!targetCell) {
      vscode.window.showWarningMessage(`Cell ${cellId} not found.`);
      return;
    }

    const range = new vscode.NotebookRange(cellId, cellId + 1);

    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);

    vscode.window.showInformationMessage(`Jumped to cell ${cellId}.`);
  }

  private getHtml(): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />

        <style>
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: 12px;
          }

          .container {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .title {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 4px;
          }

          .search-row {
            display: flex;
            gap: 6px;
          }

          input {
            flex: 1;
            padding: 6px 8px;
            color: var(--vscode-input-foreground);
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
          }

          button {
            padding: 6px 10px;
            color: var(--vscode-button-foreground);
            background-color: var(--vscode-button-background);
            border: none;
            border-radius: 4px;
            cursor: pointer;
          }

          button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }

          .section-title {
            font-size: 13px;
            font-weight: 600;
            margin-top: 12px;
            margin-bottom: 6px;
          }

          .cell-card {
            padding: 8px;
            margin-bottom: 8px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background-color: var(--vscode-editor-background);
            cursor: pointer;
          }

          .cell-card:hover {
            outline: 1px solid var(--vscode-focusBorder);
          }

          .cell-label {
            font-weight: 600;
            margin-bottom: 4px;
          }

          .cell-description {
            font-size: 12px;
            opacity: 0.85;
            line-height: 1.4;
          }

          .empty {
            font-size: 12px;
            opacity: 0.7;
          }

          .error {
            color: var(--vscode-errorForeground);
            font-size: 12px;
          }
        </style>
      </head>

      <body>
        <div class="container">
          <div>
            <div class="title">Semantic Canvas</div>
            <div class="search-row">
              <input id="searchInput" type="text" placeholder="Search cells..." />
              <button id="searchButton">Search</button>
            </div>
          </div>

          <div id="status" class="empty">
            Index the notebook first, then search.
          </div>

          <div>
            <div class="section-title">Relevant Cells</div>
            <div id="queryCellsList" class="empty">No results yet.</div>
          </div>

          <div>
            <div class="section-title">Other Cells</div>
            <div id="otherCellsList" class="empty">No results yet.</div>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();

          const searchInput = document.getElementById("searchInput");
          const searchButton = document.getElementById("searchButton");
          const status = document.getElementById("status");
          const queryCellsList = document.getElementById("queryCellsList");
          const otherCellsList = document.getElementById("otherCellsList");

          function search() {
            const query = searchInput.value.trim();

            if (!query) {
              status.textContent = "Please enter a search query.";
              return;
            }

            status.className = "empty";
            status.textContent = "Searching...";

            vscode.postMessage({
              type: "search",
              query
            });
          }

          searchButton.addEventListener("click", search);

          searchInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              search();
            }
          });

          window.addEventListener("message", (event) => {
            const message = event.data;

            if (message.type === "searchResult") {
              status.className = "empty";
              status.textContent = "Search complete.";
              renderResults(message.data);
            }

            if (message.type === "searchError") {
              status.textContent = "Search failed.";
              status.className = "error";
            }
          });

          function renderResults(data) {
            renderCellList(queryCellsList, data.queryCellsList);
            renderCellList(otherCellsList, data.otherCellsList);
          }

          function renderCellList(container, cells) {
            container.innerHTML = "";

            if (!cells || cells.length === 0) {
              container.textContent = "No cells found.";
              container.className = "empty";
              return;
            }

            container.className = "";

            cells.forEach((cell) => {
              const card = document.createElement("div");
              card.className = "cell-card";

              const label = document.createElement("div");
              label.className = "cell-label";
              label.textContent = cell.cellLabel || "Untitled Cell";

              const description = document.createElement("div");
              description.className = "cell-description";
              description.textContent =
                cell.cellDescription || "No description available.";

              card.appendChild(label);
              card.appendChild(description);

              card.addEventListener("click", () => {
                vscode.postMessage({
                  type: "jumpToCell",
                  cellId: cell.cellId
                });
              });

              container.appendChild(card);
            });
          }
        </script>
      </body>
      </html>
    `;
  }
}
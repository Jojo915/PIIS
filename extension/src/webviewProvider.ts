import * as vscode from "vscode";
import { searchCells } from "./backendClient";
import { BackendSearchResponse, CellId } from "./types";

export class SemanticCanvasWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "semanticCanvas.sidebar";

  private _view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    console.log("Semantic Canvas webview resolved.");

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case "search":
            await this.handleSearch(message.query);
            break;

          case "jumpToCell":
            await this.jumpToCell(message.cellId);
            break;

          default:
            console.warn("Unknown webview message type:", message.type);
            break;
        }
      } catch (error) {
        console.error("Webview message error:", error);

        this._view?.webview.postMessage({
          type: "searchError",
          error: getErrorMessage(error),
        });
      }
    });
  }

  private async handleSearch(query: string): Promise<void> {
    if (!query || query.trim().length === 0) {
      vscode.window.showWarningMessage("Please enter a search query.");
      return;
    }

    const editor = vscode.window.activeNotebookEditor;

    if (!editor) {
      throw new Error("No active notebook editor found.");
    }

    try {
      const result: BackendSearchResponse = await searchCells({
        notebook_id: editor.notebook.uri.toString(),
        text: query.trim(),
      });

      console.log("Backend /search response:", result);

      const normalizedResults = result.map((item) => {
        const cellIndex = this.findCellIndexById(item.cell_id);

        return {
          cellId: item.cell_id,
          cellIndex,
          cellLabel: item.label ?? item.cell_id,
          cellDescription:
            item.summary ?? `Distance: ${item.distance.toFixed(4)}`,
          distance: item.distance,
        };
      });

      this._view?.webview.postMessage({
        type: "searchResult",
        data: {
          queryCellsList: normalizedResults,
          otherCellsList: [],
          tuple: null,
        },
      });
    } catch (error) {
      console.error("Search failed:", error);

      vscode.window.showErrorMessage(`Search failed: ${getErrorMessage(error)}`);

      this._view?.webview.postMessage({
        type: "searchError",
        error: getErrorMessage(error),
      });
    }
  }

  private async jumpToCell(cellId: CellId): Promise<void> {
    const editor = vscode.window.activeNotebookEditor;

    if (!editor) {
      vscode.window.showWarningMessage("No active notebook editor found.");
      return;
    }

    const cells = editor.notebook.getCells();

    const targetIndex = cells.findIndex((cell, index) => {
      return this.getStableCellId(cell, index) === cellId;
    });

    if (targetIndex === -1) {
      vscode.window.showWarningMessage(`Cell ${cellId} not found.`);
      return;
    }

    const range = new vscode.NotebookRange(targetIndex, targetIndex + 1);

    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);

    vscode.window.showInformationMessage(`Jumped to cell ${cellId}.`);
  }

  private findCellIndexById(cellId: CellId): number | null {
    const editor = vscode.window.activeNotebookEditor;

    if (!editor) {
      return null;
    }

    const cells = editor.notebook.getCells();

    const index = cells.findIndex((cell, cellIndex) => {
      return this.getStableCellId(cell, cellIndex) === cellId;
    });

    return index === -1 ? null : index;
  }

  private getStableCellId(cell: vscode.NotebookCell, index: number): CellId {
    const metadata = cell.metadata as {
      id?: string;
      custom?: {
        id?: string;
      };
    };

    if (metadata.id) {
      return metadata.id;
    }

    if (metadata.custom?.id) {
      return metadata.custom.id;
    }

    return `cell_${index}`;
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
            min-width: 0;
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

          .cell-meta {
            font-size: 11px;
            opacity: 0.65;
            margin-top: 6px;
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
              status.textContent = message.error || "Search failed.";
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

              const meta = document.createElement("div");
              meta.className = "cell-meta";
              meta.textContent =
                "Cell ID: " +
                cell.cellId +
                (cell.cellIndex !== null && cell.cellIndex !== undefined
                  ? " · Index: " + cell.cellIndex
                  : "") +
                (cell.distance !== undefined
                  ? " · Distance: " + Number(cell.distance).toFixed(4)
                  : "");

              card.appendChild(label);
              card.appendChild(description);
              card.appendChild(meta);

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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

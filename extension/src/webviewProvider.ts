import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";
import { searchCells } from "./backendClient";
import { BackendSearchResponse, CellId } from "./types";

export class SemanticCanvasWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = "semanticCanvas.sidebar";

  private _view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    const uiRoot = vscode.Uri.file(
      path.join(this.context.extensionPath, "..", "frontend"),
    );

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [uiRoot],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview, uiRoot);

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
        notebook_id: editor.notebook.uri.fsPath,
        text: query.trim(),
      });
      console.log("Question:", query.trim());
      console.log("Backend /search response:", result);

      const normalizedResults = result
        .map((item) => {
          const cellIndex = this.findCellIndexById(item.cell_id);

          return {
            cellId: item.cell_id,
            cellIndex,
            cellLabel: this.getCellLabel(cellIndex),
            distance: item.distance,
            score: 1 - item.distance,
          };
        })
        // Rank by similarity (lowest distance first), not by notebook
        // position — position ordering is only correct for the unfiltered
        // "All Cells" view (see postIndexResult in extension.ts).
        .sort((left, right) => left.distance - right.distance);

      this._view?.webview.postMessage({
        type: "searchResult",
        data: {
          queryCellsList: normalizedResults,
          otherCellsList: [],
        },
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Search failed: ${getErrorMessage(error)}`,
      );

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

  private getCellLabel(cellIndex: number | null): string {
    if (cellIndex === null) {
      return "Cell unknown";
    }

    return `Cell ${cellIndex + 1}`;
  }

  public postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview, uiRoot: vscode.Uri): string {
    const uiRootUri = webview.asWebviewUri(uiRoot);

    const htmlPath = path.join(uiRoot.fsPath, "index.html");
    let html = fs.readFileSync(htmlPath, "utf8");

    // Replace relative asset paths with webview-safe URIs
    html = html
      .replace('href="styles.css"', `href="${uiRootUri}/styles.css"`)
      .replace('src="mockdata.js"', `src="${uiRootUri}/mockdata.js"`)
      .replace('src="script.js"', `src="${uiRootUri}/script.js"`)
      .replace(/src="icons\//g, `src="${uiRootUri}/icons/`)
      .replace("<body>", `<body data-icons-uri="${uiRootUri}/icons">`);

    // Inject Content Security Policy with unsafe-inline for style support
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; img-src ${webview.cspSource};">`;
    html = html.replace("<head>", `<head>\n    ${csp}`);

    return html;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

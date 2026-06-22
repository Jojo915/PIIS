import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";
import { saveCellSummary, searchCells } from "./backendClient";
import { getCurrentNotebookEditor } from "./notebookReader";
import { BackendSearchResponse, CellId } from "./types";

export class SemanticCanvasWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = "semanticCanvas.sidebar";

  private _view?: vscode.WebviewView;
  private _latestIndexResultMessage?: unknown;

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

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case "webviewReady":
            await this.handleWebviewReady();
            break;

          case "search":
            await this.handleSearch(message.query);
            break;

          case "jumpToCell":
            await this.jumpToCell(message.cellId);
            break;

          case "saveSummary":
            await this.saveSummary(message.cellId, message.summary);
            break;

          default:
            console.warn("Unknown webview message type:", message.type);
            break;
        }
      } catch (error) {
        console.error("Webview message error:", error);

        if (message.type === "saveSummary") {
          this._view?.webview.postMessage({
            type: "summarySaveError",
            data: {
              cellId: message.cellId,
              error: getErrorMessage(error),
            },
          });
          return;
        }

        this._view?.webview.postMessage({
          type: "searchError",
          error: getErrorMessage(error),
        });
      }
    });

    webviewView.webview.html = this.getHtml(webviewView.webview, uiRoot);
    setTimeout(() => {
      void vscode.commands.executeCommand("semanticCanvas.indexNotebook");
    }, 1000);
  }

  private async handleWebviewReady(): Promise<void> {
    if (this._latestIndexResultMessage !== undefined) {
      await this._view?.webview.postMessage(this._latestIndexResultMessage);
      return;
    }

    await vscode.commands.executeCommand("semanticCanvas.indexNotebook");
  }

  private async handleSearch(query: string): Promise<void> {
    if (!query || query.trim().length === 0) {
      vscode.window.showWarningMessage("Please enter a search query.");
      return;
    }

    const editor = getCurrentNotebookEditor();

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
        .sort((left, right) => {
          return this.compareCellIndexes(left.cellIndex, right.cellIndex);
        });

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

  private async saveSummary(
    cellId: CellId,
    summary: string | null,
  ): Promise<void> {
    const editor = getCurrentNotebookEditor();

    if (!editor) {
      throw new Error("No active notebook editor found.");
    }

    const result = await saveCellSummary({
      notebook_id: editor.notebook.uri.fsPath,
      cell_id: cellId,
      summary,
    });

    this._view?.webview.postMessage({
      type: "summarySaved",
      data: {
        cellId: result.cell_id,
        summary: result.display_summary ?? "",
      },
    });
  }

  private async jumpToCell(cellId: CellId): Promise<void> {
    const editor = getCurrentNotebookEditor();

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
    const editor = getCurrentNotebookEditor();

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

  private compareCellIndexes(
    leftIndex: number | null,
    rightIndex: number | null,
  ): number {
    if (leftIndex === null && rightIndex === null) {
      return 0;
    }

    if (leftIndex === null) {
      return 1;
    }

    if (rightIndex === null) {
      return -1;
    }

    return leftIndex - rightIndex;
  }

  public postMessage(message: unknown): void {
    if (isIndexResultMessage(message)) {
      this._latestIndexResultMessage = message;
    }

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

function isIndexResultMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const typedMessage = message as { type?: unknown };

  return typedMessage.type === "indexResult";
}

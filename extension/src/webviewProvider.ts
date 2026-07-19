import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";
import {
  getAIConfig,
  saveAIConfig as saveBackendAIConfig,
  saveCellSummary,
  searchCells,
  suggestCellSummary,
} from "./backendClient";
import { getCurrentNotebookEditor, getStableCellId } from "./notebookReader";
import { BackendSearchResponse, CellId } from "./types";

// How many of the ranked /search results render as "Top Matches" before the
// rest fall into the collapsed "Other Cells" bucket. Note: the backend's
// /search endpoint currently caps total results at 3 (see
// retrieve_documents's n_results default), so Other Cells is empty until
// that's raised — this constant is ready for that the moment it changes.
const TOP_MATCHES_COUNT = 3;
const AI_API_KEY_SECRET_KEY = "semanticCanvas.aiApiKey";
const AI_MODEL_STATE_KEY = "semanticCanvas.aiModel";
const DEFAULT_AI_MODEL = "gemini-2.5-flash-lite";

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
            await this.saveSummary(
              message.cellId,
              message.label,
              message.summary,
            );
            break;

          case "suggestSummary":
            await this.suggestSummary(message.cellId);
            break;

          case "saveAIConfig":
            await this.saveAIConfig(message.apiKey, message.model);
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

        if (message.type === "suggestSummary") {
          this._view?.webview.postMessage({
            type: "summarySuggestionError",
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
    await this.syncSavedAIConfig();

    if (this._latestIndexResultMessage !== undefined) {
      await this._view?.webview.postMessage(this._latestIndexResultMessage);
      return;
    }

    await vscode.commands.executeCommand("semanticCanvas.indexNotebook");
  }

  private async syncSavedAIConfig(): Promise<void> {
    const apiKey = await this.context.secrets.get(AI_API_KEY_SECRET_KEY);
    const savedModel = this.context.globalState.get<string>(AI_MODEL_STATE_KEY);
    const model = savedModel || DEFAULT_AI_MODEL;

    try {
      const config = apiKey
        ? await saveBackendAIConfig({ api_key: apiKey, model })
        : await getAIConfig();

      this.postAIConfig(config.model, config.has_api_key, "AI settings loaded.");
    } catch (error) {
      this.postAIConfig(model, Boolean(apiKey), getErrorMessage(error), true);
    }
  }

  private async saveAIConfig(
    apiKey: string | null | undefined,
    model: string | null | undefined,
  ): Promise<void> {
    const normalizedApiKey = apiKey?.trim() ?? "";
    const normalizedModel = model?.trim() || DEFAULT_AI_MODEL;

    if (normalizedApiKey) {
      await this.context.secrets.store(AI_API_KEY_SECRET_KEY, normalizedApiKey);
    }
    await this.context.globalState.update(AI_MODEL_STATE_KEY, normalizedModel);

    try {
      const config = await saveBackendAIConfig({
        api_key: normalizedApiKey || null,
        model: normalizedModel,
      });
      this.postAIConfig(config.model, config.has_api_key, "AI settings saved.");
    } catch (error) {
      this.postAIConfig(
        normalizedModel,
        Boolean(normalizedApiKey),
        getErrorMessage(error),
        true,
      );
    }
  }

  private postAIConfig(
    model: string,
    hasApiKey: boolean,
    status: string,
    isError = false,
  ): void {
    this._view?.webview.postMessage({
      type: "aiConfig",
      data: {
        model,
        hasApiKey,
        status,
        isError,
      },
    });
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
        // Rank by similarity (lowest distance first), not by notebook
        // position — position ordering is only correct for the unfiltered
        // "All Cells" view (see postIndexResult in extension.ts).
        .sort((left, right) => left.distance - right.distance);

      this._view?.webview.postMessage({
        type: "searchResult",
        data: {
          queryCellsList: normalizedResults.slice(0, TOP_MATCHES_COUNT),
          otherCellsList: normalizedResults.slice(TOP_MATCHES_COUNT),
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
    label: string | null,
    summary: string | null,
  ): Promise<void> {
    const editor = getCurrentNotebookEditor();

    if (!editor) {
      throw new Error("No active notebook editor found.");
    }

    const result = await saveCellSummary({
      notebook_id: editor.notebook.uri.fsPath,
      cell_id: cellId,
      label,
      summary,
    });

    const savedLabel = result.display_label ?? result.ai_label ?? "";
    const savedSummary = result.display_summary ?? "";
    const isUserEdited = result.user_label != null || result.user_summary != null;
    this.updateCachedCellDetails(cellId, savedLabel, savedSummary, isUserEdited);

    this._view?.webview.postMessage({
      type: "summarySaved",
      data: {
        cellId: result.cell_id,
        label: savedLabel,
        summary: savedSummary,
        isUserEdited,
      },
    });
  }

  private updateCachedCellDetails(
    cellId: CellId,
    label: string,
    summary: string,
    isUserEdited: boolean,
  ): void {
    if (!isIndexResultMessage(this._latestIndexResultMessage)) {
      return;
    }

    this._latestIndexResultMessage = {
      ...this._latestIndexResultMessage,
      data: this._latestIndexResultMessage.data.map((cell) => {
        if (cell.cellId !== cellId) {
          return cell;
        }

        return {
          ...cell,
          cellLabel: label,
          cellDescription: summary,
          isUserEdited,
        };
      }),
    };
  }

  private async suggestSummary(cellId: CellId): Promise<void> {
    const editor = getCurrentNotebookEditor();

    if (!editor) {
      throw new Error("No active notebook editor found.");
    }

    const cells = editor.notebook.getCells();
    const cellIndex = cells.findIndex((cell, index) => {
      return getStableCellId(cell, index) === cellId;
    });

    if (cellIndex === -1) {
      throw new Error(`Cell ${cellId} not found.`);
    }

    const cell = cells[cellIndex];
    const previousCells = cells
      .slice(Math.max(0, cellIndex - 5), cellIndex)
      .map((previousCell) => previousCell.document.getText());

    const result = await suggestCellSummary({
      notebook_id: editor.notebook.uri.fsPath,
      cell_id: cellId,
      cell_type:
        cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
      source: cell.document.getText(),
      previous_cells: previousCells,
    });

    this._view?.webview.postMessage({
      type: "summarySuggestion",
      data: {
        cellId,
        label: result.label ?? "",
        summary: result.summary ?? "",
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
      return getStableCellId(cell, index) === cellId;
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
      return getStableCellId(cell, cellIndex) === cellId;
    });

    return index === -1 ? null : index;
  }

  private getCellLabel(cellIndex: number | null): string {
    if (cellIndex === null) {
      return "Cell unknown";
    }

    return `Cell ${cellIndex + 1}`;
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

interface IndexResultMessage {
  type: "indexResult";
  data: Array<{
    cellId: string;
    cellLabel: string;
    cellDescription: string;
    cellContent?: string;
    cellIcon?: string;
    isUserEdited?: boolean;
  }>;
}

function isIndexResultMessage(message: unknown): message is IndexResultMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const typedMessage = message as { type?: unknown; data?: unknown };

  return typedMessage.type === "indexResult" && Array.isArray(typedMessage.data);
}

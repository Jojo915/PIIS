import * as vscode from "vscode";
import {
  readCurrentNotebookForBackend,
  readCurrentCodeCellForBackend,
  readNotebookCodeCellForBackend,
  readNotebookForBackend,
} from "./notebookReader";
import { indexNotebook, updateCell, searchCells } from "./backendClient";
import { SemanticCanvasWebviewProvider } from "./webviewProvider";
import { BackendNotebookRequest, BackendNotebookResponse } from "./types";

const CELL_UPDATE_DEBOUNCE_MS = 1000;
const NOTEBOOK_REINDEX_DEBOUNCE_MS = 1000;

export function activate(context: vscode.ExtensionContext) {
  console.log("Semantic Canvas extension is now active.");

  /**
   * Register sidebar webview provider.
   *
   * Make sure package.json has the same view id:
   * "id": "semanticCanvasView"
   */
  const provider = new SemanticCanvasWebviewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SemanticCanvasWebviewProvider.viewType,
      provider,
    ),
  );

  /**
   * Command:
   * Semantic Canvas: Index Current Notebook
   *
   * Backend endpoint:
   * POST /notebooks
   */
  const indexNotebookCommand = vscode.commands.registerCommand(
    "semanticCanvas.indexNotebook",
    async () => {
      try {
        const request = readCurrentNotebookForBackend();

        console.log("Sending notebook to backend:", request);

        const result = await indexNotebook(request);
        postIndexResult(provider, request, result);

        console.log("Backend /notebooks response:", result);

        vscode.window.showInformationMessage(
          `Notebook indexed: ${result.length} cells`,
        );
      } catch (error) {
        console.error("Index notebook failed:", error);

        vscode.window.showErrorMessage(
          `Index notebook failed: ${getErrorMessage(error)}`,
        );
      }
    },
  );

  /**
   * Command:
   * Semantic Canvas: Update Current Cell
   *
   * Backend endpoint:
   * POST /cells
   *
   * Note: backend currently expects only code cells.
   */
  const updateCellCommand = vscode.commands.registerCommand(
    "semanticCanvas.updateCell",
    async () => {
      try {
        const request = readCurrentCodeCellForBackend();

        console.log("Sending cell to backend:", request);

        const result = await updateCell(request);

        console.log("Backend /cells response:", result);

        vscode.window.showInformationMessage(`Cell updated: ${result.cell_id}`);
      } catch (error) {
        console.error("Update cell failed:", error);

        vscode.window.showErrorMessage(
          `Update cell failed: ${getErrorMessage(error)}`,
        );
      }
    },
  );

  /**
   * Command:
   * Semantic Canvas: Search Current Notebook
   *
   * Backend endpoint:
   * POST /search
   */
  const searchNotebookCommand = vscode.commands.registerCommand(
    "semanticCanvas.searchNotebook",
    async () => {
      try {
        const editor = vscode.window.activeNotebookEditor;
        console.log("1");

        if (!editor) {
          throw new Error("No active notebook found.");
        }
        console.log("2");

        const question = await vscode.window.showInputBox({
          prompt: "Ask a question about this notebook",
          placeHolder: "Where is data normalization?",
        });
        console.log("3");

        if (!question || question.trim().length === 0) {
          return;
        }
        console.log("Question:", question);

        const result = await searchCells({
          notebook_id: editor.notebook.uri.toString(),
          text: question.trim(),
        });

        console.log("Backend /search response:", result);

        vscode.window.showInformationMessage(
          `Search finished: ${result.length} results`,
        );
      } catch (error) {
        console.error("Search failed:", error);

        vscode.window.showErrorMessage(
          `Search failed: ${getErrorMessage(error)}`,
        );
      }
    },
  );

  const pendingCellUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingNotebookIndexes = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  const notebookChangeListener = vscode.workspace.onDidChangeNotebookDocument(
    (event) => {
      if (event.contentChanges.length > 0) {
        const notebookKey = event.notebook.uri.toString();
        const existingTimer = pendingNotebookIndexes.get(notebookKey);

        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
          pendingNotebookIndexes.delete(notebookKey);

          try {
            const request = readNotebookForBackend(event.notebook);

            console.log("Auto-reindexing changed notebook:", request);

            const result = await indexNotebook(request);
            postIndexResult(provider, request, result);

            console.log("Backend /notebooks auto-reindex response:", result);
          } catch (error) {
            console.error("Auto-reindex notebook failed:", error);
          }
        }, NOTEBOOK_REINDEX_DEBOUNCE_MS);

        pendingNotebookIndexes.set(notebookKey, timer);
      }

      for (const change of event.cellChanges) {
        if (!change.outputs && !change.executionSummary) {
          continue;
        }

        if (change.cell.kind !== vscode.NotebookCellKind.Code) {
          continue;
        }

        const updateKey = `${event.notebook.uri.toString()}::${change.cell.document.uri.toString()}`;
        const existingTimer = pendingCellUpdates.get(updateKey);

        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
          pendingCellUpdates.delete(updateKey);

          try {
            const request = readNotebookCodeCellForBackend(
              event.notebook,
              change.cell,
            );

            console.log("Auto-updating executed notebook cell:", request);

            const result = await updateCell(request);

            console.log("Backend /cells auto-update response:", result);
          } catch (error) {
            console.error("Auto-update cell failed:", error);
          }
        }, CELL_UPDATE_DEBOUNCE_MS);

        pendingCellUpdates.set(updateKey, timer);
      }
    },
  );

  const clearPendingCellUpdates = new vscode.Disposable(() => {
    for (const timer of pendingCellUpdates.values()) {
      clearTimeout(timer);
    }

    pendingCellUpdates.clear();

    for (const timer of pendingNotebookIndexes.values()) {
      clearTimeout(timer);
    }

    pendingNotebookIndexes.clear();
  });

  context.subscriptions.push(
    indexNotebookCommand,
    updateCellCommand,
    searchNotebookCommand,
    notebookChangeListener,
    clearPendingCellUpdates,
  );
}

export function deactivate() {
  console.log("Semantic Canvas extension is now deactivated.");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function postIndexResult(
  provider: SemanticCanvasWebviewProvider,
  request: BackendNotebookRequest,
  result: BackendNotebookResponse,
): void {
  const cellOrder = new Map(
    request.content.cells.map((cell, index) => [cell.id, index]),
  );

  provider.postMessage({
    type: "indexResult",
    data: result
      .filter((item) => item.cell_type === "code")
      .sort((left, right) => {
        return compareCellIndexes(
          cellOrder.get(left.cell_id) ?? null,
          cellOrder.get(right.cell_id) ?? null,
        );
      })
      .map((item) => ({
        cellId: item.cell_id,
        cellLabel: getCellLabel(cellOrder.get(item.cell_id) ?? null),
        cellDescription: item.content,
        cellIcon: "table",
      })),
  });
}

function getCellLabel(cellIndex: number | null): string {
  if (cellIndex === null) {
    return "Cell unknown";
  }

  return `Cell ${cellIndex + 1}`;
}

function compareCellIndexes(
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

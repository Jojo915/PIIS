import * as vscode from "vscode";
import {
  readCurrentNotebookForBackend,
  readCurrentCodeCellForBackend,
  readNotebookCodeCellForBackend,
  readNotebookForBackend,
  getStableCellId,
} from "./notebookReader";
import {
  indexNotebook,
  updateCell,
  searchCells,
  deleteCell,
} from "./backendClient";
import { SemanticCanvasWebviewProvider } from "./webviewProvider";
import { BackendNotebookRequest, BackendNotebookResponse } from "./types";

const CELL_UPDATE_DEBOUNCE_MS = 1000;

export function activate(context: vscode.ExtensionContext) {
  console.log("Semantic Canvas extension is now active.");

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

        if (result.cell_type === "code") {
          const editor = vscode.window.activeNotebookEditor;
          const cells = editor?.notebook.getCells() ?? [];
          const cellIndex = cells.findIndex(
            (c) => c.document.uri.toString() === request.content.id,
          );

          provider.postMessage({
            type: "cellUpdated",
            data: {
              cellId: result.cell_id,
              cellLabel: getCellLabel(cellIndex !== -1 ? cellIndex : null),
              cellDescription: result.content,
              cellIcon: "table",
            },
          });
        }

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

        if (!editor) {
          throw new Error("No active notebook found.");
        }

        const question = await vscode.window.showInputBox({
          prompt: "Ask a question about this notebook",
          placeHolder: "Where is data normalization?",
        });

        if (!question || question.trim().length === 0) {
          return;
        }

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

  /**
   * Auto-index when a notebook is opened.
   */
  const notebookOpenListener = vscode.workspace.onDidOpenNotebookDocument(
    async (notebook) => {
      try {
        const request = readNotebookForBackend(notebook);

        console.log("Auto-indexing opened notebook:", notebook.uri.toString());

        const result = await indexNotebook(request);
        postIndexResult(provider, request, result);

        console.log("Backend /notebooks auto-index response:", result);

        vscode.window.showInformationMessage(
          `Notebook indexed: ${result.length} cells`,
        );
      } catch (error) {
        console.error("Auto-index notebook failed:", error);
      }
    },
  );

  const pendingCellUpdates = new Map<string, ReturnType<typeof setTimeout>>();

  const notebookChangeListener = vscode.workspace.onDidChangeNotebookDocument(
    (event) => {
      // Handle cell deletions
      for (const change of event.contentChanges) {
        for (const removedCell of change.removedCells) {
          const cellId = getStableCellId(removedCell, removedCell.index);

          provider.postMessage({
            type: "cellDeleted",
            data: { cellId },
          });

          (async () => {
            try {
              await deleteCell(cellId);
              console.log("Cell deleted from backend:", cellId);
            } catch (error) {
              console.error("Failed to delete cell from backend:", error);
            }
          })();
        }
      }

      // Handle cell executions
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

            if (result.cell_type === "code") {
              const cells = event.notebook.getCells();
              const cellIndex = cells.findIndex(
                (c) =>
                  c.document.uri.toString() ===
                  change.cell.document.uri.toString(),
              );

              provider.postMessage({
                type: "cellUpdated",
                data: {
                  cellId: result.cell_id,
                  cellLabel: result.label ?? getCellLabel(cellIndex !== -1 ? cellIndex : null),
                  cellDescription: result.summary ?? result.content,
                  cellIcon: "table",
                },
              });
            }
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
  });

  context.subscriptions.push(
    indexNotebookCommand,
    updateCellCommand,
    searchNotebookCommand,
    notebookOpenListener,
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
        cellLabel: item.label ?? getCellLabel(cellOrder.get(item.cell_id) ?? null),
        cellDescription: item.summary ?? item.content,
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

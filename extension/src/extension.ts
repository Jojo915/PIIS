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
  reorderNotebook,
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

  const MOVE_RECONCILE_WINDOW_MS = 800;
  const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>();

  const notebookChangeListener = vscode.workspace.onDidChangeNotebookDocument(
    (event) => {
      // Collect all added/removed cell ids across every contentChange in
      // this event. VS Code sometimes represents a move as a removedCells
      // entry and an addedCells entry within the SAME event (just under
      // different `change` entries), and sometimes spreads it across two
      // separate invocations. We handle both: same-event reconciliation
      // first (the common case), then a cross-event fallback via
      // pendingDeletions for cases where the add and remove land in
      // different invocations.
      const addedIdsThisEvent = new Set<string>();
      const removedIdsThisEvent = new Set<string>();

      for (const change of event.contentChanges) {
        for (const addedCell of change.addedCells) {
          addedIdsThisEvent.add(getStableCellId(addedCell, addedCell.index));
        }
        for (const removedCell of change.removedCells) {
          removedIdsThisEvent.add(
            getStableCellId(removedCell, removedCell.index),
          );
        }
      }

      // Cross-event fallback: cancel any previously-scheduled deletion for
      // a cell that has now reappeared as an addedCell in this event.
      for (const cellId of addedIdsThisEvent) {
        const pendingTimer = pendingDeletions.get(cellId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingDeletions.delete(cellId);
          console.log(
            `Cell ${cellId} reappeared in a later event — treating as move.`,
          );
        }
      }

      // Schedule deletions only for cells removed but NOT also added
      // within this same event (same-event add+remove = a move, not a
      // delete).
      for (const cellId of removedIdsThisEvent) {
        if (addedIdsThisEvent.has(cellId)) {
          console.log(
            `Cell ${cellId} removed and re-added in the same event — move, not delete.`,
          );
          continue;
        }

        const existingTimer = pendingDeletions.get(cellId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          pendingDeletions.delete(cellId);

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
        }, MOVE_RECONCILE_WINDOW_MS);

        pendingDeletions.set(cellId, timer);
      }

      // Sync cell order whenever cells were added in this event. Covers
      // both "a cell was moved (reinserted here)" and "a brand new cell
      // was added" — reorderNotebook is a cheap metadata-only update
      // (no re-embedding, no LLM calls), so it's safe to call generously.
      if (addedIdsThisEvent.size > 0) {
        const cellIds = event.notebook
          .getCells()
          .map((cell, index) => getStableCellId(cell, index));

        provider.postMessage({
          type: "cellsReordered",
          data: { cellIds },
        });

        (async () => {
          try {
            await reorderNotebook(event.notebook.uri.fsPath, cellIds);
            console.log("Notebook reorder synced to backend.");
          } catch (error) {
            console.error("Failed to sync reorder to backend:", error);
          }
        })();
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
                  cellLabel:
                    result.label ??
                    getCellLabel(cellIndex !== -1 ? cellIndex : null),
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

    for (const timer of pendingDeletions.values()) {
      clearTimeout(timer);
    }
    pendingDeletions.clear();
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
        cellLabel:
          item.label ?? getCellLabel(cellOrder.get(item.cell_id) ?? null),
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

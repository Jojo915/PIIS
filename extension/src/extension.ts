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
  getNotebookSummaries,
} from "./backendClient";
import { SemanticCanvasWebviewProvider } from "./webviewProvider";
import {
  BackendNotebookRequest,
  BackendNotebookResponse,
  BackendNotebookSummariesResponse,
} from "./types";

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

  function getCodeCellOrder(notebook: vscode.NotebookDocument): string[] {
    // Returns an ordered list of stable cell ids for code cells only,
    // matching the order they appear in the notebook.
    return notebook
      .getCells()
      .filter((c) => c.kind === vscode.NotebookCellKind.Code)
      .map((c, i) => getStableCellId(c, notebook.getCells().indexOf(c)));
  }

  const MOVE_RECONCILE_WINDOW_MS = 800;
  const pendingCellUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>();

  // Source of truth for the current canvas state, maintained in the
  // extension host so it survives webview cold-opens. Replayed as a
  // fresh indexResult whenever the sidebar is revealed from hidden.
  // Tracks cell data by cellId, and a separate ordered list of cellIds
  // since a Map has no inherent order.
  const currentCellsMap = new Map<
    string,
    {
      cellId: string;
      cellLabel: string;
      cellDescription: string;
      cellContent: string;
      cellIcon: string;
    }
  >();
  let currentCellOrder: string[] = [];

  function replayCurrentCells(): void {
    const data = currentCellOrder
      .map((id) => currentCellsMap.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    provider.postMessage({ type: "indexResult", data });
  }

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
        postIndexResult(provider, request, result, currentCellsMap, (order) => {
          currentCellOrder = order;
        });

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

          const cellData = {
            cellId: result.cell_id,
            cellLabel: getCellLabel(cellIndex !== -1 ? cellIndex : null),
            cellDescription: result.content,
            cellContent: result.content,
            cellIcon: "table" as const,
          };

          const isNew = !currentCellsMap.has(cellData.cellId);
          currentCellsMap.set(cellData.cellId, cellData);

          if (isNew && editor) {
            currentCellOrder = cells
              .filter((c) => c.kind === vscode.NotebookCellKind.Code)
              .map((c) => getStableCellId(c, cells.indexOf(c)))
              .filter((id) => currentCellsMap.has(id));

            const allCellIds = cells.map((c, i) => getStableCellId(c, i));
            provider.postMessage({ type: "cellUpdated", data: cellData });
            provider.postMessage({
              type: "cellsReordered",
              data: { cellIds: allCellIds },
            });
          }

          vscode.window.showInformationMessage(
            `Cell updated: ${result.cell_id}`,
          );
        }
      } catch (error) {
        console.error("Update cell failed:", error);

        vscode.window.showErrorMessage(
          `Update cell failed: ${getErrorMessage(error)}`,
        );
      }
    },
  );

  const focusSearchCommand = vscode.commands.registerCommand(
    "semanticCanvas.focusSearch",
    async () => {
      await vscode.commands.executeCommand("semanticCanvas.sidebar.focus");

      setTimeout(() => {
        replayCurrentCells();
        provider.postMessage({ type: "focusSearch" });
      }, 100);
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
        postIndexResult(provider, request, result, currentCellsMap, (order) => {
          currentCellOrder = order;
        });

        console.log("Backend /notebooks auto-index response:", result);

        vscode.window.showInformationMessage(
          `Notebook indexed: ${result.length} cells`,
        );
      } catch (error) {
        console.error("Auto-index notebook failed:", error);
      }
    },
  );

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

          // Keep extension-side state in sync.
          currentCellsMap.delete(cellId);
          currentCellOrder = currentCellOrder.filter((id) => id !== cellId);

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

        // Keep extension-side state in sync — reorder only, don't touch
        // map values since cell content hasn't changed.
        currentCellOrder = cellIds.filter((id) => currentCellsMap.has(id));

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

              const cellData = {
                cellId: result.cell_id,
                cellLabel:
                  result.label ??
                  getCellLabel(cellIndex !== -1 ? cellIndex : null),
                cellDescription: result.summary ?? result.content,
                cellContent: result.content,
                cellIcon: "table" as const,
              };

              const isNew = !currentCellsMap.has(cellData.cellId);
              currentCellsMap.set(cellData.cellId, cellData);

              if (isNew) {
                // Recompute currentCellOrder from the notebook's actual code-cell
                // ordering, now that we've added the new cell to currentCellsMap.
                // This correctly handles markdown cells in between (which are not
                // in currentCellsMap/currentCellOrder) and avoids the off-by-one
                // that splice(rawCellIndex) produces.
                currentCellOrder = cells
                  .filter((c) => c.kind === vscode.NotebookCellKind.Code)
                  .map((c, i) => getStableCellId(c, cells.indexOf(c)))
                  .filter((id) => currentCellsMap.has(id));

                // Also tell the webview to reorder so the live canvas matches —
                // cellsReordered won't have fired for this execution-triggered
                // addition (only structural adds trigger addedIdsThisEvent).
                const allCellIds = cells.map((c, i) => getStableCellId(c, i));
                provider.postMessage({ type: "cellUpdated", data: cellData });
                provider.postMessage({
                  type: "cellsReordered",
                  data: { cellIds: allCellIds },
                });
              }
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
    focusSearchCommand,
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

async function indexNotebookForDisplay(
  request: BackendNotebookRequest,
): Promise<BackendNotebookResponse> {
  try {
    const result = await indexNotebook(request);
    console.log("Backend /notebooks response:", result);
    return result;
  } catch (error) {
    console.error("Backend /notebooks failed:", error);
    vscode.window.showWarningMessage(
      `Notebook vector index failed, showing cells from SQLite summaries: ${getErrorMessage(error)}`,
    );
    return createNotebookResponseFromRequest(request);
  }
}

function createNotebookResponseFromRequest(
  request: BackendNotebookRequest,
): BackendNotebookResponse {
  return request.content.cells.map((cell) => ({
    cell_id: cell.id,
    cell_type: cell.cell_type,
    content: cell.source,
    notebook_id: request.notebook_id,
  }));
}

async function postIndexResult(
  provider: SemanticCanvasWebviewProvider,
  request: BackendNotebookRequest,
  result: BackendNotebookResponse,
  currentCellsMap: Map<
    string,
    {
      cellId: string;
      cellLabel: string;
      cellDescription: string;
      cellContent: string;
      cellIcon: string;
    }
  >,
  setCurrentCellOrder: (order: string[]) => void,
): Promise<void> {
  const cellOrder = new Map(
    request.content.cells.map((cell, index) => [cell.id, index]),
  );
  const summariesByCellId = await getSummariesByCellId(request);

  const data = result
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
      cellDescription:
        summariesByCellId.get(item.cell_id)?.display_summary ??
        item.summary ??
        item.content,
      cellContent: item.content,
      cellIcon: "table" as const,
    }));

  // Keep extension-side state in sync.
  currentCellsMap.clear();
  const newOrder: string[] = [];
  for (const cell of data) {
    currentCellsMap.set(cell.cellId, cell);
    newOrder.push(cell.cellId);
  }
  setCurrentCellOrder(newOrder);

  provider.postMessage({ type: "indexResult", data });
}

async function getSummariesByCellId(
  request: BackendNotebookRequest,
): Promise<Map<string, BackendNotebookSummariesResponse[number]>> {
  try {
    const summaries = await getNotebookSummaries({
      notebook_id: request.notebook_id,
      cells: request.content.cells.map((cell, index) => ({
        cell_id: cell.id,
        cell_type: cell.cell_type,
        source: cell.source,
        cell_index: index,
      })),
    });

    return new Map(summaries.map((summary) => [summary.cell_id, summary]));
  } catch (error) {
    console.error("Failed to hydrate summaries from backend:", error);
    return new Map();
  }
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

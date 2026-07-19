import * as vscode from "vscode";
import {
  readCurrentNotebookForBackend,
  readCurrentCodeCellForBackend,
  readNotebookCodeCellForBackend,
  readNotebookForBackend,
  getStableCellId,
  getBackendNotebookCells,
} from "./notebookReader";
import {
  indexNotebook,
  updateCell,
  searchCells,
  deleteCell,
  reorderNotebook,
  getNotebookSummaries,
  findDuplicateCells,
  findDeadCells,
  findStaleCells,
} from "./backendClient";
import { SemanticCanvasWebviewProvider } from "./webviewProvider";
import {
  BackendNotebookRequest,
  BackendNotebookResponse,
  BackendNotebookSummariesResponse,
  BackendStaleCellResponse,
  CellOrigin,
} from "./types";
import {
  InlineSummaryManager,
} from "./inlineSummaryManager";
import { isInlineSummaryCell } from "./inlineSummaryMetadata";

const CELL_UPDATE_DEBOUNCE_MS = 1000;
const STALE_DETECT_DEBOUNCE_MS = 700;

interface TrackedCellData {
  cellId: string;
  cellLabel: string;
  cellDescription: string;
  cellContent: string;
  cellIcon: string;
  cellOrigin?: CellOrigin;
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Semantic Canvas extension is now active.");

  const inlineSummaryManager = new InlineSummaryManager(
    async (notebookId, cellId, label, description) => {
      const existing = currentCellsMap.get(cellId);
      if (!existing) {
        return;
      }

      const { savedLabel, savedSummary } = await provider.saveHandEditedSummary(
        cellId,
        label,
        description,
      );

      const updatedCell = {
        ...existing,
        cellLabel: savedLabel,
        cellDescription: savedSummary,
        cellOrigin: "human" as const,
      };
      currentCellsMap.set(cellId, updatedCell);
      provider.postMessage({
        type: "cellUpdated",
        data: updatedCell,
        notebookId,
      });
      await inlineSummaryManager.updateCells(getOrderedCells());
    },
  );
  const provider = new SemanticCanvasWebviewProvider(
    context,
    async (mode) => {
      await inlineSummaryManager.setMode(mode);
      replayCurrentCells();
    },
    async (cellId, label, summary, origin) => {
      const existing = currentCellsMap.get(cellId);
      if (!existing) {
        return;
      }

      const updatedCell = {
        ...existing,
        cellLabel: label,
        cellDescription: summary,
        cellOrigin: origin,
      };
      currentCellsMap.set(cellId, updatedCell);
      await inlineSummaryManager.updateCells(getOrderedCells());
    },
    async (appliedCellIds) => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) {
        return;
      }

      const cells = getBackendNotebookCells(editor.notebook);
      let updatedCount = 0;

      for (const cellId of appliedCellIds) {
        try {
          const cellIndex = cells.findIndex(
            (candidate, index) => getStableCellId(candidate, index) === cellId,
          );
          if (cellIndex === -1) {
            continue;
          }

          const cell = cells[cellIndex];
          if (cell.kind !== vscode.NotebookCellKind.Code) {
            continue;
          }

          const request = readNotebookCodeCellForBackend(editor.notebook, cell);
          const result = await updateCell(request);

          if (result.cell_type !== "code") {
            continue;
          }

          const existing = currentCellsMap.get(result.cell_id);
          const cellData = {
            cellId: result.cell_id,
            cellLabel:
              result.label ?? existing?.cellLabel ?? getCellLabel(cellIndex),
            cellDescription: result.summary ?? result.content,
            cellContent: result.content,
            cellIcon: "table" as const,
            cellOrigin: existing?.cellOrigin,
          };

          currentCellsMap.set(cellData.cellId, cellData);
          provider.postMessage({
            type: "cellUpdated",
            data: cellData,
            notebookId: editor.notebook.uri.fsPath,
          });
          updatedCount++;
        } catch (error) {
          console.error(`Replace All: failed to re-embed cell ${cellId}:`, error);
        }
      }

      await inlineSummaryManager.updateCells(getOrderedCells());

      if (updatedCount > 0) {
        const request = readNotebookForBackend(editor.notebook);
        await detectAndPostDeadCells(provider, request);
        await detectAndPostStaleCells(provider, request, executedSourceByCell);
      }

      if (updatedCount > 1) {
        vscode.window.showInformationMessage(
          `Semantic Canvas: replaced text in ${updatedCount} cells.`,
        );
      }
    },
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SemanticCanvasWebviewProvider.viewType,
      provider,
      {
        // Keep the webview's DOM + JS state alive while the view is hidden
        // (e.g. when switching to the Git / Extensions view container and
        // back). Without this, VS Code tears the webview down on hide and
        // reloads it on reveal, which reintroduced the "info randomly gone
        // on return" bug: the provider's visibility replay could post to a
        // webview whose reloaded script hadn't yet attached its message
        // listener, dropping the replayed state. Retaining context means the
        // rendered cards + advisories simply persist across the switch, no
        // replay race. Full panel closes still tear down and are handled by
        // `handleWebviewReady`/`replayCachedState`.
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );
  for (const editor of vscode.window.visibleNotebookEditors) {
    void inlineSummaryManager.clearInlineSummaries(editor.notebook);
  }

  function getCodeCellOrder(notebook: vscode.NotebookDocument): string[] {
    // Returns an ordered list of stable cell ids for code cells only,
    // matching the order they appear in the notebook.
    return notebook
      .getCells()
      .filter((c) => !isInlineSummaryCell(c))
      .filter((c) => c.kind === vscode.NotebookCellKind.Code)
      .map((c, i) => getStableCellId(c, notebook.getCells().indexOf(c)));
  }

  const MOVE_RECONCILE_WINDOW_MS = 800;
  const INLINE_NOTE_EDIT_DEBOUNCE_MS = 800;
  const pendingCellUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingStaleDetect = new Map<string, ReturnType<typeof setTimeout>>();
  let pendingInlineNoteRefresh: ReturnType<typeof setTimeout> | undefined;

  // Flipped once on deactivation (see clearPendingCellUpdates below).
  // clearTimeout only prevents a *future* firing -- a timer whose
  // callback has already started running (e.g. mid-await on a backend
  // HTTP call) keeps executing to completion regardless. Every timer
  // callback below checks this flag before doing any further work
  // (backend calls, webview postMessage) so a straggler that fires
  // around teardown becomes a harmless no-op instead of touching a
  // disposed webview or making a pointless/unhandled network request.
  let isDisposed = false;

  function scheduleInlineNoteRefresh(): void {
    if (inlineSummaryManager.getMode() !== "inline") {
      return;
    }

    if (pendingInlineNoteRefresh) {
      clearTimeout(pendingInlineNoteRefresh);
    }

    pendingInlineNoteRefresh = setTimeout(() => {
      pendingInlineNoteRefresh = undefined;
      if (isDisposed) {
        return;
      }
      void inlineSummaryManager.refreshInlineSummaries();
    }, INLINE_NOTE_EDIT_DEBOUNCE_MS);
  }

  // Records, per cell id, the source text that was present the last time
  // the cell executed. A cell is "edit-stale" when its current source no
  // longer matches this — i.e. it was changed after it last ran, so its
  // shown output reflects old code. This is the extension-side half of
  // staleness detection; the backend owns order-staleness (execution_count).
  const executedSourceByCell = new Map<string, string>();

  // Debounce edit-staleness re-checks: text edits fire per keystroke, but
  // recomputing staleness on every one would be wasteful (and the backend
  // order-stale call is a round-trip). One timer per notebook.
  function scheduleStaleDetect(notebook: vscode.NotebookDocument): void {
    const key = notebook.uri.toString();
    const existing = pendingStaleDetect.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      pendingStaleDetect.delete(key);
      if (isDisposed) {
        return;
      }
      void detectAndPostStaleCells(
        provider,
        readNotebookForBackend(notebook),
        executedSourceByCell,
      );
    }, STALE_DETECT_DEBOUNCE_MS);
    pendingStaleDetect.set(key, timer);
  }

  // Source of truth for the current canvas state, maintained in the
  // extension host so it survives webview cold-opens. Replayed as a
  // fresh indexResult whenever the sidebar is revealed from hidden.
  // Tracks cell data by cellId, and a separate ordered list of cellIds
  // since a Map has no inherent order.
  const currentCellsMap = new Map<string, TrackedCellData>();
  let currentCellOrder: string[] = [];
  // The notebook_id the canvas is currently showing, set whenever a fresh
  // indexResult is posted. Attached to subsequent notebook-scoped messages
  // (cellUpdated, cellDeleted, cellsReordered, advisor results) so the
  // webview provider can detect and drop results that resolve after a
  // different notebook has already become current.
  let currentNotebookId: string | undefined;

  function getOrderedCells(): Array<
    NonNullable<ReturnType<typeof currentCellsMap.get>>
  > {
    return currentCellOrder
      .map((id) => currentCellsMap.get(id))
      .filter((cell): cell is NonNullable<typeof cell> => cell !== undefined);
  }

  function replayCurrentCells(): void {
    provider.postMessage({
      type: "indexResult",
      data: getOrderedCells(),
      viewMode: inlineSummaryManager.getMode(),
      notebookId: currentNotebookId,
      // This is a replay of already-known state (e.g. a view-mode toggle),
      // not a genuine re-index — the backend hasn't re-embedded anything and
      // no fresh advisor pass follows. isFreshIndex must stay false/absent
      // so postMessage doesn't wipe the duplicate/dead/stale caches; see the
      // isFreshIndex comment on the postIndexResult call site below.
      isFreshIndex: false,
    });
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

        const result = await indexNotebookForDisplay(request);
        await postIndexResult(
          provider,
          request,
          result,
          currentCellsMap,
          (order) => {
            currentCellOrder = order;
          },
          inlineSummaryManager,
          (notebookId) => {
            currentNotebookId = notebookId;
          },
        );

        // Advisor: flag likely-dead code cells across the whole notebook.
        await detectAndPostDeadCells(provider, request);

        // Advisor: flag likely-stale (out-of-order / edited) code cells.
        await detectAndPostStaleCells(provider, request, executedSourceByCell);

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
              .filter((c) => !isInlineSummaryCell(c))
              .filter((c) => c.kind === vscode.NotebookCellKind.Code)
              .map((c) => getStableCellId(c, cells.indexOf(c)))
              .filter((id) => currentCellsMap.has(id));

            const allCellIds = getBackendNotebookCells(editor.notebook).map((c, i) =>
              getStableCellId(c, i),
            );
            provider.postMessage({
              type: "cellUpdated",
              data: cellData,
              notebookId: editor.notebook.uri.fsPath,
            });
            provider.postMessage({
              type: "cellsReordered",
              data: { cellIds: allCellIds },
              notebookId: editor.notebook.uri.fsPath,
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

      // NOTE: do NOT call replayCurrentCells() here. Populating a revealed
      // view is owned by `handleWebviewReady` (via the webview's
      // `webviewReady` handshake), which replays the cached index AND its
      // advisories. replayCurrentCells posts a bare `indexResult` tagged
      // `isFreshIndex: false`, so it no longer clobbers the dead/stale/
      // duplicate caches the way it used to (see the isFreshIndex handling
      // in `postMessage`) -- but it's still a redundant, notebook-wide
      // re-render for what only needs to focus the search box, so it's
      // skipped here regardless. The 100ms delay just gives a freshly
      // recreated webview a
      // moment to be ready to receive the (cosmetic) focus message.
      setTimeout(() => {
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
        if (inlineSummaryManager.getMode() === "sidebar") {
          await inlineSummaryManager.clearInlineSummaries(notebook);
        }

        const request = readNotebookForBackend(notebook);

        console.log("Auto-indexing opened notebook:", notebook.uri.toString());

        const result = await indexNotebookForDisplay(request);
        await postIndexResult(
          provider,
          request,
          result,
          currentCellsMap,
          (order) => {
            currentCellOrder = order;
          },
          inlineSummaryManager,
          (notebookId) => {
            currentNotebookId = notebookId;
          },
        );

        // Advisor: flag likely-dead code cells across the whole notebook.
        await detectAndPostDeadCells(provider, request);

        // Advisor: flag likely-stale (out-of-order / edited) code cells.
        await detectAndPostStaleCells(provider, request, executedSourceByCell);

        vscode.window.showInformationMessage(
          `Notebook indexed: ${result.length} cells`,
        );
      } catch (error) {
        console.error("Auto-index notebook failed:", error);
      }
    },
  );

  // executedSourceByCell accumulates one entry per cell id, for every
  // notebook ever opened in this session, and nothing else prunes it (it's
  // only ever deleted per-cell on a real cell delete). Left unchecked, a
  // long-running session that opens and closes many notebooks grows this
  // map without bound. Once a notebook closes, its cells' source snapshots
  // are meaningless (there's nothing left to detect edit-staleness in), so
  // clear them here.
  const notebookCloseListener = vscode.workspace.onDidCloseNotebookDocument(
    (notebook) => {
      for (const cell of notebook.getCells()) {
        if (isInlineSummaryCell(cell)) {
          continue;
        }
        executedSourceByCell.delete(getStableCellId(cell, cell.index));
      }

      // Also drop any still-pending debounced staleness re-check for this
      // notebook -- there's nothing left to detect staleness in.
      const key = notebook.uri.toString();
      const pendingTimer = pendingStaleDetect.get(key);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingStaleDetect.delete(key);
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
          if (isInlineSummaryCell(addedCell)) {
            continue;
          }
          addedIdsThisEvent.add(getStableCellId(addedCell, addedCell.index));
        }
        for (const removedCell of change.removedCells) {
          if (isInlineSummaryCell(removedCell)) {
            continue;
          }
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

          if (isDisposed) {
            return;
          }

          // Keep extension-side state in sync.
          currentCellsMap.delete(cellId);
          currentCellOrder = currentCellOrder.filter((id) => id !== cellId);
          executedSourceByCell.delete(cellId);

          provider.postMessage({
            type: "cellDeleted",
            data: { cellId },
            notebookId: event.notebook.uri.fsPath,
          });

          (async () => {
            try {
              await deleteCell(cellId, event.notebook.uri.fsPath);
              console.log("Cell deleted from backend:", cellId);

              // Deleting a cell can orphan a definition elsewhere (e.g. the
              // only reader of `df` is gone), so re-check dead cells.
              await detectAndPostDeadCells(
                provider,
                readNotebookForBackend(event.notebook),
              );

              // Removing a cell also changes the dependency graph, which can
              // flip downstream cells' order-staleness — re-check.
              await detectAndPostStaleCells(
                provider,
                readNotebookForBackend(event.notebook),
                executedSourceByCell,
              );
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
        const cellIds = getBackendNotebookCells(event.notebook)
          .map((cell, index) => getStableCellId(cell, index));

        // Keep extension-side state in sync — reorder only, don't touch
        // map values since cell content hasn't changed.
        currentCellOrder = cellIds.filter((id) => currentCellsMap.has(id));

        provider.postMessage({
          type: "cellsReordered",
          data: { cellIds },
          notebookId: event.notebook.uri.fsPath,
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

      // Handle cell edits and executions
      for (const change of event.cellChanges) {
        if (change.cell.kind === vscode.NotebookCellKind.Markup) {
          if (change.document && isInlineSummaryCell(change.cell)) {
            scheduleInlineNoteRefresh();
          }
          continue;
        }

        if (change.cell.kind !== vscode.NotebookCellKind.Code) {
          continue;
        }

        // A text edit to a code cell may make it edit-stale: its source no
        // longer matches what last ran. Debounced re-check (no execution
        // happened, so nothing else fires here).
        if (change.document) {
          scheduleStaleDetect(event.notebook);
        }

        if (!change.outputs && !change.executionSummary) {
          continue;
        }

        // The cell just executed: record the source that actually ran so a
        // later edit can be detected as staleness, and so any prior
        // edit-staleness for this cell now clears.
        executedSourceByCell.set(
          getStableCellId(change.cell, change.cell.index),
          change.cell.document.getText(),
        );

        const updateKey = `${event.notebook.uri.toString()}::${change.cell.document.uri.toString()}`;
        const existingTimer = pendingCellUpdates.get(updateKey);

        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
          pendingCellUpdates.delete(updateKey);

          if (isDisposed) {
            return;
          }

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
                  .filter((c) => !isInlineSummaryCell(c))
                  .filter((c) => c.kind === vscode.NotebookCellKind.Code)
                  .map((c, i) => getStableCellId(c, cells.indexOf(c)))
                  .filter((id) => currentCellsMap.has(id));

                // Also tell the webview to reorder so the live canvas matches —
                // cellsReordered won't have fired for this execution-triggered
                // addition (only structural adds trigger addedIdsThisEvent).
                const allCellIds = getBackendNotebookCells(event.notebook).map(
                  (c, i) => getStableCellId(c, i),
                );
                provider.postMessage({
                  type: "cellUpdated",
                  data: cellData,
                  notebookId: event.notebook.uri.fsPath,
                });
                provider.postMessage({
                  type: "cellsReordered",
                  data: { cellIds: allCellIds },
                  notebookId: event.notebook.uri.fsPath,
                });
              }

              await inlineSummaryManager.updateCells(getOrderedCells());

              // Check for near-duplicate cells after the vector store is updated.
              // Wrapped in its own try/catch so a failure here never suppresses
              // the main cell-update result above.
              try {
                const duplicates = await findDuplicateCells({
                  notebook_id: event.notebook.uri.fsPath,
                  cell_id: result.cell_id,
                });
                if (duplicates.length > 0) {
                  const group = [
                    result.cell_id,
                    ...duplicates.map((d) => d.cell_id),
                  ];
                  provider.postMessage({
                    type: "duplicatesDetected",
                    data: { group },
                    notebookId: event.notebook.uri.fsPath,
                  });
                  console.log("Duplicate cells detected:", group);
                }
              } catch (dupError) {
                console.error("Duplicate check failed:", dupError);
              }

              // Re-run whole-notebook dead-cell detection: this cell's new
              // content can make another cell newly-dead (or newly-alive).
              await detectAndPostDeadCells(
                provider,
                readNotebookForBackend(event.notebook),
              );

              // Re-run staleness: this execution bumped the cell's
              // execution_count (may flip downstream order-staleness) and
              // cleared its own edit-staleness (source now matches what ran).
              await detectAndPostStaleCells(
                provider,
                readNotebookForBackend(event.notebook),
                executedSourceByCell,
              );
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
    // Set first: any timer callback that fires after this point (its
    // clearTimeout below loses that race) checks this flag and bails out
    // before touching the backend or the webview.
    isDisposed = true;

    for (const timer of pendingCellUpdates.values()) {
      clearTimeout(timer);
    }
    pendingCellUpdates.clear();

    for (const timer of pendingDeletions.values()) {
      clearTimeout(timer);
    }
    pendingDeletions.clear();

    for (const timer of pendingStaleDetect.values()) {
      clearTimeout(timer);
    }
    pendingStaleDetect.clear();

    if (pendingInlineNoteRefresh) {
      clearTimeout(pendingInlineNoteRefresh);
      pendingInlineNoteRefresh = undefined;
    }

    void inlineSummaryManager.clearInlineSummaries();
  });

  context.subscriptions.push(
    indexNotebookCommand,
    updateCellCommand,
    searchNotebookCommand,
    notebookOpenListener,
    notebookCloseListener,
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

/**
 * Run whole-notebook dead-cell detection and relay the result to the
 * webview. Advisory-only: this never modifies the notebook. The result is
 * a full replacement of the notebook's current dead-cell set, so it is
 * always safe to call after any structural change (index, cell update,
 * delete). Wrapped so a failure here never disrupts the caller.
 */
async function detectAndPostDeadCells(
  provider: SemanticCanvasWebviewProvider,
  request: BackendNotebookRequest,
): Promise<void> {
  try {
    const deadCells = await findDeadCells(request);

    provider.postMessage({
      type: "deadCellsDetected",
      data: { cells: deadCells },
      notebookId: request.notebook_id,
    });

    if (deadCells.length > 0) {
      console.log(
        "Dead cells detected:",
        deadCells.map((cell) => cell.cell_id),
      );
    }
  } catch (error) {
    console.error("Dead cell detection failed:", error);
  }
}

/**
 * Run whole-notebook staleness detection and relay the merged result to
 * the webview. Two independent signals are combined into one flag set:
 *
 *  - Order-staleness (backend): a cell whose dependency ran more recently
 *    than it did, per kernel execution_count, or is itself stale.
 *  - Edit-staleness (extension): a cell whose current source no longer
 *    matches the source that was present when it last executed.
 *
 * Both mean the same thing to the user — "this cell's shown output is a
 * lie, re-run it" — so they are greyed out identically in the canvas. The
 * result is a full replacement of the stale set, safe to call after any
 * change. Advisory-only: nothing is ever modified. Executed-but-unseen
 * cells are seeded so an opened notebook doesn't flag every executed cell.
 */
async function detectAndPostStaleCells(
  provider: SemanticCanvasWebviewProvider,
  request: BackendNotebookRequest,
  executedSourceByCell: Map<string, string>,
): Promise<void> {
  try {
    // Seed executed source for already-executed cells not seen run this
    // session, so opening a notebook doesn't flag every executed cell as
    // edited. Conservative: assume the saved state is self-consistent.
    for (const cell of request.content.cells) {
      if (cell.cell_type !== "code" || cell.execution_count == null) {
        continue;
      }
      if (!executedSourceByCell.has(cell.id)) {
        executedSourceByCell.set(cell.id, cell.source);
      }
    }

    // Order-staleness from the backend. Wrapped so a backend failure still
    // lets edit-staleness (which is purely local) be reported.
    let orderStale: BackendStaleCellResponse = [];
    try {
      orderStale = await findStaleCells(request);
    } catch (error) {
      console.error("Order-stale detection failed:", error);
    }

    // Merge by cell id. Edit-staleness is the more direct, actionable
    // cause ("you changed it"), so its reason wins when a cell is both.
    const reasons = new Map<string, string>();
    for (const item of orderStale) {
      reasons.set(item.cell_id, item.reason);
    }
    for (const cell of request.content.cells) {
      if (cell.cell_type !== "code") {
        continue;
      }
      const executedSource = executedSourceByCell.get(cell.id);
      if (executedSource !== undefined && executedSource !== cell.source) {
        reasons.set(
          cell.id,
          "This cell was changed after it last ran — its shown output " +
            "reflects the old code. Re-run to refresh.",
        );
      }
    }

    const cells = Array.from(reasons, ([cell_id, reason]) => ({
      cell_id,
      reason,
    }));

    provider.postMessage({
      type: "staleCellsDetected",
      data: { cells },
      notebookId: request.notebook_id,
    });

    if (cells.length > 0) {
      console.log(
        "Stale cells detected:",
        cells.map((cell) => cell.cell_id),
      );
    }
  } catch (error) {
    console.error("Stale cell detection failed:", error);
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
  currentCellsMap: Map<string, TrackedCellData>,
  setCurrentCellOrder: (order: string[]) => void,
  inlineSummaryManager: InlineSummaryManager,
  setCurrentNotebookId: (notebookId: string) => void,
): Promise<void> {
  const cellOrder = new Map(
    request.content.cells.map((cell, index) => [cell.id, index]),
  );
  const summariesByCellId = await getSummariesByCellId(request);
  const indexedCellsById = new Map(result.map((cell) => [cell.cell_id, cell]));

  const data = request.content.cells
    .filter((cell) => cell.cell_type === "code")
    .map((cell) => {
      const indexedCell = indexedCellsById.get(cell.id);
      const summary = summariesByCellId.get(cell.id);
      const cellIndex = cellOrder.get(cell.id) ?? null;

      const cellOrigin: CellOrigin =
        summary != null &&
        (summary.user_label != null || summary.user_summary != null)
          ? "human"
          : "ai";

      return {
        cellId: cell.id,
        cellLabel:
          summary?.display_label ??
          indexedCell?.label ??
          getCellLabel(cellIndex),
        cellDescription:
          summary?.display_summary ??
          indexedCell?.summary ??
          cell.source,
        cellContent: cell.source,
        cellIcon: "table" as const,
        cellOrigin,
      };
    });

  // Keep extension-side state in sync.
  currentCellsMap.clear();
  const newOrder: string[] = [];
  for (const cell of data) {
    currentCellsMap.set(cell.cellId, cell);
    newOrder.push(cell.cellId);
  }
  setCurrentCellOrder(newOrder);
  setCurrentNotebookId(request.notebook_id);
  await inlineSummaryManager.updateCells(data);

  provider.postMessage({
    type: "indexResult",
    data,
    viewMode: inlineSummaryManager.getMode(),
    notebookId: request.notebook_id,
    // A genuine backend re-index (cells re-embedded from scratch): any
    // previously detected duplicate/dead/stale flags are now stale and
    // should be cleared, since indexNotebookCommand/notebookOpenListener
    // both re-run the advisors right after this. Contrast with
    // replayCurrentCells, which echoes already-known state (e.g. a
    // sidebar/inline toggle) and must NOT clear the caches.
    isFreshIndex: true,
  });
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

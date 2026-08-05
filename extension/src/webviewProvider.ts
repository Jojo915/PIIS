import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";
import {
  getAiSettings,
  resetAiSettings,
  saveAiSettings,
  saveCellSummary,
  searchCells,
  suggestCellSummary,
} from "./backendClient";
import {
  getBackendNotebookCells,
  getCurrentNotebookEditor,
  getStableCellId,
} from "./notebookReader";
import {
  BackendAiSettingsRequest,
  BackendAiSettingsSaveResponse,
  BackendSearchResponse,
  CellId,
  CellOrigin,
} from "./types";
import { SummaryViewMode } from "./inlineSummaryManager";

// How many of the ranked /search results render as "Top Matches" before the
// rest fall into the collapsed "Others..." dropdown. The backend fetches
// TOP_MATCHES_COUNT + OTHERS_COUNT results so both buckets are always full
// (or as full as the collection allows). Adjust either constant here and
// the retrieve_documents call below stays consistent automatically.
const TOP_MATCHES_COUNT = 3;
const OTHERS_COUNT = 5;

export class SemanticCanvasWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = "semanticCanvas.sidebar";

  private _view?: vscode.WebviewView;
  private _latestIndexResultMessage?: unknown;
  // The notebook the cache currently reflects, taken from the most recent
  // `indexResult` message. Used to reject stale, notebook-scoped messages
  // that arrive after the cache has already moved on to a different
  // notebook -- see `isForeignNotebookMessage`.
  private _currentNotebookId?: string;
  // The latest duplicate-cluster advisory message, cached so the amber
  // "duplicate" flags survive the webview being closed and reopened.
  // Duplicate-cluster detection is a whole-notebook, complete-linkage
  // re-cluster that replaces the entire set each time (see
  // app.analysis.duplicate_clusters on the backend), so -- like dead/stale
  // cells below -- caching the single most-recent message is sufficient;
  // there is no incremental per-group merge to track anymore.
  private _latestDuplicatesMessage?: unknown;
  // The latest dead-cell advisory message, cached so the amber/grey
  // "dead code" flags survive the webview being closed and reopened.
  // Dead-cell detection replaces the whole set each time, so caching the
  // single most-recent message is sufficient.
  private _latestDeadCellsMessage?: unknown;
  // The latest stale-cell advisory message, cached so the greyed-out
  // "needs re-run" flags survive the webview being closed and reopened.
  // Like dead cells, staleness replaces the whole set each time, so the
  // single most-recent message is all that needs caching.
  private _latestStaleCellsMessage?: unknown;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onSummaryViewModeChange?: (
      mode: SummaryViewMode,
    ) => Promise<void>,
    private readonly onSummarySaved?: (
      cellId: CellId,
      label: string,
      summary: string,
      origin: CellOrigin,
    ) => Promise<void>,
    private readonly onReplaceAll?: (
      appliedCellIds: CellId[],
    ) => Promise<void>,
    // Fired after a successful `saveAiSettings` round-trip. The provider
    // itself has no notion of "the current notebook" beyond what
    // getCurrentNotebookEditor() can find, and the reindex-on-new-key
    // decision needs to reuse the same full-reindex logic the
    // semanticCanvas.indexNotebook command already owns in extension.ts --
    // so, like onSummarySaved/onReplaceAll, this just hands the raw result
    // (including api_key_changed) up to the caller rather than trying to
    // own that decision here.
    private readonly onAiSettingsSaved?: (
      result: BackendAiSettingsSaveResponse,
    ) => Promise<void>,
  ) {}

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
              message.origin,
            );
            break;

          case "suggestSummary":
            await this.suggestSummary(message.cellId);
            break;

          case "setSummaryViewMode":
            await this.setSummaryViewMode(message.mode);
            break;

          case "replaceAll":
            await this.replaceAll(message.replacements);
            break;

          case "getAiSettings":
            await this.getAiSettings();
            break;

          case "saveAiSettings":
            await this.saveAiSettings(message.data);
            break;

          case "resetAiSettings":
            await this.resetAiSettings();
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

        if (message.type === "replaceAll") {
          this._view?.webview.postMessage({
            type: "replaceAllError",
            error: getErrorMessage(error),
          });
          return;
        }

        if (message.type === "saveAiSettings") {
          this._view?.webview.postMessage({
            type: "aiSettingsSaveError",
            error: getErrorMessage(error),
          });
          return;
        }

        if (message.type === "resetAiSettings") {
          this._view?.webview.postMessage({
            type: "aiSettingsResetError",
            error: getErrorMessage(error),
          });
          return;
        }

        if (message.type === "getAiSettings") {
          this._view?.webview.postMessage({
            type: "aiSettingsLoadError",
            error: getErrorMessage(error),
          });
          return;
        }

        this._view?.webview.postMessage({
          type: "searchError",
          error: getErrorMessage(error),
        });
      }
    });

    // Replay the cached index + advisories whenever the view becomes visible.
    // VS Code tears down a hidden webview but does NOT reliably reload its
    // script on reveal, so `webviewReady` (which drives `handleWebviewReady`)
    // fires only sometimes on reopen — leaving the view randomly blank when it
    // doesn't. Replaying on visibility change closes that gap: if the script
    // did reload, `webviewReady` replays first and this is a harmless re-post
    // of the same cached state; if it didn't, this is the only replay that
    // fires. `replayCachedState` no-ops on a cold cache, so first-time
    // population still flows through `handleWebviewReady`'s index path.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.replayCachedState();
      }
    });

    webviewView.webview.html = this.getHtml(webviewView.webview, uiRoot);
    // NOTE: do NOT kick off an index here. The webview posts `webviewReady`
    // once its script has loaded, and `handleWebviewReady` is the single
    // source of truth for populating a freshly (re)opened view: it indexes
    // when the cache is empty (cold start) and replays the cached index +
    // advisories when it isn't (reopen). An unconditional timer here used to
    // race that replay — on reopen it fired a redundant re-index that reset
    // the advisory caches (see `postMessage`) and, if the notebook wasn't the
    // active editor at that moment, dropped the flags until the next cell
    // execution. Letting `handleWebviewReady` own this removes the race.
  }

  private async handleWebviewReady(): Promise<void> {
    if (this._latestIndexResultMessage !== undefined) {
      await this.replayCachedState();
      return;
    }

    await vscode.commands.executeCommand("semanticCanvas.indexNotebook");
  }

  /**
   * Re-post the cached index result and all advisory flags (duplicates, dead
   * cells, stale cells) to the current webview. This is the single mechanism
   * that repopulates a revealed view from the provider's cache.
   *
   * It is invoked from two places: `handleWebviewReady` (when the webview
   * script freshly loads and posts `webviewReady`) and the view's
   * `onDidChangeVisibility` handler (when VS Code reveals a view that was
   * torn down on hide but NOT reloaded — in which case no `webviewReady`
   * fires). Wiring both is deliberate: VS Code is nondeterministic about
   * whether a revealed view reloads its script, so relying on `webviewReady`
   * alone left reopens (notably via ctrl+f) randomly blank. Replaying on
   * visibility as well makes reveal-time population deterministic.
   *
   * No-ops when there is nothing cached yet (cold start), so the cold-start
   * index path in `handleWebviewReady` still owns first-time population.
   */
  private async replayCachedState(): Promise<void> {
    if (this._latestIndexResultMessage === undefined) {
      return;
    }

    await this._view?.webview.postMessage(this._latestIndexResultMessage);
    // Restore the duplicate-cluster advisories too.
    if (this._latestDuplicatesMessage !== undefined) {
      await this._view?.webview.postMessage(this._latestDuplicatesMessage);
    }
    // Restore the dead-cell advisories too.
    if (this._latestDeadCellsMessage !== undefined) {
      await this._view?.webview.postMessage(this._latestDeadCellsMessage);
    }
    // Restore the stale-cell advisories too.
    if (this._latestStaleCellsMessage !== undefined) {
      await this._view?.webview.postMessage(this._latestStaleCellsMessage);
    }
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
        n_results: TOP_MATCHES_COUNT + OTHERS_COUNT,
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

  private async persistSummary(
    cellId: CellId,
    label: string | null,
    summary: string | null,
  ): Promise<{ savedLabel: string; savedSummary: string }> {
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

    return {
      savedLabel: result.display_label ?? result.ai_label ?? "",
      savedSummary: result.display_summary ?? "",
    };
  }

  private async saveSummary(
    cellId: CellId,
    label: string | null,
    summary: string | null,
    origin: unknown,
  ): Promise<void> {
    const { savedLabel, savedSummary } = await this.persistSummary(
      cellId,
      label,
      summary,
    );
    const resolvedOrigin: CellOrigin = origin === "human" ? "human" : "ai";
    this.updateCachedCellDetails(cellId, savedLabel, savedSummary, resolvedOrigin);
    await this.onSummarySaved?.(cellId, savedLabel, savedSummary, resolvedOrigin);

    this._view?.webview.postMessage({
      type: "summarySaved",
      data: {
        cellId,
        label: savedLabel,
        summary: savedSummary,
      },
    });
  }

  public async saveHandEditedSummary(
    cellId: CellId,
    label: string,
    summary: string,
  ): Promise<{ savedLabel: string; savedSummary: string }> {
    const { savedLabel, savedSummary } = await this.persistSummary(
      cellId,
      label,
      summary,
    );
    this.updateCachedCellDetails(cellId, savedLabel, savedSummary, "human");
    return { savedLabel, savedSummary };
  }

  private async setSummaryViewMode(mode: unknown): Promise<void> {
    if (mode !== "sidebar" && mode !== "inline") {
      throw new Error(`Unknown summary view mode: ${String(mode)}`);
    }

    await this.onSummaryViewModeChange?.(mode);
  }

  private updateCachedCellDetails(
    cellId: CellId,
    label: string,
    summary: string,
    origin: CellOrigin,
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
          cellOrigin: origin,
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

  private async replaceAll(
    replacements: Array<{ cellId: CellId; newContent: string }>,
  ): Promise<void> {
    const editor = getCurrentNotebookEditor();

    if (!editor) {
      throw new Error("No active notebook editor found.");
    }

    const cellsById = new Map(
      getBackendNotebookCells(editor.notebook).map((cell, index) => [
        getStableCellId(cell, index),
        cell,
      ]),
    );

    const edit = new vscode.WorkspaceEdit();
    const appliedCellIds: CellId[] = [];

    for (const { cellId, newContent } of replacements) {
      const cell = cellsById.get(cellId);
      if (!cell || cell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }
      if (cell.document.getText() === newContent) {
        continue;
      }

      const fullRange = new vscode.Range(0, 0, cell.document.lineCount, 0);
      edit.replace(cell.document.uri, fullRange, newContent);
      appliedCellIds.push(cellId);
    }

    if (appliedCellIds.length === 0) {
      this._view?.webview.postMessage({
        type: "replaceAllComplete",
        data: { count: 0, cellIds: [] },
      });
      return;
    }

    const applied = await vscode.workspace.applyEdit(edit);

    if (!applied) {
      throw new Error("Failed to apply replacements to the notebook.");
    }

    await this.onReplaceAll?.(appliedCellIds);

    this._view?.webview.postMessage({
      type: "replaceAllComplete",
      data: { count: appliedCellIds.length, cellIds: appliedCellIds },
    });
  }

  /**
   * Called when the webview loads and needs to hydrate the (collapsed)
   * AI Settings card. Global, not notebook-scoped -- unlike the rest of
   * this provider's caching, there is nothing to keep in sync per notebook
   * here, so this is a plain pass-through with no local cache.
   *
   * Backend endpoint:
   * GET /settings
   */
  private async getAiSettings(): Promise<void> {
    const settings = await getAiSettings();

    this._view?.webview.postMessage({
      type: "aiSettingsLoaded",
      data: settings,
    });
  }

  /**
   * Called when the user clicks Save in the AI Settings panel.
   *
   * Backend endpoint:
   * POST /settings
   *
   * The reindex decision (only when `api_key_changed` is true) is owned by
   * the caller via `onAiSettingsSaved` -- this method's only job is the
   * round-trip and relaying the result, mirroring `saveSummary`'s split
   * between "persist" and "notify caller" responsibilities.
   */
  private async saveAiSettings(data: unknown): Promise<void> {
    const payload = toAiSettingsRequest(data);
    const result = await saveAiSettings(payload);

    await this.onAiSettingsSaved?.(result);

    this._view?.webview.postMessage({
      type: "aiSettingsSaved",
      data: result,
    });
  }

  /**
   * Called when the user clicks Reset in the AI Settings panel.
   *
   * Backend endpoint:
   * POST /settings/reset
   *
   * A reset always clears the API key, so from the reindex perspective it
   * is equivalent to "the key changed" -- but per the feature spec, Reset
   * only restores defaults and persists them; it does not itself trigger a
   * reindex (there is no new key to index *with*, so re-embedding the
   * notebook would just reproduce the same vectors). Only Save triggers a
   * reindex, and only for a new/changed key.
   */
  private async resetAiSettings(): Promise<void> {
    const settings = await resetAiSettings();

    this._view?.webview.postMessage({
      type: "aiSettingsReset",
      data: settings,
    });
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

  // Message types produced by a backend round-trip that describes one
  // specific notebook (a whole-notebook advisor scan, or a per-cell
  // update/delete/reorder). These are the ones that can arrive after the
  // cache has already moved on to a different notebook -- see postMessage.
  private static readonly NOTEBOOK_SCOPED_MESSAGE_TYPES = new Set([
    "cellUpdated",
    "cellDeleted",
    "cellsReordered",
    "deadCellsDetected",
    "staleCellsDetected",
    "duplicatesDetected",
  ]);

  /**
   * True when `message` is tagged with a `notebookId` that names a
   * notebook other than the one the cache currently reflects. Messages
   * with no `notebookId` (e.g. from a call site that hasn't been updated
   * to attach one) or arriving before any notebook has been cached are
   * treated conservatively as belonging to the current notebook, so they
   * are never dropped by this check -- only a confirmed mismatch is.
   */
  private isForeignNotebookMessage(message: unknown): boolean {
    if (typeof message !== "object" || message === null) {
      return false;
    }

    const type = (message as { type?: unknown }).type;
    if (
      typeof type !== "string" ||
      !SemanticCanvasWebviewProvider.NOTEBOOK_SCOPED_MESSAGE_TYPES.has(type)
    ) {
      return false;
    }

    const notebookId = getMessageNotebookId(message);
    if (notebookId === undefined || this._currentNotebookId === undefined) {
      return false;
    }

    return notebookId !== this._currentNotebookId;
  }

  public postMessage(message: unknown): void {
    if (isIndexResultMessage(message)) {
      // An indexResult is the single point where "which notebook is this
      // cache for" can change -- accept it unconditionally and let it
      // redefine `_currentNotebookId`, even if that's a different notebook
      // than whatever was cached before. This applies whether the message
      // is a genuine re-index or a replay (see below) -- both carry the
      // authoritative current cell list.
      this._currentNotebookId = getMessageNotebookId(message);
      this._latestIndexResultMessage = message;
      // Only a *genuine* re-index (isFreshIndex: true) means previously
      // detected duplicate/dead/stale flags are now stale -- the cells were
      // just re-embedded from scratch, and a fresh detection pass follows
      // right after. A *replay* of already-known state (isFreshIndex not
      // true; e.g. `replayCurrentCells` echoing the current cells after a
      // sidebar/inline view-mode toggle) reflects a notebook that hasn't
      // actually changed, so clearing the caches here would just erase
      // advisories that remain valid and nothing would repopulate them
      // until the next real change -- this was the bug where toggling to
      // inline view and back to sidebar silently dropped duplicate/dead/
      // stale flags.
      if (message.isFreshIndex) {
        this._latestDuplicatesMessage = undefined;
        this._latestDeadCellsMessage = undefined;
        this._latestStaleCellsMessage = undefined;
      }
    } else if (this.isForeignNotebookMessage(message)) {
      // A whole-notebook advisor call (findDeadCells/findStaleCells) or a
      // per-cell backend round-trip (updateCell/deleteCell/reorderNotebook)
      // can still be in flight when the user opens or switches to a
      // different notebook before it resolves. Without this guard, the
      // late-arriving result would silently overwrite the cache -- and the
      // live webview -- with another notebook's flags. Drop it: it's stale
      // by the time it arrives, and the relevant advisor/index path already
      // re-runs for whichever notebook is now current.
      console.warn(
        "Discarding webview message for a non-current notebook:",
        (message as { type?: unknown }).type,
      );
      return;
    } else if (isDeadCellsDetectedMessage(message)) {
      this._latestDeadCellsMessage = message;
    } else if (isStaleCellsDetectedMessage(message)) {
      this._latestStaleCellsMessage = message;
    } else if (isDuplicatesDetectedMessage(message)) {
      // Full replace, mirroring dead/stale: duplicate-cluster detection is
      // now a whole-notebook, complete-linkage re-cluster (see
      // app.analysis.duplicate_clusters on the backend), not an incremental
      // per-group merge, so the incoming message's `groups` is always the
      // complete, authoritative current set -- including the empty-array
      // case used to explicitly hide flags when the checkbox is off.
      this._latestDuplicatesMessage = message;
    } else if (isCellClearedMessage(message)) {
      // cellUpdated and cellDeleted both update the cached index. Duplicate/
      // dead/stale flags for the affected cell are not eagerly patched here
      // -- the whole-notebook advisor re-run that always follows this
      // message (see runAdvisors in extension.ts) posts a fresh, complete
      // replacement for all three shortly after.
      const cellId = message.data.cellId;

      if (isIndexResultMessage(this._latestIndexResultMessage)) {
        if (isCellUpdatedMessage(message)) {
          const existingIndex = this._latestIndexResultMessage.data.findIndex(
            (cell) => cell.cellId === cellId,
          );
          const nextData =
            existingIndex !== -1
              ? this._latestIndexResultMessage.data.map((cell, index) =>
                  index === existingIndex ? message.data : cell,
                )
              : [...this._latestIndexResultMessage.data, message.data];

          this._latestIndexResultMessage = {
            ...this._latestIndexResultMessage,
            data: nextData,
          };
        } else {
          this._latestIndexResultMessage = {
            ...this._latestIndexResultMessage,
            data: this._latestIndexResultMessage.data.filter(
              (cell) => cell.cellId !== cellId,
            ),
          };
        }
      }
    } else if (
      isCellsReorderedMessage(message) &&
      isIndexResultMessage(this._latestIndexResultMessage)
    ) {
      // A reorder posts `cellsReordered`, not a fresh `indexResult`, so the
      // cached index (replayed by handleWebviewReady on the next reveal) would
      // otherwise keep the pre-move order. Reorder the cache to match, mirroring
      // the webview's own `cellsReordered` handling: rebuild by the incoming id
      // order via a lookup map, dropping ids we have no cell data for (e.g.
      // markdown cells, which never enter the code-cell index). This keeps a
      // while-closed reorder in sync when the view is later reopened — whether
      // by clicking the panel or via ctrl+f — without touching advisory caches.
      const byId = new Map(
        this._latestIndexResultMessage.data.map((cell) => [cell.cellId, cell]),
      );
      const reordered = message.data.cellIds
        .map((id) => byId.get(id))
        .filter(
          (cell): cell is IndexResultMessage["data"][number] =>
            cell !== undefined,
        );
      this._latestIndexResultMessage = {
        ...this._latestIndexResultMessage,
        data: reordered,
      };
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

/**
 * Convert the webview's camelCase `saveAiSettings` payload into the
 * backend's snake_case wire format. Kept here (rather than in the webview)
 * because every other backend-request shape in this codebase is built on
 * the extension side -- the webview only ever sends plain, UI-shaped data.
 *
 * `apiKey` is deliberately passed through as-is, including `undefined`/
 * empty string: an empty string means "the field was left blank", which
 * `saveAiSettings` (backend `/settings`) already treats as "no new key" --
 * see the `new_key_provided` check in `app.py`.
 */
function toAiSettingsRequest(data: unknown): BackendAiSettingsRequest {
  const payload = (data ?? {}) as {
    apiKey?: unknown;
    model?: unknown;
    customModel?: unknown;
    detectStaleCells?: unknown;
    detectDuplicateCells?: unknown;
    detectDeadCells?: unknown;
  };

  return {
    api_key:
      typeof payload.apiKey === "string" && payload.apiKey.length > 0
        ? payload.apiKey
        : null,
    model: typeof payload.model === "string" ? payload.model : "",
    custom_model:
      typeof payload.customModel === "string" ? payload.customModel : null,
    detect_stale_cells: Boolean(payload.detectStaleCells),
    detect_duplicate_cells: Boolean(payload.detectDuplicateCells),
    detect_dead_cells: Boolean(payload.detectDeadCells),
  };
}

/** Extract the `notebookId` field from a webview message, if present. */
function getMessageNotebookId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }

  const notebookId = (message as { notebookId?: unknown }).notebookId;
  return typeof notebookId === "string" ? notebookId : undefined;
}

interface IndexResultMessage {
  type: "indexResult";
  notebookId?: string;
  // True only for a genuine backend re-index (cells re-embedded from
  // scratch), as opposed to a replay of already-known state (e.g. a
  // sidebar/inline view-mode toggle). Only a genuine re-index invalidates
  // the duplicate/dead/stale advisory caches -- see postMessage.
  isFreshIndex?: boolean;
  data: Array<{
    cellId: string;
    cellLabel: string;
    cellDescription: string;
    cellContent?: string;
    cellIcon?: string;
    cellOrigin?: CellOrigin;
  }>;
}

function isIndexResultMessage(message: unknown): message is IndexResultMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const typedMessage = message as { type?: unknown; data?: unknown };

  return typedMessage.type === "indexResult" && Array.isArray(typedMessage.data);
}

interface DuplicatesDetectedMessage {
  type: "duplicatesDetected";
  notebookId?: string;
  data: { groups: string[][] };
}

function isDuplicatesDetectedMessage(
  message: unknown,
): message is DuplicatesDetectedMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const m = message as { type?: unknown; data?: { groups?: unknown } };
  return m.type === "duplicatesDetected" && Array.isArray(m.data?.groups);
}

interface DeadCellsDetectedMessage {
  type: "deadCellsDetected";
  notebookId?: string;
  data: { cells: unknown[] };
}

function isDeadCellsDetectedMessage(
  message: unknown,
): message is DeadCellsDetectedMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const m = message as { type?: unknown; data?: { cells?: unknown } };
  return m.type === "deadCellsDetected" && Array.isArray(m.data?.cells);
}

interface StaleCellsDetectedMessage {
  type: "staleCellsDetected";
  notebookId?: string;
  data: { cells: unknown[] };
}

function isStaleCellsDetectedMessage(
  message: unknown,
): message is StaleCellsDetectedMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const m = message as { type?: unknown; data?: { cells?: unknown } };
  return m.type === "staleCellsDetected" && Array.isArray(m.data?.cells);
}

// Covers both cellUpdated and cellDeleted — both carry { cellId } and both
// should clear any duplicate group that contains that cell.
interface CellClearedMessage {
  type: "cellUpdated" | "cellDeleted";
  notebookId?: string;
  data: { cellId: string };
}

function isCellClearedMessage(message: unknown): message is CellClearedMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const m = message as { type?: unknown; data?: { cellId?: unknown } };
  return (
    (m.type === "cellUpdated" || m.type === "cellDeleted") &&
    typeof m.data?.cellId === "string"
  );
}

interface CellUpdatedMessage {
  type: "cellUpdated";
  notebookId?: string;
  data: IndexResultMessage["data"][number];
}

function isCellUpdatedMessage(
  message: unknown,
): message is CellUpdatedMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const m = message as { type?: unknown; data?: Record<string, unknown> };
  return (
    m.type === "cellUpdated" &&
    typeof m.data?.cellId === "string" &&
    typeof m.data?.cellLabel === "string" &&
    typeof m.data?.cellDescription === "string"
  );
}

interface CellsReorderedMessage {
  type: "cellsReordered";
  notebookId?: string;
  data: { cellIds: string[] };
}

function isCellsReorderedMessage(
  message: unknown,
): message is CellsReorderedMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const m = message as { type?: unknown; data?: { cellIds?: unknown } };
  return m.type === "cellsReordered" && Array.isArray(m.data?.cellIds);
}

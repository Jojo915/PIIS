import * as assert from "assert";
import * as vscode from "vscode";
import { getStableCellId } from "../../src/notebookReader";
import {
  closeActiveEditor,
  getBackendRequests,
  hasReceivedRequest,
  openFixtureNotebook,
  resetBackendRequests,
  sleep,
  waitFor,
} from "./testUtils";

/**
 * Real Extension Host coverage for the move-vs-delete reconciliation logic
 * documented in CLAUDE.md ("Cell deletion vs. cell move" under
 * extension.ts): VS Code does not represent a notebook cell move as one
 * clean paired add+remove event, so extension.ts has to reconcile
 * same-event and cross-event add/remove pairs before deciding a cell was
 * genuinely deleted. This drives real `NotebookEdit`s against a real
 * opened notebook and asserts on what the extension actually sent to the
 * backend (via the fake backend's request log), the same signal a real
 * regression would show up as: an errant `DELETE /cells/{id}` call.
 */
describe("move vs delete reconciliation and reorder sync", () => {
  let editor: vscode.NotebookEditor;

  beforeEach(async () => {
    editor = await openFixtureNotebook();
    // Let the auto-index-on-open flow (POST /notebooks + advisors) settle
    // before each test resets the log, so it doesn't leak into assertions
    // made about the edit performed in the test itself.
    await waitFor(() => hasReceivedRequest("POST", "/notebooks"), 10000);
    await resetBackendRequests();
  });

  afterEach(async () => {
    await closeActiveEditor();
  });

  it("does not call DELETE for a same-event move (delete+insert in one WorkspaceEdit)", async () => {
    const notebook = editor.notebook;
    const originalOrder = notebook
      .getCells()
      .map((cell, index) => getStableCellId(cell, index));
    const movedCell = notebook.cellAt(0);

    const newCellData = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      movedCell.document.getText(),
      movedCell.document.languageId,
    );
    newCellData.metadata = movedCell.metadata;

    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [
      vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(0, 1)),
      // Append at the absolute end; using notebook.cellCount (not
      // cellCount - 1) keeps this unambiguous regardless of how VS Code
      // orders/relativizes the two edits internally.
      vscode.NotebookEdit.insertCells(notebook.cellCount, [newCellData]),
    ]);
    const applied = await vscode.workspace.applyEdit(edit);
    assert.ok(applied, "the move edit should apply successfully");

    await waitFor(() => hasReceivedRequest("PATCH", "/notebooks/reorder"));
    // Give the 800ms move-reconcile window plenty of margin to have fired
    // a wrongful deletion if the reconciliation logic were broken.
    await sleep(1200);

    const requests = await getBackendRequests();
    const deletes = requests.filter((r) => r.method === "DELETE");
    assert.strictEqual(
      deletes.length,
      0,
      `a same-event cell move must never call DELETE /cells/{id}, got: ${JSON.stringify(deletes)}`,
    );

    const reorderCall = requests.find(
      (r) => r.method === "PATCH" && r.path === "/notebooks/reorder",
    );
    assert.ok(reorderCall, "expected a PATCH /notebooks/reorder call");
    const body = reorderCall!.body as { cell_ids: string[] };
    assert.deepStrictEqual(
      body.cell_ids,
      [originalOrder[1], originalOrder[2], originalOrder[0]],
      "the synced order should reflect the moved cell now being last",
    );
  });

  it("does not call DELETE for a cross-event move (re-added moments later, separate applyEdit calls)", async () => {
    const notebook = editor.notebook;
    const movedCell = notebook.cellAt(0);
    const movedText = movedCell.document.getText();
    const movedLanguageId = movedCell.document.languageId;
    const movedMetadata = movedCell.metadata;

    const deleteEdit = new vscode.WorkspaceEdit();
    deleteEdit.set(notebook.uri, [
      vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(0, 1)),
    ]);
    await vscode.workspace.applyEdit(deleteEdit);

    // Re-add well within the 800ms MOVE_RECONCILE_WINDOW_MS, but via a
    // genuinely separate applyEdit call (a separate
    // onDidChangeNotebookDocument invocation) -- this exercises the
    // pendingDeletions cross-event fallback path, not the same-event
    // reconciliation path covered by the previous test. Reusing the same
    // cell metadata (as VS Code itself does for a real drag-move) is what
    // lets the extension's identity check (getStableCellId) recognize
    // this as the same logical cell reappearing.
    await sleep(300);

    const reAdded = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      movedText,
      movedLanguageId,
    );
    reAdded.metadata = movedMetadata;

    const insertEdit = new vscode.WorkspaceEdit();
    insertEdit.set(notebook.uri, [
      vscode.NotebookEdit.insertCells(notebook.cellCount, [reAdded]),
    ]);
    await vscode.workspace.applyEdit(insertEdit);

    // Wait past the full reconcile window measured from the original delete.
    await sleep(1200);

    const requests = await getBackendRequests();
    const deletes = requests.filter((r) => r.method === "DELETE");
    assert.strictEqual(
      deletes.length,
      0,
      `a cross-event move (re-added within the reconcile window) must not call DELETE, got: ${JSON.stringify(deletes)}`,
    );
  });

  it("does call DELETE for a genuine delete (no reappearance within the window)", async () => {
    const notebook = editor.notebook;
    const deletedCell = notebook.cellAt(0);
    const deletedId = getStableCellId(deletedCell, 0);

    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [
      vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(0, 1)),
    ]);
    await vscode.workspace.applyEdit(edit);

    await waitFor(() => hasReceivedRequest("DELETE", "/cells/"), 3000);

    const requests = await getBackendRequests();
    const deleteCall = requests.find((r) => r.method === "DELETE");
    assert.ok(deleteCall, "expected a real DELETE /cells/{id} call");
    assert.ok(
      decodeURIComponent(deleteCall!.path).includes(deletedId),
      `expected the DELETE path to reference the deleted cell id ${deletedId}, got ${deleteCall!.path}`,
    );
  });
});

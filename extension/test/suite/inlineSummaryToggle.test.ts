import * as assert from "assert";
import * as vscode from "vscode";
import {
  InlineSummaryCellData,
  InlineSummaryManager,
} from "../../src/inlineSummaryManager";
import { getStableCellId } from "../../src/notebookReader";
import { isInlineSummaryCell } from "../../src/inlineSummaryMetadata";
import { closeActiveEditor, openFixtureNotebook } from "./testUtils";

/**
 * Extension-side analog of the originally-reported bug (advisory flags
 * vanishing on an inline<->sidebar toggle -- see frontend/tests/
 * view_mode_sync.test.js for the webview-side regression test). This
 * suite exercises the *other* half of the same view-mode feature:
 * InlineSummaryManager, which is what actually inserts/removes the
 * managed markdown "note" cells into the real notebook when the user
 * toggles view modes. There's no public command/webview automation path
 * for triggering the toggle button itself through @vscode/test-electron,
 * so this drives InlineSummaryManager directly via its public API
 * (exactly the same calls extension.ts's onSummaryViewModeChange callback
 * makes), against a real, opened notebook editor.
 */
describe("InlineSummaryManager sidebar<->inline toggle", () => {
  let editor: vscode.NotebookEditor;
  let manager: InlineSummaryManager;
  let summaries: InlineSummaryCellData[];

  beforeEach(async () => {
    editor = await openFixtureNotebook();
    manager = new InlineSummaryManager();

    const codeCells = editor.notebook.getCells();
    // Deliberately punctuation-free: formatInlineSummary markdown-escapes
    // characters like "." and "!" (see escapeMarkdown in
    // inlineSummaryManager.ts), so a raw substring match against the
    // rendered note text would break on escaped punctuation. Keeping the
    // fixture text plain keeps these assertions about identity/content
    // correctness, not escaping behavior (which isn't what's under test
    // here).
    summaries = codeCells.map((cell, index) => ({
      cellId: getStableCellId(cell, index),
      cellLabel: `Label for cell ${index}`,
      cellDescription: `Summary text for cell ${index}`,
    }));
  });

  afterEach(async () => {
    await closeActiveEditor();
  });

  it("does not touch the notebook while in sidebar mode", async () => {
    await manager.updateCells(summaries);
    assert.strictEqual(editor.notebook.cellCount, 3);
  });

  it("inserts one managed note directly above each code cell when switching to inline", async () => {
    await manager.updateCells(summaries);
    await manager.setMode("inline");

    assert.strictEqual(
      editor.notebook.cellCount,
      6,
      "expected one inline note cell inserted per code cell",
    );

    const cells = editor.notebook.getCells();
    for (let i = 0; i < cells.length; i += 2) {
      const noteCell = cells[i];
      const codeCell = cells[i + 1];

      assert.ok(
        isInlineSummaryCell(noteCell),
        `cell at index ${i} should be a managed inline summary note`,
      );
      assert.strictEqual(codeCell.kind, vscode.NotebookCellKind.Code);

      const codeCellId = getStableCellId(codeCell, i + 1);
      const expected = summaries.find((s) => s.cellId === codeCellId);
      assert.ok(expected, `no expected summary found for code cell ${codeCellId}`);
      assert.ok(
        noteCell.document.getText().includes(expected!.cellLabel),
        `note above cell ${codeCellId} should contain its own label, got: ${noteCell.document.getText()}`,
      );
    }
  });

  it("removes all managed notes when switching back to sidebar", async () => {
    await manager.updateCells(summaries);
    await manager.setMode("inline");
    assert.strictEqual(editor.notebook.cellCount, 6);

    await manager.setMode("sidebar");

    assert.strictEqual(
      editor.notebook.cellCount,
      3,
      "all managed inline notes should be removed in sidebar mode",
    );
    for (const cell of editor.notebook.getCells()) {
      assert.strictEqual(cell.kind, vscode.NotebookCellKind.Code);
    }
  });

  it("survives an inline -> sidebar -> inline round trip with the same content", async () => {
    await manager.updateCells(summaries);
    await manager.setMode("inline");
    await manager.setMode("sidebar");
    await manager.setMode("inline");

    assert.strictEqual(
      editor.notebook.cellCount,
      6,
      "notes should be re-inserted identically on the second inline switch",
    );

    const cells = editor.notebook.getCells();
    for (let i = 0; i < cells.length; i += 2) {
      const noteCell = cells[i];
      const codeCell = cells[i + 1];
      const codeCellId = getStableCellId(codeCell, i + 1);
      const expected = summaries.find((s) => s.cellId === codeCellId);

      assert.ok(isInlineSummaryCell(noteCell));
      assert.ok(
        noteCell.document.getText().includes(expected!.cellLabel) &&
          noteCell.document.getText().includes(expected!.cellDescription),
        "the round-tripped note must still carry the correct label and summary, not stale or swapped data",
      );
    }
  });
});

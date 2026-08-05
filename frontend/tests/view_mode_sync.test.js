"use strict";

/**
 * Regression coverage for the reported bug: toggling from the sidebar view
 * to the inline view and back made duplicate/dead/stale advisory flags
 * vanish from the sidebar cards, even though nothing about the notebook
 * had actually changed.
 *
 * Root cause (see extension.ts / webviewProvider.ts / script.js): a
 * view-mode toggle re-sends the current cell list to the webview as an
 * `indexResult` message (so the freshly-shown view has data to render),
 * but that message type was also used for genuine re-indexing, and the
 * webview unconditionally wiped its advisory Maps on every `indexResult`.
 * The fix threads an `isFreshIndex` flag through extension.ts ->
 * webviewProvider.ts -> script.js: only a *genuine* re-index clears
 * duplicate/dead/stale state; a view-mode-toggle replay (isFreshIndex:
 * false) leaves it alone.
 *
 * These tests drive the real script.js message handler (via a jsdom
 * window, see helpers.js) exactly the way the extension does, and assert
 * on the actually-rendered DOM -- the same thing the user was looking at
 * when they noticed the bug.
 */

const assert = require("assert");
const {
  loadCanvas,
  postFromExtension,
  cardFor,
  cellData,
} = require("./helpers");

describe("sidebar advisory sync across indexResult messages", () => {
  it("keeps dead/stale flags after a non-fresh replay (view-mode toggle)", async () => {
    const dom = await loadCanvas();

    // Initial genuine index of a two-cell notebook.
    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1"), cellData("c2")],
    });

    // The extension's advisor pass flags c1 as dead and c2 as stale.
    postFromExtension(dom, {
      type: "deadCellsDetected",
      data: {
        cells: [
          { cell_id: "c1", cell_index: 0, unused_names: [], reason: "unused" },
        ],
      },
    });
    postFromExtension(dom, {
      type: "staleCellsDetected",
      data: {
        cells: [
          { cell_id: "c2", cell_index: 1, reason: "out of order", stale_due_to: [0] },
        ],
      },
    });

    assert.ok(
      cardFor(dom, "c1").classList.contains("dead-flagged"),
      "c1 should be flagged dead before any view toggle",
    );
    assert.ok(
      cardFor(dom, "c2").classList.contains("stale-flagged"),
      "c2 should be flagged stale before any view toggle",
    );

    // Simulate: user switches to inline view, then back to sidebar. Both
    // transitions replay the same cell list via a non-fresh indexResult
    // (see webviewProvider.ts's replayCurrentCells / postIndexResult).
    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: false,
      viewMode: "inline",
      data: [cellData("c1"), cellData("c2")],
    });
    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: false,
      viewMode: "sidebar",
      data: [cellData("c1"), cellData("c2")],
    });

    assert.ok(
      cardFor(dom, "c1").classList.contains("dead-flagged"),
      "c1's dead flag must survive an inline/sidebar round trip",
    );
    assert.ok(
      cardFor(dom, "c2").classList.contains("stale-flagged"),
      "c2's stale flag must survive an inline/sidebar round trip",
    );
  });

  it("clears dead/stale flags on a genuine re-index", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1")],
    });
    postFromExtension(dom, {
      type: "deadCellsDetected",
      data: {
        cells: [
          { cell_id: "c1", cell_index: 0, unused_names: [], reason: "unused" },
        ],
      },
    });
    assert.ok(cardFor(dom, "c1").classList.contains("dead-flagged"));

    // A real re-index (e.g. the same notebook saved and reopened, or a
    // different notebook opened in the same panel) must not carry the old
    // flag forward -- the extension will re-run the advisors and
    // repopulate whatever still applies, but until it does, a stale
    // "dead" flag on a cell nothing has analyzed yet would be a false
    // positive.
    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1")],
    });

    assert.ok(
      !cardFor(dom, "c1").classList.contains("dead-flagged"),
      "a genuine re-index must clear stale advisory flags",
    );
  });

  it("keeps duplicate-group flags after a non-fresh replay too", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1"), cellData("c2"), cellData("c3")],
    });
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [["c1", "c2"]] },
    });

    assert.ok(cardFor(dom, "c1").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c2").classList.contains("duplicate-flagged"));
    assert.ok(!cardFor(dom, "c3").classList.contains("duplicate-flagged"));

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: false,
      viewMode: "inline",
      data: [cellData("c1"), cellData("c2"), cellData("c3")],
    });
    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: false,
      viewMode: "sidebar",
      data: [cellData("c1"), cellData("c2"), cellData("c3")],
    });

    assert.ok(
      cardFor(dom, "c1").classList.contains("duplicate-flagged"),
      "duplicate group must survive an inline/sidebar round trip",
    );
    assert.ok(
      cardFor(dom, "c2").classList.contains("duplicate-flagged"),
      "duplicate group must survive an inline/sidebar round trip",
    );
  });

  it("still hides the sidebar card list while in inline mode", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      viewMode: "inline",
      data: [cellData("c1")],
    });

    assert.strictEqual(
      dom.window.document.getElementById("allCellsContainer").innerHTML,
      "",
      "inline mode must not render sidebar cards (they live in the notebook instead)",
    );
  });
});

describe("per-cell advisory clearing (cellUpdated / cellDeleted)", () => {
  it("eagerly clears a re-executed cell's own dead flag", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1")],
    });
    postFromExtension(dom, {
      type: "deadCellsDetected",
      data: {
        cells: [
          { cell_id: "c1", cell_index: 0, unused_names: [], reason: "unused" },
        ],
      },
    });
    assert.ok(cardFor(dom, "c1").classList.contains("dead-flagged"));

    postFromExtension(dom, {
      type: "cellUpdated",
      data: cellData("c1", { cellDescription: "Now does something." }),
    });

    assert.ok(
      !cardFor(dom, "c1").classList.contains("dead-flagged"),
      "a re-executed cell's stale dead-flag must be cleared optimistically",
    );
  });

  it("removes a deleted cell's card entirely", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1"), cellData("c2")],
    });
    postFromExtension(dom, {
      type: "cellDeleted",
      data: { cellId: "c1" },
    });

    assert.strictEqual(cardFor(dom, "c1"), null);
    assert.ok(cardFor(dom, "c2") !== null);
  });
});

describe("cellsReordered", () => {
  it("re-renders the sidebar list in the new notebook order", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1"), cellData("c2"), cellData("c3")],
    });

    postFromExtension(dom, {
      type: "cellsReordered",
      data: { cellIds: ["c3", "c1", "c2"] },
    });

    const { cellCardIds } = require("./helpers");
    assert.deepStrictEqual(cellCardIds(dom), ["c3", "c1", "c2"]);
  });
});

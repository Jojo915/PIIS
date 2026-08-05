"use strict";

/**
 * Regression coverage for the duplicate-highlighting lifecycle, covering
 * three reported bugs against the current whole-notebook, full-replace
 * `duplicatesDetected` protocol (`data: { groups: string[][] }`).
 *
 * Duplicate-cluster detection moved from a per-cell nearest-neighbor check
 * (one `duplicatesDetected` message per cell, incrementally merged into
 * `activeDuplicateGroups` client-side) to a whole-notebook, complete-linkage
 * re-cluster on the backend (see app.analysis.duplicate_clusters):  every
 * call to `POST /notebooks/duplicate-cells` returns the *entire* current set
 * of independent duplicate clusters in one shot, and the webview now simply
 * replaces `activeDuplicateGroups` with `message.data.groups` wholesale --
 * mirroring how `deadCellsDetected`/`staleCellsDetected` already work. There
 * is no more separate `duplicatesCleared` message: turning "Detect duplicate
 * cells" off now posts a `duplicatesDetected` message with an empty `groups`
 * array, exactly like the dead/stale advisors already do.
 *
 * Bug 1: deleting one cell out of a duplicate group used to wipe out the
 * highlighting for the *surviving* group members too, with nothing ever
 * re-flagging them afterward. Now, any structural change (delete, edit,
 * execution) is followed by a fresh whole-notebook re-cluster, so the
 * survivors are naturally included in the next full-replace `groups` list.
 *
 * Bug 2: disabling "Detect duplicate cells" in AI Settings and clicking Save
 * didn't clear already-shown highlights until an unrelated action happened
 * to touch one of the flagged cells. Fixed by posting an explicit empty-
 * groups `duplicatesDetected` message immediately on save, the same way
 * dead/stale cells are cleared.
 *
 * Bug 3: two unrelated duplicate clusters (cell A duplicated 3x, cell B
 * duplicated 2x elsewhere in the notebook) used to be merged into a single
 * reported group of 5, because the old per-cell nearest-neighbor query
 * behaved like single-linkage/graph-connectivity clustering -- a "bridge"
 * cell pair under the distance threshold could chain two otherwise-
 * unrelated clusters together. Complete-linkage clustering on the backend
 * fixes this structurally: the two clusters now always arrive as two
 * separate entries in the same `groups` array, and clicking "Ignore" on one
 * must only dismiss that one group.
 */

const assert = require("assert");
const { loadCanvas, postFromExtension, cardFor, cellData } = require("./helpers");

describe("duplicate group lifecycle", () => {
  it("Bug 1: re-flags surviving duplicates after one group member is deleted", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1"), cellData("c2"), cellData("c3")],
    });
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [["c1", "c2", "c3"]] },
    });

    assert.ok(cardFor(dom, "c1").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c2").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c3").classList.contains("duplicate-flagged"));

    // c1 is deleted. The webview eagerly drops the whole group locally
    // (existing, deliberately-cautious behavior -- it doesn't yet know
    // whether c2/c3 are still duplicates of each other).
    postFromExtension(dom, {
      type: "cellDeleted",
      data: { cellId: "c1" },
    });

    assert.ok(
      !cardFor(dom, "c2").classList.contains("duplicate-flagged"),
      "group is provisionally cleared immediately after the delete",
    );
    assert.ok(!cardFor(dom, "c3").classList.contains("duplicate-flagged"));

    // extension.ts then re-runs the whole-notebook duplicate-cluster
    // advisor (runAdvisors) and posts a fresh, full-replace groups list
    // reflecting the surviving cluster.
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [["c2", "c3"]] },
    });

    assert.ok(
      cardFor(dom, "c2").classList.contains("duplicate-flagged"),
      "surviving duplicates must be re-flagged, not permanently lost",
    );
    assert.ok(
      cardFor(dom, "c3").classList.contains("duplicate-flagged"),
      "surviving duplicates must be re-flagged, not permanently lost",
    );
  });

  it("Bug 2: an empty-groups duplicatesDetected message immediately drops all highlights", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1"), cellData("c2"), cellData("c3"), cellData("c4")],
    });
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [["c1", "c2"], ["c3", "c4"]] },
    });

    assert.ok(cardFor(dom, "c1").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c2").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c3").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c4").classList.contains("duplicate-flagged"));

    // Simulates: AI Settings Save with "Detect duplicate cells" unchecked --
    // runAdvisors posts an explicit empty-groups clear, mirroring how
    // deadCellsDetected/staleCellsDetected are cleared.
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [] },
    });

    for (const id of ["c1", "c2", "c3", "c4"]) {
      assert.ok(
        !cardFor(dom, id).classList.contains("duplicate-flagged"),
        `${id} must lose its duplicate flag immediately once detection is disabled`,
      );
    }
  });

  it("Bug 3: keeps two independent duplicate clusters separate, so Ignore on one leaves the other intact", async () => {
    const dom = await loadCanvas();

    // Two unrelated clusters: cell A duplicated 3x, cell B duplicated 2x,
    // both reported in a single whole-notebook duplicatesDetected message --
    // mirroring the real backend, which runs one complete-linkage cluster
    // pass over the whole notebook and returns every independent cluster at
    // once, rather than one per-cell round-trip per executed cell.
    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [
        cellData("a1"),
        cellData("a2"),
        cellData("a3"),
        cellData("b1"),
        cellData("b2"),
      ],
    });
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [["a1", "a2", "a3"], ["b1", "b2"]] },
    });

    for (const id of ["a1", "a2", "a3", "b1", "b2"]) {
      assert.ok(
        cardFor(dom, id).classList.contains("duplicate-flagged"),
        `${id} should be flagged before any Ignore click`,
      );
    }

    // Click "Ignore" on the A cluster's banner (via a1's card) -- this must
    // only dismiss the A cluster (a1/a2/a3), not the unrelated B cluster,
    // even though both arrived in the same duplicatesDetected message.
    const ignoreButton = cardFor(dom, "a1").querySelector(
      ".duplicate-ignore-btn",
    );
    assert.ok(ignoreButton, "expected a1's card to have an Ignore button");
    ignoreButton.click();

    for (const id of ["a1", "a2", "a3"]) {
      assert.ok(
        !cardFor(dom, id).classList.contains("duplicate-flagged"),
        `${id} should be cleared after ignoring the A cluster`,
      );
    }
    for (const id of ["b1", "b2"]) {
      assert.ok(
        cardFor(dom, id).classList.contains("duplicate-flagged"),
        `${id} is an unrelated cluster and must stay flagged after ignoring A`,
      );
    }
  });

  it("re-enabling detection later can flag a fresh group again after a clear", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1"), cellData("c2")],
    });
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [["c1", "c2"]] },
    });
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [] },
    });
    assert.ok(!cardFor(dom, "c1").classList.contains("duplicate-flagged"));

    // A later cell execution (or any fresh whole-notebook re-cluster)
    // re-populates it.
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { groups: [["c1", "c2"]] },
    });

    assert.ok(cardFor(dom, "c1").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c2").classList.contains("duplicate-flagged"));
  });
});

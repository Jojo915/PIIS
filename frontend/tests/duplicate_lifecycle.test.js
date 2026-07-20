"use strict";

/**
 * Regression coverage for two reported duplicate-highlighting bugs.
 *
 * Bug 1: deleting one cell out of a duplicate group used to wipe out the
 * highlighting for the *surviving* group members too, because
 * `clearDuplicateGroupsForCell` (fired by `cellDeleted`) drops the whole
 * group containing the deleted cell's id, and nothing ever re-added a
 * group for the survivors. The fix lives in extension.ts: it now captures
 * the deleted cell's group membership before posting `cellDeleted`, and
 * re-runs the per-cell duplicate check for each surviving member
 * afterward. From the webview's perspective, that shows up as a fresh
 * `duplicatesDetected` message (for the smaller, surviving group) arriving
 * shortly after `cellDeleted` -- these tests drive exactly that message
 * sequence and assert the survivors end up flagged again.
 *
 * Bug 2: disabling "Detect duplicate cells" in AI Settings and clicking
 * Save didn't clear already-shown highlights until an unrelated action
 * happened to touch one of the flagged cells. The fix adds a new
 * `duplicatesCleared` message (mirroring how `deadCellsDetected`/
 * `staleCellsDetected` are explicitly cleared by posting an empty set),
 * posted immediately by extension.ts's `applyAiSettingsSaveResult`
 * whenever the checkbox transitions from on to off.
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
      data: { group: ["c1", "c2", "c3"] },
    });

    assert.ok(cardFor(dom, "c1").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c2").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c3").classList.contains("duplicate-flagged"));

    // c1 is deleted. The webview eagerly drops the whole group (existing,
    // deliberately-cautious behavior -- it doesn't know yet whether c2/c3
    // are still duplicates of each other).
    postFromExtension(dom, {
      type: "cellDeleted",
      data: { cellId: "c1" },
    });

    assert.ok(
      !cardFor(dom, "c2").classList.contains("duplicate-flagged"),
      "group is provisionally cleared immediately after the delete",
    );
    assert.ok(!cardFor(dom, "c3").classList.contains("duplicate-flagged"));

    // extension.ts then re-checks each surviving former group member and
    // re-posts duplicatesDetected for whatever's still a match.
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { group: ["c2", "c3"] },
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

  it("Bug 2: an explicit duplicatesCleared message immediately drops all highlights", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "indexResult",
      isFreshIndex: true,
      data: [cellData("c1"), cellData("c2"), cellData("c3"), cellData("c4")],
    });
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { group: ["c1", "c2"] },
    });
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { group: ["c3", "c4"] },
    });

    assert.ok(cardFor(dom, "c1").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c2").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c3").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c4").classList.contains("duplicate-flagged"));

    // Simulates: AI Settings Save with "Detect duplicate cells" unchecked.
    postFromExtension(dom, { type: "duplicatesCleared" });

    for (const id of ["c1", "c2", "c3", "c4"]) {
      assert.ok(
        !cardFor(dom, id).classList.contains("duplicate-flagged"),
        `${id} must lose its duplicate flag immediately once detection is disabled`,
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
      data: { group: ["c1", "c2"] },
    });
    postFromExtension(dom, { type: "duplicatesCleared" });
    assert.ok(!cardFor(dom, "c1").classList.contains("duplicate-flagged"));

    // A later cell execution (or any fresh per-cell check) re-populates it.
    postFromExtension(dom, {
      type: "duplicatesDetected",
      data: { group: ["c1", "c2"] },
    });

    assert.ok(cardFor(dom, "c1").classList.contains("duplicate-flagged"));
    assert.ok(cardFor(dom, "c2").classList.contains("duplicate-flagged"));
  });
});

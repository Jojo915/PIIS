"use strict";

/**
 * jsdom loader for the sidebar webview (frontend/index.html + script.js).
 *
 * The webview has no build step and no CommonJS wrapper for its DOM/message
 * handling code (only a handful of pure functions are exported via the
 * `module.exports` block at the bottom of script.js, guarded by
 * `typeof module !== "undefined"` -- see that file). To exercise the real
 * message-handling and rendering logic (not just the pure helpers), this
 * loads the actual index.html into a jsdom window with `runScripts:
 * "dangerously"` so script.js executes exactly as it would inside the real
 * VS Code webview, then waits for its own `DOMContentLoaded`-triggered
 * `init()` to finish wiring up event listeners.
 *
 * Each call returns a fresh jsdom Window/Document -- module-level `let`
 * state in script.js (allCells, deadCellsById, etc.) lives inside that
 * window's script realm, so tests get full isolation from each other
 * without needing to reset any globals by hand.
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const INDEX_HTML_PATH = path.join(__dirname, "..", "index.html");

async function loadCanvas() {
  const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");

  const dom = new JSDOM(html, {
    url: `file://${INDEX_HTML_PATH}`,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
  });

  // jsdom has no ResizeObserver implementation; script.js's init() uses one
  // purely to auto-grow the search textarea on panel resize, which isn't
  // relevant to any of the sync/rendering behavior under test here, so a
  // no-op stub is enough to let init() run to completion.
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  await new Promise((resolve) => {
    if (dom.window.document.readyState === "complete") {
      resolve();
      return;
    }
    dom.window.addEventListener("load", resolve, { once: true });
  });

  return dom;
}

/**
 * Simulate the extension posting a message to the webview.
 *
 * Uses a synchronous `MessageEvent` dispatch rather than the real
 * `window.postMessage` (which jsdom, like browsers, queues as an async
 * task) so tests don't need to sprinkle in arbitrary waits -- the
 * dispatched event is handled inline, exactly like the real
 * `window.addEventListener("message", ...)` handler in script.js.
 */
function postFromExtension(dom, message) {
  const event = new dom.window.MessageEvent("message", { data: message });
  dom.window.dispatchEvent(event);
}

function cellCardIds(dom) {
  return Array.from(
    dom.window.document.querySelectorAll("#allCellsContainer .result-card"),
  ).map((card) => card.dataset.cellId);
}

function cardFor(dom, cellId) {
  return dom.window.document.querySelector(
    `#allCellsContainer .result-card[data-cell-id="${cellId}"]`,
  );
}

function cellData(cellId, overrides = {}) {
  return {
    cellId,
    cellLabel: `Label ${cellId}`,
    cellDescription: `Summary for ${cellId}`,
    cellContent: `# ${cellId}\nx = 1`,
    ...overrides,
  };
}

module.exports = {
  loadCanvas,
  postFromExtension,
  cellCardIds,
  cardFor,
  cellData,
};

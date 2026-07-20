"use strict";

/**
 * Coverage for the AI Settings panel's webview-side logic: hydrating the
 * collapsible card's form fields from a backend-shaped settings object,
 * the model-select -> custom-model-field visibility toggle, and status
 * text on the save/reset error paths.
 *
 * These drive the real script.js message handlers (via a jsdom window, see
 * helpers.js) exactly the way the extension does, and assert on the
 * actually-rendered DOM -- consistent with the rest of this test suite.
 *
 * Note: the outbound side (script.js -> extension postMessage payloads for
 * saveAiSettings/resetAiSettings) is not covered here, since `vscode` is
 * `null` in this jsdom environment (no `acquireVsCodeApi`, matching every
 * other test in this suite) -- only the inbound message-handling and
 * rendering logic is exercised, same as view_mode_sync.test.js.
 */

const assert = require("assert");
const { loadCanvas, postFromExtension } = require("./helpers");

const BASE_SETTINGS = {
  has_api_key: false,
  model: "gemini-2.5-flash-lite",
  custom_model: null,
  detect_stale_cells: true,
  detect_duplicate_cells: true,
  detect_dead_cells: true,
};

describe("AI Settings panel", () => {
  it("hydrates the form from aiSettingsLoaded, using a placeholder for an already-saved key", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "aiSettingsLoaded",
      data: {
        ...BASE_SETTINGS,
        has_api_key: true,
        model: "gemini-1.5-flash",
        detect_stale_cells: false,
      },
    });

    const d = dom.window.document;
    const apiKeyValue = d.getElementById("aiSettingsApiKeyInput").value;

    // A real key is never sent to the webview -- only a fixed placeholder
    // standing in for "a key is saved".
    assert.ok(apiKeyValue.length > 0);
    assert.notStrictEqual(apiKeyValue, "");
    assert.strictEqual(
      d.getElementById("aiSettingsModelSelect").value,
      "gemini-1.5-flash",
    );
    assert.strictEqual(
      d.getElementById("aiSettingsDetectStaleCheckbox").checked,
      false,
    );
    assert.strictEqual(
      d.getElementById("aiSettingsDetectDuplicateCheckbox").checked,
      true,
    );
    assert.strictEqual(
      d.getElementById("aiSettingsDetectDeadCheckbox").checked,
      true,
    );
  });

  it("leaves the API Key field empty when no key is saved", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, { type: "aiSettingsLoaded", data: BASE_SETTINGS });

    assert.strictEqual(
      dom.window.document.getElementById("aiSettingsApiKeyInput").value,
      "",
    );
  });

  it("falls back to the 'other' option and shows the custom field for an unrecognized model", async () => {
    const dom = await loadCanvas();

    postFromExtension(dom, {
      type: "aiSettingsLoaded",
      data: { ...BASE_SETTINGS, model: "some-custom-model", custom_model: "some-custom-model" },
    });

    const d = dom.window.document;
    assert.strictEqual(d.getElementById("aiSettingsModelSelect").value, "other");
    assert.strictEqual(
      d.getElementById("aiSettingsCustomModelField").style.display,
      "flex",
    );
    assert.strictEqual(
      d.getElementById("aiSettingsCustomModelInput").value,
      "some-custom-model",
    );
  });

  it("hides the custom model field again once a known model is loaded", async () => {
    const dom = await loadCanvas();
    const d = dom.window.document;

    postFromExtension(dom, {
      type: "aiSettingsLoaded",
      data: { ...BASE_SETTINGS, model: "other", custom_model: "x" },
    });
    assert.strictEqual(d.getElementById("aiSettingsCustomModelField").style.display, "flex");

    postFromExtension(dom, {
      type: "aiSettingsLoaded",
      data: { ...BASE_SETTINGS, model: "gemini-2.5-flash-lite", custom_model: null },
    });
    assert.strictEqual(d.getElementById("aiSettingsCustomModelField").style.display, "none");
  });

  it("toggles the custom model field visibility when the user changes the model dropdown", async () => {
    const dom = await loadCanvas();
    const d = dom.window.document;
    const select = d.getElementById("aiSettingsModelSelect");

    select.value = "other";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.strictEqual(d.getElementById("aiSettingsCustomModelField").style.display, "flex");

    select.value = "gemini-1.5-flash";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.strictEqual(d.getElementById("aiSettingsCustomModelField").style.display, "none");
  });

  it("shows the reset settings on aiSettingsReset and a confirmation status", async () => {
    const dom = await loadCanvas();
    const d = dom.window.document;

    postFromExtension(dom, {
      type: "aiSettingsReset",
      data: { ...BASE_SETTINGS, detect_dead_cells: true },
    });

    assert.strictEqual(
      d.getElementById("aiSettingsModelSelect").value,
      "gemini-2.5-flash-lite",
    );
    assert.strictEqual(d.getElementById("aiSettingsApiKeyInput").value, "");
    assert.strictEqual(d.getElementById("aiSettingsStatus").textContent, "Reset to defaults.");
  });

  it("hydrates from the settings echoed back on aiSettingsSaved", async () => {
    const dom = await loadCanvas();
    const d = dom.window.document;

    postFromExtension(dom, {
      type: "aiSettingsSaved",
      data: {
        settings: { ...BASE_SETTINGS, detect_duplicate_cells: false },
        api_key_changed: false,
      },
    });

    assert.strictEqual(
      d.getElementById("aiSettingsDetectDuplicateCheckbox").checked,
      false,
    );
    assert.strictEqual(d.getElementById("aiSettingsStatus").textContent, "Saved.");
  });

  it("surfaces a save error as status text and flags it as an error", async () => {
    const dom = await loadCanvas();
    const d = dom.window.document;

    postFromExtension(dom, {
      type: "aiSettingsSaveError",
      error: "Backend unreachable",
    });

    const status = d.getElementById("aiSettingsStatus");
    assert.strictEqual(status.textContent, "Backend unreachable");
    assert.ok(status.classList.contains("summary-error"));
  });

  it("surfaces a reset error as status text and flags it as an error", async () => {
    const dom = await loadCanvas();
    const d = dom.window.document;

    postFromExtension(dom, {
      type: "aiSettingsResetError",
      error: "Reset failed",
    });

    const status = d.getElementById("aiSettingsStatus");
    assert.strictEqual(status.textContent, "Reset failed");
    assert.ok(status.classList.contains("summary-error"));
  });

  it("does not throw when Save/Reset are clicked with no vscode API present", async () => {
    const dom = await loadCanvas();
    const d = dom.window.document;

    postFromExtension(dom, { type: "aiSettingsLoaded", data: BASE_SETTINGS });

    assert.doesNotThrow(() => {
      d.getElementById("aiSettingsSaveButton").click();
    });
    assert.doesNotThrow(() => {
      d.getElementById("aiSettingsResetButton").click();
    });
  });
});

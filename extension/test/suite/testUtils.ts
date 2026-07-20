import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const FAKE_BACKEND_URL = "http://127.0.0.1:8000";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Fetches the fake backend's full request log (see fakeBackend.ts). */
export async function getBackendRequests(): Promise<RecordedRequest[]> {
  const response = await fetch(`${FAKE_BACKEND_URL}/__test__/requests`);
  return (await response.json()) as RecordedRequest[];
}

/** Clears the fake backend's request log between tests. */
export async function resetBackendRequests(): Promise<void> {
  await fetch(`${FAKE_BACKEND_URL}/__test__/reset`, { method: "POST" });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `check()` until it returns true or `timeoutMs` elapses. Used
 * instead of a fixed sleep wherever we're waiting on the extension's async
 * (debounced, or backend-round-trip-driven) reactions to a notebook edit,
 * so tests aren't slower or flakier than they need to be.
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/** True once the fake backend has received a request matching the given method+path prefix. */
export async function hasReceivedRequest(
  method: string,
  pathPrefix: string,
): Promise<boolean> {
  const requests = await getBackendRequests();
  return requests.some(
    (r) => r.method === method && r.path.startsWith(pathPrefix),
  );
}

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

/**
 * Copies the checked-in sample notebook fixture to a fresh temp file and
 * opens+shows it as a real notebook editor. A fresh file per test (rather
 * than reusing one URI) avoids any cross-test state bleeding through
 * VS Code's own document cache, and guarantees
 * `onDidOpenNotebookDocument` actually fires (it doesn't fire for a
 * document VS Code considers already open).
 */
export async function openFixtureNotebook(): Promise<vscode.NotebookEditor> {
  const source = path.join(FIXTURES_DIR, "sample.ipynb");
  const dest = path.join(
    os.tmpdir(),
    `semantic-canvas-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ipynb`,
  );
  fs.copyFileSync(source, dest);

  const uri = vscode.Uri.file(dest);
  const doc = await vscode.workspace.openNotebookDocument(uri);
  const editor = await vscode.window.showNotebookDocument(doc);
  return editor;
}

export async function closeActiveEditor(): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.closeActiveEditor",
  );
}

/** Stable ids of the fixture notebook's three code cells, in original order. */
export const FIXTURE_CELL_IDS = ["cell-1", "cell-2", "cell-3"];

import * as path from "path";
import { runTests } from "@vscode/test-electron";
import { FakeBackend } from "./fakeBackend";

/**
 * Node-side bootstrap for the real VS Code Extension Host integration
 * tests. Downloads/launches a real VS Code instance, loads this extension
 * into it unmodified, and runs the Mocha suite in `test/suite/index.ts`
 * inside that Extension Host process (not this Node process).
 *
 * The fake backend (see fakeBackend.ts) is started here, in the Node
 * process, *before* VS Code launches -- `backendClient.ts` talks to
 * `http://127.0.0.1:8000` unconditionally, so as long as this process is
 * still alive and listening when the Extension Host makes requests, no
 * extension source changes are needed to redirect it.
 */
async function main(): Promise<void> {
  const fakeBackend = new FakeBackend();
  await fakeBackend.start(8000);
  // Individual test files run inside the *Extension Host* process, which
  // is separate from this Node bootstrap process, so they cannot reach
  // this FakeBackend instance directly -- they query it over HTTP instead,
  // via the introspection routes in fakeBackend.ts (GET
  // /__test__/requests, POST /__test__/reset), the same way the real
  // extension code talks to it.

  try {
    // extension/ (this package's root) -- the folder VS Code loads as the
    // extension under test.
    const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
    // Compiled Mocha suite entrypoint that runs inside the Extension Host.
    const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");
    // A throwaway workspace folder containing a fixture notebook, opened
    // automatically so tests can grab vscode.window.activeNotebookEditor.
    const workspacePath = path.resolve(__dirname, "fixtures");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        "--disable-extensions",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });
  } finally {
    await fakeBackend.stop();
  }
}

main().catch((error) => {
  console.error("Failed to run VS Code integration tests:", error);
  process.exit(1);
});

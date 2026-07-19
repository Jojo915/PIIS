import * as path from "path";
import Mocha from "mocha";
import { glob } from "glob";

/**
 * Entry point VS Code's Extension Host runs (`extensionTestsPath` in
 * runTest.ts). Discovers every compiled `*.test.js` under this directory
 * and hands them to Mocha, which then runs inside the real Extension Host
 * process -- so `vscode.*` APIs used by the test files are the genuine
 * ones, not a mock.
 */
export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 60000,
  });

  const testsRoot = __dirname;
  const files = await glob("**/*.test.js", { cwd: testsRoot });

  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

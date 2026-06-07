import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { readCurrentNotebookCells } from "./notebookReader";
import { indexNotebook } from "./backendClient";
import { SemanticCanvasWebviewProvider } from "./webviewProvider";

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage("Semantic Canvas activated");
  console.log("Semantic Canvas extension activated.");

  const provider = new SemanticCanvasWebviewProvider(context);

  context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(
    "semanticCanvas.sidebar",
    provider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }
  )
);

  const indexDisposable = vscode.commands.registerCommand(
    "semanticCanvas.indexNotebook",
    async () => {
      try {
        const cells = readCurrentNotebookCells();

        if (cells.length === 0) {
          vscode.window.showWarningMessage("No cells found in current notebook.");
          return;
        }

        const notebookId =
          vscode.window.activeNotebookEditor?.notebook.uri.toString();

        if (!notebookId) {
          vscode.window.showWarningMessage("No notebook ID found.");
          return;
        }

        const result = await indexNotebook({
          notebookId,
          cells,
        });

        vscode.window.showInformationMessage(
          `Notebook indexed: ${result.cellLabels.length} cells`
        );

        console.log("Backend result:", result);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to index notebook: ${error}`);
        console.error(error);
      }
    }
  );

  const debugDisposable = vscode.commands.registerCommand(
    "semanticCanvas.debugInfo",
    async () => {
      const extensionPath = context.extensionPath;
      const packageJsonPath = path.join(extensionPath, "package.json");
      const outExtensionPath = path.join(extensionPath, "out", "extension.js");
      const srcExtensionPath = path.join(extensionPath, "src", "extension.ts");
      const iconPath = path.join(extensionPath, "media", "icon.svg");

      let packageJsonText = "";
      let packageJson: any = null;

      try {
        packageJsonText = fs.readFileSync(packageJsonPath, "utf8");
        packageJson = JSON.parse(packageJsonText);
      } catch (error) {
        packageJsonText = `FAILED TO READ package.json: ${String(error)}`;
      }

      const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
      const activeNotebookUri = activeNotebook?.uri.toString() ?? "NO_ACTIVE_NOTEBOOK";
      const activeNotebookCellCount = activeNotebook?.cellCount ?? 0;

      const debugInfo = {
        message: "Semantic Canvas Debug Info",
        time: new Date().toISOString(),

        extension: {
          id: context.extension.id,
          extensionPath,
          packageJsonPath,
          outExtensionPath,
          srcExtensionPath,
          iconPath,
        },

        filesExist: {
          packageJson: fs.existsSync(packageJsonPath),
          outExtensionJs: fs.existsSync(outExtensionPath),
          srcExtensionTs: fs.existsSync(srcExtensionPath),
          iconSvg: fs.existsSync(iconPath),
        },

        packageJsonImportantFields: packageJson
          ? {
              name: packageJson.name,
              displayName: packageJson.displayName,
              publisher: packageJson.publisher,
              main: packageJson.main,
              activationEvents: packageJson.activationEvents,
              contributes: packageJson.contributes,
            }
          : "package.json could not be parsed",

        expectedIds: {
          commandIndexNotebook: "semanticCanvas.indexNotebook",
          commandDebugInfo: "semanticCanvas.debugInfo",
          webviewViewId: "semanticCanvas.sidebar",
          viewContainerId: "semanticCanvas",
          providerViewType: SemanticCanvasWebviewProvider.viewType,
        },

        notebook: {
          activeNotebookUri,
          activeNotebookCellCount,
        },
      };

      const output = JSON.stringify(debugInfo, null, 2);

      console.log(output);

      const doc = await vscode.workspace.openTextDocument({
        content: output,
        language: "json",
      });

      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });

      vscode.window.showInformationMessage(
        "Semantic Canvas debug info generated. Copy the JSON and send it."
      );
    }
  );

  context.subscriptions.push(indexDisposable, debugDisposable);
}

export function deactivate() {}
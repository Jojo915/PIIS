import * as vscode from "vscode";
import {
  readCurrentNotebookForBackend,
  readCurrentCodeCellForBackend,
} from "./notebookReader";
import { indexNotebook, updateCell, searchCells } from "./backendClient";
import { SemanticCanvasWebviewProvider } from "./webviewProvider";

export function activate(context: vscode.ExtensionContext) {
  console.log("Semantic Canvas extension is now active.");

  /**
   * Register sidebar webview provider.
   *
   * Make sure package.json has the same view id:
   * "id": "semanticCanvasView"
   */
  const provider = new SemanticCanvasWebviewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SemanticCanvasWebviewProvider.viewType,
      provider,
    ),
  );

  /**
   * Command:
   * Semantic Canvas: Index Current Notebook
   *
   * Backend endpoint:
   * POST /notebooks
   */
  const indexNotebookCommand = vscode.commands.registerCommand(
    "semanticCanvas.indexNotebook",
    async () => {
      try {
        const request = readCurrentNotebookForBackend();

        console.log("Sending notebook to backend:", request);

        const result = await indexNotebook(request);

        provider.postMessage({
          type: "indexResult",
          data: result
            .filter((item) => item.cell_type === "code")
            .map((item) => ({
              cellId: item.cell_id,
              cellLabel: item.label ?? item.cell_id,
              cellDescription: item.summary ?? "",
              cellIcon: "table",
            })),
        });

        console.log("Backend /notebooks response:", result);

        vscode.window.showInformationMessage(
          `Notebook indexed: ${result.length} cells`,
        );
      } catch (error) {
        console.error("Index notebook failed:", error);

        vscode.window.showErrorMessage(
          `Index notebook failed: ${getErrorMessage(error)}`,
        );
      }
    },
  );

  /**
   * Command:
   * Semantic Canvas: Update Current Cell
   *
   * Backend endpoint:
   * POST /cells
   *
   * Note: backend currently expects only code cells.
   */
  const updateCellCommand = vscode.commands.registerCommand(
    "semanticCanvas.updateCell",
    async () => {
      try {
        const request = readCurrentCodeCellForBackend();

        console.log("Sending cell to backend:", request);

        const result = await updateCell(request);

        console.log("Backend /cells response:", result);

        vscode.window.showInformationMessage(`Cell updated: ${result.cell_id}`);
      } catch (error) {
        console.error("Update cell failed:", error);

        vscode.window.showErrorMessage(
          `Update cell failed: ${getErrorMessage(error)}`,
        );
      }
    },
  );

  /**
   * Command:
   * Semantic Canvas: Search Current Notebook
   *
   * Backend endpoint:
   * POST /search
   */
  const searchNotebookCommand = vscode.commands.registerCommand(
    "semanticCanvas.searchNotebook",
    async () => {
      try {
        const editor = vscode.window.activeNotebookEditor;
        console.log("1");

        if (!editor) {
          throw new Error("No active notebook found.");
        }
        console.log("2");

        const question = await vscode.window.showInputBox({
          prompt: "Ask a question about this notebook",
          placeHolder: "Where is data normalization?",
        });
        console.log("3");

        if (!question || question.trim().length === 0) {
          return;
        }
        console.log("Question:", question);

        const result = await searchCells({
          notebook_id: editor.notebook.uri.toString(),
          text: question.trim(),
        });

        console.log("Backend /search response:", result);

        vscode.window.showInformationMessage(
          `Search finished: ${result.length} results`,
        );
      } catch (error) {
        console.error("Search failed:", error);

        vscode.window.showErrorMessage(
          `Search failed: ${getErrorMessage(error)}`,
        );
      }
    },
  );

  context.subscriptions.push(
    indexNotebookCommand,
    updateCellCommand,
    searchNotebookCommand,
  );
}

export function deactivate() {
  console.log("Semantic Canvas extension is now deactivated.");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

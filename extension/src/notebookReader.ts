import * as vscode from "vscode";
import { NotebookCellInput } from "./types";

export function readCurrentNotebookCells(): NotebookCellInput[] {
  const editor = vscode.window.activeNotebookEditor;

  if (!editor) {
    vscode.window.showWarningMessage("No active notebook found.");
    return [];
  }

  const notebook = editor.notebook;
  const notebookId = notebook.uri.toString();

  const cells: NotebookCellInput[] = notebook.getCells().map((cell) => {
    return {
      notebookId,
      cellId: cell.index,
      cellContent: cell.document.getText(),
      cellType: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    };
  });

  return cells;
}

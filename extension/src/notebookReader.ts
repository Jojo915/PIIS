import * as vscode from "vscode";
import {
  BackendNotebookRequest,
  BackendCellRequest,
  JupyterCellContent,
  JupyterOutput,
  CellId,
} from "./types";

/**
 * Read the active VS Code Jupyter notebook
 * and convert it to the backend /notebooks request format.
 */
export function readCurrentNotebookForBackend(): BackendNotebookRequest {
  const editor = vscode.window.activeNotebookEditor;

  if (!editor) {
    throw new Error("No active notebook found.");
  }

  const notebook = editor.notebook;
  const notebookId = notebook.uri.fsPath;
  const cells: JupyterCellContent[] = notebook.getCells().map((cell, index) => {
    return convertVSCodeCellToBackendCell(cell, index);
  });

  return {
    notebook_id: notebookId,
    content: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          display_name: "Python 3",
          language: "python",
          name: "python3",
        },
      },
      cells,
    },
  };
}

/**
 * Read the currently selected cell
 * and convert it to the backend /cells request format.
 *
 * Backend requirement:
 * only code cells should be sent to /cells.
 */
export function readCurrentCodeCellForBackend(): BackendCellRequest {
  const editor = vscode.window.activeNotebookEditor;

  if (!editor) {
    throw new Error("No active notebook found.");
  }

  const notebook = editor.notebook;
  const notebookId = notebook.uri.fsPath;

  const selectedIndex = editor.selection.start;

  if (selectedIndex < 0 || selectedIndex >= notebook.cellCount) {
    throw new Error("No selected notebook cell found.");
  }

  const cell = notebook.cellAt(selectedIndex);

  if (cell.kind !== vscode.NotebookCellKind.Code) {
    throw new Error("Only code cells can be sent to /cells.");
  }

  return {
    notebook_id: notebookId,
    content: convertVSCodeCellToBackendCell(cell, selectedIndex),
  };
}

/**
 * Convert one VS Code notebook cell to the backend cell JSON format.
 */
function convertVSCodeCellToBackendCell(
  cell: vscode.NotebookCell,
  index: number,
): JupyterCellContent {
  return {
    id: getStableCellId(cell, index),
    cell_type: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    source: cell.document.getText(),
    metadata: cell.metadata ?? {},
    outputs: convertOutputs(cell),
    execution_count: cell.executionSummary?.executionOrder ?? null,
  };
}

/**
 * Try to use the real notebook cell id from metadata.
 * If not available, use a fallback id like cell_0, cell_1, ...
 */
function getStableCellId(cell: vscode.NotebookCell, index: number): CellId {
  const metadata = cell.metadata as {
    id?: string;
    custom?: {
      id?: string;
    };
  };

  if (metadata.id) {
    return metadata.id;
  }

  if (metadata.custom?.id) {
    return metadata.custom.id;
  }

  return `cell_${index}`;
}

/**
 * Convert VS Code notebook outputs to a simple Jupyter-like output format.
 */
function convertOutputs(cell: vscode.NotebookCell): JupyterOutput[] {
  return cell.outputs.flatMap((output) => {
    return output.items.map((item) => {
      const mime = item.mime;
      const text = new TextDecoder().decode(item.data);

      if (
        mime === "text/plain" ||
        mime === "text/x-python" ||
        mime === "application/vnd.code.notebook.stdout"
      ) {
        return {
          output_type: "stream",
          name: "stdout",
          text,
        };
      }

      if (mime === "application/vnd.code.notebook.stderr") {
        return {
          output_type: "stream",
          name: "stderr",
          text,
        };
      }

      return {
        output_type: "display_data",
        data: {
          [mime]: text,
        },
        metadata: {},
      };
    });
  });
}

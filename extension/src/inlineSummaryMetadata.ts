import * as vscode from "vscode";

export const INLINE_SUMMARY_METADATA_KEY = "semanticCanvasInlineSummary";
export const INLINE_SUMMARY_MARKER = "<!-- semantic-canvas-inline-summary -->";

export function isInlineSummaryCell(cell: vscode.NotebookCell): boolean {
  const metadata = cell.metadata as Record<string, unknown>;
  return (
    metadata[INLINE_SUMMARY_METADATA_KEY] === true ||
    cell.document.getText().startsWith(INLINE_SUMMARY_MARKER)
  );
}

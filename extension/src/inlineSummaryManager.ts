import * as vscode from "vscode";

import {
  INLINE_SUMMARY_MARKER,
  isInlineSummaryCell,
} from "./inlineSummaryMetadata";
import { getCurrentNotebookEditor, getStableCellId } from "./notebookReader";

export interface InlineSummaryCellData {
  cellId: string;
  cellLabel: string;
  cellDescription: string;
}

export type SummaryViewMode = "sidebar" | "inline";

export class InlineSummaryManager {
  private viewMode: SummaryViewMode = "sidebar";
  private latestCells: InlineSummaryCellData[] = [];
  private isRefreshing = false;

  public getMode(): SummaryViewMode {
    return this.viewMode;
  }

  public async setMode(mode: SummaryViewMode): Promise<void> {
    this.viewMode = mode;

    if (mode === "inline") {
      await this.refreshInlineSummaries();
      return;
    }

    await this.clearInlineSummaries();
  }

  public async updateCells(cells: InlineSummaryCellData[]): Promise<void> {
    this.latestCells = cells;

    if (this.viewMode === "inline") {
      await this.refreshInlineSummaries();
    }
  }

  public async refreshInlineSummaries(): Promise<void> {
    if (this.isRefreshing) {
      return;
    }

    const editor = getCurrentNotebookEditor();

    if (!editor) {
      return;
    }

    const summaryByCellId = new Map(
      this.latestCells.map((cell) => [cell.cellId, cell]),
    );

    if (this.isNotebookInSync(editor.notebook, summaryByCellId)) {
      return;
    }

    this.isRefreshing = true;
    try {
      await this.clearInlineSummaries(editor.notebook);

      const notebookCells = editor.notebook.getCells();
      const insertions: Array<{
        index: number;
        cellData: vscode.NotebookCellData;
      }> = [];

      notebookCells.forEach((cell, index) => {
        if (cell.kind !== vscode.NotebookCellKind.Code) {
          return;
        }

        const cellId = getStableCellId(cell, index);
        const summary = summaryByCellId.get(cellId);

        if (!summary) {
          return;
        }

      insertions.push({
        index,
        cellData: createInlineSummaryCell(summary),
      });
      });

      if (insertions.length === 0) {
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      edit.set(
        editor.notebook.uri,
        insertions
          .reverse()
          .map((insertion) =>
            vscode.NotebookEdit.insertCells(insertion.index, [
              insertion.cellData,
            ]),
          ),
      );

      await vscode.workspace.applyEdit(edit);
    } finally {
      this.isRefreshing = false;
    }
  }

  public async clearInlineSummaries(
    notebook: vscode.NotebookDocument | undefined = getCurrentNotebookEditor()
      ?.notebook,
  ): Promise<void> {
    if (!notebook) {
      return;
    }

    const ranges = notebook
      .getCells()
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => this.isManagedInlineSummaryCell(cell))
      .map(({ index }) => new vscode.NotebookRange(index, index + 1))
      .reverse();

    if (ranges.length === 0) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.set(
      notebook.uri,
      ranges.map((range) => vscode.NotebookEdit.deleteCells(range)),
    );

    await vscode.workspace.applyEdit(edit);
  }

  private isNotebookInSync(
    notebook: vscode.NotebookDocument,
    summaryByCellId: Map<string, InlineSummaryCellData>,
  ): boolean {
    const cells = notebook.getCells();
    const expectedSummaryIds = new Set(summaryByCellId.keys());
    let matchedSummaryCount = 0;

    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];

      if (this.isManagedInlineSummaryCell(cell)) {
        const nextCell = cells[index + 1];

        if (!nextCell || nextCell.kind !== vscode.NotebookCellKind.Code) {
          return false;
        }

      const targetCellId = getStableCellId(nextCell, index + 1);
      const expectedSummary = summaryByCellId.get(targetCellId);

        if (!expectedSummary) {
          return false;
        }

        if (!this.doesCellMatchSummary(cell, expectedSummary)) {
          return false;
        }

        matchedSummaryCount++;
        continue;
      }

      if (cell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }

      const previousCell = cells[index - 1];
      const cellId = getStableCellId(cell, index);

      if (
        expectedSummaryIds.has(cellId) &&
        (!previousCell || !this.isManagedInlineSummaryCell(previousCell))
      ) {
        return false;
      }
    }

    return matchedSummaryCount === expectedSummaryIds.size;
  }

  private isManagedInlineSummaryCell(cell: vscode.NotebookCell): boolean {
    if (isInlineSummaryCell(cell)) {
      return true;
    }

    return this.latestCells.some((summary) =>
      this.doesCellMatchLegacySummary(cell, summary),
    );
  }

  private doesCellMatchSummary(
    cell: vscode.NotebookCell,
    summary: InlineSummaryCellData,
  ): boolean {
    const cellText = normalizeInlineSummaryText(cell.document.getText());

    return (
      cellText === normalizeInlineSummaryText(formatInlineSummary(summary)) ||
      cellText === normalizeInlineSummaryText(formatLegacyInlineSummary(summary))
    );
  }

  private doesCellMatchLegacySummary(
    cell: vscode.NotebookCell,
    summary: InlineSummaryCellData,
  ): boolean {
    if (cell.kind !== vscode.NotebookCellKind.Markup) {
      return false;
    }

    return (
      normalizeInlineSummaryText(cell.document.getText()) ===
      normalizeInlineSummaryText(formatLegacyInlineSummary(summary))
    );
  }
}

function createInlineSummaryCell(
  summary: InlineSummaryCellData,
): vscode.NotebookCellData {
  const markdown = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Markup,
    formatInlineSummary(summary),
    "markdown",
  );

  return markdown;
}

function formatInlineSummary(summary: InlineSummaryCellData): string {
  return [INLINE_SUMMARY_MARKER, formatLegacyInlineSummary(summary)].join("\n");
}

function formatLegacyInlineSummary(summary: InlineSummaryCellData): string {
  const label = summary.cellLabel.trim() || "Summary";
  const description = summary.cellDescription.trim() || "No summary yet.";

  return [
    `> **${escapeMarkdown(label)}**`,
    ">",
    ...description
      .split(/\r?\n/)
      .map((line) => `> ${escapeMarkdown(line)}`),
  ].join("\n");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function normalizeInlineSummaryText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

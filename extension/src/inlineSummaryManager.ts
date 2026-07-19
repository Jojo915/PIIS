import * as vscode from "vscode";

import {
  INLINE_SUMMARY_MARKER,
  isInlineSummaryCell,
} from "./inlineSummaryMetadata";
import { getCurrentNotebookEditor, getStableCellId } from "./notebookReader";
import { CellOrigin } from "./types";

export interface InlineSummaryCellData {
  cellId: string;
  cellLabel: string;
  cellDescription: string;
  cellOrigin?: CellOrigin;
}

export type SummaryViewMode = "sidebar" | "inline";

type SyncedData = { cellLabel: string; cellDescription: string };

export type InlineHandEditHandler = (
  notebookId: string,
  cellId: string,
  label: string,
  description: string,
) => Promise<void>;

export class InlineSummaryManager {
  private viewMode: SummaryViewMode = "sidebar";
  private latestCells: InlineSummaryCellData[] = [];
  private isRefreshing = false;
  private refreshPending = false;

  private lastSyncedDataByCellId = new Map<string, SyncedData>();
  private lastWrittenTextByCellId = new Map<string, string>();

  constructor(private readonly onHandEdit?: InlineHandEditHandler) {}

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
      this.refreshPending = true;
      return;
    }

    this.isRefreshing = true;
    try {
      do {
        this.refreshPending = false;

        const editor = getCurrentNotebookEditor();
        if (!editor) {
          return;
        }

        const summaryByCellId = new Map(
          this.latestCells.map((cell) => [cell.cellId, cell]),
        );

        await this.syncExistingNotes(editor.notebook, summaryByCellId);
        await this.removeOrphanedNotes(editor.notebook, summaryByCellId);
        await this.insertMissingNotes(editor.notebook, summaryByCellId);
      } while (this.refreshPending);
    } finally {
      this.isRefreshing = false;
    }
  }

  private async syncExistingNotes(
    notebook: vscode.NotebookDocument,
    summaryByCellId: Map<string, InlineSummaryCellData>,
  ): Promise<void> {
    const cells = notebook.getCells();
    const edit = new vscode.WorkspaceEdit();
    let hasEdits = false;

    for (let index = 0; index < cells.length; index++) {
      const noteCell = cells[index];
      if (!this.isManagedInlineSummaryCell(noteCell)) {
        continue;
      }

      const targetCell = cells[index + 1];
      if (!targetCell || targetCell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }

      const cellId = getStableCellId(targetCell, index + 1);
      const expected = summaryByCellId.get(cellId);
      if (!expected) {
        continue;
      }

      const currentText = noteCell.document.getText();
      const lastData = this.lastSyncedDataByCellId.get(cellId);
      const dataChanged =
        !lastData ||
        lastData.cellLabel !== expected.cellLabel ||
        lastData.cellDescription !== expected.cellDescription;

      if (dataChanged) {
        const origin = expected.cellOrigin ?? "ai";
        const nextText = formatInlineSummary(expected, origin);

        if (currentText !== nextText) {
          const fullRange = new vscode.Range(
            0,
            0,
            noteCell.document.lineCount,
            0,
          );
          edit.replace(noteCell.document.uri, fullRange, nextText);
          hasEdits = true;
        }

        this.lastSyncedDataByCellId.set(cellId, {
          cellLabel: expected.cellLabel,
          cellDescription: expected.cellDescription,
        });
        this.lastWrittenTextByCellId.set(cellId, nextText);
        continue;
      }

      const lastWritten = this.lastWrittenTextByCellId.get(cellId);
      if (
        lastWritten === undefined ||
        normalizeInlineSummaryText(currentText) ===
          normalizeInlineSummaryText(lastWritten)
      ) {
        continue;
      }

      const parsed = parseLegacyInlineSummary(currentText);
      const label = parsed?.label ?? expected.cellLabel;
      const description =
        parsed?.description ?? extractFallbackDescription(currentText);

      if (!parsed) {
        void vscode.window.showWarningMessage(
          `Semantic Canvas couldn't read the label from the hand-edited note for "${label}" It saved the text, but the "> **Label**" line needs to stay intact for label edits to sync.`,
        );
      }

      await this.onHandEdit?.(notebook.uri.fsPath, cellId, label, description);

      const lines = currentText.split(/\r?\n/);
      const badgeLineIndex = lines.findIndex((line) => isOriginBadgeLine(line));
      const humanBadgeLine = formatOriginBadge("human");

      if (badgeLineIndex === -1) {
        const markerLineIndex = lines.indexOf(INLINE_SUMMARY_MARKER);
        const insertAt = markerLineIndex !== -1 ? markerLineIndex + 1 : 0;
        edit.insert(
          noteCell.document.uri,
          new vscode.Position(insertAt, 0),
          `${humanBadgeLine}\n`,
        );
        hasEdits = true;
        lines.splice(insertAt, 0, humanBadgeLine);
        this.lastWrittenTextByCellId.set(cellId, lines.join("\n"));
      } else if (lines[badgeLineIndex] !== humanBadgeLine) {
        const badgeRange = noteCell.document.lineAt(badgeLineIndex).range;
        edit.replace(noteCell.document.uri, badgeRange, humanBadgeLine);
        hasEdits = true;
        lines[badgeLineIndex] = humanBadgeLine;
        this.lastWrittenTextByCellId.set(cellId, lines.join("\n"));
      } else {
        this.lastWrittenTextByCellId.set(cellId, currentText);
      }
    }

    if (hasEdits) {
      await vscode.workspace.applyEdit(edit);
    }
  }

  private async removeOrphanedNotes(
    notebook: vscode.NotebookDocument,
    summaryByCellId: Map<string, InlineSummaryCellData>,
  ): Promise<void> {
    const cells = notebook.getCells();
    const ranges: vscode.NotebookRange[] = [];
    const orphanedIds: string[] = [];

    for (let index = 0; index < cells.length; index++) {
      const noteCell = cells[index];
      if (!this.isManagedInlineSummaryCell(noteCell)) {
        continue;
      }

      const targetCell = cells[index + 1];
      const targetId =
        targetCell && targetCell.kind === vscode.NotebookCellKind.Code
          ? getStableCellId(targetCell, index + 1)
          : undefined;

      if (!targetId || !summaryByCellId.has(targetId)) {
        ranges.push(new vscode.NotebookRange(index, index + 1));
        if (targetId) {
          orphanedIds.push(targetId);
        }
      }
    }

    if (ranges.length === 0) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.set(
      notebook.uri,
      ranges.reverse().map((range) => vscode.NotebookEdit.deleteCells(range)),
    );
    await vscode.workspace.applyEdit(edit);

    for (const id of orphanedIds) {
      this.lastSyncedDataByCellId.delete(id);
      this.lastWrittenTextByCellId.delete(id);
    }
  }

  private async insertMissingNotes(
    notebook: vscode.NotebookDocument,
    summaryByCellId: Map<string, InlineSummaryCellData>,
  ): Promise<void> {
    const cells = notebook.getCells();
    const insertions: Array<{
      index: number;
      cellData: vscode.NotebookCellData;
    }> = [];

    cells.forEach((cell, index) => {
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        return;
      }

      const cellId = getStableCellId(cell, index);
      const expected = summaryByCellId.get(cellId);
      if (!expected) {
        return;
      }

      const previousCell = cells[index - 1];
      if (previousCell && this.isManagedInlineSummaryCell(previousCell)) {
        return;
      }

      const lastData = this.lastSyncedDataByCellId.get(cellId);
      const dataUnchanged =
        lastData !== undefined &&
        lastData.cellLabel === expected.cellLabel &&
        lastData.cellDescription === expected.cellDescription;

      const cachedText = this.lastWrittenTextByCellId.get(cellId);
      const text =
        dataUnchanged && cachedText !== undefined
          ? cachedText
          : formatInlineSummary(expected, expected.cellOrigin ?? "ai");

      insertions.push({
        index,
        cellData: createInlineSummaryCellFromText(text),
      });
      this.lastSyncedDataByCellId.set(cellId, {
        cellLabel: expected.cellLabel,
        cellDescription: expected.cellDescription,
      });
      this.lastWrittenTextByCellId.set(cellId, text);
    });

    if (insertions.length === 0) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.set(
      notebook.uri,
      insertions
        .reverse()
        .map((insertion) =>
          vscode.NotebookEdit.insertCells(insertion.index, [
            insertion.cellData,
          ]),
        ),
    );
    await vscode.workspace.applyEdit(edit);
  }

  public async clearInlineSummaries(
    notebook: vscode.NotebookDocument | undefined = getCurrentNotebookEditor()
      ?.notebook,
  ): Promise<void> {
    if (!notebook) {
      return;
    }

    const summaryByCellId = new Map(
      this.latestCells.map((cell) => [cell.cellId, cell]),
    );
    await this.syncExistingNotes(notebook, summaryByCellId);

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

  private isManagedInlineSummaryCell(cell: vscode.NotebookCell): boolean {
    if (isInlineSummaryCell(cell)) {
      return true;
    }

    return this.latestCells.some((summary) =>
      this.doesCellMatchLegacySummary(cell, summary),
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

function createInlineSummaryCellFromText(
  text: string,
): vscode.NotebookCellData {
  return new vscode.NotebookCellData(
    vscode.NotebookCellKind.Markup,
    text,
    "markdown",
  );
}

const AI_ORIGIN_COLOR = "#FFFAC2";
const HUMAN_ORIGIN_COLOR = "#D7FFC2";

function formatOriginBadge(origin: CellOrigin): string {
  return origin === "human"
    ? `<span style="color:${HUMAN_ORIGIN_COLOR}">#HumanEdit</span>`
    : `<span style="color:${AI_ORIGIN_COLOR}">#AIEdit</span>`;
}

function isOriginBadgeLine(line: string): boolean {
  return (
    line === formatOriginBadge("ai") || line === formatOriginBadge("human")
  );
}

function formatInlineSummary(
  summary: InlineSummaryCellData,
  origin: CellOrigin,
): string {
  return [
    INLINE_SUMMARY_MARKER,
    formatOriginBadge(origin),
    "",
    formatLegacyInlineSummary(summary),
  ].join("\n");
}

function formatLegacyInlineSummary(summary: InlineSummaryCellData): string {
  const label = summary.cellLabel.trim() || "Summary";
  const description = summary.cellDescription.trim() || "No summary yet.";

  return [
    `> **${escapeMarkdown(label)}**`,
    ">",
    ...description.split(/\r?\n/).map((line) => `> ${escapeMarkdown(line)}`),
  ].join("\n");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1");
}

function parseLegacyInlineSummary(
  text: string,
): { label: string; description: string } | null {
  const lines = text.split(/\r?\n/);
  const quoteStart = lines.findIndex((line) => line.startsWith(">"));
  if (quoteStart === -1) {
    return null;
  }

  const quoteLines = lines
    .slice(quoteStart)
    .map((line) => line.replace(/^>\s?/, ""));
  const labelMatch = quoteLines[0]?.match(/^\*\*(.*)\*\*$/);
  if (!labelMatch) {
    return null;
  }

  const descriptionStart = quoteLines[1] === "" ? 2 : 1;

  return {
    label: unescapeMarkdown(labelMatch[1]),
    description: quoteLines
      .slice(descriptionStart)
      .map((line) => unescapeMarkdown(line))
      .join("\n")
      .trim(),
  };
}

function extractFallbackDescription(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(
      (line) => line !== INLINE_SUMMARY_MARKER && !isOriginBadgeLine(line),
    )
    .map((line) => unescapeMarkdown(line.replace(/^>\s?/, "")))
    .join("\n")
    .trim();
}

function normalizeInlineSummaryText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

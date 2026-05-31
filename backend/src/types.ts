export type CellId = number;

export type CellType = "code" | "markdown";

export interface NotebookCellInput {
  notebookId: string;
  cellId: CellId;
  cellContent: string;
  cellType: CellType;
}

export interface CellData {
  cellId: CellId;
  cellLabel: string;
  cellDescription: string;
  cellColor?: string;
  cellIcon?: string;
  createTime?: string;
  updateTime?: string[];
}

export interface UpdateCellRequest {
  notebookId: string;
  cellId: CellId;
  cellContent: string;
  cellType: CellType;
}

export interface UpdateCellResponse {
  cellLabel: string;
  cellDescription: string;
}

export interface IndexNotebookRequest {
  notebookId: string;
  cells: NotebookCellInput[];
}

export interface IndexNotebookResponse {
  cellLabels: string[];
  cellDescriptions: string[];
}

export interface BackendSearchRequest {
  questionId: CellId;
  question: string;
}

export interface SearchResult {
  cellId: CellId;
  similarity: number;
  label?: string;
}

export interface BackendSearchResponse {
  queryCellsList: CellData[];
  otherCellsList: CellData[];
  tuple: null;
}

export interface CanvasData {
  searchBar: string;
  queryCellsList: CellData[];
  otherCellsList: CellData[];
  tuple: null;
}

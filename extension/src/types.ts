export type CellId = string;

export type CellType = "code" | "markdown";

/**
 * =========================
 * Frontend / Canvas Types
 * =========================
 * These types are mainly used by the VS Code webview frontend.
 */

export interface CellData {
  cellId: CellId;
  cellLabel: string;
  cellDescription: string;
  cellColor?: string;
  cellIcon?: string;
  createTime?: string;
  updateTime?: string[];
  similarity?: number;
  distance?: number;
}

export interface CanvasData {
  searchBar: string;
  queryCellsList: CellData[];
  otherCellsList: CellData[];
  tuple: null;
}

/**
 * =========================
 * Backend Jupyter Notebook Types
 * =========================
 * These types must match the FastAPI backend request format.
 */

export interface JupyterOutput {
  output_type: string;
  name?: string;
  text?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface JupyterCellContent {
  id: CellId;
  cell_type: CellType;
  source: string;
  metadata: Record<string, unknown>;
  outputs?: JupyterOutput[];
  execution_count?: number | null;
}

export interface NotebookContent {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: JupyterCellContent[];
}

/**
 * Request body for:
 * POST /notebooks
 */
export interface BackendNotebookRequest {
  notebook_id: string;
  content: NotebookContent;
}

/**
 * Response item from:
 * POST /notebooks
 */
export interface BackendCellResponse {
  cell_id: CellId;
  cell_type: CellType;
  content: string;
  notebook_id: string;
  label?: string;
  summary?: string;
}

/**
 * Full response from:
 * POST /notebooks
 */
export type BackendNotebookResponse = BackendCellResponse[];

/**
 * Request body for:
 * POST /cells
 *
 * Backend note:
 * For now, only code cells should be sent to this endpoint.
 */
export interface BackendCellRequest {
  notebook_id: string;
  content: JupyterCellContent;
}

/**
 * Response from:
 * POST /cells
 */
export type BackendUpdateCellResponse = BackendCellResponse;

/**
 * Request body for:
 * POST /search
 */
export interface BackendSearchRequest {
  notebook_id: string;
  text: string;
}

/**
 * Response item from:
 * POST /search
 *
 * Current backend only returns cell_id and distance.
 */
export interface BackendSearchResult {
  cell_id: CellId;
  distance: number;
  cell_type?: CellType;
  label?: string;
  summary?: string;
}

/**
 * Full response from:
 * POST /search
 */
export type BackendSearchResponse = BackendSearchResult[];

/**
 * =========================
 * Internal Extension Types
 * =========================
 * These are optional helper types used inside the extension.
 */

export interface NotebookCellInput {
  notebookId: string;
  cellId: CellId;
  cellContent: string;
  cellType: CellType;
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

export interface SearchResult {
  cellId: CellId;
  similarity: number;
  label?: string;
}

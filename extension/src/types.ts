export type CellId = string;

export type CellType = "code" | "markdown";

export type CellOrigin = "ai" | "human";

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
  cellContent?: string;  // raw source code, used for keyword (ctrl+f style) search
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
  cell_index: number;
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
  /** How many results to return in total. Caller is responsible for
   *  splitting them into top / others buckets. Defaults to 8 server-side. */
  n_results?: number;
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
 * Request body for:
 * POST /cells/summary
 */
export interface BackendSummaryRequest {
  notebook_id: string;
  cell_id: CellId;
  label: string | null;
  summary: string | null;
}

/**
 * Response from:
 * GET/POST /cells/summary
 */
export interface BackendSummaryResponse {
  notebook_id: string;
  cell_id: CellId;
  ai_label: string | null;
  user_label: string | null;
  ai_summary: string | null;
  user_summary: string | null;
  source_hash: string | null;
  display_label: string | null;
  display_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackendNotebookSummaryCell {
  cell_id: CellId;
  cell_type: CellType;
  source: string;
  cell_index: number;
}

export interface BackendSummarySuggestionRequest {
  notebook_id: string;
  cell_id: CellId;
  cell_type: CellType;
  source: string;
  previous_cells: string[];
}

export interface BackendSummarySuggestionResponse {
  label: string | null;
  summary: string | null;
}

/**
 * Request body for:
 * POST /notebooks/summaries
 */
export interface BackendNotebookSummariesRequest {
  notebook_id: string;
  cells: BackendNotebookSummaryCell[];
}

/**
 * Full response from:
 * POST /notebooks/summaries
 */
export type BackendNotebookSummariesResponse = BackendSummaryResponse[];

/**
 * Request body for:
 * POST /cells/duplicates
 */
export interface BackendDuplicateRequest {
  notebook_id: string;
  cell_id: CellId;
  threshold?: number;
}

/**
 * One result item from:
 * POST /cells/duplicates
 */
export interface BackendDuplicateResult {
  cell_id: CellId;
  distance: number;
}

/**
 * Full response from:
 * POST /cells/duplicates
 */
export type BackendDuplicateResponse = BackendDuplicateResult[];

/**
 * Request body for:
 * POST /notebooks/dead-cells
 *
 * Dead-cell detection is a whole-notebook static analysis, so the full
 * notebook content is sent (same shape as POST /notebooks).
 */
export interface BackendDeadCellRequest {
  notebook_id: string;
  content: NotebookContent;
}

/**
 * One result item from:
 * POST /notebooks/dead-cells
 */
export interface BackendDeadCellResult {
  cell_id: CellId;
  cell_index: number;
  unused_names: string[];
  reason: string;
}

/**
 * Full response from:
 * POST /notebooks/dead-cells
 */
export type BackendDeadCellResponse = BackendDeadCellResult[];

/**
 * Request body for:
 * POST /notebooks/stale-cells
 *
 * Order-staleness detection is a whole-notebook static analysis over the
 * kernel execution_count of each cell, so the full notebook content is
 * sent (same shape as POST /notebooks).
 */
export interface BackendStaleCellRequest {
  notebook_id: string;
  content: NotebookContent;
}

/**
 * One result item from:
 * POST /notebooks/stale-cells
 */
export interface BackendStaleCellResult {
  cell_id: CellId;
  cell_index: number;
  reason: string;
  stale_due_to: number[];
}

/**
 * Full response from:
 * POST /notebooks/stale-cells
 */
export type BackendStaleCellResponse = BackendStaleCellResult[];

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

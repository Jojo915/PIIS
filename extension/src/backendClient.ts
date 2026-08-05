import {
  BackendNotebookRequest,
  BackendNotebookResponse,
  BackendSearchRequest,
  BackendSearchResponse,
  BackendCellRequest,
  BackendUpdateCellResponse,
  BackendSummaryRequest,
  BackendSummaryResponse,
  BackendNotebookSummariesRequest,
  BackendNotebookSummariesResponse,
  BackendSummarySuggestionRequest,
  BackendSummarySuggestionResponse,
  BackendDuplicateRequest,
  BackendDuplicateResponse,
  BackendDuplicateClustersRequest,
  BackendDuplicateClustersResponse,
  BackendDeadCellRequest,
  BackendDeadCellResponse,
  BackendStaleCellRequest,
  BackendStaleCellResponse,
  BackendAiSettingsRequest,
  BackendAiSettingsResponse,
  BackendAiSettingsSaveResponse,
} from "./types";

const BACKEND_URL = "http://127.0.0.1:8000";
const BACKEND_RETRY_DELAYS_MS = [500, 1000, 2000];

async function postJson<TRequest, TResponse>(
  endpoint: string,
  data: TRequest,
): Promise<TResponse> {
  const response = await fetchWithRetry(`${BACKEND_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Backend request failed: ${endpoint}, status: ${response.status}, message: ${errorText}`,
    );
  }

  return response.json() as Promise<TResponse>;
}

async function getJson<TResponse>(endpoint: string): Promise<TResponse> {
  const response = await fetchWithRetry(`${BACKEND_URL}${endpoint}`, {
    method: "GET",
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Backend request failed: ${endpoint}, status: ${response.status}, message: ${errorText}`,
    );
  }

  return response.json() as Promise<TResponse>;
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= BACKEND_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;

      if (attempt === BACKEND_RETRY_DELAYS_MS.length) {
        break;
      }

      await delay(BACKEND_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Called when the user opens a notebook.
 *
 * Backend endpoint:
 * POST /notebooks
 */
export async function indexNotebook(
  data: BackendNotebookRequest,
): Promise<BackendNotebookResponse> {
  return postJson<BackendNotebookRequest, BackendNotebookResponse>(
    "/notebooks",
    data,
  );
}

/**
 * Called when a code cell is executed or updated.
 *
 * Backend endpoint:
 * POST /cells
 *
 * Backend requirement:
 * only code cells should be sent to this endpoint.
 */
export async function updateCell(
  data: BackendCellRequest,
): Promise<BackendUpdateCellResponse> {
  return postJson<BackendCellRequest, BackendUpdateCellResponse>(
    "/cells",
    data,
  );
}

/**
 * Called when the user deletes a cell.
 *
 * Backend endpoint:
 * DELETE /cells/{cellId}?notebook_id=...
 *
 * notebookId is required (not just cellId) so the backend can also clear
 * that cell's row in the SQLite summary store, which is keyed by
 * (notebook_id, cell_id) -- cell_id alone is only unique within one
 * notebook, not globally.
 */
export async function deleteCell(
  cellId: string,
  notebookId: string,
): Promise<void> {
  const url = `${BACKEND_URL}/cells/${encodeURIComponent(cellId)}?notebook_id=${encodeURIComponent(notebookId)}`;
  const response = await fetchWithRetry(url, {
    method: "DELETE",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Backend request failed: /cells/${cellId}, status: ${response.status}, message: ${errorText}`,
    );
  }
}

/**
 * Called when cells are reordered within a notebook (no content change).
 *
 * Backend endpoint:
 * PATCH /notebooks/reorder
 */
export async function reorderNotebook(
  notebookId: string,
  cellIds: string[],
): Promise<void> {
  const response = await fetchWithRetry(`${BACKEND_URL}/notebooks/reorder`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ notebook_id: notebookId, cell_ids: cellIds }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Backend request failed: /notebooks/reorder, status: ${response.status}, message: ${errorText}`,
    );
  }
}

/**
 * Called when the user enters a question.
 *
 * Backend endpoint:
 * POST /search
 */
export async function searchCells(
  data: BackendSearchRequest,
): Promise<BackendSearchResponse> {
  return postJson<BackendSearchRequest, BackendSearchResponse>("/search", data);
}

/**
 * Called after a cell is auto-updated to check for near-duplicate cells.
 *
 * Backend endpoint:
 * POST /cells/duplicates
 */
export async function findDuplicateCells(
  data: BackendDuplicateRequest,
): Promise<BackendDuplicateResponse> {
  return postJson<BackendDuplicateRequest, BackendDuplicateResponse>(
    "/cells/duplicates",
    data,
  );
}

/**
 * Called to find independent clusters of mutually near-duplicate code
 * cells across the whole notebook.
 *
 * Backend endpoint:
 * POST /notebooks/duplicate-cells
 *
 * Unlike findDuplicateCells (a per-cell "what's this one cell close to"
 * lookup), this is the whole-notebook, full-replace analysis that powers
 * the duplicate advisor -- it uses complete-linkage clustering so two
 * unrelated near-duplicate clusters connected only by a weak "bridge"
 * pair stay separate instead of merging into one oversized group.
 */
export async function findDuplicateClusters(
  data: BackendDuplicateClustersRequest,
): Promise<BackendDuplicateClustersResponse> {
  return postJson<
    BackendDuplicateClustersRequest,
    BackendDuplicateClustersResponse
  >("/notebooks/duplicate-cells", data);
}

/**
 * Called to find likely-dead code cells across the whole notebook.
 *
 * Backend endpoint:
 * POST /notebooks/dead-cells
 */
export async function findDeadCells(
  data: BackendDeadCellRequest,
): Promise<BackendDeadCellResponse> {
  return postJson<BackendDeadCellRequest, BackendDeadCellResponse>(
    "/notebooks/dead-cells",
    data,
  );
}

/**
 * Called to find likely-stale (out-of-order) code cells across the
 * whole notebook, using each cell's kernel execution_count.
 *
 * Backend endpoint:
 * POST /notebooks/stale-cells
 */
export async function findStaleCells(
  data: BackendStaleCellRequest,
): Promise<BackendStaleCellResponse> {
  return postJson<BackendStaleCellRequest, BackendStaleCellResponse>(
    "/notebooks/stale-cells",
    data,
  );
}

/**
 * Called when the user edits a cell summary in the webview.
 *
 * Backend endpoint:
 * POST /cells/summary
 */
export async function saveCellSummary(
  data: BackendSummaryRequest,
): Promise<BackendSummaryResponse> {
  return postJson<BackendSummaryRequest, BackendSummaryResponse>(
    "/cells/summary",
    data,
  );
}

/**
 * Called after notebook indexing to hydrate display summaries from SQLite.
 *
 * Backend endpoint:
 * POST /notebooks/summaries
 */
export async function getNotebookSummaries(
  data: BackendNotebookSummariesRequest,
): Promise<BackendNotebookSummariesResponse> {
  return postJson<
    BackendNotebookSummariesRequest,
    BackendNotebookSummariesResponse
  >("/notebooks/summaries", data);
}

/**
 * Called when the user asks AI to suggest a new summary manually.
 *
 * Backend endpoint:
 * POST /cells/summary/suggestion
 */
export async function suggestCellSummary(
  data: BackendSummarySuggestionRequest,
): Promise<BackendSummarySuggestionResponse> {
  return postJson<
    BackendSummarySuggestionRequest,
    BackendSummarySuggestionResponse
  >("/cells/summary/suggestion", data);
}

/**
 * Called when the AI Settings panel is loaded (webview ready, or on
 * demand), to hydrate its fields with the currently-saved settings.
 *
 * Backend endpoint:
 * GET /settings
 */
export async function getAiSettings(): Promise<BackendAiSettingsResponse> {
  return getJson<BackendAiSettingsResponse>("/settings");
}

/**
 * Called when the user clicks Save in the AI Settings panel.
 *
 * Backend endpoint:
 * POST /settings
 *
 * The response's `api_key_changed` flag is what the caller uses to decide
 * whether to trigger a full notebook reindex -- per the feature's
 * reindexing rule, that should happen only when a new/changed API key was
 * saved, never for a model- or checkbox-only change.
 */
export async function saveAiSettings(
  data: BackendAiSettingsRequest,
): Promise<BackendAiSettingsSaveResponse> {
  return postJson<BackendAiSettingsRequest, BackendAiSettingsSaveResponse>(
    "/settings",
    data,
  );
}

/**
 * Called when the user clicks Reset in the AI Settings panel.
 *
 * Backend endpoint:
 * POST /settings/reset
 */
export async function resetAiSettings(): Promise<BackendAiSettingsResponse> {
  const response = await fetchWithRetry(`${BACKEND_URL}/settings/reset`, {
    method: "POST",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Backend request failed: /settings/reset, status: ${response.status}, message: ${errorText}`,
    );
  }

  return response.json() as Promise<BackendAiSettingsResponse>;
}

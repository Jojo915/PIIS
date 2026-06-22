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
 * DELETE /cells
 */
export async function deleteCell(cellId: string): Promise<void> {
  const response = await fetchWithRetry(`${BACKEND_URL}/cells/${cellId}`, {
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

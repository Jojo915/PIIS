import {
  BackendNotebookRequest,
  BackendNotebookResponse,
  BackendSearchRequest,
  BackendSearchResponse,
  BackendCellRequest,
  BackendUpdateCellResponse,
} from "./types";

const BACKEND_URL = "http://localhost:8000";

async function postJson<TRequest, TResponse>(
  endpoint: string,
  data: TRequest,
): Promise<TResponse> {
  const response = await fetch(`${BACKEND_URL}${endpoint}`, {
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

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
 * Called when the user deletes a cell.
 *
 * Backend endpoint:
 * DELETE /cells
 */
export async function deleteCell(cellId: string): Promise<void> {
  const response = await fetch(`${BACKEND_URL}/cells/${cellId}`, {
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
  const response = await fetch(`${BACKEND_URL}/notebooks/reorder`, {
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

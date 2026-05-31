import {
  IndexNotebookRequest,
  IndexNotebookResponse,
  BackendSearchRequest,
  BackendSearchResponse,
  UpdateCellRequest,
  UpdateCellResponse,
} from "./types";

const BACKEND_URL = "http://localhost:8000";

async function postJson<TRequest, TResponse>(
  endpoint: string,
  data: TRequest
): Promise<TResponse> {
  const response = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status}`);
  }

  return response.json() as Promise<TResponse>;
}

export async function indexNotebook(
  data: IndexNotebookRequest
): Promise<IndexNotebookResponse> {
  return postJson<IndexNotebookRequest, IndexNotebookResponse>(
    "/notebook/index",
    data
  );
}

export async function searchCells(
  data: BackendSearchRequest
): Promise<BackendSearchResponse> {
  return postJson<BackendSearchRequest, BackendSearchResponse>(
    "/search",
    data
  );
}

export async function updateCell(
  data: UpdateCellRequest
): Promise<UpdateCellResponse> {
  return postJson<UpdateCellRequest, UpdateCellResponse>(
    "/cell/update",
    data
  );
}

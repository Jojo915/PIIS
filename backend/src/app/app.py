"""Contains initial fastapi endpoints."""

from __future__ import annotations

import hashlib

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.cells.code import CodeCell
from app.cells.factory import cell_factory
from app.inference.client import get_client
from app.inference.utils import (
    create_label_and_summary_prompt,
    run_chat_completion,
)
from app.summary_store.base import CellSummary
from app.summary_store.sqlite_store import SQLiteSummaryStore
from app.vector_store.client import create_vector_store
from app.vector_store.embedding_model import load_embedding_model
from app.vector_store.operations import (
    chunk_complete_notebook,
    construct_vector_store,
    delete_notebook_from_store,
    update_cell_order,
    update_vector_store,
)
from app.vector_store.utils import (
    retrieve_documents,
    retrieve_previous_cells,
)

app = FastAPI()

model = load_embedding_model("sentence-transformers/all-MiniLM-L6-v2")

client = get_client()

summary_store = SQLiteSummaryStore()
INVALID_AI_SUMMARIES = {"", "summary"}


class Cell(BaseModel):
    """Represents the data for a cell."""

    content: dict
    notebook_id: str
    cell_index: int


class Notebook(BaseModel):
    """Represents the notebook."""

    notebook_id: str
    content: dict


class Query(BaseModel):
    """Represents the query."""

    notebook_id: str
    text: str


class SummaryRequest(BaseModel):
    """Represents a user-edited cell summary."""

    notebook_id: str
    cell_id: str
    summary: str | None


class SummaryResponse(BaseModel):
    """Represents stored summaries for one cell."""

    notebook_id: str
    cell_id: str
    ai_summary: str | None
    user_summary: str | None
    source_hash: str | None
    display_summary: str | None
    created_at: str
    updated_at: str


class NotebookSummaryCell(BaseModel):
    """Represents one notebook cell for summary hydration."""

    cell_id: str
    cell_type: str
    source: str
    cell_index: int


class NotebookSummariesRequest(BaseModel):
    """Represents a batch summary request for one notebook."""

    notebook_id: str
    cells: list[NotebookSummaryCell]


# NOTE: This is called when a cell is executed, you send the cell
@app.post("/cells")
async def embed_cell(cell: Cell):
    """Receives a cell and embeds the cell."""
    content = cell.content
    notebook_id = cell.notebook_id

    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    created_cell = cell_factory(content, cell.cell_index)
    updated_chunk = created_cell.to_chunk(notebook_id=notebook_id)
    updated_embed = created_cell.to_embed()
    if isinstance(created_cell, CodeCell):
        previous_cells = retrieve_previous_cells(
            collection, notebook_id, cell.cell_index
        )
        context = [str(c["embed_text"]) for c in previous_cells]
        prompt = create_label_and_summary_prompt(created_cell.content, context)
        label, summary = run_chat_completion(client=client, prompt=prompt)
        if label is not None:
            updated_chunk["label"] = label  # pyright: ignore[reportIndexIssue]
        if summary is not None:
            updated_chunk["summary"] = summary  # pyright: ignore[reportIndexIssue]
            summary_store.save_ai_summary(
                notebook_id=notebook_id,
                cell_id=str(updated_chunk["cell_id"]),
                summary=summary,
                source_hash=hash_cell_source(str(updated_chunk["content"])),
            )
    update_vector_store(collection, updated_chunk, updated_embed, model)
    return updated_chunk


# NOTE: This is called when the user deletes a cell.
@app.delete("/cells/{cell_id}")
async def delete_cell(cell_id: str):
    """Delete a single cell from the vector store."""
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    collection.delete(where={"cell_id": cell_id})
    return {"deleted": cell_id}


@app.get("/cells/summary", response_model=SummaryResponse)
async def get_cell_summary(notebook_id: str, cell_id: str):
    """Return stored summaries for one cell."""
    summary = summary_store.get_summary(notebook_id, cell_id)

    if summary is None:
        raise HTTPException(status_code=404, detail="Summary not found")

    return summary_to_response(summary)


@app.post("/cells/summary", response_model=SummaryResponse)
async def save_cell_summary(request: SummaryRequest):
    """Create or update a user-edited summary for one cell."""
    summary = summary_store.save_user_summary(
        notebook_id=request.notebook_id,
        cell_id=request.cell_id,
        summary=request.summary,
    )
    return summary_to_response(summary)


@app.post("/notebooks/summaries", response_model=list[SummaryResponse])
async def get_notebook_summaries(request: NotebookSummariesRequest):
    """Return display summaries for cells, generating missing AI summaries."""
    responses: list[SummaryResponse] = []
    previous_cells: list[str] = []

    for cell in sorted(request.cells, key=lambda item: item.cell_index):
        source_hash = hash_cell_source(cell.source)
        stored = summary_store.get_summary(request.notebook_id, cell.cell_id)

        if (
            stored is not None
            and stored.display_summary is not None
            and (
                stored.user_summary is not None
                or (
                    stored.source_hash == source_hash
                    and is_valid_ai_summary(stored.ai_summary)
                )
            )
        ):
            responses.append(summary_to_response(stored))
            previous_cells.append(cell.source)
            continue

        _, generated_summary = generate_cell_label_and_summary(
            cell_type=cell.cell_type,
            source=cell.source,
            previous_cells=previous_cells,
        )
        summary = summary_store.save_ai_summary(
            notebook_id=request.notebook_id,
            cell_id=cell.cell_id,
            summary=generated_summary,
            source_hash=source_hash,
        )
        responses.append(summary_to_response(summary))
        previous_cells.append(cell.source)

    return responses


# NOTE: This is called when the user opens a notebook
@app.post("/notebooks")
async def embed_notebook(notebook: Notebook):
    """Receives the complete notebook and embeds it."""
    notebook_id = notebook.notebook_id
    content = notebook.content
    chunks, embed_texts = chunk_complete_notebook(content, notebook_id, client)
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    delete_notebook_from_store(collection, notebook_id)
    construct_vector_store(collection, chunks, embed_texts, model)
    save_ai_summaries(notebook_id, chunks)
    return chunks


# NOTE: This is called when the user enters a question, returns similar cells.
@app.post("/search")
async def query_cells(query: Query):
    """Receives a question and responds with the most similar cells."""
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )

    results = retrieve_documents(
        query=query.text,
        collection=collection,
        model=model,
        notebook_id=query.notebook_id,
    )
    return results


class ReorderRequest(BaseModel):
    """Represents the new cell ordering for a notebook."""

    notebook_id: str
    cell_ids: list[str]


@app.patch("/notebooks/reorder")
async def reorder_notebook(reorder: ReorderRequest):
    """Update stored cell_index for every cell after a reorder."""
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    update_cell_order(collection, reorder.notebook_id, reorder.cell_ids)
    return {
        "notebook_id": reorder.notebook_id,
        "reordered": len(reorder.cell_ids),
    }


def summary_to_response(summary: CellSummary) -> SummaryResponse:
    """Convert a stored summary to an API response."""
    return SummaryResponse(
        notebook_id=summary.notebook_id,
        cell_id=summary.cell_id,
        ai_summary=summary.ai_summary,
        user_summary=summary.user_summary,
        source_hash=summary.source_hash,
        display_summary=summary.display_summary,
        created_at=summary.created_at,
        updated_at=summary.updated_at,
    )


def is_valid_ai_summary(summary: str | None) -> bool:
    """Return whether a stored AI summary is useful enough to show."""
    if summary is None:
        return False

    return summary.strip().lower() not in INVALID_AI_SUMMARIES


def save_ai_summaries(notebook_id: str, chunks: list) -> None:
    """Persist AI-generated summaries from notebook indexing."""
    for chunk in chunks:
        summary = chunk.get("summary")

        if summary is None:
            continue

        summary_store.save_ai_summary(
            notebook_id=notebook_id,
            cell_id=str(chunk["cell_id"]),
            summary=str(summary),
            source_hash=hash_cell_source(str(chunk["content"])),
        )


def hash_cell_source(source: str) -> str:
    """Return a stable hash for the cell source used by AI summaries."""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def generate_cell_label_and_summary(
    cell_type: str,
    source: str,
    previous_cells: list[str],
) -> tuple[str | None, str | None]:
    """Generate a label and summary for one cell when needed."""
    if cell_type != "code":
        return None, None

    context = previous_cells[-5:]
    prompt = create_label_and_summary_prompt(source, context)
    return run_chat_completion(client=client, prompt=prompt)

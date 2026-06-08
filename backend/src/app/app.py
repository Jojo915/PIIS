"""Contains initial fastapi endpoints."""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from app.cells.code import CodeCell
from app.cells.factory import cell_factory
from app.inference.client import get_client
from app.inference.utils import create_prompt, run_chat_completion
from app.vector_store.client import create_vector_store
from app.vector_store.embedding_model import load_embedding_model
from app.vector_store.operations import (
    chunk_complete_notebook,
    construct_vector_store,
    delete_notebook_from_store,
    update_vector_store,
)
from app.vector_store.utils import (
    retrieve_documents,
)

app = FastAPI()

model = load_embedding_model("sentence-transformers/all-MiniLM-L6-v2")

client = get_client()


class Cell(BaseModel):
    """Represents the data for a cell."""

    content: dict
    notebook_id: str


class Notebook(BaseModel):
    """Represents the notebook."""

    notebook_id: str
    content: dict


class Query(BaseModel):
    """Represents the query."""

    notebook_id: str
    text: str


# NOTE: This is called when a cell is executed, you send the cell
@app.post("/cells")
async def embed_cell(cell: Cell):
    """Receives a cell and embeds the cell."""
    content = cell.content
    notebook_id = cell.notebook_id

    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    created_cell = cell_factory(content)
    updated_chunk = created_cell.to_chunk(notebook_id=notebook_id)
    updated_embed = created_cell.to_embed()
    if isinstance(created_cell, CodeCell):
        prompt = create_prompt(updated_embed)
        if len(created_cell.content) == 0:
            label = "label"
            summary = "summary"
        else:
            label = run_chat_completion(client=client, prompt=prompt)
            summary = "summary"
        updated_chunk["label"] = label  # pyright: ignore[reportIndexIssue]
        updated_chunk["summary"] = summary  # pyright: ignore[reportIndexIssue]
    update_vector_store(collection, updated_chunk, updated_embed, model)
    return updated_chunk


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

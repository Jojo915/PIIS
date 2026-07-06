"""Contains the vector store operations."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.cells.code import CodeCell
from app.cells.factory import cell_factory
from app.inference.utils import (
    create_label_and_summary_prompt,
    run_chat_completion,
)
from app.vector_store.utils import DEFAULT_CONTEXT_WINDOW

if TYPE_CHECKING:
    from chromadb import Collection, Metadata
    from google import genai
    from sentence_transformers import SentenceTransformer


def enrich_embed_text(
    base_embed: str,
    label: str | None,
    summary: str | None,
) -> str:
    """Append LLM-generated label and summary to the base embed text.

    Including label and summary in the embedding means concept-level queries
    ("what normalises features?") can match cells via their LLM-generated
    description even when the raw code doesn't contain those exact words.
    Only non-empty values are appended; the base embed is always returned
    unchanged when both label and summary are absent or falsy.
    """
    parts = [base_embed]
    if label:
        parts.append(label)
    if summary:
        parts.append(summary)
    return "\n".join(parts)


def chunk_complete_notebook(
    notebook: dict, notebook_id: str, client: genai.Client
) -> tuple[list, list[str]]:
    """Return chunks and embed texts for all cells in a notebook."""
    chunks, embed_texts = [], []
    previous_embeds: list[str] = []
    for cell_index, cell in enumerate(notebook["cells"]):
        cell_obj = cell_factory(cell, cell_index)
        chunk = cell_obj.to_chunk(notebook_id=notebook_id)
        embed_text = cell_obj.to_embed()
        if isinstance(cell_obj, CodeCell):
            context = previous_embeds[-DEFAULT_CONTEXT_WINDOW:]
            prompt = create_label_and_summary_prompt(cell_obj.content, context)
            label, summary = run_chat_completion(client=client, prompt=prompt)
            if label is not None:
                chunk["label"] = label  # pyright: ignore[reportIndexIssue]
            if summary is not None:
                chunk["summary"] = summary  # pyright: ignore[reportIndexIssue]
            embed_text = enrich_embed_text(embed_text, label, summary)
            chunk["embed_text"] = embed_text  # pyright: ignore[reportIndexIssue]
        embed_texts.append(embed_text)
        chunks.append(chunk)
        previous_embeds.append(embed_text)
    return chunks, embed_texts


def construct_vector_store(
    collection: Collection,
    chunks: list,
    embed_texts: list[str],
    model: SentenceTransformer,
) -> None:
    """Construct vector store by embedding and upserting all chunks."""
    collection.upsert(
        ids=[chunk["cell_id"] for chunk in chunks],
        embeddings=[
            model.encode(text, convert_to_numpy=True) for text in embed_texts
        ],
        metadatas=chunks,
    )


def update_vector_store(
    collection: Collection,
    chunk: Metadata,
    embed_text: str,
    model: SentenceTransformer,
) -> None:
    """Replace a single cell in the vector store with a new embedding."""
    cell_id = str(chunk["cell_id"])
    collection.delete(ids=[cell_id])
    collection.upsert(
        ids=[cell_id],
        embeddings=model.encode([embed_text], convert_to_numpy=True),
        metadatas=[chunk],
    )


def delete_notebook_from_store(collection: Collection, notebook_id: str):
    """Delete all the cells from one notebook.

    This function should be called when a notebook is deleted.
    """
    collection.delete(where={"notebook_id": notebook_id})


def update_cell_order(
    collection: Collection, notebook_id: str, cell_ids: list[str]
) -> None:
    """Update cell_index for every cell in a notebook after a reorder.

    Metadata-only update; does not touch embeddings, since cell content
    hasn't changed.
    """
    collection.update(
        ids=cell_ids,
        metadatas=[{"cell_index": index} for index in range(len(cell_ids))],
    )

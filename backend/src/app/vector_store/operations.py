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
    if not chunks:
        # A notebook can legitimately re-index down to zero cells (e.g.
        # every cell was deleted before save). Chroma's upsert rejects an
        # empty embeddings list outright, so skip the call entirely rather
        # than erroring -- there is nothing to construct.
        return
    collection.upsert(
        ids=[chunk["cell_id"] for chunk in chunks],
        embeddings=[
            model.encode(
                text, convert_to_numpy=True, normalize_embeddings=True
            )
            for text in embed_texts
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
        embeddings=model.encode(
            [embed_text], convert_to_numpy=True, normalize_embeddings=True
        ),
        metadatas=[chunk],
    )


def delete_notebook_from_store(collection: Collection, notebook_id: str):
    """Delete all the cells from one notebook.

    This function should be called when a notebook is deleted.
    """
    collection.delete(where={"notebook_id": notebook_id})


def delete_cell_from_store(
    collection: Collection, notebook_id: str, cell_id: str
) -> None:
    """Delete one cell's chunk from the vector store, scoped to its notebook.

    ``cell_id`` (the nbformat cell id) is only guaranteed unique *within* a
    single notebook -- if a notebook file is ever duplicated on disk, the
    copy's cells keep the same nbformat ids as the original, so the same
    ``cell_id`` can legitimately appear in more than one indexed notebook.
    Scoping the delete with ``notebook_id`` (mirroring the ``$and`` filter
    convention used elsewhere, e.g. ``retrieve_documents``) ensures deleting
    a cell in one notebook can never remove a same-id cell that belongs to a
    different notebook.
    """
    collection.delete(
        where={"$and": [{"cell_id": cell_id}, {"notebook_id": notebook_id}]}
    )


def update_cell_order(
    collection: Collection, notebook_id: str, cell_ids: list[str]
) -> None:
    """Update cell_index for every cell in a notebook after a reorder.

    Metadata-only update; does not touch embeddings, since cell content
    hasn't changed.

    ``cell_ids`` is validated against ``notebook_id`` before writing: only
    ids that are actually stored under this notebook are updated. Without
    this check, a request whose ``cell_ids`` accidentally (or, in the
    duplicated-notebook-file scenario described in ``delete_cell_from_store``,
    legitimately) includes an id belonging to a *different* notebook would
    silently overwrite that other notebook's ``cell_index`` too, since
    ``collection.update(ids=...)`` targets ids directly with no notebook
    scoping of its own. The new ``cell_index`` values still come from each
    id's position in the (caller-supplied, already-ordered) ``cell_ids``
    list, so validation only ever drops entries -- it never reorders the
    ones that pass.
    """
    if not cell_ids:
        return
    existing = collection.get(
        ids=cell_ids, where={"notebook_id": notebook_id}, include=[]
    )
    valid_ids = set(existing["ids"])
    ids: list[str] = []
    metadatas: list[Metadata] = []
    for index, cell_id in enumerate(cell_ids):
        if cell_id in valid_ids:
            ids.append(cell_id)
            metadatas.append({"cell_index": index})  # pyright: ignore[reportArgumentType]
    if ids:
        collection.update(ids=ids, metadatas=metadatas)

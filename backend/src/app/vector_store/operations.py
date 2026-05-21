"""Contains the vector store operations."""

from chromadb import Collection, Metadata
from sentence_transformers import SentenceTransformer

from app.cells.factory import cell_factory


def chunk_complete_notebook(
    notebook: dict, notebook_id: str
) -> tuple[list, list[str]]:
    """Return chunks and embed texts for all cells in a notebook."""
    chunks, embed_texts = [], []
    for cell in notebook["cells"]:
        cell_obj = cell_factory(cell)
        chunks.append(cell_obj.to_chunk(notebook_id=notebook_id))
        embed_texts.append(cell_obj.to_embed())
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
    """Update a single cell in the vector store by upserting new embedding."""
    collection.upsert(
        ids=[str(chunk["cell_id"])],
        embeddings=model.encode([embed_text], convert_to_numpy=True),
        metadatas=[chunk],
    )


def delete_notebook_from_store(collection: Collection, notebook_id: str):
    """Delete all the cells from one notebook.

    This function should be called when a notebook is deleted.
    """
    collection.delete(where={"notebook_id": notebook_id})


def retrieve_documents(
    query: str,
    collection: Collection,
    model: SentenceTransformer,
    notebook_id: str,
    n_results: int = 3,
) -> list[dict]:
    """Query the vector store and return ranked results for one notebook."""
    n_results = min(n_results, collection.count())
    if n_results == 0:
        return []
    results = collection.query(
        query_embeddings=model.encode([query], convert_to_numpy=True),
        where={"notebook_id": notebook_id},
        n_results=n_results,
        include=["metadatas", "distances"],
    )
    assert results["metadatas"] is not None
    assert results["distances"] is not None
    return [
        {
            "cell_id": cell_id,
            "cell_type": metadata["cell_type"],
            "distance": distance,
        }
        for cell_id, metadata, distance in zip(
            results["ids"][0],
            results["metadatas"][0],
            results["distances"][0],
            strict=False,
        )
    ]

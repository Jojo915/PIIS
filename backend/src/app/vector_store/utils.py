"""Util files for interacting with the vector store."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from chromadb import Collection
    from sentence_transformers import SentenceTransformer

DEFAULT_CONTEXT_WINDOW = 5


def retrieve_documents(
    query: str,
    collection: Collection,
    model: SentenceTransformer,
    notebook_id: str,
    n_results: int = 8,
) -> list[dict]:
    """Retrieve the most similar code cells to a given query."""
    n_results = min(n_results, collection.count())
    if n_results == 0:
        return []
    results = collection.query(
        query_embeddings=model.encode([query], convert_to_numpy=True),
        where={"$and": [{"notebook_id": notebook_id}, {"cell_type": "code"}]},
        n_results=n_results,
        include=["metadatas", "distances"],
    )
    assert results["metadatas"] is not None
    assert results["distances"] is not None
    return [
        {"cell_id": cell_id, "distance": distance}
        for cell_id, distance in zip(
            results["ids"][0], results["distances"][0], strict=False
        )
    ]


def retrieve_previous_cells(
    collection: Collection,
    notebook_id: str,
    cell_index: int,
    n_previous: int = DEFAULT_CONTEXT_WINDOW,
) -> list[dict]:
    """Retrieve up to n_previous cells immediately preceding cell_index.

    Looks up cells already stored for this notebook with a smaller
    cell_index, and returns at most n_previous of them, ordered
    chronologically (oldest first).
    """
    if cell_index == 0 or n_previous == 0:
        return []
    results = collection.get(
        where={
            "$and": [
                {"notebook_id": notebook_id},
                {"cell_index": {"$lt": cell_index}},
            ]
        },
        include=["metadatas"],
    )
    metadatas = results["metadatas"] or []
    # Closest-preceding cells first, then truncate to the window...
    closest_first = sorted(
        metadatas, key=lambda m: m["cell_index"], reverse=True
    )[:n_previous]
    # ...then flip back to chronological order for the prompt.
    return list(reversed(closest_first))


# def retrieve_documents(
#     query: str,
#     collection: Collection,
#     model: SentenceTransformer,
#     notebook_id: str,
#     n_results: int = 3,
# ) -> list[dict]:
#     """Query the vector store and return ranked results for one notebook."""
#     n_results = min(n_results, collection.count())
#     if n_results == 0:
#         return []
#     results = collection.query(
#         query_embeddings=model.encode([query], convert_to_numpy=True),
#         where={"notebook_id": notebook_id},
#         n_results=n_results,
#         include=["metadatas", "distances"],
#     )
#     assert results["metadatas"] is not None
#     assert results["distances"] is not None
#     return [
#         {
#             "cell_id": cell_id,
#             "cell_type": metadata["cell_type"],
#             "distance": distance,
#         }
#         for cell_id, metadata, distance in zip(
#             results["ids"][0],
#             results["metadatas"][0],
#             results["distances"][0],
#             strict=False,
#         )
#     ]


# def _replace_markdown_with_next_code(
#     results: list[dict],
#     notebook: dict,
#     collection: Collection,
#     model: SentenceTransformer,
#     notebook_id: str,
#     query: str,
# ) -> list[dict]:
#     """Replace markdown cells with the next code cell in the notebook."""
#     cells = notebook["cells"]
#     cell_index = {cell["id"]: i for i, cell in enumerate(cells)}

#     all_results = retrieve_documents(
#         query=query,
#         collection=collection,
#         model=model,
#         notebook_id=notebook_id,
#         n_results=collection.count(),
#     )

#     selected_ids = {r["cell_id"] for r in results}
#     final_results = []

#     for result in results:
#         if result["cell_type"] != "markdown":
#             final_results.append(result)
#             continue

#         idx = cell_index[result["cell_id"]]
#         next_code_id = None
#         for cell in cells[idx + 1 :]:
#             if cell["cell_type"] == "code" and cell["id"] not in selected_ids:
#                 next_code_id = cell["id"]
#                 break

#         if next_code_id is None:
#             continue

#         replacement = next(
#             (r for r in all_results if r["cell_id"] == next_code_id), None
#         )
#         if replacement:
#             selected_ids.add(next_code_id)
#             final_results.append(replacement)

#     return final_results


# def retrieve_documents_code_only(
#     query: str,
#     collection: Collection,
#     model: SentenceTransformer,
#     notebook_id: str,
#     notebook: dict,
#     n_results: int = 3,
# ) -> list[dict]:
#     """Retrieve top k cells, replace markdown cells w/ the next code cell."""
#     top_results = retrieve_documents(
#         query=query,
#         collection=collection,
#         model=model,
#         notebook_id=notebook_id,
#         n_results=n_results,
#     )

#     if not any(r["cell_type"] == "markdown" for r in top_results):
#         return top_results

#     return _replace_markdown_with_next_code(
#         results=top_results,
#         notebook=notebook,
#         collection=collection,
#         model=model,
#         notebook_id=notebook_id,
#         query=query,
#     )

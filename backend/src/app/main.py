"""Demo of the notebook RAG pipeline."""

from .vector_store.client import create_vector_store
from .vector_store.embedding_model import load_embedding_model
from .vector_store.operations import (
    chunk_complete_notebook,
    construct_vector_store,
    retrieve_documents,
)

NOTEBOOK_ID = "demo_notebook"

NOTEBOOK = {
    "nbformat": 4,
    "nbformat_minor": 5,
    "metadata": {
        "kernelspec": {
            "display_name": "Python 3",
            "language": "python",
            "name": "python3",
        }
    },
    "cells": [
        {
            "id": "cell_md_01",
            "cell_type": "markdown",
            "source": "## Data Normalization\nThis section normalizes input features to avoid exploding gradients.",
            "metadata": {},
            "outputs": [],
        },
        {
            "id": "cell_code_01",
            "cell_type": "code",
            "source": "import numpy as np\n\n# Normalize to zero mean and unit variance\nX = np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])\nX_normalized = (X - X.mean(axis=0)) / X.std(axis=0)\nprint(X_normalized)",
            "metadata": {},
            "outputs": [
                {
                    "output_type": "stream",
                    "name": "stdout",
                    "text": "[[-1.22474487 -1.22474487]\n [ 0.  0.]\n [ 1.22474487  1.22474487]]",
                }
            ],
            "execution_count": 1,
        },
    ],
}

if __name__ == "__main__":
    print("Loading model...")
    model = load_embedding_model("sentence-transformers/all-MiniLM-L6-v2")

    print("Chunking notebook...")
    chunks, embed_texts = chunk_complete_notebook(NOTEBOOK, NOTEBOOK_ID)

    print("Building vector store...")
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    construct_vector_store(collection, chunks, embed_texts, model)

    print(f"\nIndexed {collection.count()} cells.")
    print("\nQuerying: 'how are the features normalized?'")
    results = retrieve_documents(
        query="how are the features normalized?",
        collection=collection,
        model=model,
        notebook_id=NOTEBOOK_ID,
    )

    for rank, result in enumerate(results, start=1):
        print(
            f"\nRank {rank}: {result['cell_id']} ({result['cell_type']}) — distance: {result['distance']:.4f}"
        )

# TODO: When markdown has highest score then return next codecell
# TODO: Setup vLLM for inference on CIP pool.
# NOTE: one click on nodes, extend node and give summarization. Double click move to cell.  # noqa: E501

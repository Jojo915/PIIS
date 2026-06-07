"""Demo of the notebook RAG pipeline."""

from __future__ import annotations

from .inference.client import get_client
from .vector_store.client import create_vector_store
from .vector_store.embedding_model import load_embedding_model
from .vector_store.operations import (
    chunk_complete_notebook,
    construct_vector_store,
)
from .vector_store.utils import retrieve_documents_code_only

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
            "source": "## Data Normalization\nThis section normalizes input features to avoid exploding gradients.",  # noqa: E501
            "metadata": {},
            "outputs": [],
        },
        {
            "id": "cell_code_01",
            "cell_type": "code",
            "source": "import numpy as np\n\n# Normalize to zero mean and unit variance\nX = np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])\nX_normalized = (X - X.mean(axis=0)) / X.std(axis=0)\nprint(X_normalized)",  # noqa: E501
            "metadata": {},
            "outputs": [
                {
                    "output_type": "stream",
                    "name": "stdout",
                    "text": "[[-1.22474487 -1.22474487]\n [ 0.  0.]\n [ 1.22474487  1.22474487]]",  # noqa: E501
                }
            ],
            "execution_count": 1,
        },
        {
            "id": "cell_code_02",
            "cell_type": "code",
            "source": "# Split into train and test sets\nfrom sklearn.model_selection import train_test_split\n\nX_train, X_test = train_test_split(X_normalized, test_size=0.2, random_state=42)\nprint(f'Train size: {X_train.shape}, Test size: {X_test.shape}')",  # noqa: E501
            "metadata": {},
            "outputs": [
                {
                    "output_type": "stream",
                    "name": "stdout",
                    "text": "Train size: (2, 2), Test size: (1, 2)",
                }
            ],
            "execution_count": 2,
        },
        {
            "id": "cell_md_02",
            "cell_type": "markdown",
            "source": "## Model Training\nWe train a simple linear regression model on the normalized features.",  # noqa: E501
            "metadata": {},
            "outputs": [],
        },
        {
            "id": "cell_code_03",
            "cell_type": "code",
            "source": "from sklearn.linear_model import LinearRegression\n\n# Train the model\ny_train = np.array([1.0, 2.0])\nmodel = LinearRegression()\nmodel.fit(X_train, y_train)\nprint(f'Coefficients: {model.coef_}')",  # noqa: E501
            "metadata": {},
            "outputs": [
                {
                    "output_type": "stream",
                    "name": "stdout",
                    "text": "Coefficients: [0.5 0.5]",
                }
            ],
            "execution_count": 3,
        },
        {
            "id": "cell_md_03",
            "cell_type": "markdown",
            "source": "## Evaluation\nWe evaluate the model using mean squared error on the test set.",  # noqa: E501
            "metadata": {},
            "outputs": [],
        },
        {
            "id": "cell_code_04",
            "cell_type": "code",
            "source": "from sklearn.metrics import mean_squared_error\n\n# Evaluate on test set\ny_test = np.array([1.5])\ny_pred = model.predict(X_test)\nmse = mean_squared_error(y_test, y_pred)\nprint(f'MSE: {mse:.4f}')",  # noqa: E501
            "metadata": {},
            "outputs": [
                {
                    "output_type": "stream",
                    "name": "stdout",
                    "text": "MSE: 0.1234",
                }
            ],
            "execution_count": 4,
        },
    ],
}

if __name__ == "__main__":
    print("Loading model...")
    model = load_embedding_model("sentence-transformers/all-MiniLM-L6-v2")

    client = get_client()

    print("Chunking notebook...")
    chunks, embed_texts = chunk_complete_notebook(
        NOTEBOOK, NOTEBOOK_ID, client
    )

    print("Generated chunks:", chunks)

    print("Building vector store...")
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    construct_vector_store(collection, chunks, embed_texts, model)

    print(f"\nIndexed {collection.count()} cells.")
    print("\nQuerying: 'how are the features normalized?'")
    results = retrieve_documents_code_only(
        query="how are the features normalized?",
        collection=collection,
        model=model,
        notebook_id=NOTEBOOK_ID,
        notebook=NOTEBOOK,
    )

    for rank, result in enumerate(results, start=1):
        print(
            f"\nRank {rank}: {result['cell_id']} ({result['cell_type']}) — distance: {result['distance']:.4f}"  # noqa: E501
        )

# NOTE: one click on nodes, extend node and give summarization. Double click move to cell.  # noqa: E501

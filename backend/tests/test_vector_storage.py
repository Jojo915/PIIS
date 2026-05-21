"""Integration tests for the ChromaDB vector store utilities."""

from __future__ import annotations

import unittest

import chromadb

from backend.src.app.cells.factory import cell_factory
from backend.src.app.vector_store.embedding_model import load_embedding_model
from backend.src.app.vector_store.operations import (
    construct_vector_store,
    delete_notebook_from_store,
    update_vector_store,
)
from backend.src.app.vector_store.utils import (
    retrieve_documents,
    retrieve_documents_code_only,
)

NOTEBOOK_ID_A = "notebook_a"
NOTEBOOK_ID_B = "notebook_b"

MARKDOWN_CELL = {
    "id": "cell_md_01",
    "cell_type": "markdown",
    "source": "## Data Normalization\nThis section normalizes input features.",
    "metadata": {},
    "outputs": [],
}

CODE_CELL = {
    "id": "cell_code_01",
    "cell_type": "code",
    "source": "# Normalize features\nX_normalized = (X - X.mean()) / X.std()",
    "metadata": {},
    "outputs": [
        {
            "output_type": "stream",
            "name": "stdout",
            "text": "[[-1.22 -1.22]\n [ 0.  0.]]",
        }
    ],
    "execution_count": 1,
}

CODE_CELL_UPDATED = {
    **CODE_CELL,
    "outputs": [
        {
            "output_type": "stream",
            "name": "stdout",
            "text": "[[0.0 0.0]\n [1.0 1.0]]",
        }
    ],
    "execution_count": 2,
}

NOTEBOOK_B_CELL = {
    "id": "cell_nb_b_01",
    "cell_type": "markdown",
    "source": "## Unrelated notebook content about gradient descent.",
    "metadata": {},
    "outputs": [],
}

# Notebook for retrieve_documents_code_only tests
# Order: md_01 -> code_01 -> code_02 -> md_02 -> code_03 -> md_03 -> code_04
NOTEBOOK = {
    "cells": [
        {
            "id": "cell_md_01",
            "cell_type": "markdown",
            "source": "## Data Normalization\nNormalizes input features to avoid exploding gradients.",  # noqa: E501
            "metadata": {},
            "outputs": [],
        },
        {
            "id": "cell_code_01",
            "cell_type": "code",
            "source": "import numpy as np\nX_normalized = (X - X.mean(axis=0)) / X.std(axis=0)",  # noqa: E501
            "metadata": {},
            "outputs": [
                {
                    "output_type": "stream",
                    "name": "stdout",
                    "text": "[[-1.22 -1.22]\n [ 0.  0.]]",
                }
            ],
            "execution_count": 1,
        },
        {
            "id": "cell_code_02",
            "cell_type": "code",
            "source": "from sklearn.model_selection import train_test_split\nX_train, X_test = train_test_split(X_normalized, test_size=0.2)",  # noqa: E501
            "metadata": {},
            "outputs": [
                {
                    "output_type": "stream",
                    "name": "stdout",
                    "text": "Train size: (2, 2)",
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
            "source": "from sklearn.linear_model import LinearRegression\nmodel = LinearRegression()\nmodel.fit(X_train, y_train)",  # noqa: E501
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
            "source": "from sklearn.metrics import mean_squared_error\nmse = mean_squared_error(y_test, y_pred)\nprint(f'MSE: {mse:.4f}')",  # noqa: E501
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
    ]
}


def make_chunks(cells: list, notebook_id: str) -> list:
    """Produce chunk dicts from a list of raw cell dicts."""
    return [
        cell_factory(cell).to_chunk(notebook_id=notebook_id) for cell in cells
    ]


def make_embed_texts(cells: list) -> list:
    """Produce embed texts from a list of raw cell dicts."""
    return [cell_factory(cell).to_embed() for cell in cells]


class ChromaTestBase(unittest.TestCase):
    """Base class that sets up a Chroma collection and embedding model."""

    @classmethod
    def setUpClass(cls):
        """Load the embedding model once for the entire test class."""
        cls.model = load_embedding_model(
            "sentence-transformers/all-MiniLM-L6-v2"
        )

    def setUp(self):
        """Create a fresh Chroma client and collection before each test."""
        self.client = chromadb.EphemeralClient()
        self.collection = self.client.create_collection("test_collection")

    def tearDown(self):
        """Delete the collection after each test to avoid state leakage."""
        self.client.delete_collection("test_collection")


class TestConstructVectorStore(ChromaTestBase):
    """Tests that construct_vector_store correctly populates the collection."""

    def test_chunks_are_retrievable_by_id_after_construct(self):
        """Verify that all upserted cell IDs are present in the collection."""
        cells = [MARKDOWN_CELL, CODE_CELL]
        chunks = make_chunks(cells, NOTEBOOK_ID_A)
        embed_texts = make_embed_texts(cells)
        construct_vector_store(
            self.collection, chunks, embed_texts, self.model
        )

        result = self.collection.get(ids=["cell_md_01", "cell_code_01"])
        self.assertEqual(len(result["ids"]), 2)

    def test_metadata_is_stored_correctly(self):
        """Verify that notebook_id and cell_type are stored as metadata."""
        chunks = make_chunks([MARKDOWN_CELL], NOTEBOOK_ID_A)
        embed_texts = make_embed_texts([MARKDOWN_CELL])
        construct_vector_store(
            self.collection, chunks, embed_texts, self.model
        )

        result = self.collection.get(ids=["cell_md_01"], include=["metadatas"])
        metadatas = result["metadatas"]
        self.assertIsNotNone(metadatas)
        assert metadatas is not None
        self.assertEqual(metadatas[0]["notebook_id"], NOTEBOOK_ID_A)
        self.assertEqual(metadatas[0]["cell_type"], "markdown")

    def test_collection_count_matches_number_of_chunks(self):
        """Verify the collection count equals the number of upserted cells."""
        cells = [MARKDOWN_CELL, CODE_CELL]
        chunks = make_chunks(cells, NOTEBOOK_ID_A)
        embed_texts = make_embed_texts(cells)
        construct_vector_store(
            self.collection, chunks, embed_texts, self.model
        )

        self.assertEqual(self.collection.count(), 2)


class TestUpdateVectorStore(ChromaTestBase):
    """Tests that update_vector_store correctly replaces cell vectors."""

    def test_re_executed_cell_does_not_increase_collection_count(self):
        """Verify upserting an existing cell ID replaces, not appends."""
        chunks = make_chunks([CODE_CELL], NOTEBOOK_ID_A)
        embed_texts = make_embed_texts([CODE_CELL])
        construct_vector_store(
            self.collection, chunks, embed_texts, self.model
        )

        updated_chunk = cell_factory(CODE_CELL_UPDATED).to_chunk(
            notebook_id=NOTEBOOK_ID_A
        )
        updated_embed = cell_factory(CODE_CELL_UPDATED).to_embed()
        update_vector_store(
            self.collection, updated_chunk, updated_embed, self.model
        )

        self.assertEqual(self.collection.count(), 1)

    def test_re_executed_cell_updates_metadata(self):
        """Verify the stored metadata reflects the latest cell content."""
        chunks = make_chunks([CODE_CELL], NOTEBOOK_ID_A)
        embed_texts = make_embed_texts([CODE_CELL])
        construct_vector_store(
            self.collection, chunks, embed_texts, self.model
        )

        updated_chunk = cell_factory(CODE_CELL_UPDATED).to_chunk(
            notebook_id=NOTEBOOK_ID_A
        )
        updated_embed = cell_factory(CODE_CELL_UPDATED).to_embed()
        update_vector_store(
            self.collection, updated_chunk, updated_embed, self.model
        )

        result = self.collection.get(
            ids=["cell_code_01"], include=["metadatas"]
        )
        metadatas = result["metadatas"]
        self.assertIsNotNone(metadatas)
        assert metadatas is not None
        self.assertEqual(metadatas[0]["cell_id"], "cell_code_01")


class TestDeleteNotebookFromStore(ChromaTestBase):
    """delete_notebook_from_store only removes cells from target notebook."""

    def test_all_cells_from_notebook_are_deleted(self):
        """Verify all cells belonging to the deleted notebook are removed."""
        chunks_a = make_chunks([MARKDOWN_CELL, CODE_CELL], NOTEBOOK_ID_A)
        embed_texts_a = make_embed_texts([MARKDOWN_CELL, CODE_CELL])
        construct_vector_store(
            self.collection, chunks_a, embed_texts_a, self.model
        )

        delete_notebook_from_store(self.collection, NOTEBOOK_ID_A)

        result = self.collection.get(ids=["cell_md_01", "cell_code_01"])
        self.assertEqual(len(result["ids"]), 0)

    def test_cells_from_other_notebooks_are_not_deleted(self):
        """Verify cells from other notebooks are untouched after a delete."""
        chunks_a = make_chunks([MARKDOWN_CELL], NOTEBOOK_ID_A)
        chunks_b = make_chunks([NOTEBOOK_B_CELL], NOTEBOOK_ID_B)
        embed_texts_a = make_embed_texts([MARKDOWN_CELL])
        embed_texts_b = make_embed_texts([NOTEBOOK_B_CELL])
        construct_vector_store(
            self.collection, chunks_a, embed_texts_a, self.model
        )
        construct_vector_store(
            self.collection, chunks_b, embed_texts_b, self.model
        )

        delete_notebook_from_store(self.collection, NOTEBOOK_ID_A)

        result = self.collection.get(ids=["cell_nb_b_01"])
        self.assertEqual(len(result["ids"]), 1)

    def test_collection_count_decreases_by_deleted_notebook_size(self):
        """Verify the collection count drops by the number of deleted cells."""
        chunks_a = make_chunks([MARKDOWN_CELL, CODE_CELL], NOTEBOOK_ID_A)
        chunks_b = make_chunks([NOTEBOOK_B_CELL], NOTEBOOK_ID_B)
        embed_texts_a = make_embed_texts([MARKDOWN_CELL, CODE_CELL])
        embed_texts_b = make_embed_texts([NOTEBOOK_B_CELL])
        construct_vector_store(
            self.collection, chunks_a, embed_texts_a, self.model
        )
        construct_vector_store(
            self.collection, chunks_b, embed_texts_b, self.model
        )

        delete_notebook_from_store(self.collection, NOTEBOOK_ID_A)

        self.assertEqual(self.collection.count(), 1)


class TestRetrieveDocuments(ChromaTestBase):
    """Tests that retrieve_documents returns correctly ranked results."""

    def setUp(self):
        """Populate the collection with cells from two notebooks b4 tests."""
        super().setUp()
        chunks_a = make_chunks([MARKDOWN_CELL, CODE_CELL], NOTEBOOK_ID_A)
        chunks_b = make_chunks([NOTEBOOK_B_CELL], NOTEBOOK_ID_B)
        embed_texts_a = make_embed_texts([MARKDOWN_CELL, CODE_CELL])
        embed_texts_b = make_embed_texts([NOTEBOOK_B_CELL])
        construct_vector_store(
            self.collection, chunks_a, embed_texts_a, self.model
        )
        construct_vector_store(
            self.collection, chunks_b, embed_texts_b, self.model
        )

    def test_results_are_scoped_to_notebook_id(self):
        """Verify retrieval never returns cells from a different notebook."""
        results = retrieve_documents(
            "normalization", self.collection, self.model, NOTEBOOK_ID_A
        )
        returned_ids = [r["cell_id"] for r in results]
        self.assertNotIn("cell_nb_b_01", returned_ids)

    def test_results_contain_distance_score(self):
        """Verify each result includes a distance score."""
        results = retrieve_documents(
            "normalization", self.collection, self.model, NOTEBOOK_ID_A
        )
        for result in results:
            self.assertIn("distance", result)

    def test_most_relevant_cell_has_lowest_distance(self):
        """Verify results are ordered by ascending distance."""
        results = retrieve_documents(
            "normalization", self.collection, self.model, NOTEBOOK_ID_A
        )
        distances = [r["distance"] for r in results]
        self.assertEqual(distances, sorted(distances))

    def test_empty_collection_returns_no_results(self):
        """Verify retrieval on an empty notebook returns an empty list."""
        delete_notebook_from_store(self.collection, NOTEBOOK_ID_A)
        delete_notebook_from_store(self.collection, NOTEBOOK_ID_B)
        results = retrieve_documents(
            "normalization", self.collection, self.model, NOTEBOOK_ID_A
        )
        self.assertEqual(results, [])


class TestRetrieveDocumentsCodeOnly(ChromaTestBase):
    """retrieve_documents_code_only replaces markdown results correctly."""

    def setUp(self):
        """Populate the collection with the full test notebook before tests."""
        super().setUp()
        chunks = make_chunks(NOTEBOOK["cells"], NOTEBOOK_ID_A)
        embed_texts = make_embed_texts(NOTEBOOK["cells"])
        construct_vector_store(
            self.collection, chunks, embed_texts, self.model
        )

    def test_no_markdown_cells_in_results(self):
        """Verify the returned results contain no markdown cells."""
        results = retrieve_documents_code_only(
            "normalization",
            self.collection,
            self.model,
            NOTEBOOK_ID_A,
            NOTEBOOK,
        )
        cell_types = [r["cell_type"] for r in results]
        self.assertNotIn("markdown", cell_types)

    def test_markdown_replaced_by_next_code_cell(self):
        """Verify a markdown result is replaced by the next code cell."""
        results = retrieve_documents_code_only(
            "data normalization",
            self.collection,
            self.model,
            NOTEBOOK_ID_A,
            NOTEBOOK,
            n_results=1,
        )
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["cell_id"], "cell_code_01")

    def test_replacement_not_already_in_results(self):
        """Verify the replacement cell is never a duplicate of a result."""
        results = retrieve_documents_code_only(
            "normalization training evaluation",
            self.collection,
            self.model,
            NOTEBOOK_ID_A,
            NOTEBOOK,
            n_results=4,
        )
        cell_ids = [r["cell_id"] for r in results]
        self.assertEqual(len(cell_ids), len(set(cell_ids)))

    def test_markdown_with_no_next_code_cell_is_dropped(self):
        """Verify a markdown cell with no following code cell is dropped."""
        truncated_notebook = {
            "cells": [
                c for c in NOTEBOOK["cells"] if c["id"] != "cell_code_04"
            ]
        }
        results = retrieve_documents_code_only(
            "evaluation MSE",
            self.collection,
            self.model,
            NOTEBOOK_ID_A,
            truncated_notebook,
            n_results=3,
        )
        cell_ids = [r["cell_id"] for r in results]
        self.assertNotIn("cell_md_03", cell_ids)

    def test_all_code_results_returned_unchanged(self):
        """Verify results that are already code cells are returned as-is."""
        results = retrieve_documents_code_only(
            "linear regression coefficients",
            self.collection,
            self.model,
            NOTEBOOK_ID_A,
            NOTEBOOK,
            n_results=2,
        )
        for result in results:
            self.assertEqual(result["cell_type"], "code")


if __name__ == "__main__":
    unittest.main()

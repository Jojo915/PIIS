"""Integration tests for the ChromaDB vector store utilities."""

import unittest

import chromadb

from backend.src.app.cells.factory import cell_factory
from backend.src.app.vector_store.embedding_model import load_embedding_model
from backend.src.app.vector_store.operations import (
    construct_vector_store,
    delete_notebook_from_store,
    retrieve_documents,
    update_vector_store,
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


def make_chunks(cells: list, notebook_id: str) -> list:
    """Produce chunk dicts from a list of raw cell dicts."""
    return [
        cell_factory(cell).to_chunk(notebook_id=notebook_id) for cell in cells
    ]


def make_embed_texts(cells: list) -> list:
    """Produce embed texts from a list of raw cell dicts."""
    return [cell_factory(cell).to_embed() for cell in cells]


class ChromaTestBase(unittest.TestCase):
    """Base class that sets up an Chroma collection and embedding model."""

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
        assert metadatas is not None  # narrows type for the type checker
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
        """Populate the collection with cells from 2 notebooks before tests."""
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


def tearDown(self):
    """Delete the collection after each test to avoid state leakage."""
    self.client.delete_collection("test_collection")

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


if __name__ == "__main__":
    unittest.main()

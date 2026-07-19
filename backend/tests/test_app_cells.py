"""Endpoint tests for POST /cells and DELETE /cells/{cell_id}."""

from __future__ import annotations

from backend.src.app.summary_store.sqlite_store import DEFAULT_DB_PATH

from .app_test_utils import (
    NOTEBOOK_ID_A,
    NOTEBOOK_ID_B,
    AppTestCase,
    code_cell,
    markdown_cell,
)


class TestEmbedCellEndpoint(AppTestCase):
    """POST /cells: single-cell indexing (the cell-execution path)."""

    def _post_cell(self, cell: dict, notebook_id: str, cell_index: int):
        return self.client.post(
            "/cells",
            json={
                "content": cell,
                "notebook_id": notebook_id,
                "cell_index": cell_index,
            },
        )

    def test_code_cell_gets_label_and_summary(self):
        """A code cell is enriched with an AI label and summary."""
        response = self._post_cell(
            code_cell("c1", "x = 1"), NOTEBOOK_ID_A, 0
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["cell_id"], "c1")
        self.assertIn("label", body)
        self.assertIn("summary", body)
        self.assertIsNotNone(body["label"])
        self.assertIsNotNone(body["summary"])

    def test_code_cell_summary_is_persisted_to_summary_store(self):
        """The generated AI summary is saved, not just returned."""
        self._post_cell(code_cell("c1", "x = 1"), NOTEBOOK_ID_A, 0)

        stored = self.summary_store.get_summary(NOTEBOOK_ID_A, "c1")
        self.assertIsNotNone(stored)
        assert stored is not None
        self.assertIsNotNone(stored.ai_summary)

    def test_markdown_cell_gets_no_label_or_summary(self):
        """Markdown cells are indexed but never sent through the LLM."""
        response = self._post_cell(
            markdown_cell("m1", "# Title"), NOTEBOOK_ID_A, 0
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertNotIn("label", body)
        self.assertNotIn("summary", body)

        # No summary row should ever be created for a markdown cell either.
        self.assertIsNone(self.summary_store.get_summary(NOTEBOOK_ID_A, "m1"))

    def test_cell_is_stored_under_the_given_notebook_id(self):
        """The chunk's notebook_id metadata matches the request."""
        self._post_cell(code_cell("c1", "x = 1"), NOTEBOOK_ID_A, 0)

        result = self.collection.get(ids=["c1"], include=["metadatas"])
        metadatas = result["metadatas"]
        assert metadatas is not None
        self.assertEqual(metadatas[0]["notebook_id"], NOTEBOOK_ID_A)

    def test_re_posting_same_cell_id_replaces_not_duplicates(self):
        """Re-executing a cell (same id) updates in place."""
        self._post_cell(code_cell("c1", "x = 1"), NOTEBOOK_ID_A, 0)
        self._post_cell(code_cell("c1", "x = 2"), NOTEBOOK_ID_A, 0)

        self.assertEqual(self.collection.count(), 1)
        result = self.collection.get(ids=["c1"], include=["metadatas"])
        metadatas = result["metadatas"]
        assert metadatas is not None
        self.assertIn("x = 2", str(metadatas[0]["content"]))

    def test_same_cell_id_in_two_notebooks_does_not_cross_contaminate(
        self,
    ):
        """A cell id shared across notebooks keeps independent summary rows.

        This mirrors the duplicated-notebook-file scenario documented for
        the vector store: the summary store is keyed by
        (notebook_id, cell_id), so unlike the Chroma collection (which uses
        cell_id alone as its primary key and would collide), each
        notebook's summary row must remain independent.
        """
        self._post_cell(code_cell("c1", "x = 1"), NOTEBOOK_ID_A, 0)
        self._post_cell(code_cell("c1", "y = 2"), NOTEBOOK_ID_B, 0)

        summary_a = self.summary_store.get_summary(NOTEBOOK_ID_A, "c1")
        summary_b = self.summary_store.get_summary(NOTEBOOK_ID_B, "c1")
        self.assertIsNotNone(summary_a)
        self.assertIsNotNone(summary_b)


class TestDeleteCellEndpoint(AppTestCase):
    """DELETE /cells/{cell_id}: single-cell removal (the cell-delete path)."""

    def _post_cell(self, cell: dict, notebook_id: str, cell_index: int):
        return self.client.post(
            "/cells",
            json={
                "content": cell,
                "notebook_id": notebook_id,
                "cell_index": cell_index,
            },
        )

    def test_deleting_a_cell_removes_it_from_the_vector_store(self):
        """Verify the vector-store chunk is gone after delete."""
        self._post_cell(code_cell("c1", "x = 1"), NOTEBOOK_ID_A, 0)

        response = self.client.delete(
            "/cells/c1", params={"notebook_id": NOTEBOOK_ID_A}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"deleted": "c1"})
        self.assertEqual(self.collection.count(), 0)

    def test_deleting_a_cell_removes_its_summary_row(self):
        """Verify the SQLite summary row is gone after delete."""
        self._post_cell(code_cell("c1", "x = 1"), NOTEBOOK_ID_A, 0)
        self.assertIsNotNone(
            self.summary_store.get_summary(NOTEBOOK_ID_A, "c1")
        )

        self.client.delete("/cells/c1", params={"notebook_id": NOTEBOOK_ID_A})

        self.assertIsNone(self.summary_store.get_summary(NOTEBOOK_ID_A, "c1"))

    def test_notebook_id_is_required(self):
        """Omitting notebook_id is a validation error, not a silent no-op.

        The endpoint relies on notebook_id for both the vector-store scoping
        fix and the summary-store lookup key, so it must stay a required
        query parameter.
        """
        response = self.client.delete("/cells/c1")

        self.assertEqual(response.status_code, 422)

    def test_delete_does_not_affect_a_colliding_id_in_another_notebook(self):
        """A delete scoped to notebook A must not remove notebook B's cell.

        Regression test for the notebook-scoping fix: simulates a
        duplicated notebook file where both notebooks' copy of a cell kept
        the same nbformat id. Re-indexing notebook B overwrites the single
        Chroma row (upsert-by-id) so it now belongs to notebook B; deleting
        "the same id" from notebook A must be a no-op for the vector store,
        and must not touch notebook B's summary row either.
        """
        self._post_cell(code_cell("shared", "x = 1"), NOTEBOOK_ID_A, 0)
        self._post_cell(code_cell("shared", "y = 2"), NOTEBOOK_ID_B, 0)
        self.assertEqual(self.collection.count(), 1)

        self.client.delete(
            "/cells/shared", params={"notebook_id": NOTEBOOK_ID_A}
        )

        # Notebook B's vector-store row (the current owner of this id)
        # survives.
        self.assertEqual(self.collection.count(), 1)
        # Notebook B's summary row survives too -- only notebook A's
        # (already-absent) row was targeted.
        self.assertIsNotNone(
            self.summary_store.get_summary(NOTEBOOK_ID_B, "shared")
        )

    def test_deleting_one_cell_leaves_sibling_cells_untouched(self):
        """Verify only the targeted cell is removed, not the whole notebook."""
        self._post_cell(code_cell("c1", "x = 1"), NOTEBOOK_ID_A, 0)
        self._post_cell(code_cell("c2", "y = 2"), NOTEBOOK_ID_A, 1)

        self.client.delete("/cells/c1", params={"notebook_id": NOTEBOOK_ID_A})

        self.assertEqual(self.collection.count(), 1)
        result = self.collection.get(ids=["c2"])
        self.assertEqual(len(result["ids"]), 1)


# Sanity check that AppTestCase's SQLiteSummaryStore patch actually produces
# a distinct, on-disk-isolated store per test (guards against accidentally
# sharing one database across the whole test run).
class TestSummaryStoreIsolation(AppTestCase):
    """Each test gets its own summary store, never the real dev database."""

    def test_summary_store_is_not_the_default_database(self):
        """The patched store's db_path differs from the real dev db."""
        self.assertNotEqual(self.summary_store.db_path, DEFAULT_DB_PATH)

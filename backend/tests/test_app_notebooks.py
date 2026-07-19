"""Endpoint tests for whole-notebook routes.

Covers POST /notebooks, PATCH /notebooks/reorder, POST /search,
POST /cells/duplicates, POST /notebooks/dead-cells, and
POST /notebooks/stale-cells.
"""

from __future__ import annotations

from .app_test_utils import (
    NOTEBOOK_ID_A,
    NOTEBOOK_ID_B,
    AppTestCase,
    code_cell,
    markdown_cell,
    notebook_content,
)


class TestEmbedNotebookEndpoint(AppTestCase):
    """POST /notebooks: full notebook (re-)indexing."""

    def _post_notebook(
        self, cells: list[dict], notebook_id: str = NOTEBOOK_ID_A
    ):
        return self.client.post(
            "/notebooks",
            json={
                "notebook_id": notebook_id,
                "content": notebook_content(cells),
            },
        )

    def test_indexes_every_cell(self):
        """A fresh notebook produces one chunk per cell."""
        response = self._post_notebook(
            [markdown_cell("m1", "# Title"), code_cell("c1", "x = 1")]
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 2)
        self.assertEqual(self.collection.count(), 2)

    def test_reindexing_removes_cells_deleted_from_the_notebook(self):
        """A cell absent from a re-index is dropped from the vector store."""
        self._post_notebook(
            [code_cell("c1", "x = 1"), code_cell("c2", "y = 2")]
        )
        self.assertEqual(self.collection.count(), 2)

        # c2 is gone from the notebook on this re-index.
        self._post_notebook([code_cell("c1", "x = 1")])

        self.assertEqual(self.collection.count(), 1)
        result = self.collection.get(ids=["c2"])
        self.assertEqual(len(result["ids"]), 0)

    def test_reindexing_prunes_orphaned_summaries(self):
        """A summary row for a cell no longer in the notebook is removed."""
        self._post_notebook(
            [code_cell("c1", "x = 1"), code_cell("c2", "y = 2")]
        )
        self.assertIsNotNone(
            self.summary_store.get_summary(NOTEBOOK_ID_A, "c2")
        )

        self._post_notebook([code_cell("c1", "x = 1")])

        self.assertIsNone(self.summary_store.get_summary(NOTEBOOK_ID_A, "c2"))
        # The surviving cell's summary is untouched.
        self.assertIsNotNone(
            self.summary_store.get_summary(NOTEBOOK_ID_A, "c1")
        )

    def test_reindexing_preserves_user_edits_for_surviving_cells(self):
        """A user-edited summary survives a full notebook re-index."""
        self._post_notebook([code_cell("c1", "x = 1")])
        self.summary_store.save_user_summary(
            notebook_id=NOTEBOOK_ID_A,
            cell_id="c1",
            summary="My hand-written summary.",
        )

        self._post_notebook([code_cell("c1", "x = 1")])

        stored = self.summary_store.get_summary(NOTEBOOK_ID_A, "c1")
        assert stored is not None
        self.assertEqual(stored.display_summary, "My hand-written summary.")

    def test_reindexing_one_notebook_does_not_touch_another(self):
        """Notebook B's chunks survive a re-index of notebook A."""
        self._post_notebook([code_cell("a1", "x = 1")], NOTEBOOK_ID_A)
        self._post_notebook([code_cell("b1", "y = 2")], NOTEBOOK_ID_B)

        self._post_notebook([], NOTEBOOK_ID_A)

        self.assertEqual(self.collection.count(), 1)
        result = self.collection.get(ids=["b1"])
        self.assertEqual(len(result["ids"]), 1)


class TestReorderNotebookEndpoint(AppTestCase):
    """PATCH /notebooks/reorder."""

    def _post_notebook(
        self, cells: list[dict], notebook_id: str = NOTEBOOK_ID_A
    ):
        return self.client.post(
            "/notebooks",
            json={
                "notebook_id": notebook_id,
                "content": notebook_content(cells),
            },
        )

    def test_reorder_updates_cell_index_metadata(self):
        """Reversing two cells rewrites their stored cell_index."""
        self._post_notebook(
            [code_cell("c1", "x = 1"), code_cell("c2", "y = 2")]
        )

        response = self.client.patch(
            "/notebooks/reorder",
            json={"notebook_id": NOTEBOOK_ID_A, "cell_ids": ["c2", "c1"]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["reordered"], 2)
        result = self.collection.get(
            ids=["c1", "c2"], include=["metadatas"]
        )
        metadatas = result["metadatas"]
        assert metadatas is not None
        by_id = {meta["cell_id"]: meta for meta in metadatas}
        self.assertEqual(by_id["c2"]["cell_index"], 0)
        self.assertEqual(by_id["c1"]["cell_index"], 1)

    def test_reorder_does_not_touch_another_notebooks_colliding_id(self):
        """A reorder request scoped to A must not silently rewrite B's cell."""
        self._post_notebook([code_cell("b1", "z = 3")], NOTEBOOK_ID_B)
        original = self.collection.get(ids=["b1"], include=["metadatas"])
        original_metadatas = original["metadatas"]
        assert original_metadatas is not None
        original_index = original_metadatas[0]["cell_index"]

        self.client.patch(
            "/notebooks/reorder",
            json={"notebook_id": NOTEBOOK_ID_A, "cell_ids": ["b1"]},
        )

        result = self.collection.get(ids=["b1"], include=["metadatas"])
        metadatas = result["metadatas"]
        assert metadatas is not None
        self.assertEqual(metadatas[0]["cell_index"], original_index)


class TestSearchEndpoint(AppTestCase):
    """POST /search."""

    def _post_notebook(
        self, cells: list[dict], notebook_id: str = NOTEBOOK_ID_A
    ):
        return self.client.post(
            "/notebooks",
            json={
                "notebook_id": notebook_id,
                "content": notebook_content(cells),
            },
        )

    def test_search_only_returns_code_cells(self):
        """Markdown cells are never returned by semantic search."""
        self._post_notebook(
            [
                markdown_cell("m1", "# Data normalization"),
                code_cell("c1", "X_norm = (X - X.mean()) / X.std()"),
            ]
        )

        response = self.client.post(
            "/search",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "text": "normalize the data",
            },
        )

        self.assertEqual(response.status_code, 200)
        ids = [item["cell_id"] for item in response.json()]
        self.assertIn("c1", ids)
        self.assertNotIn("m1", ids)

    def test_search_is_scoped_to_the_requested_notebook(self):
        """A search in notebook A never returns notebook B's cells."""
        self._post_notebook([code_cell("a1", "x = 1")], NOTEBOOK_ID_A)
        self._post_notebook([code_cell("b1", "y = 2")], NOTEBOOK_ID_B)

        response = self.client.post(
            "/search", json={"notebook_id": NOTEBOOK_ID_A, "text": "x"}
        )

        ids = [item["cell_id"] for item in response.json()]
        self.assertNotIn("b1", ids)

    def test_search_on_empty_collection_returns_empty_list(self):
        """Searching before anything is indexed doesn't error."""
        response = self.client.post(
            "/search", json={"notebook_id": NOTEBOOK_ID_A, "text": "anything"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])


class TestDuplicateCellsEndpoint(AppTestCase):
    """POST /cells/duplicates."""

    def _post_notebook(
        self, cells: list[dict], notebook_id: str = NOTEBOOK_ID_A
    ):
        return self.client.post(
            "/notebooks",
            json={
                "notebook_id": notebook_id,
                "content": notebook_content(cells),
            },
        )

    def test_near_identical_cells_are_flagged_as_duplicates(self):
        """Two nearly-identical cells flag each other."""
        self._post_notebook(
            [
                code_cell("c1", "X_norm = (X - X.mean()) / X.std()"),
                code_cell("c2", "X_norm = (X - X.mean()) / X.std()"),
                code_cell("c3", "model.fit(X_train, y_train)"),
            ]
        )

        response = self.client.post(
            "/cells/duplicates",
            json={"notebook_id": NOTEBOOK_ID_A, "cell_id": "c1"},
        )

        self.assertEqual(response.status_code, 200)
        ids = [item["cell_id"] for item in response.json()]
        self.assertIn("c2", ids)
        self.assertNotIn("c3", ids)

    def test_queried_cell_is_excluded_from_its_own_results(self):
        """A cell is never reported as its own duplicate."""
        self._post_notebook([code_cell("c1", "x = 1")])

        response = self.client.post(
            "/cells/duplicates",
            json={"notebook_id": NOTEBOOK_ID_A, "cell_id": "c1"},
        )

        ids = [item["cell_id"] for item in response.json()]
        self.assertNotIn("c1", ids)

    def test_unknown_cell_id_returns_empty_list(self):
        """Querying a cell id that was never indexed doesn't error."""
        self._post_notebook([code_cell("c1", "x = 1")])

        response = self.client.post(
            "/cells/duplicates",
            json={"notebook_id": NOTEBOOK_ID_A, "cell_id": "does-not-exist"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])


class TestDeadCellsEndpoint(AppTestCase):
    """POST /notebooks/dead-cells: thin wiring test.

    Logic is covered separately in test_dead_cells.py -- this only checks
    the endpoint's request/response plumbing.
    """

    def test_dead_cell_is_flagged_and_live_cell_is_not(self):
        """A defined-but-unused cell is flagged; a used cell is not."""
        response = self.client.post(
            "/notebooks/dead-cells",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "content": notebook_content(
                    [
                        code_cell("c1", "unused_value = 42"),
                        code_cell("c2", "print('hello')"),
                    ]
                ),
            },
        )

        self.assertEqual(response.status_code, 200)
        flagged_ids = [item["cell_id"] for item in response.json()]
        self.assertIn("c1", flagged_ids)
        self.assertNotIn("c2", flagged_ids)


class TestStaleCellsEndpoint(AppTestCase):
    """POST /notebooks/stale-cells: thin wiring test.

    Logic is covered separately in test_stale_cells.py -- this only checks
    the endpoint's request/response plumbing.
    """

    def test_out_of_order_execution_is_flagged_stale(self):
        """A dependent cell re-run before its dependency is flagged stale."""
        response = self.client.post(
            "/notebooks/stale-cells",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "content": notebook_content(
                    [
                        code_cell("c1", "x = 1", execution_count=2),
                        code_cell("c2", "y = x + 1", execution_count=1),
                    ]
                ),
            },
        )

        self.assertEqual(response.status_code, 200)
        flagged_ids = [item["cell_id"] for item in response.json()]
        self.assertIn("c2", flagged_ids)

"""Endpoint tests for the summary-store routes.

Covers GET/POST /cells/summary, POST /cells/summary/suggestion, and the
batch-hydration route POST /notebooks/summaries.
"""

from __future__ import annotations

from .app_test_utils import NOTEBOOK_ID_A, AppTestCase


class TestGetCellSummary(AppTestCase):
    """GET /cells/summary."""

    def test_missing_summary_returns_404(self):
        """A cell with no stored summary is a 404, not an empty body."""
        response = self.client.get(
            "/cells/summary",
            params={"notebook_id": NOTEBOOK_ID_A, "cell_id": "c1"},
        )

        self.assertEqual(response.status_code, 404)

    def test_stored_summary_is_returned(self):
        """An existing summary round-trips through the endpoint."""
        self.summary_store.save_ai_summary(
            notebook_id=NOTEBOOK_ID_A,
            cell_id="c1",
            summary="Computes a rolling mean.",
            label="Rolling mean",
            source_hash="hash-1",
        )

        response = self.client.get(
            "/cells/summary",
            params={"notebook_id": NOTEBOOK_ID_A, "cell_id": "c1"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["display_summary"], "Computes a rolling mean.")
        self.assertEqual(body["display_label"], "Rolling mean")


class TestSaveCellSummary(AppTestCase):
    """POST /cells/summary."""

    def test_saving_a_user_summary_creates_a_row(self):
        """A brand-new user edit is persisted and becomes the display value."""
        response = self.client.post(
            "/cells/summary",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cell_id": "c1",
                "label": "My label",
                "summary": "My summary.",
            },
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["user_summary"], "My summary.")
        self.assertEqual(body["display_summary"], "My summary.")

    def test_user_edit_takes_precedence_over_existing_ai_summary(self):
        """A user save overrides the AI text for display purposes."""
        self.summary_store.save_ai_summary(
            notebook_id=NOTEBOOK_ID_A,
            cell_id="c1",
            summary="AI-generated summary.",
            label="AI label",
            source_hash="hash-1",
        )

        response = self.client.post(
            "/cells/summary",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cell_id": "c1",
                "label": "User label",
                "summary": "User summary.",
            },
        )

        body = response.json()
        # The AI text is preserved underneath, but display prefers the user's.
        self.assertEqual(body["ai_summary"], "AI-generated summary.")
        self.assertEqual(body["display_summary"], "User summary.")

    def test_saving_null_summary_clears_the_user_override(self):
        """Explicitly saving summary=None reverts display to the AI text."""
        self.summary_store.save_ai_summary(
            notebook_id=NOTEBOOK_ID_A,
            cell_id="c1",
            summary="AI-generated summary.",
            label="AI label",
            source_hash="hash-1",
        )
        self.client.post(
            "/cells/summary",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cell_id": "c1",
                "label": "User label",
                "summary": "User summary.",
            },
        )

        response = self.client.post(
            "/cells/summary",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cell_id": "c1",
                "label": None,
                "summary": None,
            },
        )

        body = response.json()
        self.assertIsNone(body["user_summary"])
        self.assertEqual(body["display_summary"], "AI-generated summary.")


class TestSuggestCellSummary(AppTestCase):
    """POST /cells/summary/suggestion."""

    def test_suggestion_for_code_cell_returns_label_and_summary(self):
        """A code cell suggestion returns a non-empty label and summary."""
        response = self.client.post(
            "/cells/summary/suggestion",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cell_id": "c1",
                "cell_type": "code",
                "source": "x = 1",
                "previous_cells": [],
            },
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIsNotNone(body["label"])
        self.assertIsNotNone(body["summary"])

    def test_suggestion_for_markdown_cell_returns_nothing(self):
        """Markdown cells never go through the LLM, even for suggestions."""
        response = self.client.post(
            "/cells/summary/suggestion",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cell_id": "m1",
                "cell_type": "markdown",
                "source": "# Title",
                "previous_cells": [],
            },
        )

        body = response.json()
        self.assertIsNone(body["label"])
        self.assertIsNone(body["summary"])

    def test_suggestion_is_not_persisted(self):
        """A suggestion must not be saved until the user explicitly accepts.

        The editor flow is: request a suggestion, show it in an
        accept/reject panel, and only persist on an explicit Save. If the
        suggestion endpoint silently wrote to the summary store, an
        unreviewed AI suggestion could leak into the display summary.
        """
        self.client.post(
            "/cells/summary/suggestion",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cell_id": "c1",
                "cell_type": "code",
                "source": "x = 1",
                "previous_cells": [],
            },
        )

        self.assertIsNone(self.summary_store.get_summary(NOTEBOOK_ID_A, "c1"))


class TestGetNotebookSummaries(AppTestCase):
    """POST /notebooks/summaries: batch hydration for a whole notebook."""

    def _cell(
        self, cell_id: str, source: str, cell_type: str, index: int
    ) -> dict:
        return {
            "cell_id": cell_id,
            "cell_type": cell_type,
            "source": source,
            "cell_index": index,
        }

    def test_missing_summaries_are_generated_for_every_cell(self):
        """A notebook with no stored summaries gets one response per cell."""
        response = self.client.post(
            "/notebooks/summaries",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cells": [
                    self._cell("c1", "x = 1", "code", 0),
                    self._cell("m1", "# Title", "markdown", 1),
                ],
            },
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body), 2)
        by_id = {item["cell_id"]: item for item in body}
        # Code cell: AI-enriched.
        self.assertIsNotNone(by_id["c1"]["ai_summary"])
        # Markdown cell: never enriched, but still hydrated with a row.
        self.assertIsNone(by_id["m1"]["ai_summary"])

    def test_existing_valid_cached_summary_is_reused_not_regenerated(self):
        """A fresh, matching-hash AI summary is served from cache as-is."""
        from backend.src.app.app import hash_cell_source

        source = "x = 1"
        self.summary_store.save_ai_summary(
            notebook_id=NOTEBOOK_ID_A,
            cell_id="c1",
            summary="A previously cached, still-valid summary.",
            label="Cached label",
            source_hash=hash_cell_source(source),
        )

        response = self.client.post(
            "/notebooks/summaries",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cells": [self._cell("c1", source, "code", 0)],
            },
        )

        body = response.json()[0]
        self.assertEqual(
            body["ai_summary"], "A previously cached, still-valid summary."
        )

    def test_changed_source_invalidates_the_cached_summary(self):
        """Editing a cell's source (different hash) forces regeneration."""
        from backend.src.app.app import hash_cell_source

        self.summary_store.save_ai_summary(
            notebook_id=NOTEBOOK_ID_A,
            cell_id="c1",
            summary="Summary for the old source.",
            label="Old label",
            source_hash=hash_cell_source("x = 1"),
        )

        response = self.client.post(
            "/notebooks/summaries",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cells": [self._cell("c1", "x = 2", "code", 0)],
            },
        )

        body = response.json()[0]
        self.assertNotEqual(
            body["ai_summary"], "Summary for the old source."
        )

    def test_user_edit_is_never_overwritten_by_batch_hydration(self):
        """A user-edited summary survives even when its hash is stale."""
        from backend.src.app.app import hash_cell_source

        self.summary_store.save_ai_summary(
            notebook_id=NOTEBOOK_ID_A,
            cell_id="c1",
            summary="Original AI summary.",
            label="Original label",
            source_hash=hash_cell_source("x = 1"),
        )
        self.summary_store.save_user_summary(
            notebook_id=NOTEBOOK_ID_A,
            cell_id="c1",
            summary="My hand-written summary.",
            label="My label",
        )

        # The cell's source has since changed (hash no longer matches), but
        # the user's own text must still win.
        response = self.client.post(
            "/notebooks/summaries",
            json={
                "notebook_id": NOTEBOOK_ID_A,
                "cells": [self._cell("c1", "x = 2", "code", 0)],
            },
        )

        body = response.json()[0]
        self.assertEqual(body["display_summary"], "My hand-written summary.")

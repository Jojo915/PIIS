"""Tests for SQLite-backed summary storage."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.src.app.summary_store.sqlite_store import SQLiteSummaryStore


class TestSQLiteSummaryStore(unittest.TestCase):
    """Verify summary persistence behavior."""

    def setUp(self) -> None:
        """Create a temporary SQLite database for each test."""
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "summaries.db"
        self.store = SQLiteSummaryStore(self.db_path)

    def tearDown(self) -> None:
        """Clean up the temporary database."""
        self.tmpdir.cleanup()

    def test_missing_summary_returns_none(self) -> None:
        """Unknown cells should not produce fake summaries."""
        summary = self.store.get_summary("notebook", "cell")

        self.assertIsNone(summary)

    def test_user_summary_takes_display_precedence(self) -> None:
        """User-edited summaries are preferred over AI summaries."""
        self.store.save_ai_summary(
            "notebook",
            "cell",
            "AI summary",
            label="AI label",
            source_hash="hash-v1",
        )
        summary = self.store.save_user_summary(
            "notebook", "cell", "User summary"
        )

        self.assertEqual(summary.ai_label, "AI label")
        self.assertEqual(summary.ai_summary, "AI summary")
        self.assertEqual(summary.user_summary, "User summary")
        self.assertEqual(summary.source_hash, "hash-v1")
        self.assertEqual(summary.display_summary, "User summary")

    def test_updating_ai_summary_preserves_user_summary(self) -> None:
        """Regenerated AI summaries must not overwrite user edits."""
        self.store.save_ai_summary(
            "notebook", "cell", "Old AI", source_hash="hash-v1"
        )
        self.store.save_user_summary("notebook", "cell", "User summary")
        summary = self.store.save_ai_summary(
            "notebook", "cell", "New AI", source_hash="hash-v2"
        )

        self.assertEqual(summary.ai_summary, "New AI")
        self.assertEqual(summary.user_summary, "User summary")
        self.assertEqual(summary.source_hash, "hash-v2")
        self.assertEqual(summary.display_summary, "User summary")

    def test_summary_can_be_recovered_by_source_hash(self) -> None:
        """Summaries can be copied when a temporary cell id changes."""
        self.store.save_ai_summary(
            "notebook",
            "old-cell",
            "AI summary",
            label="AI label",
            source_hash="hash-v1",
        )
        existing = self.store.save_user_summary(
            "notebook",
            "old-cell",
            "User summary",
            label="User label",
        )

        recovered = self.store.get_summary_by_source_hash(
            "notebook", "hash-v1"
        )
        self.assertIsNotNone(recovered)

        copied = self.store.copy_summary_to_cell(
            existing,
            cell_id="new-cell",
            source_hash="hash-v1",
        )

        self.assertEqual(copied.cell_id, "new-cell")
        self.assertEqual(copied.display_label, "User label")
        self.assertEqual(copied.display_summary, "User summary")

    def test_source_hash_lookup_prefers_user_edits(self) -> None:
        """A fresh AI-only row should not hide older user edits."""
        self.store.save_ai_summary(
            "notebook",
            "old-cell",
            "Old AI summary",
            label="Old AI label",
            source_hash="hash-v1",
        )
        self.store.save_user_summary(
            "notebook",
            "old-cell",
            "User summary",
            label="User label",
        )
        self.store.save_ai_summary(
            "notebook",
            "new-cell",
            "New AI summary",
            label="New AI label",
            source_hash="hash-v1",
        )

        recovered = self.store.get_summary_by_source_hash(
            "notebook", "hash-v1"
        )

        self.assertIsNotNone(recovered)
        self.assertEqual(recovered.cell_id, "old-cell")
        self.assertEqual(recovered.display_label, "User label")
        self.assertEqual(recovered.display_summary, "User summary")

    def test_existing_database_is_migrated_with_source_hash(self) -> None:
        """Older databases receive the source_hash column on startup."""
        import sqlite3

        connection = sqlite3.connect(self.db_path)
        try:
            connection.execute("DROP TABLE cell_summaries")
            connection.execute(
                """
                CREATE TABLE cell_summaries (
                    notebook_id TEXT NOT NULL,
                    cell_id TEXT NOT NULL,
                    ai_summary TEXT,
                    user_summary TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (notebook_id, cell_id)
                )
                """
            )
            connection.commit()
        finally:
            connection.close()

        migrated_store = SQLiteSummaryStore(self.db_path)
        summary = migrated_store.save_ai_summary(
            "notebook",
            "cell",
            "AI summary",
            label="AI label",
            source_hash="hash-v1",
        )

        self.assertEqual(summary.ai_label, "AI label")
        self.assertEqual(summary.source_hash, "hash-v1")

    def test_delete_notebook_summaries_removes_only_target(self) -> None:
        """Notebook-level deletes should not touch other notebooks."""
        self.store.save_user_summary("notebook_a", "cell", "Summary A")
        self.store.save_user_summary("notebook_b", "cell", "Summary B")

        self.store.delete_notebook_summaries("notebook_a")

        self.assertIsNone(self.store.get_summary("notebook_a", "cell"))
        self.assertIsNotNone(self.store.get_summary("notebook_b", "cell"))


if __name__ == "__main__":
    unittest.main()

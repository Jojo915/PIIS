"""SQLite-backed implementation of cell summary storage."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .base import CellSummary


BACKEND_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB_PATH = BACKEND_ROOT / "semantic_canvas.db"


class SQLiteSummaryStore:
    """Store user-editable cell summaries in a local SQLite database."""

    def __init__(self, db_path: str | Path = DEFAULT_DB_PATH) -> None:
        """Create the store and ensure its schema exists."""
        self.db_path = Path(db_path)
        self._initialize()

    def get_summary(
        self, notebook_id: str, cell_id: str
    ) -> CellSummary | None:
        """Return summaries for one cell if present."""
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT notebook_id, cell_id, ai_label, user_label,
                       ai_summary, user_summary, source_hash,
                       created_at, updated_at
                FROM cell_summaries
                WHERE notebook_id = ? AND cell_id = ?
                """,
                (notebook_id, cell_id),
            ).fetchone()

        return self._row_to_summary(row) if row else None

    def get_summary_by_source_hash(
        self, notebook_id: str, source_hash: str
    ) -> CellSummary | None:
        """Return the most recently updated summary for matching source."""
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT notebook_id, cell_id, ai_label, user_label,
                       ai_summary, user_summary, source_hash,
                       created_at, updated_at
                FROM cell_summaries
                WHERE notebook_id = ? AND source_hash = ?
                ORDER BY
                    CASE
                        WHEN user_label IS NOT NULL OR user_summary IS NOT NULL
                        THEN 0
                        ELSE 1
                    END,
                    updated_at DESC
                LIMIT 1
                """,
                (notebook_id, source_hash),
            ).fetchone()

        return self._row_to_summary(row) if row else None

    def copy_summary_to_cell(
        self,
        summary: CellSummary,
        cell_id: str,
        source_hash: str | None = None,
    ) -> CellSummary:
        """Copy an existing summary to a new cell id."""
        return self._upsert_summary(
            notebook_id=summary.notebook_id,
            cell_id=cell_id,
            ai_label=summary.ai_label,
            user_label=summary.user_label,
            ai_summary=summary.ai_summary,
            user_summary=summary.user_summary,
            source_hash=source_hash or summary.source_hash,
            update_ai=True,
            update_user=True,
            update_hash=True,
        )

    def save_ai_summary(
        self,
        notebook_id: str,
        cell_id: str,
        summary: str | None,
        label: str | None = None,
        source_hash: str | None = None,
    ) -> CellSummary:
        """Create or update the AI-generated summary for one cell."""
        return self._upsert_summary(
            notebook_id=notebook_id,
            cell_id=cell_id,
            ai_label=label,
            user_label=None,
            ai_summary=summary,
            user_summary=None,
            source_hash=source_hash,
            update_ai=True,
            update_user=False,
            update_hash=True,
        )

    def save_user_summary(
        self,
        notebook_id: str,
        cell_id: str,
        summary: str | None,
        label: str | None = None,
    ) -> CellSummary:
        """Create or update the user-edited label and summary for one cell."""
        return self._upsert_summary(
            notebook_id=notebook_id,
            cell_id=cell_id,
            ai_label=None,
            user_label=label,
            ai_summary=None,
            user_summary=summary,
            source_hash=None,
            update_ai=False,
            update_user=True,
            update_hash=False,
        )

    def delete_cell_summary(self, notebook_id: str, cell_id: str) -> None:
        """Delete summaries for one cell."""
        with self._connect() as connection:
            connection.execute(
                """
                DELETE FROM cell_summaries
                WHERE notebook_id = ? AND cell_id = ?
                """,
                (notebook_id, cell_id),
            )

    def delete_notebook_summaries(self, notebook_id: str) -> None:
        """Delete summaries for all cells in one notebook."""
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM cell_summaries WHERE notebook_id = ?",
                (notebook_id,),
            )

    def _initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS cell_summaries (
                    notebook_id TEXT NOT NULL,
                    cell_id TEXT NOT NULL,
                    ai_label TEXT,
                    user_label TEXT,
                    ai_summary TEXT,
                    user_summary TEXT,
                    source_hash TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (notebook_id, cell_id)
                )
                """
            )
            self._ensure_column(connection, "ai_label", "TEXT")
            self._ensure_column(connection, "user_label", "TEXT")
            self._ensure_column(connection, "source_hash", "TEXT")

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _upsert_summary(
        self,
        notebook_id: str,
        cell_id: str,
        ai_label: str | None,
        user_label: str | None,
        ai_summary: str | None,
        user_summary: str | None,
        source_hash: str | None,
        update_ai: bool,
        update_user: bool,
        update_hash: bool,
    ) -> CellSummary:
        label_update = "excluded.ai_label" if update_ai else "ai_label"
        user_label_update = (
            "excluded.user_label" if update_user else "user_label"
        )
        ai_update = "excluded.ai_summary" if update_ai else "ai_summary"
        user_update = (
            "excluded.user_summary" if update_user else "user_summary"
        )
        hash_update = (
            "excluded.source_hash" if update_hash else "source_hash"
        )

        with self._connect() as connection:
            connection.execute(
                f"""
                INSERT INTO cell_summaries (
                    notebook_id, cell_id, ai_label, user_label, ai_summary,
                    user_summary, source_hash
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(notebook_id, cell_id) DO UPDATE SET
                    ai_label = {label_update},
                    user_label = {user_label_update},
                    ai_summary = {ai_update},
                    user_summary = {user_update},
                    source_hash = {hash_update},
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    notebook_id,
                    cell_id,
                    ai_label,
                    user_label,
                    ai_summary,
                    user_summary,
                    source_hash,
                ),
            )

        summary = self.get_summary(notebook_id, cell_id)
        if summary is None:
            raise RuntimeError("Failed to save cell summary.")

        return summary

    def _row_to_summary(self, row: sqlite3.Row) -> CellSummary:
        return CellSummary(
            notebook_id=row["notebook_id"],
            cell_id=row["cell_id"],
            ai_label=row["ai_label"],
            user_label=row["user_label"],
            ai_summary=row["ai_summary"],
            user_summary=row["user_summary"],
            source_hash=row["source_hash"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _ensure_column(
        self,
        connection: sqlite3.Connection,
        column_name: str,
        column_type: str,
    ) -> None:
        existing_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(cell_summaries)")
        }

        if column_name not in existing_columns:
            connection.execute(
                f"ALTER TABLE cell_summaries ADD COLUMN {column_name} {column_type}"
            )

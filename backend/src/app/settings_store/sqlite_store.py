"""SQLite-backed implementation of AI settings storage."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .base import (
    DEFAULT_DETECT_DEAD_CELLS,
    DEFAULT_DETECT_DUPLICATE_CELLS,
    DEFAULT_DETECT_STALE_CELLS,
    DEFAULT_MODEL,
    AiSettings,
)

# Reuses the same local database file as SQLiteSummaryStore
# (``semantic_canvas.db``) rather than introducing a second db file --
# this is one small, local-dev SQLite store for the whole extension, and
# splitting it across two files would add ceremony without any benefit.
BACKEND_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB_PATH = BACKEND_ROOT / "semantic_canvas.db"

# Single global row. AI settings are not per-notebook, so there is exactly
# one settings row, pinned to id=1 by the CHECK constraint below.
_SETTINGS_ROW_ID = 1


class SQLiteSettingsStore:
    """Store the global AI settings in a local SQLite database."""

    def __init__(self, db_path: str | Path = DEFAULT_DB_PATH) -> None:
        """Create the store and ensure its schema (and default row) exist."""
        self.db_path = Path(db_path)
        self._initialize()

    def get_settings(self) -> AiSettings:
        """Return the current settings, seeding defaults if none exist."""
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT api_key, model, custom_model, detect_stale_cells,
                       detect_duplicate_cells, detect_dead_cells,
                       created_at, updated_at
                FROM ai_settings
                WHERE id = ?
                """,
                (_SETTINGS_ROW_ID,),
            ).fetchone()

        if row is None:
            # Should not normally happen (the default row is seeded in
            # _initialize), but guards against a row that was somehow
            # deleted out from under us.
            return self.reset_settings()

        return self._row_to_settings(row)

    def save_settings(
        self,
        *,
        api_key: str | None,
        model: str,
        custom_model: str | None,
        detect_stale_cells: bool,
        detect_duplicate_cells: bool,
        detect_dead_cells: bool,
    ) -> AiSettings:
        """Persist settings, leaving the stored key untouched when None."""
        key_update = "excluded.api_key" if api_key is not None else "api_key"

        with self._connect() as connection:
            connection.execute(
                f"""
                INSERT INTO ai_settings (
                    id, api_key, model, custom_model, detect_stale_cells,
                    detect_duplicate_cells, detect_dead_cells
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    api_key = {key_update},
                    model = excluded.model,
                    custom_model = excluded.custom_model,
                    detect_stale_cells = excluded.detect_stale_cells,
                    detect_duplicate_cells = excluded.detect_duplicate_cells,
                    detect_dead_cells = excluded.detect_dead_cells,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    _SETTINGS_ROW_ID,
                    api_key,
                    model,
                    custom_model,
                    int(detect_stale_cells),
                    int(detect_duplicate_cells),
                    int(detect_dead_cells),
                ),
            )

        return self.get_settings()

    def reset_settings(self) -> AiSettings:
        """Restore every setting to its default, deleting the stored key."""
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO ai_settings (
                    id, api_key, model, custom_model, detect_stale_cells,
                    detect_duplicate_cells, detect_dead_cells
                )
                VALUES (?, NULL, ?, NULL, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    api_key = NULL,
                    model = excluded.model,
                    custom_model = NULL,
                    detect_stale_cells = excluded.detect_stale_cells,
                    detect_duplicate_cells = excluded.detect_duplicate_cells,
                    detect_dead_cells = excluded.detect_dead_cells,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    _SETTINGS_ROW_ID,
                    DEFAULT_MODEL,
                    int(DEFAULT_DETECT_STALE_CELLS),
                    int(DEFAULT_DETECT_DUPLICATE_CELLS),
                    int(DEFAULT_DETECT_DEAD_CELLS),
                ),
            )

        return self.get_settings()

    def _initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    api_key TEXT,
                    model TEXT NOT NULL DEFAULT 'gemini-2.5-flash-lite',
                    custom_model TEXT,
                    detect_stale_cells INTEGER NOT NULL DEFAULT 1,
                    detect_duplicate_cells INTEGER NOT NULL DEFAULT 1,
                    detect_dead_cells INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            # Seed the single default row if this is a fresh database, so
            # get_settings() always has a row to read -- callers never have
            # to special-case "no settings saved yet".
            connection.execute(
                """
                INSERT OR IGNORE INTO ai_settings (
                    id, model, detect_stale_cells, detect_duplicate_cells,
                    detect_dead_cells
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    _SETTINGS_ROW_ID,
                    DEFAULT_MODEL,
                    int(DEFAULT_DETECT_STALE_CELLS),
                    int(DEFAULT_DETECT_DUPLICATE_CELLS),
                    int(DEFAULT_DETECT_DEAD_CELLS),
                ),
            )

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

    def _row_to_settings(self, row: sqlite3.Row) -> AiSettings:
        return AiSettings(
            api_key=row["api_key"],
            model=row["model"],
            custom_model=row["custom_model"],
            detect_stale_cells=bool(row["detect_stale_cells"]),
            detect_duplicate_cells=bool(row["detect_duplicate_cells"]),
            detect_dead_cells=bool(row["detect_dead_cells"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

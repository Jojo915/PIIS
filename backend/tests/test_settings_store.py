"""Tests for SQLite-backed AI settings storage."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.src.app.settings_store.base import DEFAULT_MODEL
from backend.src.app.settings_store.sqlite_store import SQLiteSettingsStore


class TestSQLiteSettingsStore(unittest.TestCase):
    """Verify AI settings persistence behavior."""

    def setUp(self) -> None:
        """Create a temporary SQLite database for each test."""
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "settings.db"
        self.store = SQLiteSettingsStore(self.db_path)

    def tearDown(self) -> None:
        """Clean up the temporary database."""
        self.tmpdir.cleanup()

    def test_fresh_database_seeds_defaults(self) -> None:
        """A brand-new store should already have one default settings row."""
        settings = self.store.get_settings()

        self.assertIsNone(settings.api_key)
        self.assertEqual(settings.model, DEFAULT_MODEL)
        self.assertIsNone(settings.custom_model)
        self.assertTrue(settings.detect_stale_cells)
        self.assertTrue(settings.detect_duplicate_cells)
        self.assertTrue(settings.detect_dead_cells)

    def test_save_settings_persists_all_fields(self) -> None:
        """Saving should round-trip every field, including the API key."""
        saved = self.store.save_settings(
            api_key="secret-key",
            model="other",
            custom_model="my-custom-model",
            detect_stale_cells=False,
            detect_duplicate_cells=True,
            detect_dead_cells=False,
        )

        self.assertEqual(saved.api_key, "secret-key")
        self.assertEqual(saved.model, "other")
        self.assertEqual(saved.custom_model, "my-custom-model")
        self.assertFalse(saved.detect_stale_cells)
        self.assertTrue(saved.detect_duplicate_cells)
        self.assertFalse(saved.detect_dead_cells)
        self.assertEqual(saved.resolved_model, "my-custom-model")

    def test_save_settings_with_none_api_key_leaves_it_unchanged(self) -> None:
        """Passing api_key=None must never clear a previously saved key.

        This is the storage-layer half of the "only reindex when the key
        actually changes" rule: a model/checkbox-only save must be able to
        round-trip through save_settings without touching the key at all.
        """
        self.store.save_settings(
            api_key="original-key",
            model=DEFAULT_MODEL,
            custom_model=None,
            detect_stale_cells=True,
            detect_duplicate_cells=True,
            detect_dead_cells=True,
        )

        updated = self.store.save_settings(
            api_key=None,
            model="gemini-1.5-flash",
            custom_model=None,
            detect_stale_cells=False,
            detect_duplicate_cells=True,
            detect_dead_cells=True,
        )

        self.assertEqual(updated.api_key, "original-key")
        self.assertEqual(updated.model, "gemini-1.5-flash")
        self.assertFalse(updated.detect_stale_cells)

    def test_reset_settings_restores_defaults_and_clears_key(self) -> None:
        """Reset must clear the key and restore every default value."""
        self.store.save_settings(
            api_key="secret-key",
            model="other",
            custom_model="my-custom-model",
            detect_stale_cells=False,
            detect_duplicate_cells=False,
            detect_dead_cells=False,
        )

        reset = self.store.reset_settings()

        self.assertIsNone(reset.api_key)
        self.assertEqual(reset.model, DEFAULT_MODEL)
        self.assertIsNone(reset.custom_model)
        self.assertTrue(reset.detect_stale_cells)
        self.assertTrue(reset.detect_duplicate_cells)
        self.assertTrue(reset.detect_dead_cells)

    def test_resolved_model_falls_back_to_default_without_custom_model(
        self,
    ) -> None:
        """"other" with no custom_model set should not resolve to an empty
        string -- fall back to the default model instead."""
        saved = self.store.save_settings(
            api_key=None,
            model="other",
            custom_model=None,
            detect_stale_cells=True,
            detect_duplicate_cells=True,
            detect_dead_cells=True,
        )

        self.assertEqual(saved.resolved_model, DEFAULT_MODEL)

    def test_non_other_model_resolves_to_itself(self) -> None:
        """A concrete dropdown selection should resolve to itself verbatim."""
        saved = self.store.save_settings(
            api_key=None,
            model="gemini-1.5-flash",
            custom_model="ignored-when-not-other",
            detect_stale_cells=True,
            detect_duplicate_cells=True,
            detect_dead_cells=True,
        )

        self.assertEqual(saved.resolved_model, "gemini-1.5-flash")

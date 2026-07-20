"""Shared test scaffolding for FastAPI endpoint-level tests.

``app.app`` builds its vector-store collection, its summary store, and its
settings store as module-level globals (``create_vector_store(...)`` is
called fresh inside every endpoint, while ``summary_store`` and
``settings_store`` are each constructed once at import time -- see
CLAUDE.md's "known issue" note on the former). Endpoint tests must never
touch the real, persistent ``./chroma_db`` directory or ``semantic_canvas.db``
file used during manual/dev testing, and must never leak state between
tests.

``AppTestCase`` patches all three globals for the duration of each test:
``create_vector_store`` is replaced so every call (regardless of the
``path``/``collection_name`` arguments the endpoint passes) returns the same
ephemeral, per-test Chroma collection, and ``summary_store``/
``settings_store`` are each replaced with a fresh temp-directory-backed
store instance.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import chromadb
from fastapi.testclient import TestClient

from backend.src.app.app import app as fastapi_app
from backend.src.app.settings_store.sqlite_store import SQLiteSettingsStore
from backend.src.app.summary_store.sqlite_store import SQLiteSummaryStore

NOTEBOOK_ID_A = "notebook_a.ipynb"
NOTEBOOK_ID_B = "notebook_b.ipynb"


def code_cell(
    cell_id: str, source: str, execution_count: int | None = None
) -> dict:
    """Build a raw nbformat code cell dict for request bodies."""
    return {
        "id": cell_id,
        "cell_type": "code",
        "source": source,
        "metadata": {},
        "outputs": [],
        "execution_count": execution_count,
    }


def markdown_cell(cell_id: str, source: str) -> dict:
    """Build a raw nbformat markdown cell dict for request bodies."""
    return {
        "id": cell_id,
        "cell_type": "markdown",
        "source": source,
        "metadata": {},
        "outputs": [],
    }


def notebook_content(cells: list[dict]) -> dict:
    """Wrap a list of raw cell dicts into a minimal nbformat notebook dict."""
    return {
        "cells": cells,
        "metadata": {},
        "nbformat": 4,
        "nbformat_minor": 5,
    }


class AppTestCase(unittest.TestCase):
    """Base class providing an isolated FastAPI TestClient per test."""

    def setUp(self) -> None:
        """Swap the vector store and summary store for isolated instances."""
        self.chroma_client = chromadb.EphemeralClient()
        self.collection = self.chroma_client.create_collection("test_demo")

        self.tmpdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tmpdir.name) / "summaries.db"
        self.summary_store = SQLiteSummaryStore(db_path)
        settings_db_path = Path(self.tmpdir.name) / "settings.db"
        self.settings_store = SQLiteSettingsStore(settings_db_path)

        self._vector_store_patcher = mock.patch(
            "backend.src.app.app.create_vector_store",
            return_value=self.collection,
        )
        self._vector_store_patcher.start()

        self._summary_store_patcher = mock.patch(
            "backend.src.app.app.summary_store", self.summary_store
        )
        self._summary_store_patcher.start()

        self._settings_store_patcher = mock.patch(
            "backend.src.app.app.settings_store", self.settings_store
        )
        self._settings_store_patcher.start()

        self.client = TestClient(fastapi_app)

    def tearDown(self) -> None:
        """Undo the patches and clean up the temporary collection/database.

        ``chromadb.EphemeralClient()`` instances are not fully independent
        of each other within the same process -- a collection created by
        one instance is still visible (and must be explicitly deleted) via
        a later instance, the same behavior relied on by
        ``ChromaTestBase`` in ``test_vector_storage.py``. Without this
        explicit cleanup, "test_demo" would already exist by the second
        test and every subsequent ``create_collection`` call would raise.
        """
        self._vector_store_patcher.stop()
        self._summary_store_patcher.stop()
        self._settings_store_patcher.stop()
        self.chroma_client.delete_collection("test_demo")
        self.tmpdir.cleanup()

"""Interfaces and data types for cell summary storage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CellSummary:
    """Stored summaries for one notebook cell."""

    notebook_id: str
    cell_id: str
    ai_summary: str | None
    user_summary: str | None
    source_hash: str | None
    created_at: str
    updated_at: str

    @property
    def display_summary(self) -> str | None:
        """Return the summary users should see first."""
        return self.user_summary or self.ai_summary


class SummaryStore(Protocol):
    """Persistence interface for cell summaries."""

    def get_summary(
        self, notebook_id: str, cell_id: str
    ) -> CellSummary | None:
        """Return summaries for one cell if present."""

    def save_ai_summary(
        self,
        notebook_id: str,
        cell_id: str,
        summary: str | None,
        source_hash: str | None = None,
    ) -> CellSummary:
        """Create or update the AI-generated summary for one cell."""

    def save_user_summary(
        self, notebook_id: str, cell_id: str, summary: str | None
    ) -> CellSummary:
        """Create or update the user-edited summary for one cell."""

    def delete_cell_summary(self, notebook_id: str, cell_id: str) -> None:
        """Delete summaries for one cell."""

    def delete_notebook_summaries(self, notebook_id: str) -> None:
        """Delete summaries for all cells in one notebook."""


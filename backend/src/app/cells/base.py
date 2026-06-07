"""Contains the base class for the different notebook cells."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from chromadb import Metadata


class NotebookCell:
    """Base class for notebook cells providing parsing/serialization logic."""

    def __init__(self, cell: dict) -> None:
        """Initialize a NotebookCell from a raw nbformat cell dict."""
        self.cell_type: str = cell["cell_type"]
        self.cell_id: str = cell["id"]
        self.content: str = cell["source"]
        self.output: str | None = None

    def to_chunk(self, notebook_id: str) -> Metadata:
        """Return a metadata dict ready for storage in the vector store."""
        return {
            "cell_id": self.cell_id,
            "cell_type": self.cell_type,
            "content": self.content,
            "notebook_id": notebook_id,
        }

    def to_embed(self) -> str:
        """Return the text to be embedded, using source content only."""
        return self.content

"""Contains the cell classes for parsing Jupyter notebook cells."""

from __future__ import annotations

from .base import NotebookCell


class MarkdownCell(NotebookCell):
    """Represents a markdown cell, containing only source text, no outputs."""

    def __init__(self, cell: dict, cell_index: int) -> None:
        """Initialize a MarkdownCell from a raw nbformat cell dict."""
        super().__init__(cell, cell_index)

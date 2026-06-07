"""Contains the factory for instantiating Notebook cells."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .code import CodeCell
from .markdown import MarkdownCell

if TYPE_CHECKING:
    from .base import NotebookCell


def cell_factory(cell: dict) -> NotebookCell:
    """Instantiate the correct cell subclass based on the cell's type field."""
    match cell["cell_type"]:
        case "markdown":
            return MarkdownCell(cell)
        case "code":
            return CodeCell(cell)
        case _:
            raise ValueError(f"Unknown cell type: {cell['cell_type']}")

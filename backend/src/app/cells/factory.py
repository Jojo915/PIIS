"""Contains the factory for instantiating Notebook cells."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .code import CodeCell
from .markdown import MarkdownCell

if TYPE_CHECKING:
    from .base import NotebookCell


def cell_factory(cell: dict, cell_index: int) -> NotebookCell:
    """Instantiate the correct cell subclass based on the cell's type field.

    Args:
        cell: The raw nbformat cell dict.
        cell_index: The cell's position within its notebook (0-based).

    """
    match cell["cell_type"]:
        case "markdown":
            return MarkdownCell(cell, cell_index)
        case "code":
            return CodeCell(cell, cell_index)
        case _:
            raise ValueError(f"Unknown cell type: {cell['cell_type']}")

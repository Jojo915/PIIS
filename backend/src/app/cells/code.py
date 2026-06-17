"""Contains the cell classes for parsing Jupyter notebook cells."""

from __future__ import annotations

from .base import NotebookCell


class CodeCell(NotebookCell):
    """Represents a code cell, including parsed outputs and errors."""

    def __init__(self, cell: dict, cell_index: int) -> None:
        """Initialize a CodeCell and parse all output types."""
        super().__init__(cell, cell_index)
        self.output: str | None = self._parse_output(cell.get("outputs", []))

    def _parse_output(self, outputs: list) -> str | None:
        """Flatten all output blocks into a single string."""
        texts = []
        for output in outputs:
            match output.get("output_type"):
                case "stream":
                    texts.append(output.get("text", ""))
                case "execute_result" | "display_data":
                    texts.append(output.get("data", {}).get("text/plain", ""))
                case "error":
                    traceback = "\n".join(output.get("traceback", []))
                    texts.append(traceback)
        return "\n".join(texts) if texts else None

    def to_embed(self) -> str:
        """Extend the base embedding with cell output."""
        parts = [super().to_embed()]
        if self.output:
            parts.append(self.output)
        return "\n".join(parts)

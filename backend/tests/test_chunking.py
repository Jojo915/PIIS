"""Unit tests for the notebook RAG cell parsing system."""

import unittest

from backend.src.app.cells.code import CodeCell
from backend.src.app.cells.factory import cell_factory
from backend.src.app.cells.markdown import MarkdownCell

MARKDOWN_CELL = {
    "id": "a1b2c3d4",
    "cell_type": "markdown",
    "source": "## Data Normalization\nAvoid exploding gradients.",
    "metadata": {},
    "outputs": [],
}

CODE_CELL_WITH_OUTPUT = {
    "id": "e5f6g7h8",
    "cell_type": "code",
    "source": "# Normalize\nprint(X_normalized)",
    "metadata": {},
    "outputs": [
        {
            "output_type": "stream",
            "name": "stdout",
            "text": "[[-1.22 -1.22]\n [ 0.  0.]]",
        }
    ],
    "execution_count": 1,
}

CODE_CELL_NO_OUTPUT = {
    "id": "i9j0k1l2",
    "cell_type": "code",
    "source": "import numpy as np",
    "metadata": {},
    "outputs": [],
    "execution_count": None,
}

CODE_CELL_WITH_ERROR = {
    "id": "m3n4o5p6",
    "cell_type": "code",
    "source": "1/0",
    "metadata": {},
    "outputs": [
        {
            "output_type": "error",
            "ename": "ZeroDivisionError",
            "evalue": "division by zero",
            "traceback": [
                "Traceback (most recent call last):",
                "ZeroDivisionError: division by zero",
            ],
        }
    ],
    "execution_count": 2,
}

CODE_CELL_WITH_EXECUTE_RESULT = {
    "id": "q7r8s9t0",
    "cell_type": "code",
    "source": "1 + 1",
    "metadata": {},
    "outputs": [
        {
            "output_type": "execute_result",
            "data": {"text/plain": "2"},
            "metadata": {},
            "execution_count": 3,
        }
    ],
    "execution_count": 3,
}

CODE_CELL_MULTIPLE_OUTPUTS = {
    "id": "u1v2w3x4",
    "cell_type": "code",
    "source": "print('hello')\n1 + 1",
    "metadata": {},
    "outputs": [
        {"output_type": "stream", "name": "stdout", "text": "hello\n"},
        {
            "output_type": "execute_result",
            "data": {"text/plain": "2"},
            "metadata": {},
            "execution_count": 4,
        },
    ],
    "execution_count": 4,
}


class TestCellFactory(unittest.TestCase):
    """Tests cell_factory returns the correct subclass/fails gracefully."""

    def test_returns_markdown_cell_for_markdown_type(self):
        """Verify markdown cell type produces a MarkdownCell instance."""
        self.assertIsInstance(cell_factory(MARKDOWN_CELL), MarkdownCell)

    def test_returns_code_cell_for_code_type(self):
        """Verify code cell type produces a CodeCell instance."""
        self.assertIsInstance(cell_factory(CODE_CELL_WITH_OUTPUT), CodeCell)

    def test_raises_on_unknown_cell_type(self):
        """Verify an unknown cell type raises a ValueError."""
        with self.assertRaises(ValueError):
            cell_factory({**MARKDOWN_CELL, "cell_type": "raw"})

    def test_missing_id_raises(self):
        """Verify a cell dict without an id key raises a KeyError."""
        with self.assertRaises(KeyError):
            cell_factory({k: v for k, v in MARKDOWN_CELL.items() if k != "id"})

    def test_missing_source_raises(self):
        """Verify a cell dict without a source key raises a KeyError."""
        with self.assertRaises(KeyError):
            cell_factory(
                {k: v for k, v in MARKDOWN_CELL.items() if k != "source"}
            )


class TestToChunk(unittest.TestCase):
    """Tests that to_chunk produces valid Chroma-compatible metadata dicts."""

    def test_chunk_contains_required_keys(self):
        """Verify all required metadata keys are present in the chunk."""
        chunk = cell_factory(MARKDOWN_CELL).to_chunk(notebook_id="nb_001")
        for key in ("cell_id", "cell_type", "content", "notebook_id"):
            self.assertIn(key, chunk)

    def test_chunk_notebook_id_is_set_correctly(self):
        """Verify the notebook_id passed to to_chunk is stored in the chunk."""
        chunk = cell_factory(MARKDOWN_CELL).to_chunk(notebook_id="nb_001")
        self.assertEqual(chunk["notebook_id"], "nb_001")

    def test_chunk_does_not_contain_output(self):
        """Verify output is excluded from chunk, because of embedding-only."""
        chunk = cell_factory(CODE_CELL_WITH_OUTPUT).to_chunk(
            notebook_id="nb_001"
        )
        self.assertNotIn("output", chunk)

    def test_chunk_values_are_chroma_compatible_types(self):
        """Verify all chunk values are Chroma-compatible primitive types."""
        chunk = cell_factory(CODE_CELL_WITH_OUTPUT).to_chunk(
            notebook_id="nb_001"
        )
        allowed = (str, int, float, bool, type(None))
        for key, value in chunk.items():
            self.assertIsInstance(
                value,
                allowed,
                f"Key '{key}' has incompatible type {type(value)}",
            )


class TestToEmbed(unittest.TestCase):
    """Tests that to_embed returns the correct text for embedding."""

    def test_markdown_embed_equals_source(self):
        """Verify markdown cells embed only their source content."""
        cell = cell_factory(MARKDOWN_CELL)
        self.assertEqual(cell.to_embed(), MARKDOWN_CELL["source"])

    def test_code_embed_contains_source(self):
        """Verify code cell embedding always includes the source code."""
        cell = cell_factory(CODE_CELL_WITH_OUTPUT)
        self.assertIn(CODE_CELL_WITH_OUTPUT["source"], cell.to_embed())

    def test_code_embed_contains_output(self):
        """Verify code cell embedding includes the output when present."""
        cell = cell_factory(CODE_CELL_WITH_OUTPUT)
        self.assertIn("[[-1.22 -1.22]", cell.to_embed())

    def test_code_embed_contains_error_traceback(self):
        """Verify error tracebacks are included in the embedding text."""
        cell = cell_factory(CODE_CELL_WITH_ERROR)
        self.assertIn("ZeroDivisionError", cell.to_embed())

    def test_code_embed_without_output_equals_source(self):
        """Verify code cells with no output embed only their source."""
        cell = cell_factory(CODE_CELL_NO_OUTPUT)
        self.assertEqual(cell.to_embed(), CODE_CELL_NO_OUTPUT["source"])

    def test_embed_is_richer_than_source_when_output_exists(self):
        """Verify the embed text is longer than source alone."""
        cell = cell_factory(CODE_CELL_WITH_OUTPUT)
        self.assertGreater(len(cell.to_embed()), len(cell.content))


class TestOutputParsing(unittest.TestCase):
    """Tests that all nbformat output types are parsed correctly."""

    def test_stream_output_is_parsed(self):
        """Verify stdout stream output is captured in the output attribute."""
        cell = cell_factory(CODE_CELL_WITH_OUTPUT)
        if cell.output:
            self.assertIn("[[-1.22 -1.22]", cell.output)

    def test_error_traceback_is_parsed(self):
        """Verify error tracebacks are captured rather than dropped."""
        cell = cell_factory(CODE_CELL_WITH_ERROR)
        if cell.output:
            self.assertIn("ZeroDivisionError", cell.output)

    def test_execute_result_is_parsed(self):
        """Verify execute_result output is extracted from the data field."""
        cell = cell_factory(CODE_CELL_WITH_EXECUTE_RESULT)
        if cell.output:
            self.assertIn("2", cell.output)

    def test_no_output_returns_none(self):
        """Verify output is None when a code cell has no outputs."""
        cell = cell_factory(CODE_CELL_NO_OUTPUT)
        self.assertIsNone(cell.output)

    def test_multiple_outputs_are_concatenated(self):
        """Verify multiple output blocks are joined into a single string."""
        cell = cell_factory(CODE_CELL_MULTIPLE_OUTPUTS)
        if cell.output:
            self.assertIn("hello", cell.output)
            self.assertIn("2", cell.output)


if __name__ == "__main__":
    unittest.main()

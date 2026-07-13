"""Unit tests for advisor-style dead code cell detection."""

from __future__ import annotations

import unittest

from backend.src.app.analysis.dead_cells import find_dead_cells


def code_cell(cell_id: str, source: str, outputs=None) -> dict:
    """Build a raw nbformat code cell dict for tests."""
    return {
        "id": cell_id,
        "cell_type": "code",
        "source": source,
        "metadata": {},
        "outputs": outputs or [],
    }


def markdown_cell(cell_id: str, source: str) -> dict:
    """Build a raw nbformat markdown cell dict for tests."""
    return {
        "id": cell_id,
        "cell_type": "markdown",
        "source": source,
        "metadata": {},
        "outputs": [],
    }


STREAM_OUTPUT = [
    {"output_type": "stream", "name": "stdout", "text": "some text"}
]
IMAGE_OUTPUT = [
    {
        "output_type": "display_data",
        "data": {"image/png": "base64=="},
        "metadata": {},
    }
]


def notebook(cells: list[dict]) -> dict:
    """Wrap cells in a minimal nbformat notebook dict."""
    return {"cells": cells}


def flagged_ids(cells: list[dict]) -> set[str]:
    """Return the set of cell ids flagged as dead for a cell list."""
    return {dead.cell_id for dead in find_dead_cells(notebook(cells))}


class DeadCellDetectionTest(unittest.TestCase):
    """Behavioural tests for find_dead_cells."""

    def test_genuinely_dead_cell_is_flagged(self):
        """A cell computing an unused value with no output is dead."""
        cells = [
            code_cell("a", "x = expensive_call()"),
            code_cell("b", "y = 1\nresult = y + 2"),
        ]
        # Nothing reads x, y, or result anywhere else.
        self.assertEqual(flagged_ids(cells), {"a", "b"})

    def test_value_used_in_later_cell_is_alive(self):
        """A binding read by a later cell keeps its cell alive."""
        cells = [
            code_cell("a", "x = load_data()"),
            code_cell("b", "summary = x.describe()"),
            code_cell("c", "print(summary)", outputs=STREAM_OUTPUT),
        ]
        self.assertEqual(flagged_ids(cells), set())

    def test_function_defined_then_used_later_is_alive(self):
        """Deferred use across cells must not be flagged as dead."""
        cells = [
            code_cell("a", "def preprocess(frame):\n    return frame * 2"),
            code_cell("b", "step_one = 1"),
            code_cell("c", "cleaned = preprocess(raw)"),
            code_cell("d", "cleaned"),
        ]
        # preprocess is defined in 'a' and only used in 'c'.
        self.assertNotIn("a", flagged_ids(cells))

    def test_plotting_cell_is_not_flagged(self):
        """A plot is an effect; it must never be flagged as dead."""
        # With a rendered image output.
        with_output = [
            code_cell(
                "plot",
                "plt.plot(values)\nplt.show()",
                outputs=IMAGE_OUTPUT,
            )
        ]
        self.assertEqual(flagged_ids(with_output), set())

        # Even unrun (no output), the plot calls are side effects.
        no_output = [code_cell("plot", "plt.plot(values)\nplt.show()")]
        self.assertEqual(flagged_ids(no_output), set())

    def test_printing_dataframe_is_not_flagged(self):
        """Displaying a dataframe is an effect, not dead code."""
        # Bare-expression display, no output captured.
        bare = [code_cell("show", "df.head()")]
        self.assertEqual(flagged_ids(bare), set())

        # Lone variable auto-display.
        lone = [code_cell("show", "df")]
        self.assertEqual(flagged_ids(lone), set())

        # Printed with captured stream output.
        printed = [code_cell("show", "print(df)", outputs=STREAM_OUTPUT)]
        self.assertEqual(flagged_ids(printed), set())

    def test_side_effect_call_without_output_is_not_flagged(self):
        """An IO call (to_csv) counts as an effect even if unrun."""
        cells = [code_cell("io", "written = df.to_csv('out.csv')")]
        self.assertEqual(flagged_ids(cells), set())

    def test_unused_import_is_flagged(self):
        """An import no other cell uses is dead."""
        cells = [
            code_cell("imp", "import numpy as np"),
            code_cell("work", "total = 1 + 2"),
        ]
        self.assertIn("imp", flagged_ids(cells))

    def test_used_import_is_alive(self):
        """An import used elsewhere is not flagged."""
        cells = [
            code_cell("imp", "import numpy as np"),
            code_cell("work", "arr = np.zeros(3)"),
            code_cell("show", "arr"),
        ]
        self.assertEqual(flagged_ids(cells), set())

    def test_future_import_alone_is_not_flagged(self):
        """__future__ imports are not treated as real bindings."""
        cells = [code_cell("fut", "from __future__ import annotations")]
        self.assertEqual(flagged_ids(cells), set())

    def test_partial_use_keeps_cell_alive(self):
        """If any binding is used elsewhere, the cell is alive."""
        cells = [
            code_cell("a", "kept = 1\nunused = 2"),
            code_cell("b", "value = kept + 1"),
            code_cell("c", "value"),
        ]
        self.assertNotIn("a", flagged_ids(cells))

    def test_global_used_inside_function_body_is_alive(self):
        """A name read inside a function body keeps its cell alive."""
        cells = [
            code_cell("a", "config = {'lr': 0.1}"),
            code_cell(
                "b",
                "def train():\n    return config['lr']",
            ),
            code_cell("c", "train()"),
        ]
        self.assertNotIn("a", flagged_ids(cells))

    def test_dynamic_namespace_use_is_never_flagged(self):
        """exec/eval/globals defeat analysis, so we stay silent."""
        for snippet in (
            "hidden = 1\nexec('y = hidden')",
            "value = eval('1 + 1')",
            "state = globals()",
        ):
            with self.subTest(snippet=snippet):
                self.assertEqual(
                    flagged_ids([code_cell("dyn", snippet)]), set()
                )

    def test_star_import_is_never_flagged(self):
        """A wildcard import hides bindings, so the cell is skipped."""
        cells = [code_cell("star", "from numpy import *")]
        self.assertEqual(flagged_ids(cells), set())

    def test_syntax_error_or_magic_is_never_flagged(self):
        """Unparseable cells (magics, shell escapes) are skipped."""
        for snippet in (
            "%matplotlib inline",
            "!pip install numpy",
            "def broken(:",
        ):
            with self.subTest(snippet=snippet):
                self.assertEqual(
                    flagged_ids([code_cell("bad", snippet)]), set()
                )

    def test_markdown_cell_is_never_flagged(self):
        """Markdown cells are not code and are never flagged."""
        cells = [markdown_cell("md", "# A heading with words")]
        self.assertEqual(flagged_ids(cells), set())

    def test_comment_only_cell_is_not_flagged(self):
        """A cell binding nothing is not 'dead code'."""
        cells = [code_cell("c", "# just a note\n")]
        self.assertEqual(flagged_ids(cells), set())

    def test_inplace_mutation_cell_is_not_flagged(self):
        """A mutation with no new module binding is not flagged."""
        cells = [
            code_cell("a", "df = load()"),
            code_cell("b", "df.dropna(inplace=True)"),
            code_cell("c", "df"),
        ]
        self.assertEqual(flagged_ids(cells), set())

    def test_flag_payload_lists_unused_names_and_reason(self):
        """A flag reports the offending names and a human reason."""
        dead = find_dead_cells(
            notebook([code_cell("a", "alpha = 1\nbeta = 2")])
        )
        self.assertEqual(len(dead), 1)
        self.assertEqual(dead[0].cell_id, "a")
        self.assertEqual(dead[0].cell_index, 0)
        self.assertEqual(dead[0].unused_names, ["alpha", "beta"])
        self.assertIn("alpha", dead[0].reason)
        self.assertIn("beta", dead[0].reason)

    def test_source_as_list_of_lines_is_supported(self):
        """Nbformat source may be a list of lines, not a string."""
        cell = {
            "id": "a",
            "cell_type": "code",
            "source": ["x = 1\n", "y = 2\n"],
            "metadata": {},
            "outputs": [],
        }
        self.assertEqual(flagged_ids([cell]), {"a"})

    def test_empty_notebook_returns_no_flags(self):
        """An empty notebook yields an empty result."""
        self.assertEqual(find_dead_cells({"cells": []}), [])
        self.assertEqual(find_dead_cells({}), [])


if __name__ == "__main__":
    unittest.main()

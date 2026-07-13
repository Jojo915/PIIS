"""Unit tests for advisor-style stale (out-of-order) cell detection."""

from __future__ import annotations

import unittest

from backend.src.app.analysis.stale_cells import find_stale_cells


def code_cell(
    cell_id: str, source: str, execution_count: int | None = None
) -> dict:
    """Build a raw nbformat code cell dict with an execution_count."""
    return {
        "id": cell_id,
        "cell_type": "code",
        "source": source,
        "metadata": {},
        "outputs": [],
        "execution_count": execution_count,
    }


def markdown_cell(cell_id: str, source: str) -> dict:
    """Build a raw nbformat markdown cell dict for tests."""
    return {
        "id": cell_id,
        "cell_type": "markdown",
        "source": source,
        "metadata": {},
    }


def notebook(cells: list[dict]) -> dict:
    """Wrap cells in a minimal nbformat notebook dict."""
    return {"cells": cells}


def stale_ids(cells: list[dict]) -> set[str]:
    """Return the set of cell ids flagged as stale for a cell list."""
    return {cell.cell_id for cell in find_stale_cells(notebook(cells))}


class StaleCellDetectionTest(unittest.TestCase):
    """Behavioural tests for find_stale_cells."""

    def test_clean_sequential_run_has_no_stale(self):
        """Cells run top-to-bottom in order are all fresh."""
        cells = [
            code_cell("a", "x = 1", execution_count=1),
            code_cell("b", "y = x + 1", execution_count=2),
            code_cell("c", "z = y + 1", execution_count=3),
        ]
        self.assertEqual(stale_ids(cells), set())

    def test_upstream_rerun_later_makes_downstream_stale(self):
        """Re-running an early cell after a later one flags the later."""
        cells = [
            # 'a' ran most recently (4), after 'b' (2) that reads it.
            code_cell("a", "x = 1", execution_count=4),
            code_cell("b", "y = x + 1", execution_count=2),
        ]
        self.assertEqual(stale_ids(cells), {"b"})

    def test_staleness_propagates_downstream(self):
        """A stale cell taints every cell that depends on it."""
        cells = [
            code_cell("a", "x = 1", execution_count=4),
            code_cell("b", "y = x + 1", execution_count=2),
            code_cell("c", "z = y + 1", execution_count=3),
        ]
        # 'b' is directly stale (a ran later); 'c' reads y from b, so
        # c is stale too even though a never touches c directly.
        self.assertEqual(stale_ids(cells), {"b", "c"})

    def test_unexecuted_cell_is_not_flagged(self):
        """A never-run cell has no rendered output to be stale."""
        cells = [
            code_cell("a", "x = 1", execution_count=4),
            code_cell("b", "y = x + 1", execution_count=None),
        ]
        self.assertEqual(stale_ids(cells), set())

    def test_definer_never_executed_is_conservative(self):
        """A dependency that never ran does not, by itself, flag."""
        cells = [
            code_cell("a", "x = 1", execution_count=None),
            code_cell("b", "y = x + 1", execution_count=2),
        ]
        # 'a' has no execution_count, so we cannot say it ran later.
        self.assertEqual(stale_ids(cells), set())

    def test_nearest_preceding_definer_avoids_false_positive(self):
        """Only the nearest preceding definer of a name is the dependency."""
        cells = [
            # An older definition of x that ran later (5)...
            code_cell("a", "x = 1", execution_count=5),
            # ...is shadowed by a nearer redefinition that ran before b.
            code_cell("b", "x = 2", execution_count=2),
            code_cell("c", "y = x + 1", execution_count=3),
        ]
        # c depends on b (nearest preceding definer of x), not a.
        # b ran at 2, c at 3 -> b did not run later -> c is fresh.
        self.assertEqual(stale_ids(cells), set())

    def test_independent_cells_are_not_stale(self):
        """Cells with no shared names never taint each other."""
        cells = [
            code_cell("a", "x = 1", execution_count=3),
            code_cell("b", "y = 2", execution_count=1),
        ]
        self.assertEqual(stale_ids(cells), set())

    def test_used_before_defined_is_not_a_dependency(self):
        """A name defined only after a cell is not that cell's dependency."""
        cells = [
            code_cell("a", "y = x + 1", execution_count=1),
            code_cell("b", "x = 5", execution_count=3),
        ]
        # 'a' reads x, but x is only defined later in 'b'. There is no
        # preceding definer, so no edge and nothing is flagged.
        self.assertEqual(stale_ids(cells), set())

    def test_inplace_mutation_is_a_blind_spot(self):
        """A mutation binding no name creates no edge (accepted miss)."""
        cells = [
            code_cell("a", "df = load()", execution_count=1),
            code_cell("b", "df.dropna(inplace=True)", execution_count=4),
            code_cell("c", "summary = df.mean()", execution_count=2),
        ]
        # c depends on a (the definer of df), which ran at 1 < 2, so c
        # looks fresh even though b mutated df more recently. This is the
        # documented in-place mutation blind spot.
        self.assertEqual(stale_ids(cells), set())

    def test_import_rerun_later_taints_user(self):
        """A re-run import after its user flags the user."""
        cells = [
            code_cell("imp", "import numpy as np", execution_count=5),
            code_cell("use", "arr = np.zeros(3)", execution_count=2),
        ]
        self.assertEqual(stale_ids(cells), {"use"})

    def test_markdown_cells_are_ignored(self):
        """Markdown cells are never analyzed or flagged."""
        cells = [
            markdown_cell("md", "# Narrative between code"),
            code_cell("a", "x = 1", execution_count=4),
            code_cell("b", "y = x + 1", execution_count=2),
        ]
        self.assertEqual(stale_ids(cells), {"b"})

    def test_dynamic_or_magic_cells_are_skipped(self):
        """exec/eval and unparseable magics defeat analysis; stay silent."""
        cells = [
            code_cell("a", "x = 1", execution_count=4),
            code_cell("dyn", "exec('y = x')", execution_count=2),
            code_cell("magic", "%matplotlib inline", execution_count=1),
        ]
        # Neither the dynamic cell nor the magic cell is analyzable, so
        # they contribute no edges and are never flagged.
        self.assertEqual(stale_ids(cells), set())

    def test_flag_payload_reports_cause_and_reason(self):
        """A flag reports the culprit cell indices and a human reason."""
        stale = find_stale_cells(
            notebook(
                [
                    code_cell("a", "x = 1", execution_count=4),
                    code_cell("b", "y = x + 1", execution_count=2),
                ]
            )
        )
        self.assertEqual(len(stale), 1)
        self.assertEqual(stale[0].cell_id, "b")
        self.assertEqual(stale[0].cell_index, 1)
        self.assertEqual(stale[0].stale_due_to, [0])
        self.assertIn("out of date", stale[0].reason.lower())

    def test_source_as_list_of_lines_is_supported(self):
        """Nbformat source may be a list of lines, not a string."""
        cells = [
            {
                "id": "a",
                "cell_type": "code",
                "source": ["x = 1\n"],
                "metadata": {},
                "outputs": [],
                "execution_count": 4,
            },
            {
                "id": "b",
                "cell_type": "code",
                "source": ["y = x + 1\n"],
                "metadata": {},
                "outputs": [],
                "execution_count": 2,
            },
        ]
        self.assertEqual(stale_ids(cells), {"b"})

    def test_boolean_execution_count_is_treated_as_unrun(self):
        """A stray bool execution_count is not a valid run order."""
        cells = [
            code_cell("a", "x = 1", execution_count=4),
            {
                "id": "b",
                "cell_type": "code",
                "source": "y = x + 1",
                "metadata": {},
                "outputs": [],
                "execution_count": True,
            },
        ]
        # b's execution_count is a bool, treated as None -> not flagged.
        self.assertEqual(stale_ids(cells), set())

    def test_empty_notebook_returns_no_flags(self):
        """An empty or missing notebook yields an empty result."""
        self.assertEqual(find_stale_cells({"cells": []}), [])
        self.assertEqual(find_stale_cells({}), [])


if __name__ == "__main__":
    unittest.main()

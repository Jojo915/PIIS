"""Detect likely-dead code cells in a notebook.

This is an *advisor*, not a janitor: it only flags cells it is fairly
confident are leftover, and never modifies the notebook. It errs heavily
toward silence -- a false positive (nagging about a cell that matters)
costs the user's trust, while a miss costs nothing.

A code cell is flagged as a dead candidate only when *all* of these hold:

* it is parseable Python (cells with syntax errors, IPython magics, or
  shell escapes fail to parse and are skipped);
* it binds at least one module-level name (so we only ever flag cells
  that *define something*, never comment-only or pure-effect cells);
* none of those names are read by any *other* cell in the notebook
  (whole-notebook dataflow, so "defined here, used ten cells later" is
  correctly treated as alive);
* it produces no output and has no observable effect -- no rendered
  output, no bare display expression (``df.head()``), and no call to a
  known side-effecting / IO function (``print``, ``plt.show``,
  ``to_csv``...);
* it uses no dynamic namespace features (``exec``, ``eval``,
  ``globals``, ``import *``) that would make static analysis unsound.

The module-level def/use graph is built by the shared ``dataflow`` module,
which the stale-cell analysis reuses -- the two share one notion of
"which cell defines X, which cells read X" so they cannot drift apart.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass

from .dataflow import CellFacts, analyze_cell, callee_name, module_scope_nodes

# Called functions/methods whose whole point is a side effect or output.
# Matching is by the callee's final name (``plt.show`` -> ``show``), so a
# cell that calls any of these is treated as doing something observable
# and is never flagged. Being generous here is safe: it only ever
# *prevents* a flag, which keeps precision high.
_SIDE_EFFECT_NAMES = frozenset(
    {
        "print",
        "display",
        "pprint",
        "show",
        "plot",
        "hist",
        "scatter",
        "bar",
        "barh",
        "boxplot",
        "imshow",
        "heatmap",
        "savefig",
        "save",
        "write",
        "writelines",
        "dump",
        "to_csv",
        "to_parquet",
        "to_json",
        "to_excel",
        "to_pickle",
        "to_feather",
        "to_sql",
        "to_hdf",
        "open",
        "info",
        "debug",
        "warning",
        "warn",
        "error",
        "critical",
        "log",
    }
)


@dataclass
class DeadCell:
    """One code cell flagged as a likely-dead candidate."""

    cell_id: str
    cell_index: int
    unused_names: list[str]
    reason: str


def find_dead_cells(notebook: dict) -> list[DeadCell]:
    """Return likely-dead code cells in a notebook (nbformat dict).

    Only code cells are ever returned. The result is conservative: an
    empty list means nothing looked confidently dead, not that the
    notebook is necessarily clean.
    """
    cells = notebook.get("cells", []) or []
    facts = [analyze_cell(cell, index) for index, cell in enumerate(cells)]

    used_by = _build_use_index(facts)

    dead: list[DeadCell] = []
    for info in facts:
        if not info.analyzable or not info.bindings:
            continue
        if _has_output(cells[info.cell_index]) or _is_effectful(info.tree):
            continue
        if _is_used_elsewhere(info, used_by):
            continue
        dead.append(_to_dead_cell(info))

    return dead


def _build_use_index(facts: list[CellFacts]) -> dict[str, set[int]]:
    """Map each read name to the set of cell indices that read it."""
    used_by: dict[str, set[int]] = {}
    for info in facts:
        if not info.analyzable:
            continue
        for name in info.used_names:
            used_by.setdefault(name, set()).add(info.cell_index)
    return used_by


def _is_used_elsewhere(info: CellFacts, used_by: dict[str, set[int]]) -> bool:
    """Return whether any name bound here is read by a *different* cell."""
    for name in info.bindings:
        readers = used_by.get(name, set()) - {info.cell_index}
        if readers:
            return True
    return False


def _to_dead_cell(info: CellFacts) -> DeadCell:
    """Build the flag payload for a dead candidate cell."""
    names = sorted(info.bindings)
    quoted = ", ".join(f"`{name}`" for name in names)
    subject = "it" if len(names) == 1 else "them"
    reason = (
        f"Defines {quoted} but no other cell uses {subject}, "
        "and the cell produces no output."
    )
    return DeadCell(
        cell_id=info.cell_id,
        cell_index=info.cell_index,
        unused_names=names,
        reason=reason,
    )


def _has_output(cell: dict) -> bool:
    """Return whether a code cell rendered any output."""
    return bool(cell.get("outputs"))


def _is_effectful(tree: ast.AST | None) -> bool:
    """Return whether the cell does something observable.

    True if it contains a bare display expression at module scope (a lone
    ``df`` or ``df.head()`` that Jupyter would auto-render) or calls a
    known side-effecting / IO function.
    """
    if tree is None:
        return False
    for node in module_scope_nodes(tree):
        if isinstance(node, ast.Expr) and not isinstance(
            node.value, ast.Constant
        ):
            return True
        if (
            isinstance(node, ast.Call)
            and callee_name(node.func) in _SIDE_EFFECT_NAMES
        ):
            return True
    return False

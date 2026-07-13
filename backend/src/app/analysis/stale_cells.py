"""Detect stale code cells (out-of-order / hidden-state staleness).

A cell is *stale* when its shown output no longer reflects what a clean,
top-to-bottom rerun would produce, because a cell it depends on ran more
recently or is itself stale. This is the classic Jupyter hidden-state
hazard: you edit an early cell, re-run it, and every downstream cell's
output silently becomes a lie.

The signal is the divergence between two orderings that are supposed to
agree: the notebook order (top-to-bottom) and the kernel execution order
(each code cell's ``execution_count``). Dead-cell detection deliberately
*ignores* ``execution_count``; here it is the load-bearing signal.

Dependencies use the shared def/use graph (``dataflow``): cell B depends
on cell A when A binds a name B reads and A is the nearest cell *before B
in notebook order* that binds it -- the definition a clean rerun would
use. Keying on the nearest preceding definer (rather than any definer)
avoids a false positive where a later cell rebinds the same name.

Staleness rule, applied to fixpoint so it propagates downstream:

    An executed cell B is stale if some dependency A either ran strictly
    later than B (``execution_count(A) > execution_count(B)``) or is
    itself stale.

Advisor-only and conservative, matching dead-cell detection: only executed
cells are ever flagged; cells using magics or dynamic namespace features
are skipped; and in-place mutation is invisible to static analysis (a
``df.dropna(inplace=True)`` in another cell binds no name, so it creates
no dependency edge), meaning some real staleness is missed. Precision is
preferred over recall.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .dataflow import CellFacts, analyze_cell


@dataclass
class StaleCell:
    """One code cell whose shown output is likely out of date."""

    cell_id: str
    cell_index: int
    reason: str
    stale_due_to: list[int] = field(default_factory=list)


def find_stale_cells(notebook: dict) -> list[StaleCell]:
    """Return code cells whose output is likely stale (nbformat dict).

    The result is conservative: only executed, statically-analyzable cells
    are ever returned, and an empty list does not prove the notebook is
    fresh (in-place mutation is invisible to this analysis).
    """
    cells = notebook.get("cells", []) or []
    facts = [analyze_cell(cell, index) for index, cell in enumerate(cells)]
    exec_counts = [_exec_count(cell) for cell in cells]

    definers = _definers_by_name(facts)
    deps = _dependencies(facts, definers)
    stale_causes = _resolve_stale(exec_counts, deps)

    result: list[StaleCell] = []
    for index in sorted(stale_causes):
        causes = sorted(stale_causes[index])
        result.append(
            StaleCell(
                cell_id=facts[index].cell_id,
                cell_index=index,
                reason=_reason(causes),
                stale_due_to=causes,
            )
        )
    return result


def _exec_count(cell: dict) -> int | None:
    """Return a cell's kernel ``execution_count``, or None if never run."""
    value = cell.get("execution_count")
    # bool is an int subclass; guard against a stray True/False sneaking in.
    if isinstance(value, bool):
        return None
    return value if isinstance(value, int) else None


def _definers_by_name(facts: list[CellFacts]) -> dict[str, list[int]]:
    """Map each bound name to the cell indices that bind it (ascending)."""
    definers: dict[str, list[int]] = {}
    for info in facts:
        if not info.analyzable:
            continue
        for name in info.bindings:
            definers.setdefault(name, []).append(info.cell_index)
    return definers


def _nearest_preceding(indices: list[int], before: int) -> int | None:
    """Return the largest index in ``indices`` (ascending) that is < before."""
    best: int | None = None
    for index in indices:
        if index < before:
            best = index
        else:
            break
    return best


def _dependencies(
    facts: list[CellFacts], definers: dict[str, list[int]]
) -> dict[int, set[int]]:
    """Map each analyzable cell to the definer cells it reads from."""
    deps: dict[int, set[int]] = {}
    for info in facts:
        if not info.analyzable:
            continue
        edges: set[int] = set()
        for name in info.used_names:
            definer = _nearest_preceding(
                definers.get(name, []), info.cell_index
            )
            if definer is not None and definer != info.cell_index:
                edges.add(definer)
        deps[info.cell_index] = edges
    return deps


def _resolve_stale(
    exec_counts: list[int | None],
    deps: dict[int, set[int]],
) -> dict[int, set[int]]:
    """Compute stale cells and the dependencies that make them stale.

    Iterated to a fixpoint so staleness propagates downstream: a cell is
    stale if a dependency ran strictly later than it did, or if a
    dependency is itself stale. Only executed cells are considered -- an
    unexecuted cell has no rendered output to be stale.
    """
    stale: dict[int, set[int]] = {}

    changed = True
    while changed:
        changed = False
        for index, definer_indices in deps.items():
            this_count = exec_counts[index]
            if this_count is None:
                continue

            causes: set[int] = set()
            for definer in definer_indices:
                definer_count = exec_counts[definer]
                ran_later = (
                    definer_count is not None and definer_count > this_count
                )
                if ran_later or definer in stale:
                    causes.add(definer)

            if not causes:
                continue
            if not causes <= stale.get(index, set()):
                stale[index] = stale.get(index, set()) | causes
                changed = True

    return stale


def _reason(causes: list[int]) -> str:
    """Build a human-readable reason naming the culprit cells (1-based)."""
    positions = ", ".join(str(index + 1) for index in causes)
    if len(causes) == 1:
        return (
            f"Output may be out of date: depends on cell {positions}, "
            "which ran later or is itself stale. Re-run to refresh."
        )
    return (
        f"Output may be out of date: depends on cells {positions}, "
        "which ran later or are themselves stale. Re-run to refresh."
    )

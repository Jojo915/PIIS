"""Shared module-level def/use graph primitives over notebook cells.

Dead-cell and stale-cell detection both rest on the same question: which
names does a cell *define* at module scope, and which does it *read*? This
module owns that extraction so the two analyses cannot drift apart -- a
change to how bindings or uses are collected is felt by both at once.

The extraction is deliberately conservative. A cell is only marked
``analyzable`` when static name resolution is sound for it: non-code cells,
cells with syntax errors (IPython magics, shell escapes), cells touching
dynamic namespace features (``exec``/``eval``/``globals``...), and cells
with a wildcard ``import *`` are all left un-analyzable, and downstream
analyses refuse to judge them.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

# Names whose presence anywhere in a cell makes static name resolution
# unsound. If a cell touches these we simply refuse to judge it.
_DYNAMIC_NAMES = frozenset(
    {"exec", "eval", "globals", "locals", "vars", "__import__", "compile"}
)

# Nodes that introduce their own scope. We do not descend into these when
# collecting *module-level* bindings or effects, because names stored
# inside them are local, not notebook-visible.
_NESTED_SCOPES = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.Lambda,
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    ast.GeneratorExp,
)


@dataclass
class CellFacts:
    """Static facts extracted from a single notebook cell.

    ``analyzable`` is False for non-code cells, unparseable cells, and
    cells using dynamic namespace features -- callers must never flag
    those. ``tree`` is the parsed AST when available (analyzable and some
    non-analyzable cells), or None; it lets a caller run extra analyses
    (e.g. side-effect detection) without re-parsing.
    """

    cell_id: str
    cell_index: int
    cell_type: str
    bindings: set[str] = field(default_factory=set)
    used_names: set[str] = field(default_factory=set)
    analyzable: bool = False
    tree: ast.AST | None = None


def analyze_cell(cell: dict, index: int) -> CellFacts:
    """Extract static def/use facts from one raw nbformat cell dict."""
    cell_id = str(cell.get("id", f"cell_{index}"))
    cell_type = str(cell.get("cell_type", ""))
    facts = CellFacts(cell_id=cell_id, cell_index=index, cell_type=cell_type)

    if cell_type != "code":
        return facts

    source = source_to_str(cell.get("source", ""))

    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        # Magics, shell escapes, or genuinely broken code: don't judge.
        return facts

    facts.tree = tree
    facts.used_names = used_names(tree)

    if facts.used_names & _DYNAMIC_NAMES or has_star_import(tree):
        # Dynamic namespace manipulation defeats static resolution.
        return facts

    facts.bindings = module_bindings(tree)
    facts.analyzable = True
    return facts


def source_to_str(source: object) -> str:
    """Normalize nbformat source (str or list of lines) to a string."""
    if isinstance(source, list):
        return "".join(str(part) for part in source)
    return str(source)


def used_names(tree: ast.AST) -> set[str]:
    """Return every name *read* anywhere in the cell (all scopes).

    Reads inside function bodies count: a helper referencing a global
    ``df`` keeps ``df`` alive. Over-approximating reads is safe -- it can
    only make a cell look *more* connected, never less.
    """
    return {
        node.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
    }


def module_bindings(tree: ast.AST) -> set[str]:
    """Return names bound at module scope (visible to other cells).

    Names bound inside functions, classes, lambdas, and comprehensions
    are local and deliberately excluded. ``from __future__`` imports are
    ignored since they never represent real, usable bindings.
    """
    bindings: set[str] = set()
    for node in module_scope_nodes(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            bindings.add(node.id)
        elif isinstance(
            node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ) or (isinstance(node, ast.ExceptHandler) and node.name):
            bindings.add(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                bindings.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module == "__future__":
                continue
            for alias in node.names:
                if alias.name != "*":
                    bindings.add(alias.asname or alias.name)
    return bindings


def has_star_import(tree: ast.AST) -> bool:
    """Return whether the cell contains a ``from x import *``."""
    return any(
        isinstance(node, ast.ImportFrom)
        and any(alias.name == "*" for alias in node.names)
        for node in ast.walk(tree)
    )


def callee_name(func: ast.expr) -> str | None:
    """Return the final name of a call target (``a.b.show`` -> ``show``)."""
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def module_scope_nodes(node: ast.AST) -> Iterator[ast.AST]:
    """Yield descendants that execute in module scope.

    Traversal stops at any node that opens a new scope, so names and
    effects inside functions, classes, lambdas, and comprehensions are
    not treated as notebook-level.
    """
    for child in ast.iter_child_nodes(node):
        yield child
        if isinstance(child, _NESTED_SCOPES):
            continue
        yield from module_scope_nodes(child)

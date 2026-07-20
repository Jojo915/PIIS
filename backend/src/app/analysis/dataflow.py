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
    """Return every name *read* anywhere in the cell that is not resolved
    by a local binding enclosing that read (all scopes considered).

    Reads inside a function/lambda body or a comprehension that are
    shadowed by a parameter, a comprehension target, or a name assigned
    anywhere in that same local scope are *not* counted -- per Python's
    own static scoping rules, such a read refers to the local binding,
    never to some other cell's module-level name of the same spelling.
    Without this, a helper like ``def process(df): return df + 1`` would
    look like it *reads* a module-level ``df`` purely because a parameter
    happens to share that name, fabricating a dependency on whichever
    cell happens to define a module-level ``df`` -- see the stale-cell
    false positive this was written to fix.

    A genuine free variable -- e.g. a helper referencing a real
    module-level ``config`` it never assigns or takes as a parameter --
    still counts, no matter how deeply nested. Over-approximating *those*
    reads remains intentional and safe: it can only make a cell look more
    connected, never less.
    """
    free: set[str] = set()
    _collect_free_reads(tree, bound=frozenset(), free=free)
    return free


def _collect_free_reads(
    node: ast.AST, bound: frozenset[str], free: set[str]
) -> None:
    """Walk ``node``, adding unshadowed ``Load``-context names to ``free``.

    ``bound`` is the set of names resolved locally by scopes enclosing
    ``node``. Entering a function/lambda/comprehension extends ``bound``
    with that scope's own locals before recursing into it; every other
    node (including class bodies, which don't shadow name resolution the
    way function scopes do) is walked with the same ``bound`` unchanged.
    """
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.Name):
            if isinstance(child.ctx, ast.Load) and child.id not in bound:
                free.add(child.id)
            continue
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            _collect_free_reads(child, bound | _scope_locals(child), free)
            continue
        if isinstance(
            child, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
        ):
            _collect_free_reads(
                child, bound | _comprehension_targets(child), free
            )
            continue
        _collect_free_reads(child, bound, free)


def _scope_locals(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> frozenset[str]:
    """Names local to a function's/lambda's own body.

    This mirrors Python's real scoping rule: parameters, plus any name
    assigned/imported/defined directly in the body (not in a scope nested
    further inside it), minus any name explicitly reclaimed via
    ``global``/``nonlocal`` (which makes the read refer outward again,
    same as real Python).
    """
    if isinstance(node, ast.Lambda):
        return frozenset(_arg_names(node.args))

    locals_ = _arg_names(node.args) | _own_scope_bindings(node)
    declared_outer: set[str] = set()
    for descendant in ast.walk(node):
        if isinstance(descendant, (ast.Global, ast.Nonlocal)):
            declared_outer.update(descendant.names)
    return frozenset(locals_ - declared_outer)


def _comprehension_targets(
    node: ast.ListComp | ast.SetComp | ast.DictComp | ast.GeneratorExp,
) -> frozenset[str]:
    """Loop variables bound by a comprehension's ``for`` clauses."""
    names: set[str] = set()
    for generator in node.generators:
        for target_node in ast.walk(generator.target):
            if isinstance(target_node, ast.Name):
                names.add(target_node.id)
    return frozenset(names)


def _arg_names(args: ast.arguments) -> set[str]:
    """All parameter names a function/lambda's ``arguments`` node binds."""
    names = {a.arg for a in (*args.posonlyargs, *args.args, *args.kwonlyargs)}
    if args.vararg:
        names.add(args.vararg.arg)
    if args.kwarg:
        names.add(args.kwarg.arg)
    return names


def module_bindings(tree: ast.AST) -> set[str]:
    """Return names bound at module scope (visible to other cells).

    Names bound inside functions, classes, lambdas, and comprehensions
    are local and deliberately excluded. ``from __future__`` imports are
    ignored since they never represent real, usable bindings.
    """
    return _own_scope_bindings(tree)


def _own_scope_bindings(node: ast.AST) -> set[str]:
    """Names bound directly in ``node``'s own scope (not in any scope
    nested inside it). ``module_bindings`` uses this at the module root;
    ``_scope_locals`` reuses it to find a function body's own locals, so
    the two notions of "what does this scope bind" cannot drift apart.
    """
    bindings: set[str] = set()
    for child in module_scope_nodes(node):
        if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
            bindings.add(child.id)
        elif isinstance(
            child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ) or (isinstance(child, ast.ExceptHandler) and child.name):
            bindings.add(child.name)
        elif isinstance(child, ast.Import):
            for alias in child.names:
                bindings.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(child, ast.ImportFrom):
            if child.module == "__future__":
                continue
            for alias in child.names:
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

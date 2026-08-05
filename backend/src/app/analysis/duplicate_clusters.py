"""Complete-linkage clustering for whole-notebook duplicate detection.

Pure, dict-based clustering with no vector-store/embedding-model
dependency, following the same "pure function over already-extracted
facts" shape as ``dataflow.py`` -- the I/O layer (fetching embeddings and
computing pairwise distances) lives in
``app.vector_store.utils.find_duplicate_clusters``, which calls into this
module.

## Why complete linkage, not single linkage / graph connectivity

The original duplicate advisor treated "cell X's threshold-filtered
nearest neighbors" as an entire duplicate *group*, which is equivalent to
single-linkage clustering: if A is close to B, and B is close to C, then
A/B/C all end up in one group even when A and C are far apart. In
practice this let two unrelated near-duplicate clusters merge into one
oversized, wrong group whenever a "bridge" cell pair happened to fall
just inside the distance threshold -- e.g. two trivially short,
syntactically-similar-but-semantically-unrelated assignments like
``x = 20`` and ``y = 1`` can be closer in embedding space than either is
to its own true duplicates, without being an actual duplicate of
anything.

Complete linkage fixes this structurally: two clusters are only merged
when the *worst-case* (maximum) pairwise distance between their members
is at or below the threshold. Equivalently, every final cluster is a
"clique" in the threshold graph -- every member is within `threshold` of
every other member, not just transitively reachable via bridge edges.
This is what actually matches the product's intent ("these cells are all
near-duplicates of each other"), and is what the user's "cell A
duplicated 3x, unrelated cell B duplicated 2x, reported as one group of
5" bug report requires to be fixed correctly rather than patched around.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class PairDistance:
    """One measured distance between two cells, order-independent."""

    cell_a: str
    cell_b: str
    distance: float


def _pair_key(cell_a: str, cell_b: str) -> tuple[str, str]:
    """Order-independent lookup key for a pair of cell ids."""
    return (cell_a, cell_b) if cell_a <= cell_b else (cell_b, cell_a)


def _build_distance_lookup(
    pairs: list[PairDistance],
) -> dict[tuple[str, str], float]:
    lookup: dict[tuple[str, str], float] = {}
    for pair in pairs:
        key = _pair_key(pair.cell_a, pair.cell_b)
        # If the same pair was measured from both directions (e.g. the
        # caller queried neighbors for both cell_a and cell_b), keep the
        # smaller of the two -- they should be identical in practice
        # (same embeddings, same distance function), but taking the min
        # is a harmless, deterministic tie-break if they ever differ by
        # floating-point noise.
        if key not in lookup or pair.distance < lookup[key]:
            lookup[key] = pair.distance
    return lookup


def _cluster_distance(
    cluster_a: list[str],
    cluster_b: list[str],
    distance_lookup: dict[tuple[str, str], float],
) -> float:
    """Complete-linkage distance: the worst-case pairwise distance.

    A pair with no recorded distance is treated as infinitely far apart
    (i.e. definitely not a duplicate pair) rather than as unknown/zero --
    this is what forces two clusters connected only by a partial,
    non-clique set of edges to stay separate.
    """
    worst = 0.0
    for a in cluster_a:
        for b in cluster_b:
            distance = distance_lookup.get(_pair_key(a, b), math.inf)
            if distance > worst:
                worst = distance
    return worst


def cluster_by_complete_linkage(
    cell_ids: list[str],
    pair_distances: list[PairDistance],
    threshold: float,
) -> list[list[str]]:
    """Group `cell_ids` into duplicate clusters using complete linkage.

    Runs standard agglomerative clustering: repeatedly merge the two
    clusters with the smallest complete-linkage (max pairwise) distance,
    stopping as soon as the best remaining merge would exceed
    `threshold`. Because a merge is only ever allowed when *every* cross-
    cluster pair is within threshold, every returned cluster is a clique
    in the threshold graph -- there is no way for two independent
    clusters to end up merged just because a few bridge edges happened to
    fall under the threshold.

    Singleton cells (no duplicate found) are dropped from the result --
    only clusters of two or more members are duplicate groups. Each
    cluster's members are returned sorted for a deterministic result;
    the list of clusters is also sorted (by first member) for the same
    reason.

    `cell_ids` with no distance measurements at all, and pairs whose
    distance was never measured (e.g. because it fell outside a capped
    top-k neighbor query), are both treated as "not a duplicate pair" --
    this mirrors the existing per-cell endpoint's behavior of only ever
    reporting cells the query actually found.
    """
    distance_lookup = _build_distance_lookup(pair_distances)
    clusters: list[list[str]] = [[cell_id] for cell_id in cell_ids]

    while len(clusters) > 1:
        best_pair: tuple[int, int] | None = None
        best_distance = math.inf

        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                distance = _cluster_distance(
                    clusters[i], clusters[j], distance_lookup
                )
                if distance < best_distance:
                    best_distance = distance
                    best_pair = (i, j)

        if best_pair is None or best_distance > threshold:
            break

        i, j = best_pair
        merged = clusters[i] + clusters[j]
        clusters = [c for k, c in enumerate(clusters) if k not in (i, j)]
        clusters.append(merged)

    groups = [sorted(cluster) for cluster in clusters if len(cluster) > 1]
    return sorted(groups, key=lambda group: group[0])

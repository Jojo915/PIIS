"""Unit tests for complete-linkage duplicate-cluster detection.

These are pure unit tests over hand-built distance data -- no vector
store, no embedding model -- mirroring the style of test_dead_cells.py /
test_stale_cells.py for the other advisor analyses.

The "two independent clusters connected by a partial bridge" test case
below reproduces, with the exact distance data captured while diagnosing
the real bug, the scenario reported by the user: cell A duplicated 3x,
cell B (unrelated) duplicated 2x, previously reported as a single group
of 5 because a couple of weak, threshold-passing "bridge" edges (a1-b1,
a1-b2, a2-b2, a3-b2) connected the two clusters even though the two
clusters are not a clique together (a2-b1 was never within threshold).
"""

from __future__ import annotations

import unittest

from backend.src.app.analysis.duplicate_clusters import (
    PairDistance,
    cluster_by_complete_linkage,
)

THRESHOLD = 0.80


class CompleteLinkageClusteringTest(unittest.TestCase):
    """Unit tests for cluster_by_complete_linkage."""

    def test_no_pairs_yields_no_clusters(self):
        """Cells with no measured distances at all produce no groups."""
        clusters = cluster_by_complete_linkage(
            ["c1", "c2", "c3"], [], THRESHOLD
        )

        self.assertEqual(clusters, [])

    def test_single_close_pair_forms_one_cluster(self):
        """Two cells within threshold form exactly one two-member cluster."""
        clusters = cluster_by_complete_linkage(
            ["c1", "c2"],
            [PairDistance("c1", "c2", 0.20)],
            THRESHOLD,
        )

        self.assertEqual(clusters, [["c1", "c2"]])

    def test_pair_beyond_threshold_stays_unclustered(self):
        """A pair further apart than the threshold isn't a duplicate group."""
        clusters = cluster_by_complete_linkage(
            ["c1", "c2"],
            [PairDistance("c1", "c2", 0.95)],
            THRESHOLD,
        )

        self.assertEqual(clusters, [])

    def test_full_clique_of_three_forms_one_cluster(self):
        """Three mutually-close cells (a true clique) form one cluster."""
        clusters = cluster_by_complete_linkage(
            ["c1", "c2", "c3"],
            [
                PairDistance("c1", "c2", 0.20),
                PairDistance("c1", "c3", 0.30),
                PairDistance("c2", "c3", 0.25),
            ],
            THRESHOLD,
        )

        self.assertEqual(clusters, [["c1", "c2", "c3"]])

    def test_distance_exactly_at_threshold_is_included(self):
        """Matches the per-cell endpoint's existing `dist <= threshold`."""
        clusters = cluster_by_complete_linkage(
            ["c1", "c2"],
            [PairDistance("c1", "c2", THRESHOLD)],
            THRESHOLD,
        )

        self.assertEqual(clusters, [["c1", "c2"]])

    def test_two_independent_clusters_with_a_partial_bridge_stay_separate(
        self,
    ):
        """Regression test for the reported bug.

        Real distance data captured while diagnosing the bug: {a1, a2, a3}
        is a genuine clique (every pair within threshold), {b1, b2} is a
        separate genuine clique, and there are several bridge edges under
        threshold between the two clusters (a1-b1, a1-b2, a2-b2, a3-b2) --
        but a2-b1 is NOT within threshold, so the 5-cell set is connected
        (single-linkage would wrongly merge it) but is not a clique
        (complete linkage correctly keeps the two clusters apart).
        """
        pair_distances = [
            PairDistance("a1", "a2", 0.4117),
            PairDistance("a1", "a3", 0.5172),
            PairDistance("a2", "a3", 0.4610),
            PairDistance("b1", "b2", 0.3761),
            PairDistance("a1", "b1", 0.4602),
            PairDistance("a1", "b2", 0.6317),
            PairDistance("a2", "b2", 0.5860),
            PairDistance("a3", "b1", 0.7933),
            PairDistance("a3", "b2", 0.5953),
            # a2-b1 deliberately omitted: it was never within threshold,
            # which is exactly what should prevent the two clusters from
            # being merged into one.
        ]

        clusters = cluster_by_complete_linkage(
            ["a1", "a2", "a3", "b1", "b2"], pair_distances, THRESHOLD
        )

        self.assertEqual(clusters, [["a1", "a2", "a3"], ["b1", "b2"]])

    def test_singletons_are_excluded_from_the_result(self):
        """A cell with no duplicate never appears in the returned groups."""
        clusters = cluster_by_complete_linkage(
            ["c1", "c2", "c3"],
            [PairDistance("c1", "c2", 0.20)],
            THRESHOLD,
        )

        self.assertEqual(clusters, [["c1", "c2"]])
        self.assertNotIn(["c3"], clusters)

    def test_result_ordering_is_deterministic(self):
        """Clusters and their members are returned in sorted order."""
        clusters = cluster_by_complete_linkage(
            ["z2", "z1", "a2", "a1"],
            [
                PairDistance("z2", "z1", 0.10),
                PairDistance("a2", "a1", 0.10),
            ],
            THRESHOLD,
        )

        self.assertEqual(clusters, [["a1", "a2"], ["z1", "z2"]])


if __name__ == "__main__":
    unittest.main()

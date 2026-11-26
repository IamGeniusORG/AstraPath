"""Unit tests verifying A* optimality, admissibility, heuristics, and edge cases."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from core.graph import CityGraph
from core.heuristics import haversine_km, heuristic_distance_km, heuristic_time_min
from core.pathfinder import astar_search, compare_algorithms, dijkstra_search

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "city_map.json"


@pytest.fixture
def city_graph() -> CityGraph:
    """Load a fresh copy of the Kolkata Metro graph for each test."""
    return CityGraph.from_json_file(DATA_PATH)


def test_dataset_invariants_and_connectivity(city_graph: CityGraph) -> None:
    """Verify node/edge counts, full connectivity, and A* admissibility invariants."""
    assert 18 <= len(city_graph.nodes) <= 25
    assert len(city_graph.raw_edges) >= 30
    assert city_graph.is_connected() is True
    assert city_graph.validate_admissibility() == []


def test_heuristics_are_admissible_and_non_negative(city_graph: CityGraph) -> None:
    """Ensure distance and time heuristics satisfy h(goal)=0 and h(n) >= 0."""
    n1 = city_graph.nodes["N1"]
    n19 = city_graph.nodes["N19"]

    assert heuristic_distance_km(n1, n1) == 0.0
    assert heuristic_time_min(n1, n1, city_graph.max_speed_kmph) == 0.0

    d = heuristic_distance_km(n1, n19)
    t = heuristic_time_min(n1, n19, city_graph.max_speed_kmph)
    assert d > 0.0
    assert pytest.approx((d / city_graph.max_speed_kmph) * 60.0) == t
    assert pytest.approx(haversine_km(n1.lat, n1.lng, n19.lat, n19.lng)) == d


@pytest.mark.parametrize("mode", ["fastest", "shortest"])
def test_astar_matches_dijkstra_cost_on_all_pairs(
    city_graph: CityGraph, mode: str
) -> None:
    """A* must match Dijkstra's exact optimal cost and never expand more nodes."""
    node_ids = list(city_graph.nodes.keys())
    sampled_pairs = [
        (node_ids[i], node_ids[(i * 7 + 3) % len(node_ids)])
        for i in range(len(node_ids))
    ]
    # Add long cross-city corridors explicitly
    sampled_pairs.extend(
        [
            ("N1", "N19"),
            ("N1", "N14"),
            ("N5", "N20"),
            ("N15", "N19"),
            ("N2", "N16"),
        ]
    )

    fewer_count = 0
    for start_id, goal_id in sampled_pairs:
        a_res = astar_search(city_graph, start_id, goal_id, mode=mode)
        d_res = dijkstra_search(city_graph, start_id, goal_id, mode=mode)

        assert a_res.found is True
        assert d_res.found is True
        assert a_res.total_cost is not None
        assert d_res.total_cost is not None
        assert a_res.total_cost == pytest.approx(d_res.total_cost, rel=1e-7, abs=1e-7)
        assert a_res.nodes_expanded <= d_res.nodes_expanded
        if a_res.nodes_expanded < d_res.nodes_expanded:
            fewer_count += 1

    assert fewer_count > 0


def test_fastest_vs_shortest_diverges_under_congestion(city_graph: CityGraph) -> None:
    """Heavy congestion on central roads should reroute fastest mode onto bypass."""
    overrides = {
        "N3<->N7": {"traffic_weight": 5.0},
        "N7<->N9": {"traffic_weight": 5.0},
        "N9<->N11": {"traffic_weight": 5.0},
        "N11<->N12": {"traffic_weight": 5.0},
    }
    shortest = astar_search(
        city_graph, "N3", "N12", mode="shortest", traffic_overrides=overrides
    )
    fastest = astar_search(
        city_graph, "N3", "N12", mode="fastest", traffic_overrides=overrides
    )

    assert shortest.found and fastest.found
    assert shortest.path != fastest.path
    assert shortest.total_distance_km <= fastest.total_distance_km
    assert fastest.estimated_time_min < shortest.estimated_time_min


def test_same_start_and_destination(city_graph: CityGraph) -> None:
    """Identical start and destination returns trivial zero-cost route."""
    res = astar_search(city_graph, "N1", "N1", mode="fastest")
    assert res.found is True
    assert res.path == ["N1"]
    assert res.segments == []
    assert res.total_distance_km == 0.0
    assert res.estimated_time_min == 0.0
    assert res.total_cost == 0.0


def test_blocked_road_reroutes_and_full_block_returns_unreachable(
    city_graph: CityGraph,
) -> None:
    """Blocking one road reroutes; blocking all roads to N19 returns found=False."""
    # Block N18<->N19 only: N16->N19 still allows reaching N19.
    partial_block = {"N18<->N19": {"blocked": True}}
    rerouted = astar_search(
        city_graph, "N1", "N19", mode="fastest", traffic_overrides=partial_block
    )
    assert rerouted.found is True
    assert rerouted.path[-1] == "N19"
    assert "N18" not in rerouted.path or rerouted.path[-2] != "N18"

    # Block all edges incident to N19.
    full_block = {
        "N18<->N19": {"blocked": True},
        "N16<->N19": {"blocked": True},
    }
    unreachable = astar_search(
        city_graph, "N1", "N19", mode="fastest", traffic_overrides=full_block
    )
    assert unreachable.found is False
    assert unreachable.path == []
    assert unreachable.total_cost is None
    assert unreachable.error is not None


def test_invalid_inputs_raise_value_error(city_graph: CityGraph) -> None:
    """Invalid nodes, modes, or traffic weights below 1.0 must raise ValueError."""
    with pytest.raises(ValueError):
        astar_search(city_graph, "INVALID", "N2")

    with pytest.raises(ValueError):
        astar_search(city_graph, "N1", "INVALID")

    with pytest.raises(ValueError):
        astar_search(city_graph, "N1", "N2", mode="cheapest")

    with pytest.raises(ValueError):
        astar_search(
            city_graph, "N1", "N2", traffic_overrides={"N1->N2": {"traffic_weight": 0.5}}
        )


def test_traffic_presets_and_compare_payload(city_graph: CityGraph) -> None:
    """Traffic presets mutate weights safely and compare_algorithms returns telemetry."""
    graph_copy = copy.deepcopy(city_graph)
    graph_copy.apply_preset("rush_hour", seed=42)
    assert graph_copy.validate_admissibility() == []

    summary = compare_algorithms(graph_copy, "N1", "N19", mode="fastest")
    assert summary["found"] is True
    assert summary["dijkstra"]["found"] is True
    assert summary["nodes_expanded"] <= summary["dijkstra"]["nodes_expanded"]
    assert summary["dijkstra"]["node_reduction_pct"] >= 0.0

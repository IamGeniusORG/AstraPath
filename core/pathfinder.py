"""From-scratch A* and Dijkstra pathfinding algorithms using Python heapq."""

from __future__ import annotations

import heapq
import itertools
import time
from dataclasses import dataclass, field
from typing import Any

from core.graph import VALID_MODES, CityGraph, RoadEdge
from core.heuristics import heuristic_distance_km, heuristic_time_min


@dataclass
class RouteSegment:
    """Represents one road traversal step along a computed route."""

    from_id: str
    from_name: str
    to_id: str
    to_name: str
    road_name: str
    distance_km: float
    speed_limit_kmph: float
    traffic_weight: float
    travel_time_min: float
    edge_id: str = ""
    geometry: list[list[float]] = field(default_factory=list)
    segment_type: str = "road"

    def to_dict(self) -> dict[str, Any]:
        """Serialize route segment to a JSON-compatible dictionary."""
        return {
            "id": self.edge_id or f"{self.from_id}->{self.to_id}",
            "from": self.from_id,
            "from_name": self.from_name,
            "to": self.to_id,
            "to_name": self.to_name,
            "road_name": self.road_name,
            "distance_km": round(self.distance_km, 3),
            "speed_limit_kmph": self.speed_limit_kmph,
            "traffic_weight": round(self.traffic_weight, 2),
            "traffic_factor": round(self.traffic_weight, 2),
            "travel_time_min": round(self.travel_time_min, 2),
            "geometry": self.geometry,
            "segment_type": self.segment_type,
        }


@dataclass
class SearchResult:
    """Telemetry and path output produced by a graph search algorithm."""

    algorithm: str
    mode: str
    found: bool
    path: list[str]
    path_names: list[str]
    segments: list[RouteSegment]
    total_distance_km: float
    estimated_time_min: float
    total_cost: float | None
    nodes_expanded: int
    explored_order: list[str]
    runtime_ms: float
    error: str | None = None
    coordinates: list[list[float]] = field(default_factory=list)
    explored_coords: list[list[float]] = field(default_factory=list)
    node_scores: dict[str, dict[str, float]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Serialize search result to a JSON-compatible dictionary."""
        return {
            "algorithm": self.algorithm,
            "mode": self.mode,
            "found": self.found,
            "path": self.path,
            "path_names": self.path_names,
            "coordinates": self.coordinates,
            "segments": [seg.to_dict() for seg in self.segments],
            "total_distance_km": round(self.total_distance_km, 3),
            "estimated_time_min": round(self.estimated_time_min, 2),
            "total_cost": round(self.total_cost, 4) if self.total_cost is not None else None,
            "nodes_expanded": self.nodes_expanded,
            "explored_order": self.explored_order,
            "explored_coords": self.explored_coords,
            "node_scores": self.node_scores,
            "runtime_ms": round(self.runtime_ms, 3),
            "error": self.error,
        }


def _compute_heuristic(
    graph: CityGraph,
    node_id: str,
    goal_id: str,
    mode: str,
    max_speed_kmph: float | None = None,
) -> float:
    """Compute admissible heuristic h(n) from node_id to goal_id."""
    current_node = graph.nodes[node_id]
    goal_node = graph.nodes[goal_id]
    if mode == "shortest":
        return heuristic_distance_km(current_node, goal_node)
    return heuristic_time_min(
        current_node,
        goal_node,
        max_speed_kmph if max_speed_kmph is not None else graph.max_speed_kmph,
    )


def _reconstruct_route(
    graph: CityGraph,
    start_id: str,
    goal_id: str,
    came_from: dict[str, tuple[str, RoadEdge]],
    effective_edges: dict[str, tuple[float, bool]],
    vehicle: str = "car",
) -> tuple[list[str], list[str], list[RouteSegment], float, float, list[list[float]]]:
    """Reconstruct node sequence, segments, distance, and ETA from parent pointers."""
    reversed_edges: list[RoadEdge] = []
    node_ids: list[str] = [goal_id]

    cursor = goal_id
    while cursor != start_id:
        prev_id, edge = came_from[cursor]
        reversed_edges.append(edge)
        node_ids.append(prev_id)
        cursor = prev_id

    node_ids.reverse()
    ordered_edges = list(reversed(reversed_edges))

    segments: list[RouteSegment] = []
    total_distance_km = 0.0
    estimated_time_min = 0.0
    coordinates: list[list[float]] = []

    for edge in ordered_edges:
        eff_weight, _ = effective_edges[edge.directed_uid]
        seg_time = graph.edge_cost(
            edge,
            mode="fastest",
            traffic_weight=eff_weight,
            vehicle=vehicle,
        )
        total_distance_km += edge.distance_km
        estimated_time_min += seg_time
        u_node = graph.nodes[edge.source]
        v_node = graph.nodes[edge.target]
        seg_geom = (
            edge.geometry
            if edge.geometry and len(edge.geometry) >= 2
            else [[u_node.lat, u_node.lng], [v_node.lat, v_node.lng]]
        )
        if not coordinates:
            coordinates.extend(seg_geom)
        else:
            coordinates.extend(seg_geom[1:])

        segments.append(
            RouteSegment(
                from_id=edge.source,
                from_name=u_node.name,
                to_id=edge.target,
                to_name=v_node.name,
                road_name=edge.road_name,
                distance_km=edge.distance_km,
                speed_limit_kmph=edge.speed_limit_kmph,
                traffic_weight=eff_weight,
                travel_time_min=seg_time,
                edge_id=edge.id,
                geometry=seg_geom,
                segment_type=edge.segment_type,
            )
        )

    path_names = [graph.nodes[nid].name for nid in node_ids]
    if not coordinates and node_ids:
        coordinates = [[graph.nodes[nid].lat, graph.nodes[nid].lng] for nid in node_ids]
    return (
        node_ids,
        path_names,
        segments,
        total_distance_km,
        estimated_time_min,
        coordinates,
    )


def _run_best_first_search(
    graph: CityGraph,
    start_id: str,
    goal_id: str,
    mode: str,
    use_heuristic: bool,
    traffic_overrides: dict[str, Any] | None = None,
    traffic_preset: str | None = None,
    vehicle: str = "car",
) -> SearchResult:
    """Execute priority-queue graph search (A* when use_heuristic=True, else Dijkstra).

    Uses evaluation function:
        f(n) = g(n) + h(n)
    where:
        - g(n): exact accumulated cost from start_id to n (km or minutes).
        - h(n): admissible lower-bound estimate from n to goal_id (0.0 for Dijkstra).
    """
    if start_id not in graph.nodes:
        raise ValueError(f"Invalid start node ID: '{start_id}'.")
    if goal_id not in graph.nodes:
        raise ValueError(f"Invalid destination node ID: '{goal_id}'.")
    if mode not in VALID_MODES:
        raise ValueError(f"Invalid mode '{mode}'. Expected one of {VALID_MODES}.")

    from core.modes import max_effective_speed_for_graph

    v_max_mode = max_effective_speed_for_graph(graph, vehicle)
    algorithm_name = "A*" if use_heuristic else "Dijkstra"
    effective_edges = graph.resolve_overrides(
        traffic_overrides=traffic_overrides,
        traffic_preset=traffic_preset,
    )

    t_start = time.perf_counter()

    if start_id == goal_id:
        elapsed_ms = (time.perf_counter() - t_start) * 1000.0
        node = graph.nodes[start_id]
        return SearchResult(
            algorithm=algorithm_name,
            mode=mode,
            found=True,
            path=[start_id],
            path_names=[node.name],
            segments=[],
            total_distance_km=0.0,
            estimated_time_min=0.0,
            total_cost=0.0,
            nodes_expanded=0,
            explored_order=[start_id],
            runtime_ms=elapsed_ms,
            coordinates=[[node.lat, node.lng]],
            explored_coords=[[node.lat, node.lng]],
            node_scores={start_id: {"g": 0.0, "h": 0.0, "f": 0.0}},
        )

    tie_counter = itertools.count()
    initial_h = (
        _compute_heuristic(graph, start_id, goal_id, mode, v_max_mode)
        if use_heuristic
        else 0.0
    )
    open_heap: list[tuple[float, int, float, str]] = [
        (initial_h, next(tie_counter), 0.0, start_id)
    ]

    g_scores: dict[str, float] = {start_id: 0.0}
    h_scores: dict[str, float] = {start_id: initial_h}
    came_from: dict[str, tuple[str, RoadEdge]] = {}
    closed_set: set[str] = set()
    explored_order: list[str] = []
    node_scores: dict[str, dict[str, float]] = {}
    nodes_expanded = 0

    while open_heap:
        current_f, _, current_g, current_id = heapq.heappop(open_heap)

        if current_id in closed_set:
            continue

        closed_set.add(current_id)
        explored_order.append(current_id)
        node_scores[current_id] = {
            "g": round(current_g, 3),
            "h": round(h_scores.get(current_id, 0.0), 3),
            "f": round(current_f, 3),
        }
        nodes_expanded += 1

        if current_id == goal_id:
            elapsed_ms = (time.perf_counter() - t_start) * 1000.0
            (
                path,
                path_names,
                segments,
                total_distance_km,
                estimated_time_min,
                coordinates,
            ) = _reconstruct_route(
                graph=graph,
                start_id=start_id,
                goal_id=goal_id,
                came_from=came_from,
                effective_edges=effective_edges,
                vehicle=vehicle,
            )
            return SearchResult(
                algorithm=algorithm_name,
                mode=mode,
                found=True,
                path=path,
                path_names=path_names,
                segments=segments,
                total_distance_km=total_distance_km,
                estimated_time_min=estimated_time_min,
                total_cost=current_g,
                nodes_expanded=nodes_expanded,
                explored_order=explored_order,
                explored_coords=[
                    [graph.nodes[nid].lat, graph.nodes[nid].lng]
                    for nid in explored_order
                ],
                runtime_ms=elapsed_ms,
                coordinates=coordinates,
                node_scores=node_scores,
            )

        for edge in graph.get_neighbors(current_id):
            eff_weight, is_blocked = effective_edges[edge.directed_uid]
            if is_blocked or edge.target in closed_set:
                continue

            step_cost = graph.edge_cost(
                edge, mode=mode, traffic_weight=eff_weight, vehicle=vehicle
            )
            tentative_g = current_g + step_cost

            if tentative_g < g_scores.get(edge.target, float("inf")):
                g_scores[edge.target] = tentative_g
                came_from[edge.target] = (current_id, edge)
                h_val = (
                    _compute_heuristic(graph, edge.target, goal_id, mode, v_max_mode)
                    if use_heuristic
                    else 0.0
                )
                h_scores[edge.target] = h_val
                f_val = tentative_g + h_val
                heapq.heappush(
                    open_heap,
                    (f_val, next(tie_counter), tentative_g, edge.target),
                )

    elapsed_ms = (time.perf_counter() - t_start) * 1000.0
    return SearchResult(
        algorithm=algorithm_name,
        mode=mode,
        found=False,
        path=[],
        path_names=[],
        segments=[],
        total_distance_km=0.0,
        estimated_time_min=0.0,
        total_cost=None,
        nodes_expanded=nodes_expanded,
        explored_order=explored_order,
        explored_coords=[
            [graph.nodes[nid].lat, graph.nodes[nid].lng]
            for nid in explored_order
        ],
        runtime_ms=elapsed_ms,
        error="No available route: destination is unreachable under current roadblocks.",
        node_scores=node_scores,
    )


def astar_search(
    graph: CityGraph,
    start_id: str,
    goal_id: str,
    mode: str = "fastest",
    traffic_overrides: dict[str, Any] | None = None,
    traffic_preset: str | None = None,
    vehicle: str = "car",
) -> SearchResult:
    """Find the optimal route from start_id to goal_id using the A* algorithm."""
    return _run_best_first_search(
        graph=graph,
        start_id=start_id,
        goal_id=goal_id,
        mode=mode,
        use_heuristic=True,
        traffic_overrides=traffic_overrides,
        traffic_preset=traffic_preset,
        vehicle=vehicle,
    )


def dijkstra_search(
    graph: CityGraph,
    start_id: str,
    goal_id: str,
    mode: str = "fastest",
    traffic_overrides: dict[str, Any] | None = None,
    traffic_preset: str | None = None,
    vehicle: str = "car",
) -> SearchResult:
    """Find the optimal route from start_id to goal_id using Dijkstra's algorithm."""
    return _run_best_first_search(
        graph=graph,
        start_id=start_id,
        goal_id=goal_id,
        mode=mode,
        use_heuristic=False,
        traffic_overrides=traffic_overrides,
        traffic_preset=traffic_preset,
        vehicle=vehicle,
    )


def compare_algorithms(
    graph: CityGraph,
    start_id: str,
    goal_id: str,
    mode: str = "fastest",
    traffic_overrides: dict[str, Any] | None = None,
    traffic_preset: str | None = None,
    vehicle: str = "car",
) -> dict[str, Any]:
    """Run both A* and Dijkstra on the same query and return combined telemetry."""
    astar_res = astar_search(
        graph=graph,
        start_id=start_id,
        goal_id=goal_id,
        mode=mode,
        traffic_overrides=traffic_overrides,
        traffic_preset=traffic_preset,
        vehicle=vehicle,
    )
    dijkstra_res = dijkstra_search(
        graph=graph,
        start_id=start_id,
        goal_id=goal_id,
        mode=mode,
        traffic_overrides=traffic_overrides,
        traffic_preset=traffic_preset,
        vehicle=vehicle,
    )

    if dijkstra_res.nodes_expanded > 0:
        reduction_pct = (
            (dijkstra_res.nodes_expanded - astar_res.nodes_expanded)
            / dijkstra_res.nodes_expanded
        ) * 100.0
    else:
        reduction_pct = 0.0

    payload = astar_res.to_dict()
    payload["dijkstra"] = {
        "found": dijkstra_res.found,
        "total_cost": round(dijkstra_res.total_cost, 4)
        if dijkstra_res.total_cost is not None
        else None,
        "total_distance_km": round(dijkstra_res.total_distance_km, 3),
        "estimated_time_min": round(dijkstra_res.estimated_time_min, 2),
        "nodes_expanded": dijkstra_res.nodes_expanded,
        "explored_order": dijkstra_res.explored_order,
        "runtime_ms": round(dijkstra_res.runtime_ms, 3),
        "node_reduction_pct": round(reduction_pct, 1),
    }
    return payload

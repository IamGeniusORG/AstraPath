"""Multi-modal travel profiles, rail/air transit graphs, and geodesic arc helpers."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core.graph import MIN_TRAFFIC_WEIGHT, CityGraph, CityNode, RoadEdge
from core.heuristics import haversine_km

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
RAIL_DATA_PATH = DATA_DIR / "rail_network.json"
AIRPORTS_DATA_PATH = DATA_DIR / "airports.json"

VALID_VEHICLES: tuple[str, ...] = ("car", "bike", "cycle", "walk", "train", "flight")
ROAD_VEHICLES: tuple[str, ...] = ("car", "bike", "cycle", "walk")

EXPRESSWAY_CLASSES: frozenset[str] = frozenset(
    {"motorway", "motorway_link", "trunk", "trunk_link"}
)

MINUTES_PER_HOUR: float = 60.0
RAIL_ACCESS_SPEED_KMPH: float = 28.0
RAIL_BOARDING_OVERHEAD_MIN: float = 8.0
RAIL_STOP_DWELL_MIN: float = 2.0
RAIL_MIN_DISTANCE_KM: float = 2.0

AIR_ACCESS_SPEED_KMPH: float = 28.0
AIR_CHECKIN_OVERHEAD_MIN: float = 75.0
FLIGHT_MIN_DISTANCE_KM: float = 150.0


@dataclass(frozen=True)
class VehicleProfile:
    """Routing and physics parameters for a road travel mode."""

    name: str
    speed_cap_kmph: float | None
    fixed_speed_kmph: float | None
    traffic_sensitivity: float
    expressway_penalty: float


VEHICLE_PROFILES: dict[str, VehicleProfile] = {
    "car": VehicleProfile(
        name="car",
        speed_cap_kmph=None,
        fixed_speed_kmph=None,
        traffic_sensitivity=1.0,
        expressway_penalty=1.0,
    ),
    "bike": VehicleProfile(
        name="bike",
        speed_cap_kmph=60.0,
        fixed_speed_kmph=None,
        traffic_sensitivity=0.55,
        expressway_penalty=1.0,
    ),
    "cycle": VehicleProfile(
        name="cycle",
        speed_cap_kmph=16.0,
        fixed_speed_kmph=16.0,
        traffic_sensitivity=0.15,
        expressway_penalty=2.5,
    ),
    "walk": VehicleProfile(
        name="walk",
        speed_cap_kmph=5.0,
        fixed_speed_kmph=5.0,
        traffic_sensitivity=0.0,
        expressway_penalty=4.0,
    ),
}


def compute_vehicle_edge_cost(
    edge: RoadEdge,
    mode: str,
    vehicle: str = "car",
    traffic_weight: float | None = None,
) -> float:
    """Compute traversal cost (km or minutes) for an edge under a vehicle profile.

    Preserves strict admissibility when paired with max_effective_speed_for_graph().
    """
    if vehicle in ("train", "flight"):
        if mode == "shortest":
            return edge.distance_km
        base_min = (edge.distance_km / edge.speed_limit_kmph) * MINUTES_PER_HOUR
        if edge.segment_type == "rail":
            return base_min + RAIL_STOP_DWELL_MIN
        return base_min

    profile = VEHICLE_PROFILES.get(vehicle)
    if profile is None:
        raise ValueError(f"Invalid vehicle '{vehicle}'. Expected one of {VALID_VEHICLES}.")

    is_expressway = edge.highway_type in EXPRESSWAY_CLASSES or (
        not edge.highway_type and edge.speed_limit_kmph >= 60.0
    )
    penalty = profile.expressway_penalty if is_expressway else 1.0

    if mode == "shortest":
        return edge.distance_km * penalty

    raw_weight = edge.traffic_weight if traffic_weight is None else traffic_weight
    if raw_weight < MIN_TRAFFIC_WEIGHT:
        raise ValueError(f"traffic_weight must be >= {MIN_TRAFFIC_WEIGHT}, got {raw_weight}.")

    effective_traffic = 1.0 + (raw_weight - 1.0) * profile.traffic_sensitivity
    base_speed = (
        profile.fixed_speed_kmph
        if profile.fixed_speed_kmph is not None
        else edge.speed_limit_kmph
    )
    if profile.speed_cap_kmph is not None:
        base_speed = min(base_speed, profile.speed_cap_kmph)

    effective_speed = max(1.0, base_speed / effective_traffic)
    return (edge.distance_km / effective_speed) * MINUTES_PER_HOUR * penalty


def max_effective_speed_for_graph(graph: CityGraph, vehicle: str = "car") -> float:
    """Return strict upper-bound speed (km/h) for admissible time heuristic h(n)."""
    if vehicle == "train":
        return max(90.0, graph.max_speed_kmph)
    if vehicle == "flight":
        return max(780.0, graph.max_speed_kmph)

    profile = VEHICLE_PROFILES.get(vehicle, VEHICLE_PROFILES["car"])
    if profile.fixed_speed_kmph is not None:
        return profile.fixed_speed_kmph
    if profile.speed_cap_kmph is not None:
        return min(graph.max_speed_kmph, profile.speed_cap_kmph)
    return graph.max_speed_kmph


def geodesic_arc_points(
    lat1: float,
    lng1: float,
    lat2: float,
    lng2: float,
    num_points: int = 40,
) -> list[list[float]]:
    """Generate smooth great-circle intermediate points between two GPS coordinates."""
    phi1, lam1 = math.radians(lat1), math.radians(lng1)
    phi2, lam2 = math.radians(lat2), math.radians(lng2)

    x1, y1, z1 = math.cos(phi1) * math.cos(lam1), math.cos(phi1) * math.sin(lam1), math.sin(phi1)
    x2, y2, z2 = math.cos(phi2) * math.cos(lam2), math.cos(phi2) * math.sin(lam2), math.sin(phi2)

    dot = max(-1.0, min(1.0, x1 * x2 + y1 * y2 + z1 * z2))
    omega = math.acos(dot)
    if omega < 1e-6:
        return [[lat1, lng1], [lat2, lng2]]

    sin_omega = math.sin(omega)
    points: list[list[float]] = []
    for step in range(num_points):
        t = step / (num_points - 1)
        a = math.sin((1.0 - t) * omega) / sin_omega
        b = math.sin(t * omega) / sin_omega
        x = a * x1 + b * x2
        y = a * y1 + b * y2
        z = a * z1 + b * z2
        lat = math.degrees(math.atan2(z, math.hypot(x, y)))
        lng = math.degrees(math.atan2(y, x))
        points.append([round(lat, 5), round(lng, 5)])
    return points


def _load_rail_payload() -> dict[str, Any]:
    with RAIL_DATA_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _load_air_payload() -> dict[str, Any]:
    with AIRPORTS_DATA_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def build_rail_multimodal_graph(
    start_lat: float,
    start_lng: float,
    start_name: str,
    goal_lat: float,
    goal_lng: float,
    goal_name: str,
) -> tuple[CityGraph | None, str | None]:
    """Build combined access + rail CityGraph, or return (None, reason) if too close."""
    straight_km = haversine_km(start_lat, start_lng, goal_lat, goal_lng)
    payload = _load_rail_payload()
    stations = payload["stations"]

    nearest_start = sorted(
        stations,
        key=lambda s: haversine_km(start_lat, start_lng, s["lat"], s["lng"]),
    )[:2]
    nearest_goal = sorted(
        stations,
        key=lambda s: haversine_km(goal_lat, goal_lng, s["lat"], s["lng"]),
    )[:2]

    if straight_km < RAIL_MIN_DISTANCE_KM or nearest_start[0]["id"] == nearest_goal[0]["id"]:
        return None, "Too close for rail transit"

    nodes: dict[str, CityNode] = {
        "TRIP_START": CityNode(id="TRIP_START", name=start_name or "Origin", lat=start_lat, lng=start_lng),
        "TRIP_GOAL": CityNode(id="TRIP_GOAL", name=goal_name or "Destination", lat=goal_lat, lng=goal_lng),
    }
    for st in stations:
        nodes[st["id"]] = CityNode(
            id=st["id"],
            name=f"{st['name']} Station",
            lat=float(st["lat"]),
            lng=float(st["lng"]),
        )

    raw_edges: list[RoadEdge] = []
    edge_counter = 1
    for item in payload["edges"]:
        u_node, v_node = nodes[item["from"]], nodes[item["to"]]
        raw_edges.append(
            RoadEdge(
                id=f"RAIL_{edge_counter}",
                source=item["from"],
                target=item["to"],
                road_name=item["road_name"],
                distance_km=float(item["distance_km"]),
                speed_limit_kmph=float(item["speed_limit_kmph"]),
                traffic_weight=1.0,
                bidirectional=True,
                segment_type="rail",
                geometry=[[u_node.lat, u_node.lng], [v_node.lat, v_node.lng]],
            )
        )
        edge_counter += 1

    # First-mile access edges (Origin -> nearest 2 stations)
    for st in nearest_start:
        hav = haversine_km(start_lat, start_lng, st["lat"], st["lng"])
        dist = max(0.05, round(hav * 1.25, 3))
        raw_edges.append(
            RoadEdge(
                id=f"ACCESS_S_{st['id']}",
                source="TRIP_START",
                target=st["id"],
                road_name=f"Access to {st['name']} Station",
                distance_km=dist,
                speed_limit_kmph=RAIL_ACCESS_SPEED_KMPH,
                traffic_weight=1.0,
                bidirectional=False,
                segment_type="transfer",
                geometry=[[start_lat, start_lng], [st["lat"], st["lng"]]],
            )
        )

    # Last-mile access edges (nearest 2 stations -> Destination)
    for st in nearest_goal:
        hav = haversine_km(st["lat"], st["lng"], goal_lat, goal_lng)
        dist = max(0.05, round(hav * 1.25, 3))
        raw_edges.append(
            RoadEdge(
                id=f"ACCESS_G_{st['id']}",
                source=st["id"],
                target="TRIP_GOAL",
                road_name=f"Transfer from {st['name']} Station",
                distance_km=dist,
                speed_limit_kmph=RAIL_ACCESS_SPEED_KMPH,
                traffic_weight=1.0,
                bidirectional=False,
                segment_type="transfer",
                geometry=[[st["lat"], st["lng"]], [goal_lat, goal_lng]],
            )
        )

    graph = CityGraph(
        city="Rail Transit Network",
        max_speed_kmph=float(payload.get("max_speed_kmph", 90.0)),
        nodes=nodes,
        raw_edges=raw_edges,
    )
    return graph, None


def build_air_multimodal_graph(
    start_lat: float,
    start_lng: float,
    start_name: str,
    goal_lat: float,
    goal_lng: float,
    goal_name: str,
) -> tuple[CityGraph | None, str | None]:
    """Build combined airport-transfer + geodesic flight CityGraph, or (None, reason)."""
    straight_km = haversine_km(start_lat, start_lng, goal_lat, goal_lng)
    if straight_km < FLIGHT_MIN_DISTANCE_KM:
        return None, "Flights available for inter-city routes (>150 km)"

    payload = _load_air_payload()
    airports = payload["airports"]

    nearest_start = min(
        airports,
        key=lambda a: haversine_km(start_lat, start_lng, a["lat"], a["lng"]),
    )
    nearest_goal = min(
        airports,
        key=lambda a: haversine_km(goal_lat, goal_lng, a["lat"], a["lng"]),
    )
    if nearest_start["id"] == nearest_goal["id"]:
        return None, "Flights available for inter-city routes (>150 km)"

    nodes: dict[str, CityNode] = {
        "TRIP_START": CityNode(id="TRIP_START", name=start_name or "Origin", lat=start_lat, lng=start_lng),
        "TRIP_GOAL": CityNode(id="TRIP_GOAL", name=goal_name or "Destination", lat=goal_lat, lng=goal_lng),
    }
    for ap in airports:
        nodes[ap["id"]] = CityNode(
            id=ap["id"],
            name=ap["name"],
            lat=float(ap["lat"]),
            lng=float(ap["lng"]),
        )

    raw_edges: list[RoadEdge] = []
    edge_counter = 1
    for item in payload["edges"]:
        u_node, v_node = nodes[item["from"]], nodes[item["to"]]
        arc = geodesic_arc_points(u_node.lat, u_node.lng, v_node.lat, v_node.lng, num_points=40)
        raw_edges.append(
            RoadEdge(
                id=f"AIR_{edge_counter}",
                source=item["from"],
                target=item["to"],
                road_name=item["road_name"],
                distance_km=float(item["distance_km"]),
                speed_limit_kmph=float(item["speed_limit_kmph"]),
                traffic_weight=1.0,
                bidirectional=True,
                segment_type="flight",
                geometry=arc,
            )
        )
        edge_counter += 1

    start_hav = haversine_km(start_lat, start_lng, nearest_start["lat"], nearest_start["lng"])
    raw_edges.append(
        RoadEdge(
            id="AIR_ACCESS_S",
            source="TRIP_START",
            target=nearest_start["id"],
            road_name=f"Transfer to {nearest_start['name']}",
            distance_km=max(0.1, round(start_hav * 1.25, 3)),
            speed_limit_kmph=AIR_ACCESS_SPEED_KMPH,
            traffic_weight=1.0,
            bidirectional=False,
            segment_type="transfer",
            geometry=[[start_lat, start_lng], [nearest_start["lat"], nearest_start["lng"]]],
        )
    )

    goal_hav = haversine_km(nearest_goal["lat"], nearest_goal["lng"], goal_lat, goal_lng)
    raw_edges.append(
        RoadEdge(
            id="AIR_ACCESS_G",
            source=nearest_goal["id"],
            target="TRIP_GOAL",
            road_name=f"Transfer from {nearest_goal['name']}",
            distance_km=max(0.1, round(goal_hav * 1.25, 3)),
            speed_limit_kmph=AIR_ACCESS_SPEED_KMPH,
            traffic_weight=1.0,
            bidirectional=False,
            segment_type="transfer",
            geometry=[[nearest_goal["lat"], nearest_goal["lng"]], [goal_lat, goal_lng]],
        )
    )

    graph = CityGraph(
        city="Indian Air Corridors",
        max_speed_kmph=float(payload.get("max_speed_kmph", 780.0)),
        nodes=nodes,
        raw_edges=raw_edges,
    )
    return graph, None


def run_vehicle_route(
    road_graph: CityGraph | None,
    start_id: str | None,
    goal_id: str | None,
    start_coords: tuple[float, float, str],
    goal_coords: tuple[float, float, str],
    vehicle: str = "car",
    mode: str = "fastest",
    traffic_overrides: dict[str, Any] | None = None,
    traffic_preset: str | None = None,
    include_dijkstra: bool = True,
) -> dict[str, Any]:
    """Run A* (and optional Dijkstra comparison) for any of the 6 supported vehicle modes."""
    from core.pathfinder import astar_search, compare_algorithms

    if vehicle not in VALID_VEHICLES:
        raise ValueError(f"Invalid vehicle '{vehicle}'. Expected one of {VALID_VEHICLES}.")

    if vehicle in ROAD_VEHICLES:
        if road_graph is None or not start_id or not goal_id:
            raise ValueError("Road graph and endpoints are required for road vehicle modes.")
        if include_dijkstra:
            res = compare_algorithms(
                graph=road_graph,
                start_id=start_id,
                goal_id=goal_id,
                mode=mode,
                traffic_overrides=traffic_overrides,
                traffic_preset=traffic_preset,
                vehicle=vehicle,
            )
        else:
            astar_res = astar_search(
                graph=road_graph,
                start_id=start_id,
                goal_id=goal_id,
                mode=mode,
                traffic_overrides=traffic_overrides,
                traffic_preset=traffic_preset,
                vehicle=vehicle,
            )
            res = astar_res.to_dict()
            res["dijkstra"] = None
        res["vehicle"] = vehicle
        res["available"] = res["found"]
        res["reason"] = res.get("error") if not res["found"] else None
        return res

    s_lat, s_lng, s_name = start_coords
    g_lat, g_lng, g_name = goal_coords

    if vehicle == "train":
        transit_graph, reason = build_rail_multimodal_graph(s_lat, s_lng, s_name, g_lat, g_lng, g_name)
        overhead_min = RAIL_BOARDING_OVERHEAD_MIN
    else:
        transit_graph, reason = build_air_multimodal_graph(s_lat, s_lng, s_name, g_lat, g_lng, g_name)
        overhead_min = AIR_CHECKIN_OVERHEAD_MIN

    if transit_graph is None:
        return {
            "algorithm": "A*",
            "mode": mode,
            "vehicle": vehicle,
            "found": False,
            "available": False,
            "reason": reason,
            "error": reason,
            "path": [],
            "path_names": [],
            "coordinates": [],
            "segments": [],
            "total_distance_km": 0.0,
            "estimated_time_min": 0.0,
            "total_cost": None,
            "nodes_expanded": 0,
            "explored_order": [],
            "explored_coords": [],
            "node_scores": {},
            "runtime_ms": 0.0,
            "dijkstra": None if not include_dijkstra else {
                "found": False,
                "total_cost": None,
                "total_distance_km": 0.0,
                "estimated_time_min": 0.0,
                "nodes_expanded": 0,
                "explored_order": [],
                "runtime_ms": 0.0,
                "node_reduction_pct": 0.0,
            },
        }

    if include_dijkstra:
        res = compare_algorithms(
            graph=transit_graph,
            start_id="TRIP_START",
            goal_id="TRIP_GOAL",
            mode=mode,
            vehicle=vehicle,
        )
    else:
        astar_res = astar_search(
            graph=transit_graph,
            start_id="TRIP_START",
            goal_id="TRIP_GOAL",
            mode=mode,
            vehicle=vehicle,
        )
        res = astar_res.to_dict()
        res["dijkstra"] = None

    if res["found"]:
        res["estimated_time_min"] = round(res["estimated_time_min"] + overhead_min, 2)
        if res.get("dijkstra"):
            res["dijkstra"]["estimated_time_min"] = round(
                res["dijkstra"]["estimated_time_min"] + overhead_min, 2
            )
    res["vehicle"] = vehicle
    res["available"] = res["found"]
    res["reason"] = res.get("error") if not res["found"] else None
    res["transit_graph_stats"] = {
        "total_intersections": len(transit_graph.nodes),
        "total_roads": len(transit_graph.raw_edges),
    }
    return res


def compute_all_mode_estimates(
    road_graph: CityGraph | None,
    start_id: str | None,
    goal_id: str | None,
    start_coords: tuple[float, float, str],
    goal_coords: tuple[float, float, str],
    mode: str = "fastest",
    traffic_overrides: dict[str, Any] | None = None,
    traffic_preset: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Compute lightweight A*-only ETA/distance estimates for all 6 vehicle modes."""
    from core.pathfinder import astar_search

    estimates: dict[str, dict[str, Any]] = {}

    for vehicle in ROAD_VEHICLES:
        if road_graph is None or not start_id or not goal_id:
            estimates[vehicle] = {
                "eta_min": None,
                "distance_km": None,
                "available": False,
                "reason": "Switch to a road mode to compute road ETA",
            }
            continue

        res = astar_search(
            graph=road_graph,
            start_id=start_id,
            goal_id=goal_id,
            mode=mode,
            traffic_overrides=traffic_overrides,
            traffic_preset=traffic_preset,
            vehicle=vehicle,
        )
        estimates[vehicle] = {
            "eta_min": round(res.estimated_time_min, 1) if res.found else None,
            "distance_km": round(res.total_distance_km, 2) if res.found else None,
            "available": res.found,
            "reason": res.error if not res.found else None,
        }

    s_lat, s_lng, s_name = start_coords
    g_lat, g_lng, g_name = goal_coords

    for vehicle, builder, overhead in (
        ("train", build_rail_multimodal_graph, RAIL_BOARDING_OVERHEAD_MIN),
        ("flight", build_air_multimodal_graph, AIR_CHECKIN_OVERHEAD_MIN),
    ):
        t_graph, reason = builder(s_lat, s_lng, s_name, g_lat, g_lng, g_name)
        if t_graph is None:
            estimates[vehicle] = {
                "eta_min": None,
                "distance_km": None,
                "available": False,
                "reason": reason,
            }
            continue

        t_res = astar_search(
            graph=t_graph,
            start_id="TRIP_START",
            goal_id="TRIP_GOAL",
            mode="fastest",
            vehicle=vehicle,
        )
        estimates[vehicle] = {
            "eta_min": round(t_res.estimated_time_min + overhead, 1) if t_res.found else None,
            "distance_km": round(t_res.total_distance_km, 2) if t_res.found else None,
            "available": t_res.found,
            "reason": t_res.error if not t_res.found else None,
        }

    return estimates

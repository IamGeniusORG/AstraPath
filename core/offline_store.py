"""Persistent user-saved offline places store and dynamic graph merger."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import requests

from core.graph import CityGraph, CityNode, RoadEdge
from core.heuristics import haversine_km

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_PLACES_PATH = DATA_DIR / "offline_places.json"
OSRM_ROUTE_URL = "https://router.project-osrm.org/route/v1/driving"
USER_AGENT = "AstraPath-RouteOptimizer/1.0"

ROAD_TORTUOSITY_FACTOR = 1.25
DEFAULT_CONNECTOR_SPEED_KMPH = 40.0
DEFAULT_CONNECTOR_TRAFFIC = 1.20
MAX_PLACE_NAME_LEN = 80


def is_read_only_fs() -> bool:
    """Return True when running in a serverless/read-only filesystem environment."""
    return os.getenv("VERCEL") == "1" or os.getenv("VERCEL_ENV") is not None


def _ensure_places_file(places_path: Path) -> None:
    """Create an empty offline_places.json file if writable and missing."""
    if is_read_only_fs():
        return
    if not places_path.exists():
        try:
            places_path.parent.mkdir(parents=True, exist_ok=True)
            places_path.write_text(json.dumps({"places": []}, indent=2), encoding="utf-8")
        except OSError:
            return


def load_saved_places(places_path: Path = DEFAULT_PLACES_PATH) -> list[dict[str, Any]]:
    """Load all user-saved custom offline places from disk."""
    _ensure_places_file(places_path)
    if not places_path.exists():
        return []
    try:
        payload = json.loads(places_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    places = payload.get("places")
    return places if isinstance(places, list) else []


def _write_saved_places(
    places: list[dict[str, Any]],
    places_path: Path = DEFAULT_PLACES_PATH,
) -> bool:
    """Write saved places to disk when writable; return False on read-only FS."""
    if is_read_only_fs():
        return False
    try:
        places_path.parent.mkdir(parents=True, exist_ok=True)
        places_path.write_text(json.dumps({"places": places}, indent=2), encoding="utf-8")
        return True
    except OSError:
        return False


def _next_place_id(existing_places: list[dict[str, Any]]) -> str:
    """Generate the next unique U<n> ID."""
    max_idx = 0
    for item in existing_places:
        match = re.match(r"^U(\d+)$", str(item.get("id", "")))
        if match:
            max_idx = max(max_idx, int(match.group(1)))
    return f"U{max_idx + 1}"


def _try_osrm_connector(
    lat1: float,
    lng1: float,
    lat2: float,
    lng2: float,
) -> tuple[float, list[list[float]]] | None:
    """Attempt a quick 2.5s OSRM road lookup for realistic offline connector geometry."""
    try:
        url = f"{OSRM_ROUTE_URL}/{lng1:.6f},{lat1:.6f};{lng2:.6f},{lat2:.6f}"
        resp = requests.get(
            url,
            params={"overview": "simplified", "geometries": "geojson"},
            headers={"User-Agent": USER_AGENT},
            timeout=2.5,
        )
        if not resp.ok:
            return None
        data = resp.json()
        route = (data.get("routes") or [None])[0]
        if not route:
            return None
        coords = route.get("geometry", {}).get("coordinates") or []
        if len(coords) < 2:
            return None
        geom = [[float(pt[1]), float(pt[0])] for pt in coords]
        poly_dist = 0.0
        for i in range(len(geom) - 1):
            poly_dist += haversine_km(geom[i][0], geom[i][1], geom[i + 1][0], geom[i + 1][1])
        straight = haversine_km(lat1, lng1, lat2, lng2)
        return max(poly_dist, straight), geom
    except (requests.RequestException, ValueError, KeyError, TypeError):
        return None


def _compute_connector_edge(
    source_id: str,
    target_node: CityNode,
    place_name: str,
    lat: float,
    lng: float,
    use_osrm: bool = True,
) -> dict[str, Any]:
    """Build an admissible connector edge between a custom place and an existing node."""
    hav = haversine_km(lat, lng, target_node.lat, target_node.lng)
    osrm_res = (
        _try_osrm_connector(lat, lng, target_node.lat, target_node.lng)
        if use_osrm and hav > 0.02
        else None
    )
    if osrm_res is not None:
        dist_km, geom = osrm_res
    else:
        dist_km = max(0.05, round(hav * ROAD_TORTUOSITY_FACTOR, 3))
        dist_km = max(dist_km, hav)
        geom = [[lat, lng], [target_node.lat, target_node.lng]]

    return {
        "to": target_node.id,
        "road_name": f"{place_name} - {target_node.name}",
        "distance_km": round(dist_km, 3),
        "speed_limit_kmph": DEFAULT_CONNECTOR_SPEED_KMPH,
        "traffic_weight": DEFAULT_CONNECTOR_TRAFFIC,
        "geometry": geom,
    }


def save_custom_place(
    name: str,
    lat: float,
    lng: float,
    base_graph: CityGraph,
    category: str = "custom",
    places_path: Path = DEFAULT_PLACES_PATH,
    use_osrm: bool = True,
) -> dict[str, Any]:
    """Persist a user-saved place and link it to its 3 nearest offline nodes."""
    clean_name = name.strip()
    if not clean_name or len(clean_name) > MAX_PLACE_NAME_LEN:
        raise ValueError(
            f"Place name must be between 1 and {MAX_PLACE_NAME_LEN} characters."
        )

    existing = load_saved_places(places_path)
    merged_before = build_merged_offline_graph(base_graph, places_path=places_path)

    nearest_nodes = sorted(
        merged_before.nodes.values(),
        key=lambda n: haversine_km(lat, lng, n.lat, n.lng),
    )[:3]

    place_id = _next_place_id(existing)
    connectors = [
        _compute_connector_edge(
            place_id, target, clean_name, lat, lng, use_osrm=use_osrm
        )
        for target in nearest_nodes
    ]

    record = {
        "id": place_id,
        "name": clean_name,
        "lat": round(float(lat), 6),
        "lng": round(float(lng), 6),
        "category": str(category or "custom")[:32],
        "connectors": connectors,
    }
    existing.append(record)
    persisted = _write_saved_places(existing, places_path)
    record["storage"] = "disk" if persisted else "browser_only"
    return record


def delete_custom_place(
    place_id: str,
    places_path: Path = DEFAULT_PLACES_PATH,
) -> bool:
    """Remove a saved place by ID and prune dangling connectors."""
    if is_read_only_fs():
        return True
    places = load_saved_places(places_path)
    remaining = [p for p in places if str(p.get("id")) != place_id]
    if len(remaining) == len(places):
        return False

    for p in remaining:
        p["connectors"] = [
            c for c in (p.get("connectors") or []) if str(c.get("to")) != place_id
        ]
    _write_saved_places(remaining, places_path)
    return True


def build_merged_offline_graph(
    base_graph: CityGraph,
    places_path: Path = DEFAULT_PLACES_PATH,
    origin_coords: dict[str, Any] | None = None,
    custom_places: list[dict[str, Any]] | None = None,
) -> CityGraph:
    """Merge built-in offline graph, user-saved places, and optional dynamic GPS origin."""
    nodes: dict[str, CityNode] = dict(base_graph.nodes)
    raw_edges: list[RoadEdge] = [
        RoadEdge(
            id=edge.id,
            source=edge.source,
            target=edge.target,
            road_name=edge.road_name,
            distance_km=edge.distance_km,
            speed_limit_kmph=edge.speed_limit_kmph,
            traffic_weight=edge.traffic_weight,
            bidirectional=edge.bidirectional,
            blocked=edge.blocked,
            geometry=list(edge.geometry),
            segment_type=edge.segment_type,
            highway_type=edge.highway_type,
        )
        for edge in base_graph.raw_edges
    ]

    saved_places = load_saved_places(places_path)
    if custom_places:
        seen_ids = {str(p.get("id")) for p in saved_places}
        for cp in custom_places:
            cp_id = str(cp.get("id", "")).strip()
            if cp_id and cp_id not in seen_ids:
                saved_places.append(cp)
                seen_ids.add(cp_id)
    for item in saved_places:
        pid = str(item["id"])
        nodes[pid] = CityNode(
            id=pid,
            name=str(item["name"]),
            lat=float(item["lat"]),
            lng=float(item["lng"]),
        )

    for item in saved_places:
        pid = str(item["id"])
        p_node = nodes[pid]
        valid_connectors = [
            c for c in (item.get("connectors") or []) if str(c.get("to")) in nodes
        ]
        if not valid_connectors:
            # Re-link to nearest existing node if original targets were deleted
            candidates = [n for n in nodes.values() if n.id != pid]
            if candidates:
                nearest = min(
                    candidates,
                    key=lambda n: haversine_km(p_node.lat, p_node.lng, n.lat, n.lng),
                )
                valid_connectors = [
                    _compute_connector_edge(
                        pid, nearest, p_node.name, p_node.lat, p_node.lng, use_osrm=False
                    )
                ]

        for idx, conn in enumerate(valid_connectors, start=1):
            target_id = str(conn["to"])
            target_node = nodes[target_id]
            hav = haversine_km(p_node.lat, p_node.lng, target_node.lat, target_node.lng)
            dist = max(float(conn["distance_km"]), hav)
            raw_edges.append(
                RoadEdge(
                    id=f"{pid}_CONN_{idx}",
                    source=pid,
                    target=target_id,
                    road_name=str(conn.get("road_name", f"{p_node.name} Link")),
                    distance_km=dist,
                    speed_limit_kmph=float(
                        conn.get("speed_limit_kmph", DEFAULT_CONNECTOR_SPEED_KMPH)
                    ),
                    traffic_weight=float(
                        conn.get("traffic_weight", DEFAULT_CONNECTOR_TRAFFIC)
                    ),
                    bidirectional=True,
                    blocked=False,
                    geometry=list(conn.get("geometry") or []),
                )
            )

    if origin_coords is not None:
        gps_id = "GPS_ORIGIN"
        gps_lat = float(origin_coords["lat"])
        gps_lng = float(origin_coords["lng"])
        gps_name = str(origin_coords.get("name") or "My Location")[:MAX_PLACE_NAME_LEN]
        nearest_two = sorted(
            nodes.values(),
            key=lambda n: haversine_km(gps_lat, gps_lng, n.lat, n.lng),
        )[:2]
        nodes[gps_id] = CityNode(id=gps_id, name=gps_name, lat=gps_lat, lng=gps_lng)
        for idx, target in enumerate(nearest_two, start=1):
            hav = haversine_km(gps_lat, gps_lng, target.lat, target.lng)
            dist = max(0.02, max(hav, round(hav * ROAD_TORTUOSITY_FACTOR, 3)))
            raw_edges.append(
                RoadEdge(
                    id=f"GPS_LINK_{idx}",
                    source=gps_id,
                    target=target.id,
                    road_name=f"Access to {target.name}",
                    distance_km=dist,
                    speed_limit_kmph=DEFAULT_CONNECTOR_SPEED_KMPH,
                    traffic_weight=1.0,
                    bidirectional=True,
                    blocked=False,
                    geometry=[[gps_lat, gps_lng], [target.lat, target.lng]],
                )
            )

    return CityGraph(
        city=base_graph.city,
        max_speed_kmph=base_graph.max_speed_kmph,
        nodes=nodes,
        raw_edges=raw_edges,
    )

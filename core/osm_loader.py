"""Dynamic OpenStreetMap Nominatim + Overpass loader with fast corridor fallback."""

from __future__ import annotations

import math
import re
import threading
import time
import zlib
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import requests

from core.graph import CityGraph, CityNode, RoadEdge
from core.heuristics import haversine_km

USER_AGENT: str = "AstraPath-RouteOptimizer/1.0"
PHOTON_SEARCH_URL: str = "https://photon.komoot.io/api"
NOMINATIM_SEARCH_URL: str = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE_URL: str = "https://nominatim.openstreetmap.org/reverse"
OSRM_ROUTE_URL: str = "https://router.project-osrm.org/route/v1/driving"

OVERPASS_MIRRORS: tuple[str, ...] = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)

MAX_LIVE_DISTANCE_KM: float = 450.0
LONG_DISTANCE_THRESHOLD_KM: float = 200.0
MIN_BBOX_PAD_DEG: float = 0.008
MAX_BBOX_PAD_DEG: float = 0.025
BBOX_PAD_RATIO: float = 0.12

OVERPASS_CONNECT_TIMEOUT_S: float = 2.0
OVERPASS_READ_TIMEOUT_S: float = 3.5
CORRIDOR_TIMEOUT_S: float = 3.5
OVERPASS_MAX_DISTANCE_KM: float = 8.0

CACHE_TTL_SECONDS: int = 900
CACHE_MAX_REGIONS: int = 10
GEOCODE_CACHE_MAX: int = 200
NOMINATIM_MIN_INTERVAL_S: float = 1.05

HIGHWAY_DEFAULT_SPEEDS: dict[str, float] = {
    "motorway": 80.0,
    "motorway_link": 55.0,
    "trunk": 65.0,
    "trunk_link": 45.0,
    "primary": 50.0,
    "primary_link": 40.0,
    "secondary": 45.0,
    "secondary_link": 35.0,
    "tertiary": 35.0,
    "tertiary_link": 30.0,
    "unclassified": 30.0,
    "residential": 25.0,
}

CONGESTED_HIGHWAY_CLASSES: frozenset[str] = frozenset({"primary", "secondary"})

# LRU + TTL cache keyed by (rounded_bbox_tuple, road_tier) -> (timestamp, graph, graph_source)
_GRAPH_CACHE: OrderedDict[
    tuple[tuple[float, float, float, float], str],
    tuple[float, CityGraph, str],
] = OrderedDict()

# In-memory TTL caches for forward & reverse geocoding (max 200 entries, 15 min)
_GEOCODE_CACHE: OrderedDict[str, tuple[float, list[dict[str, Any]]]] = OrderedDict()
_REVERSE_GEOCODE_CACHE: OrderedDict[tuple[float, float], tuple[float, dict[str, Any]]] = OrderedDict()
_NOMINATIM_LOCK = threading.Lock()
_last_nominatim_ts: float = 0.0


class RegionTooLargeError(ValueError):
    """Raised when Start and Goal exceed the real-time extraction limit."""


class OSMServiceError(RuntimeError):
    """Raised when all online road-network providers fail."""


def _short_place_name(item: dict[str, Any]) -> str:
    """Build a concise human-readable label from a Nominatim payload."""
    address = item.get("address") or {}
    parts: list[str] = []
    for key in (
        "amenity",
        "building",
        "road",
        "neighbourhood",
        "suburb",
        "city_district",
        "town",
        "city",
        "state_district",
        "state",
    ):
        val = address.get(key)
        if val and val not in parts:
            parts.append(str(val))
        if len(parts) >= 3:
            break

    if parts:
        return ", ".join(parts)

    display_name = str(item.get("display_name", "")).strip()
    if display_name:
        return ", ".join(display_name.split(",")[:3]).strip()
    return "Selected Location"


def _throttle_nominatim() -> None:
    """Enforce >= 1 request/second rate limit across all Nominatim calls."""
    global _last_nominatim_ts
    with _NOMINATIM_LOCK:
        now = time.monotonic()
        wait_s = NOMINATIM_MIN_INTERVAL_S - (now - _last_nominatim_ts)
        if wait_s > 0:
            time.sleep(wait_s)
        _last_nominatim_ts = time.monotonic()


def _prune_ttl_cache(cache: OrderedDict, max_items: int) -> None:
    """Evict expired entries and enforce max_items LRU bound."""
    now = time.time()
    expired = [k for k, (ts, _) in cache.items() if now - ts > CACHE_TTL_SECONDS]
    for k in expired:
        cache.pop(k, None)
    while len(cache) > max_items:
        cache.popitem(last=False)


def _format_photon_feature(feature: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize a Photon GeoJSON feature into {name, full_name, lat, lng}."""
    props = feature.get("properties") or {}
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coords) < 2:
        return None
    lng, lat = float(coords[0]), float(coords[1])

    short_parts: list[str] = []
    for key in ("name", "street", "district", "city", "town", "village"):
        val = props.get(key)
        if val and str(val) not in short_parts:
            short_parts.append(str(val))
        if len(short_parts) >= 2:
            break

    full_parts: list[str] = list(short_parts)
    for key in ("county", "state", "country"):
        val = props.get(key)
        if val and str(val) not in full_parts:
            full_parts.append(str(val))

    name = ", ".join(short_parts) if short_parts else f"{lat:.4f}, {lng:.4f}"
    full_name = ", ".join(full_parts) if full_parts else name
    return {"name": name, "full_name": full_name, "lat": lat, "lng": lng}


def _geocode_via_photon(clean_q: str, limit: int) -> list[dict[str, Any]]:
    """Query Photon OSM search-as-you-type geocoder."""
    resp = requests.get(
        PHOTON_SEARCH_URL,
        params={"q": clean_q, "limit": limit},
        headers={"User-Agent": USER_AGENT},
        timeout=3.5,
    )
    resp.raise_for_status()
    payload = resp.json()
    results: list[dict[str, Any]] = []
    for feat in payload.get("features") or []:
        parsed = _format_photon_feature(feat)
        if parsed is not None:
            results.append(parsed)
    return results


def _geocode_via_nominatim(clean_q: str, limit: int) -> list[dict[str, Any]]:
    """Query Nominatim forward geocoder respecting 1 req/s fair-use policy."""
    _throttle_nominatim()
    resp = requests.get(
        NOMINATIM_SEARCH_URL,
        params={
            "q": clean_q,
            "format": "jsonv2",
            "limit": limit,
            "addressdetails": 1,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=3.5,
    )
    resp.raise_for_status()
    items = resp.json()

    results: list[dict[str, Any]] = []
    for item in items:
        try:
            results.append(
                {
                    "name": _short_place_name(item),
                    "full_name": str(item.get("display_name", "")),
                    "lat": float(item["lat"]),
                    "lng": float(item["lon"]),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    return results


def geocode_place(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Geocode a place query using Photon with Nominatim fallback and TTL cache."""
    clean_q = query.strip()
    if len(clean_q) < 2:
        return []

    cache_key = f"{clean_q.lower()}:{limit}"
    _prune_ttl_cache(_GEOCODE_CACHE, GEOCODE_CACHE_MAX)
    cached = _GEOCODE_CACHE.get(cache_key)
    if cached is not None:
        _GEOCODE_CACHE.move_to_end(cache_key)
        return cached[1]

    results: list[dict[str, Any]] = []
    last_exc: Exception | None = None

    try:
        results = _geocode_via_photon(clean_q, limit)
    except (requests.RequestException, ValueError) as exc:
        last_exc = exc

    if not results:
        try:
            results = _geocode_via_nominatim(clean_q, limit)
        except (requests.RequestException, ValueError) as exc:
            if last_exc is not None:
                raise OSMServiceError(f"Geocoding lookup failed: {exc}") from exc
            raise OSMServiceError(f"Geocoding lookup failed: {exc}") from exc

    _GEOCODE_CACHE[cache_key] = (time.time(), results)
    _prune_ttl_cache(_GEOCODE_CACHE, GEOCODE_CACHE_MAX)
    return results


def reverse_geocode(lat: float, lng: float) -> dict[str, Any]:
    """Query Nominatim reverse geocoder with 15-min cache and 1 req/s throttle."""
    cache_key = (round(lat, 4), round(lng, 4))
    _prune_ttl_cache(_REVERSE_GEOCODE_CACHE, GEOCODE_CACHE_MAX)
    cached = _REVERSE_GEOCODE_CACHE.get(cache_key)
    if cached is not None:
        _REVERSE_GEOCODE_CACHE.move_to_end(cache_key)
        return {"name": cached[1]["name"], "lat": lat, "lng": lng}

    try:
        _throttle_nominatim()
        resp = requests.get(
            NOMINATIM_REVERSE_URL,
            params={
                "lat": lat,
                "lon": lng,
                "format": "jsonv2",
                "zoom": 17,
                "addressdetails": 1,
            },
            headers={"User-Agent": USER_AGENT},
            timeout=3.5,
        )
        resp.raise_for_status()
        item = resp.json()
        label = _short_place_name(item) if isinstance(item, dict) else f"{lat:.4f}, {lng:.4f}"
        payload = {"name": label, "lat": lat, "lng": lng}
        _REVERSE_GEOCODE_CACHE[cache_key] = (time.time(), payload)
        _prune_ttl_cache(_REVERSE_GEOCODE_CACHE, GEOCODE_CACHE_MAX)
        return payload
    except requests.RequestException:
        return {"name": f"{lat:.4f}, {lng:.4f}", "lat": lat, "lng": lng}


def select_road_tier(distance_km: float) -> tuple[str, str]:
    """Choose adaptive Overpass highway filter regex based on trip distance."""
    if distance_km > MAX_LIVE_DISTANCE_KM:
        raise RegionTooLargeError(
            f"Distance between selected places is {distance_km:.1f} km. "
            f"Please choose two places within {MAX_LIVE_DISTANCE_KM:.0f} km."
        )
    if distance_km <= 5.0:
        return (
            "local",
            "motorway|trunk|primary|secondary|tertiary|unclassified|residential",
        )
    if distance_km <= 15.0:
        return (
            "metro",
            "motorway|trunk|primary|secondary|tertiary",
        )
    if distance_km <= 35.0:
        return (
            "regional",
            "motorway|trunk|primary|secondary",
        )
    return ("highway", "motorway|trunk|primary")


def compute_padded_bbox(
    start_lat: float,
    start_lng: float,
    goal_lat: float,
    goal_lng: float,
) -> tuple[float, float, float, float]:
    """Compute tight padded (south, west, north, east) bounding box."""
    min_lat = min(start_lat, goal_lat)
    max_lat = max(start_lat, goal_lat)
    min_lng = min(start_lng, goal_lng)
    max_lng = max(start_lng, goal_lng)

    span = max(max_lat - min_lat, max_lng - min_lng)
    pad_deg = min(MAX_BBOX_PAD_DEG, max(MIN_BBOX_PAD_DEG, span * BBOX_PAD_RATIO))

    return (
        min_lat - pad_deg,
        min_lng - pad_deg,
        max_lat + pad_deg,
        max_lng + pad_deg,
    )


def _query_overpass_mirror(mirror_url: str, query: str) -> list[dict[str, Any]]:
    """Query a single Overpass API mirror and return elements list."""
    resp = requests.post(
        mirror_url,
        data={"data": query},
        headers={"User-Agent": USER_AGENT},
        timeout=(OVERPASS_CONNECT_TIMEOUT_S, OVERPASS_READ_TIMEOUT_S),
    )
    if resp.status_code in (429, 502, 503, 504):
        raise OSMServiceError(
            f"Overpass mirror {mirror_url} returned HTTP {resp.status_code}."
        )
    resp.raise_for_status()
    payload = resp.json()
    elements = payload.get("elements")
    if not isinstance(elements, list) or not elements:
        raise OSMServiceError(f"Empty Overpass payload from {mirror_url}.")
    return elements


def _race_overpass_tier(
    bbox: tuple[float, float, float, float],
    highway_regex: str,
) -> list[dict[str, Any]]:
    """Race Overpass mirrors for a given highway filter using single-pass out geom."""
    south, west, north, east = bbox
    query = (
        "[out:json][timeout:4];\n"
        f'(way["highway"~"^({highway_regex})$"]({south:.5f},{west:.5f},{north:.5f},{east:.5f}););\n'
        "out geom;\n"
    )

    last_error: Exception | None = None
    executor = ThreadPoolExecutor(max_workers=len(OVERPASS_MIRRORS))
    try:
        futures = {
            executor.submit(_query_overpass_mirror, mirror, query): mirror
            for mirror in OVERPASS_MIRRORS
        }
        try:
            for future in as_completed(futures, timeout=OVERPASS_READ_TIMEOUT_S + 0.5):
                try:
                    return future.result()
                except Exception as exc:
                    last_error = exc
        except TimeoutError as exc:
            last_error = exc
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    raise OSMServiceError(f"Overpass mirrors failed ({last_error}).")


def fetch_overpass_elements(
    bbox: tuple[float, float, float, float],
    tier_name: str,
    highway_regex: str,
) -> list[dict[str, Any]]:
    """Query Overpass once with a strict timeout; fall back to corridor graph on failure."""
    del tier_name
    return _race_overpass_tier(bbox, highway_regex)


def _parse_speed_limit(tags: dict[str, Any], highway_type: str) -> float:
    """Parse OSM maxspeed tag or fall back to highway class default (km/h)."""
    raw_speed = str(tags.get("maxspeed", "")).strip().lower()
    if raw_speed:
        match = re.search(r"(\d+(?:\.\d+)?)", raw_speed)
        if match:
            val = float(match.group(1))
            if "mph" in raw_speed:
                val *= 1.60934
            if 10.0 <= val <= 140.0:
                return round(val, 1)
    return HIGHWAY_DEFAULT_SPEEDS.get(highway_type, 35.0)


def _deterministic_traffic_factor(
    key_seed: str,
    congested_bias: bool,
) -> float:
    """Assign deterministic realistic congestion factor so Fastest != Shortest."""
    digest = zlib.crc32(key_seed.encode("utf-8"))
    frac = (digest % 1000) / 1000.0
    if congested_bias:
        return round(1.50 + frac * 0.80, 2)  # 1.50x - 2.30x
    return round(1.00 + frac * 0.30, 2)      # 1.00x - 1.30x


def _format_road_name(tags: dict[str, Any], highway_type: str) -> str:
    """Return readable road name from OSM tags."""
    name = tags.get("name") or tags.get("ref")
    if name:
        return str(name)
    return f"{highway_type.replace('_', ' ').title()} Rd"


def _retain_largest_component(
    raw_edges: list[RoadEdge],
) -> tuple[set[str], list[RoadEdge]]:
    """Keep only edges and node IDs in the largest connected component via BFS."""
    undirected_adj: dict[str, list[str]] = {}
    for edge in raw_edges:
        undirected_adj.setdefault(edge.source, []).append(edge.target)
        undirected_adj.setdefault(edge.target, []).append(edge.source)

    visited: set[str] = set()
    largest_component: set[str] = set()

    for node_key in undirected_adj:
        if node_key in visited:
            continue
        comp: set[str] = set()
        queue: deque[str] = deque([node_key])
        visited.add(node_key)
        while queue:
            curr = queue.popleft()
            comp.add(curr)
            for nxt in undirected_adj[curr]:
                if nxt not in visited:
                    visited.add(nxt)
                    queue.append(nxt)
        if len(comp) > len(largest_component):
            largest_component = comp

    filtered_edges = [
        edge
        for edge in raw_edges
        if edge.source in largest_component and edge.target in largest_component
    ]
    return largest_component, filtered_edges


def contract_osm_data(
    elements: list[dict[str, Any]],
    city_label: str = "Live OpenStreetMap Network",
    start_coords: tuple[float, float] | None = None,
    goal_coords: tuple[float, float] | None = None,
) -> CityGraph:
    """Contract raw OSM ways and nodes into an intersection-only CityGraph.

    Degree-2 intermediate shape nodes are collapsed into curved RoadEdge
    geometries whose distance_km equals the sum of Haversine segment lengths,
    preserving strict A* admissibility (distance_km >= haversine_km(u, v)).
    Only the largest connected component is retained to prevent isolated traps.
    """
    osm_nodes: dict[int, tuple[float, float]] = {}
    ways: list[dict[str, Any]] = []

    for elem in elements:
        etype = elem.get("type")
        if etype == "node" and "lat" in elem and "lon" in elem:
            osm_nodes[int(elem["id"])] = (float(elem["lat"]), float(elem["lon"]))
        elif etype == "way" and elem.get("nodes"):
            ways.append(elem)
            geom = elem.get("geometry")
            if isinstance(geom, list) and len(geom) == len(elem["nodes"]):
                for raw_nid, pt in zip(elem["nodes"], geom):
                    if isinstance(pt, dict) and "lat" in pt and "lon" in pt:
                        osm_nodes[int(raw_nid)] = (float(pt["lat"]), float(pt["lon"]))

    if not osm_nodes or not ways:
        raise OSMServiceError(
            "No drivable roads found in the selected region."
        )

    way_count: dict[int, int] = {}
    for way in ways:
        for raw_nid in way["nodes"]:
            nid = int(raw_nid)
            if nid in osm_nodes:
                way_count[nid] = way_count.get(nid, 0) + 1

    forced_vertices: set[int] = set()
    for target in (start_coords, goal_coords):
        if target is not None and way_count:
            t_lat, t_lng = target
            closest_nid = min(
                way_count.keys(),
                key=lambda nid: haversine_km(
                    t_lat, t_lng, osm_nodes[nid][0], osm_nodes[nid][1]
                ),
            )
            forced_vertices.add(closest_nid)

    vertex_ids: set[int] = set(forced_vertices)
    for way in ways:
        w_nodes = [int(n) for n in way["nodes"] if int(n) in osm_nodes]
        if len(w_nodes) < 2:
            continue
        vertex_ids.add(w_nodes[0])
        vertex_ids.add(w_nodes[-1])
        for nid in w_nodes[1:-1]:
            if way_count.get(nid, 0) >= 2:
                vertex_ids.add(nid)

    raw_edges: list[RoadEdge] = []
    vertex_road_hints: dict[int, list[str]] = {}
    edge_counter = 1

    for way in ways:
        way_id = int(way.get("id", 0))
        tags = way.get("tags") or {}
        highway_type = str(tags.get("highway", "unclassified")).lower()
        road_name = _format_road_name(tags, highway_type)
        speed_limit = _parse_speed_limit(tags, highway_type)

        w_nodes = [int(n) for n in way["nodes"] if int(n) in osm_nodes]
        if len(w_nodes) < 2:
            continue

        seg_start_idx = 0
        seg_idx = 0
        for idx in range(1, len(w_nodes)):
            curr_nid = w_nodes[idx]
            if curr_nid not in vertex_ids:
                continue

            u_nid = w_nodes[seg_start_idx]
            v_nid = curr_nid
            if u_nid != v_nid:
                seg_nodes = w_nodes[seg_start_idx : idx + 1]
                geometry = [[osm_nodes[n][0], osm_nodes[n][1]] for n in seg_nodes]

                total_dist = 0.0
                for p_i in range(len(geometry) - 1):
                    total_dist += haversine_km(
                        geometry[p_i][0],
                        geometry[p_i][1],
                        geometry[p_i + 1][0],
                        geometry[p_i + 1][1],
                    )
                straight_dist = haversine_km(
                    geometry[0][0], geometry[0][1], geometry[-1][0], geometry[-1][1]
                )
                total_dist = max(total_dist, straight_dist)

                if total_dist > 0.0:
                    traffic_factor = _deterministic_traffic_factor(
                        f"{way_id}:{seg_idx}",
                        highway_type in CONGESTED_HIGHWAY_CLASSES,
                    )
                    edge_id = f"E{edge_counter}"
                    edge_counter += 1
                    raw_edges.append(
                        RoadEdge(
                            id=edge_id,
                            source=f"OSM_{u_nid}",
                            target=f"OSM_{v_nid}",
                            road_name=road_name,
                            distance_km=total_dist,
                            speed_limit_kmph=speed_limit,
                            traffic_weight=traffic_factor,
                            bidirectional=True,
                            blocked=False,
                            geometry=geometry,
                            segment_type="road",
                            highway_type=highway_type,
                        )
                    )
                    vertex_road_hints.setdefault(u_nid, [])
                    if road_name not in vertex_road_hints[u_nid] and len(vertex_road_hints[u_nid]) < 2:
                        vertex_road_hints[u_nid].append(road_name)
                    vertex_road_hints.setdefault(v_nid, [])
                    if road_name not in vertex_road_hints[v_nid] and len(vertex_road_hints[v_nid]) < 2:
                        vertex_road_hints[v_nid].append(road_name)
                    seg_idx += 1

            seg_start_idx = idx

    if not raw_edges:
        raise OSMServiceError("Extracted road network had zero traversable segments.")

    largest_component, filtered_edges = _retain_largest_component(raw_edges)

    nodes: dict[str, CityNode] = {}
    for nid_str in largest_component:
        raw_id = int(nid_str.replace("OSM_", "", 1))
        lat, lng = osm_nodes[raw_id]
        hints = vertex_road_hints.get(raw_id, [])
        if len(hints) >= 2:
            node_name = f"{hints[0]} & {hints[1]}"
        elif len(hints) == 1:
            node_name = f"{hints[0]} Jct"
        else:
            node_name = f"Intersection {raw_id}"
        nodes[nid_str] = CityNode(id=nid_str, name=node_name, lat=lat, lng=lng)

    max_speed = max(80.0, max(edge.speed_limit_kmph for edge in filtered_edges))
    return CityGraph(
        city=city_label,
        max_speed_kmph=max_speed,
        nodes=nodes,
        raw_edges=filtered_edges,
    )


def _fetch_osrm_corridor(waypoints: list[tuple[float, float]], alternatives: bool = False) -> list[dict[str, Any]]:
    """Fetch alternative driving corridors (steps + geometries) for fallback graph assembly."""
    coords_str = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in waypoints)
    params = {
        "steps": "true",
        "geometries": "geojson",
        "overview": "full",
        "alternatives": "3" if alternatives else "false",
    }
    resp = requests.get(
        f"{OSRM_ROUTE_URL}/{coords_str}",
        params=params,
        headers={"User-Agent": USER_AGENT},
        timeout=CORRIDOR_TIMEOUT_S,
    )
    resp.raise_for_status()
    payload = resp.json()
    routes = payload.get("routes")
    return routes if isinstance(routes, list) else []


def _corridor_speed_from_name(road_name: str, step_distance_m: float, step_duration_s: float) -> float:
    """Infer realistic speed limit (km/h) for a corridor road segment."""
    name_low = road_name.lower()
    if any(k in name_low for k in ("nh", "expressway", "highway", "bypass", "flyover")):
        return 70.0
    if any(k in name_low for k in ("avenue", "ave", "sarani", "trunk", "vip")):
        return 50.0
    if step_duration_s > 0 and step_distance_m > 0:
        inferred = (step_distance_m / 1000.0) / (step_duration_s / 3600.0)
        return round(min(75.0, max(25.0, inferred)), 1)
    return 40.0


def build_corridor_fallback_graph(
    start_lat: float,
    start_lng: float,
    goal_lat: float,
    goal_lng: float,
) -> CityGraph:
    """Build a multi-corridor CityGraph when Overpass mirrors are overloaded.

    Fetches up to 3 alternative corridors plus 2 midpoint-offset detour corridors
    in parallel, merges shared junctions into CityNodes, and constructs weighted
    RoadEdges so our custom Python A* and Dijkstra still perform real graph search
    and support Fastest/Shortest divergence and roadblock rerouting.
    """
    mid_lat = (start_lat + goal_lat) / 2.0
    mid_lng = (start_lng + goal_lng) / 2.0
    d_lat = goal_lat - start_lat
    d_lng = goal_lng - start_lng
    norm = math.hypot(d_lat, d_lng) or 1e-6
    offset = max(0.008, norm * 0.08)
    perp_lat = (-d_lng / norm) * offset
    perp_lng = (d_lat / norm) * offset

    queries = [
        ([(start_lat, start_lng), (goal_lat, goal_lng)], True),
        ([(start_lat, start_lng), (mid_lat + perp_lat, mid_lng + perp_lng), (goal_lat, goal_lng)], False),
        ([(start_lat, start_lng), (mid_lat - perp_lat, mid_lng - perp_lng), (goal_lat, goal_lng)], False),
    ]

    all_routes: list[tuple[int, dict[str, Any]]] = []
    executor = ThreadPoolExecutor(max_workers=3)
    try:
        future_map = {
            executor.submit(_fetch_osrm_corridor, wps, alts): idx
            for idx, (wps, alts) in enumerate(queries)
        }
        try:
            for future in as_completed(future_map, timeout=4.0):
                q_idx = future_map[future]
                try:
                    for route in future.result():
                        all_routes.append((q_idx, route))
                except Exception:
                    continue
        except TimeoutError:
            pass
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    if not all_routes:
        raise OSMServiceError(
            "Unable to fetch road network from Overpass or corridor fallback. Check internet connectivity."
        )

    coord_to_id: dict[tuple[float, float], str] = {}
    nodes: dict[str, CityNode] = {}
    raw_edges: list[RoadEdge] = []
    seen_segments: set[tuple[str, str, str]] = set()
    node_counter = 1
    edge_counter = 1

    def get_or_create_node(lat: float, lng: float, label_hint: str) -> str:
        nonlocal node_counter
        quantized = (round(lat, 4), round(lng, 4))
        if quantized in coord_to_id:
            return coord_to_id[quantized]
        nid = f"C{node_counter}"
        node_counter += 1
        coord_to_id[quantized] = nid
        nodes[nid] = CityNode(id=nid, name=label_hint or f"Junction {nid}", lat=lat, lng=lng)
        return nid

    for corridor_idx, route in all_routes:
        for leg in route.get("legs", []):
            for step in leg.get("steps", []):
                raw_coords = step.get("geometry", {}).get("coordinates") or []
                if len(raw_coords) < 2:
                    continue

                geom = [[float(pt[1]), float(pt[0])] for pt in raw_coords]
                road_name = str(step.get("name") or step.get("ref") or "Connecting Road").strip()
                if not road_name:
                    road_name = "Connecting Road"

                u_id = get_or_create_node(geom[0][0], geom[0][1], f"{road_name} Start")
                v_id = get_or_create_node(geom[-1][0], geom[-1][1], f"{road_name} Jct")
                if u_id == v_id:
                    continue

                pair_sig = (min(u_id, v_id), max(u_id, v_id), road_name)
                if pair_sig in seen_segments:
                    continue
                seen_segments.add(pair_sig)

                total_dist = 0.0
                for i in range(len(geom) - 1):
                    total_dist += haversine_km(geom[i][0], geom[i][1], geom[i + 1][0], geom[i + 1][1])
                straight = haversine_km(geom[0][0], geom[0][1], geom[-1][0], geom[-1][1])
                total_dist = max(total_dist, straight)
                if total_dist <= 0.0:
                    continue

                speed_limit = _corridor_speed_from_name(
                    road_name,
                    float(step.get("distance", 0.0)),
                    float(step.get("duration", 0.0)),
                )
                # Bias direct corridor 0 slightly more congested on busy arterials so detours compete
                traffic_factor = _deterministic_traffic_factor(
                    f"corridor:{corridor_idx}:{road_name}:{u_id}:{v_id}",
                    congested_bias=(corridor_idx == 0 and speed_limit <= 55.0),
                )

                raw_edges.append(
                    RoadEdge(
                        id=f"E{edge_counter}",
                        source=u_id,
                        target=v_id,
                        road_name=road_name,
                        distance_km=total_dist,
                        speed_limit_kmph=speed_limit,
                        traffic_weight=traffic_factor,
                        bidirectional=True,
                        blocked=False,
                        geometry=geom,
                    )
                )
                edge_counter += 1

    if not raw_edges:
        raise OSMServiceError("Fallback corridor assembly yielded zero traversable segments.")

    largest_comp, filtered_edges = _retain_largest_component(raw_edges)
    filtered_nodes = {nid: nodes[nid] for nid in largest_comp if nid in nodes}
    max_speed = max(80.0, max(e.speed_limit_kmph for e in filtered_edges))

    return CityGraph(
        city="Fast Corridor Graph",
        max_speed_kmph=max_speed,
        nodes=filtered_nodes,
        raw_edges=filtered_edges,
    )


def snap_to_nearest_node(
    graph: CityGraph,
    lat: float,
    lng: float,
) -> tuple[str, float]:
    """Find the closest intersection node in graph to (lat, lng)."""
    best_id = ""
    best_dist = float("inf")
    for node in graph.nodes.values():
        d = haversine_km(lat, lng, node.lat, node.lng)
        if d < best_dist:
            best_dist = d
            best_id = node.id
    if not best_id:
        raise OSMServiceError("Graph contains no valid intersection nodes.")
    return best_id, best_dist


def _prune_cache() -> None:
    """Remove expired entries and enforce CACHE_MAX_REGIONS limit."""
    now = time.time()
    expired = [
        key for key, (ts, _, _) in _GRAPH_CACHE.items() if now - ts > CACHE_TTL_SECONDS
    ]
    for key in expired:
        _GRAPH_CACHE.pop(key, None)
    while len(_GRAPH_CACHE) > CACHE_MAX_REGIONS:
        _GRAPH_CACHE.popitem(last=False)


def _live_cache_key(
    start_lat: float,
    start_lng: float,
    goal_lat: float,
    goal_lng: float,
    tier_name: str,
) -> tuple[tuple[tuple[float, float], tuple[float, float]], str]:
    """Order-independent cache key for (start, goal, tier) rounded to ~110m."""
    p1 = (round(start_lat, 3), round(start_lng, 3))
    p2 = (round(goal_lat, 3), round(goal_lng, 3))
    pair = (p1, p2) if p1 <= p2 else (p2, p1)
    return (pair, tier_name)


def get_cached_live_graph(
    start_lat: float,
    start_lng: float,
    goal_lat: float,
    goal_lng: float,
) -> tuple[CityGraph, dict[str, Any]] | None:
    """Return cached live graph if already extracted, without external HTTP calls."""
    straight_km = haversine_km(start_lat, start_lng, goal_lat, goal_lng)
    if straight_km > MAX_LIVE_DISTANCE_KM:
        return None
    tier_name, _ = select_road_tier(straight_km)
    cache_key = _live_cache_key(start_lat, start_lng, goal_lat, goal_lng, tier_name)
    _prune_cache()
    cached = _GRAPH_CACHE.get(cache_key)
    if cached is None:
        return None
    _, graph, graph_source = cached
    _GRAPH_CACHE.move_to_end(cache_key)
    start_node_id, snap_start_km = snap_to_nearest_node(graph, start_lat, start_lng)
    goal_node_id, snap_goal_km = snap_to_nearest_node(graph, goal_lat, goal_lng)
    meta = {
        "road_tier": tier_name,
        "graph_source": graph_source,
        "cache_hit": True,
        "straight_distance_km": round(straight_km, 2),
        "long_distance_notice": "Long-distance highway mode active"
        if straight_km > LONG_DISTANCE_THRESHOLD_KM
        else None,
        "start_node_id": start_node_id,
        "goal_node_id": goal_node_id,
        "snap_start_km": round(snap_start_km, 3),
        "snap_goal_km": round(snap_goal_km, 3),
    }
    return graph, meta


def get_live_graph(
    start_lat: float,
    start_lng: float,
    goal_lat: float,
    goal_lng: float,
) -> tuple[CityGraph, dict[str, Any]]:
    """Return cached/fresh OSM CityGraph, using fast corridor graph for >10km or busy Overpass."""
    straight_km = haversine_km(start_lat, start_lng, goal_lat, goal_lng)
    tier_name, highway_regex = select_road_tier(straight_km)
    bbox = compute_padded_bbox(start_lat, start_lng, goal_lat, goal_lng)
    cache_key = _live_cache_key(start_lat, start_lng, goal_lat, goal_lng, tier_name)

    _prune_cache()
    cached = _GRAPH_CACHE.get(cache_key)
    cache_hit = False

    if cached is not None:
        _, graph, graph_source = cached
        _GRAPH_CACHE.move_to_end(cache_key)
        cache_hit = True
    elif straight_km > OVERPASS_MAX_DISTANCE_KM:
        # Skip Overpass completely above 10 km so routes resolve in 1-2s
        graph = build_corridor_fallback_graph(start_lat, start_lng, goal_lat, goal_lng)
        graph_source = "corridor_fallback"
        _GRAPH_CACHE[cache_key] = (time.time(), graph, graph_source)
        _prune_cache()
    else:
        try:
            elements = fetch_overpass_elements(bbox, tier_name, highway_regex)
            graph = contract_osm_data(
                elements,
                city_label=f"Live OSM ({tier_name.title()})",
                start_coords=(start_lat, start_lng),
                goal_coords=(goal_lat, goal_lng),
            )
            graph_source = "overpass"
        except OSMServiceError:
            graph = build_corridor_fallback_graph(start_lat, start_lng, goal_lat, goal_lng)
            graph_source = "corridor_fallback"

        _GRAPH_CACHE[cache_key] = (time.time(), graph, graph_source)
        _prune_cache()

    start_node_id, snap_start_km = snap_to_nearest_node(graph, start_lat, start_lng)
    goal_node_id, snap_goal_km = snap_to_nearest_node(graph, goal_lat, goal_lng)

    long_distance_notice = (
        "Long-distance highway mode active"
        if straight_km > LONG_DISTANCE_THRESHOLD_KM
        else None
    )

    meta = {
        "road_tier": tier_name,
        "graph_source": graph_source,
        "cache_hit": cache_hit,
        "straight_distance_km": round(straight_km, 2),
        "long_distance_notice": long_distance_notice,
        "start_node_id": start_node_id,
        "goal_node_id": goal_node_id,
        "snap_start_km": round(snap_start_km, 3),
        "snap_goal_km": round(snap_goal_km, 3),
    }
    return graph, meta

"""Flask web server providing Offline Preset, Custom Offline Places, and Live Multi-Modal APIs."""

from __future__ import annotations

import json
import math
import os
import socket
import time
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, make_response, render_template, request, send_from_directory

from core.graph import (
    MAX_TRAFFIC_WEIGHT,
    MIN_TRAFFIC_WEIGHT,
    VALID_LIVE_PRESETS,
    VALID_MODES,
    VALID_PRESETS,
    CityGraph,
)
from core.modes import (
    ROAD_VEHICLES,
    VALID_VEHICLES,
    compute_all_mode_estimates,
    run_vehicle_route,
)
from core.offline_store import (
    DEFAULT_PLACES_PATH,
    MAX_PLACE_NAME_LEN,
    build_merged_offline_graph,
    delete_custom_place,
    is_read_only_fs,
    load_saved_places,
    save_custom_place,
)
from core.osm_loader import (
    LONG_DISTANCE_THRESHOLD_KM,
    OSMServiceError,
    RegionTooLargeError,
    geocode_place,
    get_cached_live_graph,
    get_live_graph,
    reverse_geocode,
)
from core.heuristics import haversine_km

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "city_map.json"
STATIC_DIR = BASE_DIR / "static"

MAX_GEOCODE_QUERY_LEN: int = 120
MAX_TRAFFIC_OVERRIDES: int = 500
CONNECTIVITY_CACHE_TTL_S: float = 5.0

app = Flask(__name__, static_folder=None, template_folder=str(BASE_DIR / "templates"))

# Active in-memory base city road network state for Offline Preset simulation.
CITY_GRAPH: CityGraph = CityGraph.from_json_file(DATA_PATH)
PLACES_PATH: Path = DEFAULT_PLACES_PATH

_connectivity_cache: tuple[float, bool] = (0.0, True)


def _parse_finite_float(
    value: Any,
    min_val: float,
    max_val: float,
    field_name: str,
) -> float:
    """Validate and parse a finite float within [min_val, max_val], rejecting bool/NaN/Inf."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"'{field_name}' must be a valid finite number.")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"'{field_name}' must be a valid finite number.") from exc
    if not math.isfinite(parsed):
        raise ValueError(f"'{field_name}' must be a finite number.")
    if parsed < min_val or parsed > max_val:
        raise ValueError(
            f"'{field_name}' must be between {min_val} and {max_val}, got {parsed}."
        )
    return parsed


def _validate_traffic_overrides(raw_overrides: Any) -> dict[str, Any] | None:
    """Validate shape, size, and numeric bounds of traffic_overrides payload."""
    if raw_overrides is None:
        return None
    if not isinstance(raw_overrides, dict):
        raise ValueError("'traffic_overrides' must be a JSON object.")
    if len(raw_overrides) > MAX_TRAFFIC_OVERRIDES:
        raise ValueError(
            f"'traffic_overrides' cannot exceed {MAX_TRAFFIC_OVERRIDES} entries."
        )

    cleaned: dict[str, Any] = {}
    for raw_key, raw_val in raw_overrides.items():
        if not isinstance(raw_key, str) or not raw_key.strip():
            raise ValueError("Edge override keys must be non-empty strings.")
        if isinstance(raw_val, (int, float)) and not isinstance(raw_val, bool):
            weight = _parse_finite_float(
                raw_val, MIN_TRAFFIC_WEIGHT, MAX_TRAFFIC_WEIGHT, f"override[{raw_key}]"
            )
            cleaned[raw_key] = weight
        elif isinstance(raw_val, dict):
            entry: dict[str, Any] = {}
            if "traffic_weight" in raw_val:
                entry["traffic_weight"] = _parse_finite_float(
                    raw_val["traffic_weight"],
                    MIN_TRAFFIC_WEIGHT,
                    MAX_TRAFFIC_WEIGHT,
                    "traffic_weight",
                )
            elif "traffic_factor" in raw_val:
                entry["traffic_factor"] = _parse_finite_float(
                    raw_val["traffic_factor"],
                    MIN_TRAFFIC_WEIGHT,
                    MAX_TRAFFIC_WEIGHT,
                    "traffic_factor",
                )
            if "blocked" in raw_val:
                if not isinstance(raw_val["blocked"], bool):
                    raise ValueError("'blocked' must be a boolean.")
                entry["blocked"] = raw_val["blocked"]
            cleaned[raw_key] = entry
        else:
            raise ValueError(f"Invalid override payload for '{raw_key}'.")

    return cleaned


def _validate_custom_places(raw_places: Any) -> list[dict[str, Any]]:
    """Validate optional stateless custom_places array for serverless offline routing."""
    if raw_places is None:
        return []
    if not isinstance(raw_places, list):
        raise ValueError("'custom_places' must be an array.")
    if len(raw_places) > 100:
        raise ValueError("'custom_places' cannot exceed 100 entries.")

    validated: list[dict[str, Any]] = []
    for idx, item in enumerate(raw_places, start=1):
        if not isinstance(item, dict):
            raise ValueError("'custom_places' entries must be JSON objects.")
        name = str(item.get("name", "")).strip()
        if not name or len(name) > MAX_PLACE_NAME_LEN:
            raise ValueError(
                f"Custom place name must be between 1 and {MAX_PLACE_NAME_LEN} characters."
            )
        lat = _parse_finite_float(item.get("lat"), -90.0, 90.0, "custom_places.lat")
        lng = _parse_finite_float(item.get("lng"), -180.0, 180.0, "custom_places.lng")
        pid = str(item.get("id") or f"U{idx}").strip().upper()
        connectors = item.get("connectors")
        validated.append(
            {
                "id": pid,
                "name": name,
                "lat": lat,
                "lng": lng,
                "category": str(item.get("category") or "custom")[:32],
                "connectors": connectors if isinstance(connectors, list) else [],
            }
        )
    return validated


def _merged_offline_payload() -> dict[str, Any]:
    """Serialize merged offline graph with saved-place indicators."""
    merged = build_merged_offline_graph(CITY_GRAPH, places_path=PLACES_PATH)
    saved_ids = {str(p["id"]) for p in load_saved_places(PLACES_PATH)}
    payload = merged.to_dict()
    for node in payload["nodes"]:
        node["saved"] = node["id"] in saved_ids
    return payload


@app.after_request
def add_security_headers(response: Any) -> Any:
    """Attach standard browser security headers to every HTTP response."""
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


@app.errorhandler(400)
def handle_bad_request(err: Any) -> tuple[Any, int]:
    """Return clean JSON on 400 errors for API endpoints."""
    if request.path.startswith("/api/"):
        return jsonify({"error": getattr(err, "description", "Bad request.")}), 400
    return "Bad Request", 400


@app.errorhandler(404)
def handle_not_found(err: Any) -> tuple[Any, int]:
    """Return clean JSON on 404 errors for API endpoints."""
    if request.path.startswith("/api/"):
        return jsonify({"error": "Requested API endpoint was not found."}), 404
    return "Not Found", 404


@app.errorhandler(405)
def handle_method_not_allowed(err: Any) -> tuple[Any, int]:
    """Return clean JSON on 405 errors for API endpoints."""
    if request.path.startswith("/api/"):
        return jsonify({"error": "HTTP method not allowed for this endpoint."}), 405
    return "Method Not Allowed", 405


@app.errorhandler(500)
def handle_internal_error(err: Any) -> tuple[Any, int]:
    """Never leak raw Python tracebacks on /api/* 500 responses."""
    if request.path.startswith("/api/"):
        return jsonify({"error": "An unexpected internal server error occurred."}), 500
    return "Internal Server Error", 500


@app.route("/", methods=["GET"])
def index() -> str:
    """Serve the AstraPath single-page dashboard."""
    return render_template("index.html")


@app.route("/static/<path:filename>", endpoint="static", methods=["GET"])
def serve_static_files(filename: str) -> Any:
    """Serve static assets explicitly for both Vercel serverless and local Flask."""
    return send_from_directory(STATIC_DIR, filename)


@app.route("/sw.js", methods=["GET"])
def service_worker() -> Any:
    """Serve the PWA Service Worker from root scope with proper headers."""
    resp = make_response(send_from_directory(BASE_DIR / "static", "sw.js"))
    resp.headers["Content-Type"] = "application/javascript"
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/api/offline-bundle", methods=["GET"])
def get_offline_bundle() -> Any:
    """Return static offline datasets bundled for browser-side caching and execution."""
    data_dir = BASE_DIR / "data"
    bundle = {
        "city_graph": json.loads((data_dir / "city_map.json").read_text(encoding="utf-8")),
        "rail_network": json.loads((data_dir / "rail_network.json").read_text(encoding="utf-8")),
        "airports": json.loads((data_dir / "airports.json").read_text(encoding="utf-8")),
    }
    resp = make_response(jsonify(bundle), 200)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.route("/api/connectivity", methods=["GET"])
def check_connectivity() -> tuple[Any, int]:
    """Perform a fast 1.5s cached connectivity check."""
    global _connectivity_cache
    now = time.monotonic()
    cached_ts, cached_online = _connectivity_cache
    if now - cached_ts < CONNECTIVITY_CACHE_TTL_S:
        return jsonify({"online": cached_online}), 200

    is_online = False
    try:
        with socket.create_connection(("tile.openstreetmap.org", 443), timeout=1.5):
            is_online = True
    except OSError:
        is_online = False

    _connectivity_cache = (now, is_online)
    return jsonify({"online": is_online}), 200


@app.route("/api/graph", methods=["GET"])
def get_graph() -> tuple[Any, int]:
    """Return merged offline intersections, saved places, and road edges."""
    return jsonify(_merged_offline_payload()), 200


@app.route("/api/offline/places", methods=["GET"])
def get_offline_places() -> tuple[Any, int]:
    """Return all user-saved custom places alongside merged offline graph nodes."""
    saved = load_saved_places(PLACES_PATH)
    merged = _merged_offline_payload()
    return jsonify({"places": saved, "nodes": merged["nodes"]}), 200


@app.route("/api/offline/places", methods=["POST"])
def create_offline_place() -> tuple[Any, int]:
    """Save a custom place persistently and connect it into the offline graph."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be a JSON object."}), 400

    name = str(payload.get("name", "")).strip()
    category = str(payload.get("category", "custom")).strip()

    try:
        lat = _parse_finite_float(payload.get("lat"), -90.0, 90.0, "lat")
        lng = _parse_finite_float(payload.get("lng"), -180.0, 180.0, "lng")
        record = save_custom_place(
            name=name,
            lat=lat,
            lng=lng,
            base_graph=CITY_GRAPH,
            category=category,
            places_path=PLACES_PATH,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    storage_mode = str(record.get("storage", "disk"))
    status_code = 200 if storage_mode == "browser_only" else 201
    return (
        jsonify({"place": record, "storage": storage_mode, "graph": _merged_offline_payload()}),
        status_code,
    )


@app.route("/api/offline/places/<place_id>", methods=["DELETE"])
def remove_offline_place(place_id: str) -> tuple[Any, int]:
    """Remove a user-saved custom place and rebuild the offline graph."""
    if is_read_only_fs():
        return (
            jsonify(
                {
                    "deleted": place_id,
                    "storage": "browser_only",
                    "graph": _merged_offline_payload(),
                }
            ),
            200,
        )
    deleted = delete_custom_place(place_id.strip(), places_path=PLACES_PATH)
    if not deleted:
        return jsonify({"error": f"Saved place '{place_id}' was not found."}), 404
    return jsonify({"deleted": place_id, "storage": "disk", "graph": _merged_offline_payload()}), 200


@app.route("/api/route", methods=["POST"])
def compute_route() -> tuple[Any, int]:
    """Compute multi-modal optimal route on Offline graph (supporting dynamic GPS origin)."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be a JSON object."}), 400

    origin_coords = payload.get("origin_coords")
    start_id = str(payload.get("start", "")).strip().upper()
    end_id = str(payload.get("end", "")).strip().upper()
    mode = str(payload.get("mode", "fastest")).strip().lower()
    vehicle = str(payload.get("vehicle", "car")).strip().lower()
    compare_dijkstra = bool(payload.get("compare_dijkstra", True))

    if mode not in VALID_MODES:
        return (
            jsonify(
                {"error": f"Invalid mode '{mode}'. Expected one of {VALID_MODES}."}
            ),
            400,
        )
    if vehicle not in VALID_VEHICLES:
        return (
            jsonify(
                {"error": f"Invalid vehicle '{vehicle}'. Expected one of {VALID_VEHICLES}."}
            ),
            400,
        )

    validated_origin: dict[str, Any] | None = None
    if origin_coords is not None:
        if not isinstance(origin_coords, dict):
            return jsonify({"error": "'origin_coords' must be an object."}), 400
        try:
            o_lat = _parse_finite_float(origin_coords.get("lat"), -90.0, 90.0, "origin_coords.lat")
            o_lng = _parse_finite_float(origin_coords.get("lng"), -180.0, 180.0, "origin_coords.lng")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        validated_origin = {
            "lat": o_lat,
            "lng": o_lng,
            "name": str(origin_coords.get("name") or "My Location"),
        }
        start_id = "GPS_ORIGIN"

    if not start_id or not end_id:
        return jsonify({"error": "Both 'start' and 'end' node IDs are required."}), 400

    try:
        overrides = _validate_traffic_overrides(payload.get("traffic_overrides"))
        custom_places = _validate_custom_places(payload.get("custom_places"))
        merged_graph = build_merged_offline_graph(
            CITY_GRAPH,
            places_path=PLACES_PATH,
            origin_coords=validated_origin,
            custom_places=custom_places,
        )
        if start_id not in merged_graph.nodes:
            raise ValueError(f"Invalid start node ID: '{start_id}'.")
        if end_id not in merged_graph.nodes:
            raise ValueError(f"Invalid destination node ID: '{end_id}'.")

        s_node = merged_graph.nodes[start_id]
        g_node = merged_graph.nodes[end_id]
        start_tuple = (s_node.lat, s_node.lng, s_node.name)
        goal_tuple = (g_node.lat, g_node.lng, g_node.name)

        result = run_vehicle_route(
            road_graph=merged_graph,
            start_id=start_id,
            goal_id=end_id,
            start_coords=start_tuple,
            goal_coords=goal_tuple,
            vehicle=vehicle,
            mode=mode,
            traffic_overrides=overrides,
            include_dijkstra=compare_dijkstra,
        )
        result["mode_estimates"] = compute_all_mode_estimates(
            road_graph=merged_graph,
            start_id=start_id,
            goal_id=end_id,
            start_coords=start_tuple,
            goal_coords=goal_tuple,
            mode=mode,
            traffic_overrides=overrides,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(result), 200


@app.route("/api/traffic/preset", methods=["POST"])
def apply_traffic_preset() -> tuple[Any, int]:
    """Apply a traffic preset ('clear', 'rush_hour', 'random_jam', or 'default')."""
    global CITY_GRAPH

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be a JSON object."}), 400

    preset = str(payload.get("preset", "")).strip().lower()
    if preset == "default":
        CITY_GRAPH = CityGraph.from_json_file(DATA_PATH)
        return jsonify({"preset": "default", "graph": _merged_offline_payload()}), 200

    if preset not in VALID_PRESETS:
        return (
            jsonify(
                {
                    "error": (
                        f"Invalid preset '{preset}'. "
                        f"Expected one of {VALID_PRESETS + ('default',)}."
                    )
                }
            ),
            400,
        )

    raw_seed = payload.get("seed")
    seed: int | None = None
    if raw_seed is not None:
        if isinstance(raw_seed, bool) or not isinstance(raw_seed, int):
            return jsonify({"error": "'seed' must be an integer."}), 400
        seed = raw_seed

    CITY_GRAPH.apply_preset(preset, seed=seed)
    return jsonify({"preset": preset, "graph": _merged_offline_payload()}), 200


@app.route("/api/geocode", methods=["GET"])
def api_geocode() -> tuple[Any, int]:
    """Forward-geocode a place query via Photon with Nominatim fallback."""
    query = request.args.get("q", "").strip()
    if len(query) > MAX_GEOCODE_QUERY_LEN:
        return (
            jsonify(
                {
                    "error": f"Query length must be at most {MAX_GEOCODE_QUERY_LEN} characters.",
                    "results": [],
                }
            ),
            400,
        )
    if len(query) < 2:
        return jsonify({"results": []}), 200

    try:
        results = geocode_place(query, limit=5)
        return jsonify({"results": results}), 200
    except OSMServiceError:
        return (
            jsonify(
                {
                    "error": "Live geocoding service is unreachable. Try Offline mode.",
                    "results": [],
                }
            ),
            502,
        )


@app.route("/api/reverse-geocode", methods=["GET"])
def api_reverse_geocode() -> tuple[Any, int]:
    """Reverse-geocode validated map coordinates into a short readable label."""
    try:
        lat = _parse_finite_float(request.args.get("lat"), -90.0, 90.0, "lat")
        lng = _parse_finite_float(request.args.get("lng"), -180.0, 180.0, "lng")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(reverse_geocode(lat, lng)), 200


@app.route("/api/route-live", methods=["POST"])
def compute_route_live() -> tuple[Any, int]:
    """Dynamically extract an OSM intersection graph and run multi-modal A* + Dijkstra."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be a JSON object."}), 400

    start_obj = payload.get("start")
    goal_obj = payload.get("goal")
    mode = str(payload.get("mode", "fastest")).strip().lower()
    vehicle = str(payload.get("vehicle", "car")).strip().lower()
    compare_dijkstra = bool(payload.get("compare_dijkstra", True))
    traffic_preset = str(payload.get("traffic_preset", "normal")).strip().lower()

    if not isinstance(start_obj, dict) or not isinstance(goal_obj, dict):
        return (
            jsonify({"error": "Both 'start' and 'goal' coordinate objects are required."}),
            400,
        )

    try:
        start_lat = _parse_finite_float(start_obj.get("lat"), -90.0, 90.0, "start.lat")
        start_lng = _parse_finite_float(start_obj.get("lng"), -180.0, 180.0, "start.lng")
        goal_lat = _parse_finite_float(goal_obj.get("lat"), -90.0, 90.0, "goal.lat")
        goal_lng = _parse_finite_float(goal_obj.get("lng"), -180.0, 180.0, "goal.lng")
        overrides = _validate_traffic_overrides(payload.get("traffic_overrides"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if mode not in VALID_MODES:
        return jsonify({"error": f"Invalid mode '{mode}'. Expected one of {VALID_MODES}."}), 400
    if vehicle not in VALID_VEHICLES:
        return jsonify({"error": f"Invalid vehicle '{vehicle}'. Expected one of {VALID_VEHICLES}."}), 400
    if traffic_preset not in VALID_LIVE_PRESETS:
        return (
            jsonify(
                {
                    "error": (
                        f"Invalid traffic_preset '{traffic_preset}'. "
                        f"Expected one of {VALID_LIVE_PRESETS}."
                    )
                }
            ),
            400,
        )

    start_name = str(start_obj.get("name") or "Origin")
    goal_name = str(goal_obj.get("name") or "Destination")
    start_tuple = (start_lat, start_lng, start_name)
    goal_tuple = (goal_lat, goal_lng, goal_name)

    try:
        if vehicle in ROAD_VEHICLES:
            graph, meta = get_live_graph(start_lat, start_lng, goal_lat, goal_lng)
            effective_edges = graph.resolve_overrides(
                traffic_overrides=overrides,
                traffic_preset=traffic_preset,
            )
            start_id = meta["start_node_id"]
            goal_id = meta["goal_node_id"]
        else:
            cached = get_cached_live_graph(start_lat, start_lng, goal_lat, goal_lng)
            if cached is not None:
                graph, meta = cached
                effective_edges = graph.resolve_overrides(
                    traffic_overrides=overrides,
                    traffic_preset=traffic_preset,
                )
                start_id = meta["start_node_id"]
                goal_id = meta["goal_node_id"]
            else:
                graph = None
                effective_edges = {}
                start_id = None
                goal_id = None
                dist_km = haversine_km(start_lat, start_lng, goal_lat, goal_lng)
                meta = {
                    "start_node_id": None,
                    "goal_node_id": None,
                    "road_tier": "transit",
                    "graph_source": "rail_graph" if vehicle == "train" else "air_graph",
                    "cache_hit": False,
                    "snap_start_km": 0.0,
                    "snap_goal_km": 0.0,
                    "long_distance_notice": dist_km > LONG_DISTANCE_THRESHOLD_KM,
                }

        result = run_vehicle_route(
            road_graph=graph,
            start_id=start_id,
            goal_id=goal_id,
            start_coords=start_tuple,
            goal_coords=goal_tuple,
            vehicle=vehicle,
            mode=mode,
            traffic_overrides=overrides,
            traffic_preset=traffic_preset,
            include_dijkstra=compare_dijkstra,
        )
        mode_estimates = compute_all_mode_estimates(
            road_graph=graph,
            start_id=start_id,
            goal_id=goal_id,
            start_coords=start_tuple,
            goal_coords=goal_tuple,
            mode=mode,
            traffic_overrides=overrides,
            traffic_preset=traffic_preset,
        )
    except RegionTooLargeError as exc:
        return jsonify({"error": str(exc)}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSMServiceError:
        return (
            jsonify(
                {
                    "error": (
                        "Live map services are unreachable. Switch to Offline mode "
                        "in the top header to continue using the local Kolkata network."
                    )
                }
            ),
            502,
        )

    network_edges = []
    if graph is not None:
        for edge in graph.raw_edges:
            eff_weight, is_blocked = effective_edges[edge.directed_uid]
            network_edges.append(
                {
                    "id": edge.id,
                    "from": edge.source,
                    "to": edge.target,
                    "road_name": edge.road_name,
                    "distance_km": round(edge.distance_km, 3),
                    "speed_limit_kmph": edge.speed_limit_kmph,
                    "traffic_factor": round(eff_weight, 2),
                    "traffic_weight": round(eff_weight, 2),
                    "blocked": is_blocked,
                    "geometry": edge.geometry,
                    "segment_type": edge.segment_type,
                }
            )

    dijk = result.get("dijkstra")
    result["mode_estimates"] = mode_estimates
    result["graph_source"] = meta["graph_source"]
    result["long_distance_notice"] = meta["long_distance_notice"]
    result["graph_stats"] = {
        "total_intersections": len(graph.nodes) if graph is not None else 0,
        "total_roads": len(graph.raw_edges) if graph is not None else 0,
        "road_tier": meta["road_tier"],
        "graph_source": meta["graph_source"],
        "cache_hit": meta["cache_hit"],
        "snap_start_km": meta["snap_start_km"],
        "snap_goal_km": meta["snap_goal_km"],
    }
    if dijk is not None:
        result["comparison"] = {
            "astar_nodes": result["nodes_expanded"],
            "dijkstra_nodes": dijk["nodes_expanded"],
            "astar_ms": result["runtime_ms"],
            "dijkstra_ms": dijk["runtime_ms"],
            "reduction_pct": dijk["node_reduction_pct"],
        }
    else:
        result["comparison"] = None

    if graph is not None and start_id in graph.nodes:
        start_node = graph.nodes[start_id]
        result["snapped_start"] = {
            "id": start_node.id,
            "name": start_name,
            "lat": start_node.lat,
            "lng": start_node.lng,
        }
    else:
        result["snapped_start"] = {
            "id": "ORIGIN",
            "name": start_name,
            "lat": start_lat,
            "lng": start_lng,
        }

    if graph is not None and goal_id in graph.nodes:
        goal_node = graph.nodes[goal_id]
        result["snapped_goal"] = {
            "id": goal_node.id,
            "name": goal_name,
            "lat": goal_node.lat,
            "lng": goal_node.lng,
        }
    else:
        result["snapped_goal"] = {
            "id": "DEST",
            "name": goal_name,
            "lat": goal_lat,
            "lng": goal_lng,
        }
    result["network_edges"] = network_edges

    return jsonify(result), 200


if __name__ == "__main__":
    debug_mode = os.getenv("FLASK_DEBUG", "0") == "1"
    port = int(os.getenv("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=debug_mode)

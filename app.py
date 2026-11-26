"""Flask web server providing Offline Preset and Live Anywhere (OSM) route APIs."""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request

from core.graph import (
    MAX_TRAFFIC_WEIGHT,
    MIN_TRAFFIC_WEIGHT,
    VALID_LIVE_PRESETS,
    VALID_MODES,
    VALID_PRESETS,
    CityGraph,
)
from core.osm_loader import (
    OSMServiceError,
    RegionTooLargeError,
    geocode_place,
    get_live_graph,
    reverse_geocode,
)
from core.pathfinder import compare_algorithms

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "city_map.json"

MAX_GEOCODE_QUERY_LEN: int = 120
MAX_TRAFFIC_OVERRIDES: int = 500

app = Flask(__name__)

# Active in-memory city road network state for Offline Preset simulation.
CITY_GRAPH: CityGraph = CityGraph.from_json_file(DATA_PATH)


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


@app.route("/api/graph", methods=["GET"])
def get_graph() -> tuple[Any, int]:
    """Return all intersections and road edges for Offline Preset mode."""
    return jsonify(CITY_GRAPH.to_dict()), 200


@app.route("/api/route", methods=["POST"])
def compute_route() -> tuple[Any, int]:
    """Compute optimal route on Offline Preset graph using A* and Dijkstra."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be a JSON object."}), 400

    start_id = str(payload.get("start", "")).strip().upper()
    end_id = str(payload.get("end", "")).strip().upper()
    mode = str(payload.get("mode", "fastest")).strip().lower()

    if not start_id or not end_id:
        return jsonify({"error": "Both 'start' and 'end' node IDs are required."}), 400
    if mode not in VALID_MODES:
        return (
            jsonify(
                {"error": f"Invalid mode '{mode}'. Expected one of {VALID_MODES}."}
            ),
            400,
        )

    try:
        overrides = _validate_traffic_overrides(payload.get("traffic_overrides"))
        result = compare_algorithms(
            graph=CITY_GRAPH,
            start_id=start_id,
            goal_id=end_id,
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
        return jsonify({"preset": "default", "graph": CITY_GRAPH.to_dict()}), 200

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
    return jsonify({"preset": preset, "graph": CITY_GRAPH.to_dict()}), 200


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
    """Dynamically extract an OSM intersection graph and run custom A* + Dijkstra."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be a JSON object."}), 400

    start_obj = payload.get("start")
    goal_obj = payload.get("goal")
    mode = str(payload.get("mode", "fastest")).strip().lower()
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

    try:
        graph, meta = get_live_graph(start_lat, start_lng, goal_lat, goal_lng)
        effective_edges = graph.resolve_overrides(
            traffic_overrides=overrides,
            traffic_preset=traffic_preset,
        )
        result = compare_algorithms(
            graph=graph,
            start_id=meta["start_node_id"],
            goal_id=meta["goal_node_id"],
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

    start_node = graph.nodes[meta["start_node_id"]]
    goal_node = graph.nodes[meta["goal_node_id"]]

    network_edges = []
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
            }
        )

    dijk = result["dijkstra"]
    result["graph_source"] = meta["graph_source"]
    result["long_distance_notice"] = meta["long_distance_notice"]
    result["graph_stats"] = {
        "total_intersections": len(graph.nodes),
        "total_roads": len(graph.raw_edges),
        "road_tier": meta["road_tier"],
        "graph_source": meta["graph_source"],
        "cache_hit": meta["cache_hit"],
        "snap_start_km": meta["snap_start_km"],
        "snap_goal_km": meta["snap_goal_km"],
    }
    result["comparison"] = {
        "astar_nodes": result["nodes_expanded"],
        "dijkstra_nodes": dijk["nodes_expanded"],
        "astar_ms": result["runtime_ms"],
        "dijkstra_ms": dijk["runtime_ms"],
        "reduction_pct": dijk["node_reduction_pct"],
    }
    result["snapped_start"] = {
        "id": start_node.id,
        "name": str(start_obj.get("name") or start_node.name),
        "lat": start_node.lat,
        "lng": start_node.lng,
    }
    result["snapped_goal"] = {
        "id": goal_node.id,
        "name": str(goal_obj.get("name") or goal_node.name),
        "lat": goal_node.lat,
        "lng": goal_node.lng,
    }
    result["network_edges"] = network_edges

    return jsonify(result), 200


if __name__ == "__main__":
    debug_mode = os.getenv("FLASK_DEBUG", "0") == "1"
    port = int(os.getenv("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=debug_mode)

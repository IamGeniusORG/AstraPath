"""Integration, security, validation, and CLI smoke tests for AstraPath."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from app import app

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def client():
    """Return a Flask test client."""
    app.config["TESTING"] = True
    with app.test_client() as test_client:
        yield test_client


def test_index_and_static_assets(client) -> None:
    """Ensure dashboard HTML, static CSS/JS, and security headers are served."""
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"AstraPath" in resp.data
    assert resp.headers.get("X-Content-Type-Options") == "nosniff"
    assert resp.headers.get("X-Frame-Options") == "SAMEORIGIN"
    assert resp.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"

    css_resp = client.get("/static/css/style.css")
    assert css_resp.status_code == 200
    assert "text/css" in css_resp.headers.get("Content-Type", "")

    js_resp = client.get("/static/js/map.js")
    assert js_resp.status_code == 200
    assert "javascript" in js_resp.headers.get("Content-Type", "")

    off_js_resp = client.get("/static/js/offline_engine.js")
    assert off_js_resp.status_code == 200
    assert "javascript" in off_js_resp.headers.get("Content-Type", "")

    svg_resp = client.get("/static/img/astrapath-logo.svg")
    assert svg_resp.status_code == 200

    sw_resp = client.get("/sw.js")
    assert sw_resp.status_code == 200


def test_get_graph_endpoint(client) -> None:
    """Verify GET /api/graph returns at least 32 Greater Kolkata nodes and 62 edges."""
    resp = client.get("/api/graph")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["city"] == "Kolkata Metro"
    assert len(data["nodes"]) >= 32
    assert len(data["edges"]) >= 62


def test_post_route_and_dijkstra_benchmark(client) -> None:
    """Verify POST /api/route computes optimal path and Dijkstra metrics."""
    resp = client.post(
        "/api/route",
        json={"start": "N1", "end": "N19", "mode": "fastest"},
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["found"] is True
    assert data["path"][0] == "N1"
    assert data["path"][-1] == "N19"
    assert data["nodes_expanded"] <= data["dijkstra"]["nodes_expanded"]
    assert data["total_distance_km"] > 0
    assert data["estimated_time_min"] > 0


def test_post_route_blocked_and_invalid(client) -> None:
    """Verify blocked unreachable routes and invalid requests return expected payloads."""
    blocked_resp = client.post(
        "/api/route",
        json={
            "start": "N1",
            "end": "N19",
            "mode": "fastest",
            "traffic_overrides": {
                "N18<->N19": {"blocked": True},
                "N16<->N19": {"blocked": True},
            },
        },
    )
    assert blocked_resp.status_code == 200
    blocked_data = blocked_resp.get_json()
    assert blocked_data["found"] is False
    assert blocked_data["path"] == []

    bad_node = client.post(
        "/api/route",
        json={"start": "NOPE", "end": "N19", "mode": "fastest"},
    )
    assert bad_node.status_code == 400


def test_traffic_presets_endpoint(client) -> None:
    """Verify POST /api/traffic/preset updates graph and resets cleanly."""
    for preset in ("clear", "rush_hour", "random_jam", "default"):
        resp = client.post("/api/traffic/preset", json={"preset": preset, "seed": 7})
        assert resp.status_code == 200
        payload = resp.get_json()
        assert payload["preset"] == preset
        assert len(payload["graph"]["edges"]) >= 62

    invalid = client.post("/api/traffic/preset", json={"preset": "gridlock"})
    assert invalid.status_code == 400


def test_api_security_validation_and_json_errors(client) -> None:
    """Reject malformed JSON, NaN/Inf/bool coordinates, huge overrides, and return JSON errors."""
    # Malformed JSON body -> 400 JSON
    malformed = client.post("/api/route", data="{bad json", content_type="application/json")
    assert malformed.status_code == 400
    assert "error" in malformed.get_json()

    # Unknown API route -> 404 JSON
    not_found = client.get("/api/does-not-exist")
    assert not_found.status_code == 404
    assert "error" in not_found.get_json()

    # Wrong HTTP method -> 405 JSON
    bad_method = client.get("/api/route")
    assert bad_method.status_code == 405
    assert "error" in bad_method.get_json()

    # NaN / out-of-range / boolean coordinates on /api/route-live -> 400
    for bad_lat in ("NaN", "Infinity", 95.0, -91.0, True, "abc"):
        resp = client.post(
            "/api/route-live",
            json={
                "start": {"lat": bad_lat, "lng": 88.35},
                "goal": {"lat": 22.58, "lng": 88.36},
            },
        )
        assert resp.status_code == 400

    # Reverse-geocode invalid coordinates -> 400
    rev_bad = client.get("/api/reverse-geocode?lat=NaN&lng=88.35")
    assert rev_bad.status_code == 400

    # Geocode query > 120 chars -> 400
    long_q = client.get(f"/api/geocode?q={'a' * 125}")
    assert long_q.status_code == 400

    # Over 500 traffic overrides -> 400
    too_many = {f"E{i}": {"traffic_factor": 1.2} for i in range(505)}
    over_resp = client.post(
        "/api/route",
        json={"start": "N1", "end": "N2", "traffic_overrides": too_many},
    )
    assert over_resp.status_code == 400


def test_cli_subprocess_smoke() -> None:
    """Verify cli.py runs cleanly in subprocess and diverges on N1 -> N17."""
    fast_proc = subprocess.run(
        [sys.executable, "cli.py", "--start", "N1", "--goal", "N17", "--mode", "fastest"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert fast_proc.returncode == 0
    assert "FASTEST" in fast_proc.stdout
    assert "A* Node Reduction" in fast_proc.stdout

    short_proc = subprocess.run(
        [sys.executable, "cli.py", "--start", "N1", "--goal", "N17", "--mode", "shortest"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert short_proc.returncode == 0
    assert "SHORTEST" in short_proc.stdout

    bad_proc = subprocess.run(
        [sys.executable, "cli.py", "--start", "INVALID", "--goal", "N17"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert bad_proc.returncode == 1
    assert "Invalid start node ID" in bad_proc.stderr


def test_multimodal_vehicles_and_admissibility(client) -> None:
    """Verify all 6 vehicle modes, admissibility, and mode_estimates."""
    from core.graph import CityGraph
    from core.heuristics import heuristic_time_min
    from core.modes import (
        ROAD_VEHICLES,
        build_air_multimodal_graph,
        build_rail_multimodal_graph,
        max_effective_speed_for_graph,
    )
    from core.pathfinder import astar_search, dijkstra_search

    g = CityGraph.from_json_file(PROJECT_ROOT / "data" / "city_map.json")

    for vehicle in ROAD_VEHICLES:
        a_res = astar_search(g, "N1", "N17", mode="fastest", vehicle=vehicle)
        d_res = dijkstra_search(g, "N1", "N17", mode="fastest", vehicle=vehicle)
        assert a_res.found and d_res.found
        assert a_res.total_cost == pytest.approx(d_res.total_cost, rel=1e-6)
        v_max = max_effective_speed_for_graph(g, vehicle)
        h_val = heuristic_time_min(g.nodes["N1"], g.nodes["N17"], v_max)
        assert h_val <= a_res.total_cost + 1e-6

    # Rail multimodal test (Kalyani -> Sealdah, ~45 km)
    rail_g, rail_reason = build_rail_multimodal_graph(
        22.9742, 88.4480, "Kalyani", 22.5677, 88.3712, "Sealdah"
    )
    assert rail_g is not None and rail_reason is None
    rail_a = astar_search(rail_g, "TRIP_START", "TRIP_GOAL", mode="fastest", vehicle="train")
    rail_d = dijkstra_search(rail_g, "TRIP_START", "TRIP_GOAL", mode="fastest", vehicle="train")
    assert rail_a.found and rail_d.found
    assert rail_a.total_cost == pytest.approx(rail_d.total_cost, rel=1e-6)

    # Rail too close (< 2 km) returns unavailable gracefully
    short_rail, short_reason = build_rail_multimodal_graph(
        22.5677, 88.3712, "Sealdah", 22.5690, 88.3720, "Near Sealdah"
    )
    assert short_rail is None and short_reason is not None

    # Flight multimodal test (Kolkata -> Delhi, ~1300 km)
    air_g, air_reason = build_air_multimodal_graph(
        22.5726, 88.3639, "Kolkata", 28.6139, 77.2090, "New Delhi"
    )
    assert air_g is not None and air_reason is None
    air_a = astar_search(air_g, "TRIP_START", "TRIP_GOAL", mode="fastest", vehicle="flight")
    air_d = dijkstra_search(air_g, "TRIP_START", "TRIP_GOAL", mode="fastest", vehicle="flight")
    assert air_a.found and air_d.found
    assert air_a.total_cost == pytest.approx(air_d.total_cost, rel=1e-6)
    assert any(seg.segment_type == "flight" and len(seg.geometry) == 40 for seg in air_a.segments)

    # Flight too short (< 150 km) returns unavailable
    local_air, local_reason = build_air_multimodal_graph(
        22.5839, 88.3426, "Howrah", 22.5736, 88.4335, "Sector V"
    )
    assert local_air is None and local_reason is not None

    # API mode_estimates check
    resp = client.post("/api/route", json={"start": "N1", "end": "N17", "vehicle": "bike"})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["vehicle"] == "bike"
    assert set(data["mode_estimates"].keys()) == {"car", "bike", "cycle", "walk", "train", "flight"}
    assert data["mode_estimates"]["flight"]["available"] is False


def test_offline_places_crud_and_offline_gps_routing(client, tmp_path, monkeypatch) -> None:
    """Verify saving, listing, routing with, and deleting custom places + Offline GPS."""
    import app as app_module

    temp_places = tmp_path / "offline_places.json"
    monkeypatch.setattr(app_module, "PLACES_PATH", temp_places)

    # Save a custom place without hitting external OSRM
    monkeypatch.setattr("core.offline_store._try_osrm_connector", lambda *a, **kw: None)

    create_resp = client.post(
        "/api/offline/places",
        json={"name": "Campus Gate", "lat": 22.5750, "lng": 88.4250, "category": "custom"},
    )
    assert create_resp.status_code == 201
    created = create_resp.get_json()
    place_id = created["place"]["id"]
    assert place_id == "U1"
    assert any(n["id"] == "U1" and n["saved"] for n in created["graph"]["nodes"])

    # List saved places
    list_resp = client.get("/api/offline/places")
    assert list_resp.status_code == 200
    assert len(list_resp.get_json()["places"]) == 1

    # Route using dynamic Offline GPS origin_coords -> saved place U1
    gps_route = client.post(
        "/api/route",
        json={
            "origin_coords": {"lat": 22.5830, "lng": 88.3450, "name": "My Location"},
            "end": "U1",
            "mode": "fastest",
            "vehicle": "car",
        },
    )
    assert gps_route.status_code == 200
    gps_data = gps_route.get_json()
    assert gps_data["found"] is True
    assert gps_data["path"][0] == "GPS_ORIGIN"
    assert gps_data["path"][-1] == "U1"

    # Delete saved place
    del_resp = client.delete(f"/api/offline/places/{place_id}")
    assert del_resp.status_code == 200
    assert not any(n["id"] == "U1" for n in del_resp.get_json()["graph"]["nodes"])


def test_connectivity_endpoint_schema(client) -> None:
    """Verify GET /api/connectivity returns boolean online field."""
    resp = client.get("/api/connectivity")
    assert resp.status_code == 200
    data = resp.get_json()
    assert isinstance(data.get("online"), bool)


def test_long_distance_live_transit_and_compare_toggle(client) -> None:
    """Verify train & flight work > 450 km without 400 and compare_dijkstra=False omits Dijkstra."""
    kolkata = {"lat": 22.5726, "lng": 88.3639, "name": "Kolkata"}
    delhi = {"lat": 28.6139, "lng": 77.2090, "name": "New Delhi"}

    for vehicle in ("train", "flight"):
        resp = client.post(
            "/api/route-live",
            json={
                "start": kolkata,
                "goal": delhi,
                "vehicle": vehicle,
                "mode": "fastest",
                "compare_dijkstra": False,
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["found"] is True
        assert data["vehicle"] == vehicle
        assert data["dijkstra"] is None
        assert data["comparison"] is None
        assert data["long_distance_notice"] is True
        assert set(data["mode_estimates"].keys()) == {"car", "bike", "cycle", "walk", "train", "flight"}

    # Offline route with compare_dijkstra=False also omits Dijkstra
    off_resp = client.post(
        "/api/route",
        json={"start": "N1", "end": "N17", "vehicle": "car", "compare_dijkstra": False},
    )
    assert off_resp.status_code == 200
    off_data = off_resp.get_json()
    assert off_data["found"] is True
    assert off_data["dijkstra"] is None
    assert off_data.get("comparison") is None


def test_vercel_offline_bundle_sw_stateless_places_and_readonly_fs(client, monkeypatch) -> None:
    """Verify /api/offline-bundle, /sw.js headers, stateless custom_places, and VERCEL=1 mode."""
    bundle_resp = client.get("/api/offline-bundle")
    assert bundle_resp.status_code == 200
    assert "max-age=86400" in bundle_resp.headers.get("Cache-Control", "")
    bundle = bundle_resp.get_json()
    assert {"city_graph", "rail_network", "airports"} <= set(bundle.keys())

    sw_resp = client.get("/sw.js")
    assert sw_resp.status_code == 200
    assert "javascript" in sw_resp.headers.get("Content-Type", "")
    assert sw_resp.headers.get("Cache-Control") == "no-cache"
    assert sw_resp.headers.get("Service-Worker-Allowed") == "/"

    # Stateless custom_places in POST /api/route
    stateless_route = client.post(
        "/api/route",
        json={
            "start": "N1",
            "end": "U99",
            "vehicle": "car",
            "custom_places": [
                {"id": "U99", "name": "Stateless Spot", "lat": 22.5750, "lng": 88.4250}
            ],
        },
    )
    assert stateless_route.status_code == 200
    s_data = stateless_route.get_json()
    assert s_data["found"] is True
    assert s_data["path"][-1] == "U99"

    # Simulate Vercel read-only filesystem: save & delete return 200 OK with storage="browser_only"
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setattr("core.offline_store._try_osrm_connector", lambda *a, **kw: None)

    ro_create = client.post(
        "/api/offline/places",
        json={"name": "Browser Only Pin", "lat": 22.5750, "lng": 88.4250},
    )
    assert ro_create.status_code == 200
    ro_payload = ro_create.get_json()
    assert ro_payload["storage"] == "browser_only"
    assert ro_payload["place"]["storage"] == "browser_only"

    ro_delete = client.delete("/api/offline/places/U1")
    assert ro_delete.status_code == 200
    assert ro_delete.get_json()["storage"] == "browser_only"


def test_ip_location_vercel_headers_and_decoding(client) -> None:
    """Verify GET /api/ip-location decodes Vercel IP headers and returns no-store."""
    resp = client.get(
        "/api/ip-location",
        headers={
            "X-Vercel-IP-Latitude": "28.6139",
            "X-Vercel-IP-Longitude": "77.2090",
            "X-Vercel-IP-City": "New%20Delhi",
            "X-Vercel-IP-Country-Region": "DL",
        },
    )
    assert resp.status_code == 200
    assert resp.headers.get("Cache-Control") == "no-store"
    data = resp.get_json()
    assert data["lat"] == pytest.approx(28.6139)
    assert data["lng"] == pytest.approx(77.2090)
    assert data["label"] == "New Delhi, DL"
    assert data["approximate"] is True
    assert data["source"] == "vercel_ip"

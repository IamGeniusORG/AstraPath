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

    js_resp = client.get("/static/js/map.js")
    assert js_resp.status_code == 200

    svg_resp = client.get("/static/img/astrapath-logo.svg")
    assert svg_resp.status_code == 200


def test_get_graph_endpoint(client) -> None:
    """Verify GET /api/graph returns 20 Kolkata nodes and 40 edges."""
    resp = client.get("/api/graph")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["city"] == "Kolkata Metro"
    assert len(data["nodes"]) == 20
    assert len(data["edges"]) == 40


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
        assert len(payload["graph"]["edges"]) == 40

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

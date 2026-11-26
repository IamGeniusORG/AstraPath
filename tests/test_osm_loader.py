"""Unit tests for OSM graph contraction, admissibility, snapping, and live API."""

from __future__ import annotations

import pytest

from app import app
from core.heuristics import haversine_km
from core.osm_loader import (
    OSMServiceError,
    RegionTooLargeError,
    build_corridor_fallback_graph,
    compute_padded_bbox,
    contract_osm_data,
    get_live_graph,
    select_road_tier,
    snap_to_nearest_node,
)
from core.pathfinder import astar_search, dijkstra_search


def _sample_osm_elements() -> list[dict]:
    """Build a synthetic OSM dataset with curved degree-2 nodes and an isolated island."""
    return [
        # Main connected network (curved road + alternate route + intersection)
        {"type": "node", "id": 1, "lat": 22.5700, "lon": 88.3500},
        {"type": "node", "id": 2, "lat": 22.5740, "lon": 88.3540},  # degree-2 bend
        {"type": "node", "id": 3, "lat": 22.5780, "lon": 88.3530},  # degree-2 bend
        {"type": "node", "id": 4, "lat": 22.5800, "lon": 88.3600},  # intersection
        {"type": "node", "id": 5, "lat": 22.5720, "lon": 88.3620},  # alternate corner
        # Disconnected tiny island (must be pruned by largest connected component)
        {"type": "node", "id": 99, "lat": 22.5900, "lon": 88.3900},
        {"type": "node", "id": 100, "lat": 22.5910, "lon": 88.3910},
        {
            "type": "way",
            "id": 1001,
            "nodes": [1, 2, 3, 4],
            "tags": {"highway": "primary", "name": "Curved Arterial Rd", "maxspeed": "50"},
        },
        {
            "type": "way",
            "id": 1002,
            "nodes": [1, 5, 4],
            "tags": {"highway": "tertiary", "name": "Bypass Lane"},
        },
        {
            "type": "way",
            "id": 2001,
            "nodes": [99, 100],
            "tags": {"highway": "residential", "name": "Isolated Island"},
        },
    ]


def test_contraction_preserves_admissibility_and_curved_geometry() -> None:
    """Contracting degree-2 nodes keeps curved geometry and distance_km >= haversine."""
    elements = _sample_osm_elements()
    graph = contract_osm_data(elements)

    # Node 5 is a degree-2 shape node on way 1002 so it contracts into curved edge 1<->4,
    # leaving true intersection endpoints OSM_1 and OSM_4 with 2 parallel curved routes.
    assert "OSM_99" not in graph.nodes
    assert "OSM_100" not in graph.nodes
    assert set(graph.nodes.keys()) == {"OSM_1", "OSM_4"}
    assert len(graph.raw_edges) == 2

    # Check admissibility invariants across all contracted edges
    assert graph.validate_admissibility() == []

    edges_1_to_4 = [e for e in graph.adj["OSM_1"] if e.target == "OSM_4"]
    assert len(edges_1_to_4) == 2
    arterial = next(e for e in edges_1_to_4 if e.road_name == "Curved Arterial Rd")
    assert len(arterial.geometry) == 4  # [1, 2, 3, 4] preserved
    straight = haversine_km(22.5700, 88.3500, 22.5800, 88.3600)
    assert arterial.distance_km > straight  # curved path strictly longer than chord

    # Blocking one parallel edge by id still allows routing via the other parallel edge
    rerouted = astar_search(
        graph,
        "OSM_1",
        "OSM_4",
        mode="fastest",
        traffic_overrides={arterial.id: {"blocked": True}},
    )
    assert rerouted.found is True
    assert rerouted.segments[0].road_name == "Bypass Lane"


def test_snapping_and_astar_on_contracted_graph() -> None:
    """Snapping finds nearest connected vertex and A* matches Dijkstra on contracted graph."""
    graph = contract_osm_data(_sample_osm_elements())
    start_id, snap_s = snap_to_nearest_node(graph, 22.5702, 88.3501)
    goal_id, snap_g = snap_to_nearest_node(graph, 22.5801, 88.3602)

    assert start_id == "OSM_1"
    assert goal_id == "OSM_4"
    assert snap_s < 0.1 and snap_g < 0.1

    a_res = astar_search(graph, start_id, goal_id, mode="fastest")
    d_res = dijkstra_search(graph, start_id, goal_id, mode="fastest")
    assert a_res.found and d_res.found
    assert a_res.total_cost == pytest.approx(d_res.total_cost)
    assert len(a_res.coordinates) >= 3  # curved coordinates retained


def test_road_tier_selection_and_distance_limit() -> None:
    """Verify adaptive Overpass tiers and 450 km safety rejection."""
    assert select_road_tier(2.5)[0] == "local"
    assert select_road_tier(8.0)[0] == "metro"
    assert select_road_tier(25.0)[0] == "regional"
    assert select_road_tier(80.0)[0] == "highway"

    with pytest.raises(RegionTooLargeError):
        select_road_tier(460.0)

    bbox = compute_padded_bbox(22.57, 88.35, 22.58, 88.36)
    assert bbox[0] < 22.57 and bbox[2] > 22.58


def test_corridor_fallback_graph_runs_custom_astar(monkeypatch) -> None:
    """When Overpass fails, get_live_graph builds a corridor graph and runs A*."""
    from core import osm_loader

    osm_loader._GRAPH_CACHE.clear()

    def _fail_overpass(*args, **kwargs):
        raise OSMServiceError("Overpass busy")

    def _fake_corridor(waypoints, alternatives=False):
        if len(waypoints) == 2:
            return [
                {
                    "legs": [
                        {
                            "steps": [
                                {
                                    "name": "NH19 Arterial",
                                    "distance": 4500.0,
                                    "duration": 360.0,
                                    "geometry": {
                                        "coordinates": [
                                            [88.3500, 22.5700],
                                            [88.3700, 22.5750],
                                            [88.3900, 22.5800],
                                        ]
                                    },
                                }
                            ]
                        }
                    ]
                }
            ]
        # Offset detour corridor
        mid = waypoints[1]
        return [
            {
                "legs": [
                    {
                        "steps": [
                            {
                                "name": "Bypass East",
                                "distance": 3000.0,
                                "duration": 180.0,
                                "geometry": {
                                    "coordinates": [
                                        [88.3500, 22.5700],
                                        [mid[1], mid[0]],
                                    ]
                                },
                            },
                            {
                                "name": "Bypass Connector",
                                "distance": 3000.0,
                                "duration": 180.0,
                                "geometry": {
                                    "coordinates": [
                                        [mid[1], mid[0]],
                                        [88.3900, 22.5800],
                                    ]
                                },
                            },
                        ]
                    }
                ]
            }
        ]

    monkeypatch.setattr(osm_loader, "fetch_overpass_elements", _fail_overpass)
    monkeypatch.setattr(osm_loader, "_fetch_osrm_corridor", _fake_corridor)

    graph, meta = get_live_graph(22.5700, 88.3500, 22.5800, 88.3900)
    assert meta["graph_source"] == "corridor_fallback"
    assert graph.validate_admissibility() == []

    res = astar_search(graph, meta["start_node_id"], meta["goal_node_id"], mode="fastest")
    assert res.found is True
    assert len(res.segments) >= 1


def test_route_live_api_validation() -> None:
    """Ensure /api/route-live validates coordinates, distance > 450 km, and presets."""
    app.config["TESTING"] = True
    with app.test_client() as client:
        # > 450 km (Kolkata to Delhi) must return 400 with friendly validation message
        too_far = client.post(
            "/api/route-live",
            json={
                "start": {"lat": 22.5726, "lng": 88.3639, "name": "Kolkata"},
                "goal": {"lat": 28.6139, "lng": 77.2090, "name": "New Delhi"},
                "mode": "fastest",
            },
        )
        assert too_far.status_code == 400
        assert "450" in too_far.get_json()["error"]

        bad_preset = client.post(
            "/api/route-live",
            json={
                "start": {"lat": 22.57, "lng": 88.35},
                "goal": {"lat": 22.58, "lng": 88.36},
                "traffic_preset": "invalid_preset",
            },
        )
        assert bad_preset.status_code == 400


def test_photon_geocoding_and_ttl_cache(monkeypatch) -> None:
    """Verify geocode_place uses Photon primary, caches results, and falls back to Nominatim."""
    from core import osm_loader

    osm_loader._GEOCODE_CACHE.clear()
    calls = {"photon": 0, "nominatim": 0}

    def _fake_photon(q, limit):
        calls["photon"] += 1
        return [{"name": "Howrah", "full_name": "Howrah, India", "lat": 22.5839, "lng": 88.3426}]

    def _fake_nominatim(q, limit):
        calls["nominatim"] += 1
        return [{"name": "Fallback", "full_name": "Fallback", "lat": 22.5, "lng": 88.3}]

    monkeypatch.setattr(osm_loader, "_geocode_via_photon", _fake_photon)
    monkeypatch.setattr(osm_loader, "_geocode_via_nominatim", _fake_nominatim)

    first = osm_loader.geocode_place("Howrah", limit=5)
    second = osm_loader.geocode_place("howrah", limit=5)
    assert len(first) == 1
    assert first == second
    assert calls["photon"] == 1  # second call served from TTL cache
    assert calls["nominatim"] == 0

    def _fail_photon(q, limit):
        import requests
        raise requests.RequestException("Photon down")

    monkeypatch.setattr(osm_loader, "_geocode_via_photon", _fail_photon)
    fallback = osm_loader.geocode_place("Kalyani", limit=5)
    assert fallback[0]["name"] == "Fallback"
    assert calls["nominatim"] == 1

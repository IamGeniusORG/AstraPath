"""Geographic distance and admissible A* heuristic functions."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.graph import CityNode

EARTH_RADIUS_KM: float = 6371.0
MINUTES_PER_HOUR: float = 60.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calculate great-circle distance in kilometers between two GPS coordinates.

    Args:
        lat1: Latitude of origin point in decimal degrees.
        lng1: Longitude of origin point in decimal degrees.
        lat2: Latitude of destination point in decimal degrees.
        lng2: Longitude of destination point in decimal degrees.

    Returns:
        Great-circle surface distance in kilometers.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lng2 - lng1)

    sin_half_dphi = math.sin(delta_phi / 2.0)
    sin_half_dlambda = math.sin(delta_lambda / 2.0)

    a = (
        sin_half_dphi * sin_half_dphi
        + math.cos(phi1) * math.cos(phi2) * sin_half_dlambda * sin_half_dlambda
    )
    central_angle = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return EARTH_RADIUS_KM * central_angle


def heuristic_distance_km(node: CityNode, goal: CityNode) -> float:
    """Admissible distance heuristic h(n) in kilometers for Shortest Path mode.

    Because every road segment satisfies distance_km >= haversine_km(u, v),
    the straight-line great-circle distance from node n to the goal never
    overestimates the true remaining road distance h*(n).
    """
    return haversine_km(node.lat, node.lng, goal.lat, goal.lng)


def heuristic_time_min(
    node: CityNode,
    goal: CityNode,
    max_speed_kmph: float,
) -> float:
    """Admissible travel-time heuristic h(n) in minutes for Fastest Path mode.

    Uses straight-line Haversine distance divided by the network-wide maximum
    speed limit (max_speed_kmph) with zero traffic delay (traffic_weight = 1.0).
    Since no actual path can be shorter than straight-line distance or faster
    than max_speed_kmph, h(n) <= h*(n) is guaranteed.
    """
    if max_speed_kmph <= 0:
        raise ValueError("max_speed_kmph must be positive.")
    straight_km = haversine_km(node.lat, node.lng, goal.lat, goal.lng)
    return (straight_km / max_speed_kmph) * MINUTES_PER_HOUR

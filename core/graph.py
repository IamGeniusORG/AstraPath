"""City road network data structures, loader, validation, and traffic simulation."""

from __future__ import annotations

import json
import random
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from core.heuristics import haversine_km

MINUTES_PER_HOUR: float = 60.0
MIN_TRAFFIC_WEIGHT: float = 1.0
MAX_TRAFFIC_WEIGHT: float = 10.0

VALID_MODES: tuple[str, ...] = ("fastest", "shortest")
VALID_PRESETS: tuple[str, ...] = ("clear", "rush_hour", "random_jam")
VALID_LIVE_PRESETS: tuple[str, ...] = ("normal", "clear", "rush_hour", "random_jam")

RUSH_HOUR_ARTERIAL_KEYWORDS: tuple[str, ...] = (
    "bridge",
    "bypass",
    "flyover",
    "ajc bose",
    "park",
    "chittaranjan",
    "strand",
    "vip",
    "rashbehari",
    "gariahat",
)


@dataclass(frozen=True)
class CityNode:
    """Represents a city road intersection with GPS coordinates."""

    id: str
    name: str
    lat: float
    lng: float

    def to_dict(self) -> dict[str, Any]:
        """Serialize node to a JSON-compatible dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "lat": self.lat,
            "lng": self.lng,
        }


@dataclass
class RoadEdge:
    """Represents a directed road segment between two intersections."""

    source: str
    target: str
    road_name: str
    distance_km: float
    speed_limit_kmph: float
    traffic_weight: float = 1.0
    bidirectional: bool = True
    blocked: bool = False
    id: str = ""
    geometry: list[list[float]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.id:
            self.id = f"{self.source}->{self.target}"

    @property
    def edge_key(self) -> str:
        """Canonical directed identifier for this edge."""
        return f"{self.source}->{self.target}"

    @property
    def directed_uid(self) -> str:
        """Unique directed identifier supporting parallel roads between identical nodes."""
        return f"{self.id}|{self.source}->{self.target}"

    def effective_speed_kmph(self, traffic_weight: float | None = None) -> float:
        """Return effective traversal speed (km/h) accounting for traffic multiplier."""
        weight = self.traffic_weight if traffic_weight is None else traffic_weight
        if weight < MIN_TRAFFIC_WEIGHT:
            raise ValueError(
                f"traffic_weight must be >= {MIN_TRAFFIC_WEIGHT}, got {weight}."
            )
        return self.speed_limit_kmph / weight

    def travel_time_min(self, traffic_weight: float | None = None) -> float:
        """Compute traversal time in minutes for this road segment."""
        speed = self.effective_speed_kmph(traffic_weight)
        return (self.distance_km / speed) * MINUTES_PER_HOUR

    def to_dict(self) -> dict[str, Any]:
        """Serialize edge to a JSON-compatible dictionary."""
        return {
            "id": self.id,
            "from": self.source,
            "to": self.target,
            "road_name": self.road_name,
            "distance_km": round(self.distance_km, 3),
            "speed_limit_kmph": self.speed_limit_kmph,
            "traffic_weight": round(self.traffic_weight, 2),
            "traffic_factor": round(self.traffic_weight, 2),
            "bidirectional": self.bidirectional,
            "blocked": self.blocked,
            "geometry": self.geometry,
        }


class CityGraph:
    """Weighted, traffic-aware directed graph modeling a city road network."""

    def __init__(
        self,
        city: str,
        max_speed_kmph: float,
        nodes: dict[str, CityNode],
        raw_edges: list[RoadEdge],
    ) -> None:
        self.city = city
        self.max_speed_kmph = max_speed_kmph
        self.nodes: dict[str, CityNode] = dict(nodes)
        self.raw_edges: list[RoadEdge] = list(raw_edges)
        self.adj: dict[str, list[RoadEdge]] = {node_id: [] for node_id in self.nodes}
        self._directed_lookup: dict[str, RoadEdge] = {}
        self._id_lookup: dict[str, list[RoadEdge]] = {}
        self._build_adjacency()

    def _build_adjacency(self) -> None:
        """Populate adjacency lists from canonical road definitions."""
        self.adj = {node_id: [] for node_id in self.nodes}
        self._directed_lookup = {}
        self._uid_lookup: dict[str, RoadEdge] = {}
        self._pair_lookup: dict[str, list[RoadEdge]] = {}
        self._id_lookup = {}

        for edge in self.raw_edges:
            if edge.source not in self.nodes or edge.target not in self.nodes:
                raise ValueError(
                    f"Edge {edge.source}->{edge.target} references unknown node."
                )
            self.adj[edge.source].append(edge)
            self._directed_lookup[edge.edge_key] = edge
            self._uid_lookup[edge.directed_uid] = edge
            self._pair_lookup.setdefault(edge.edge_key, []).append(edge)
            self._id_lookup.setdefault(edge.id, []).append(edge)

            if edge.bidirectional:
                reverse_geom = list(reversed(edge.geometry)) if edge.geometry else []
                reverse_edge = RoadEdge(
                    source=edge.target,
                    target=edge.source,
                    road_name=edge.road_name,
                    distance_km=edge.distance_km,
                    speed_limit_kmph=edge.speed_limit_kmph,
                    traffic_weight=edge.traffic_weight,
                    bidirectional=True,
                    blocked=edge.blocked,
                    id=edge.id,
                    geometry=reverse_geom,
                )
                self.adj[edge.target].append(reverse_edge)
                self._directed_lookup[reverse_edge.edge_key] = reverse_edge
                self._uid_lookup[reverse_edge.directed_uid] = reverse_edge
                self._pair_lookup.setdefault(reverse_edge.edge_key, []).append(reverse_edge)
                self._id_lookup.setdefault(edge.id, []).append(reverse_edge)

    @classmethod
    def from_json_file(cls, file_path: str | Path) -> CityGraph:
        """Load a CityGraph instance from a JSON map file."""
        path = Path(file_path)
        with path.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
        return cls.from_dict(payload)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> CityGraph:
        """Construct a CityGraph instance from a parsed JSON dictionary."""
        city = str(payload.get("city", "Unknown City"))
        max_speed_kmph = float(payload["max_speed_kmph"])
        if max_speed_kmph <= 0:
            raise ValueError("max_speed_kmph must be positive.")

        nodes: dict[str, CityNode] = {}
        for raw_node in payload.get("nodes", []):
            node = CityNode(
                id=str(raw_node["id"]),
                name=str(raw_node["name"]),
                lat=float(raw_node["lat"]),
                lng=float(raw_node["lng"]),
            )
            if node.id in nodes:
                raise ValueError(f"Duplicate node ID detected: {node.id}")
            nodes[node.id] = node

        raw_edges: list[RoadEdge] = []
        for item in payload.get("edges", []):
            edge = RoadEdge(
                source=str(item["from"]),
                target=str(item["to"]),
                road_name=str(item["road_name"]),
                distance_km=float(item["distance_km"]),
                speed_limit_kmph=float(item["speed_limit_kmph"]),
                traffic_weight=float(item.get("traffic_weight", MIN_TRAFFIC_WEIGHT)),
                bidirectional=bool(item.get("bidirectional", True)),
                blocked=bool(item.get("blocked", False)),
            )
            raw_edges.append(edge)

        return cls(
            city=city,
            max_speed_kmph=max_speed_kmph,
            nodes=nodes,
            raw_edges=raw_edges,
        )

    def get_neighbors(self, node_id: str) -> list[RoadEdge]:
        """Return all outgoing road edges from the given node."""
        if node_id not in self.adj:
            raise KeyError(f"Unknown node ID: {node_id}")
        return self.adj[node_id]

    def get_edge(self, source: str, target: str) -> RoadEdge | None:
        """Return the directed RoadEdge between source and target if present."""
        return self._directed_lookup.get(f"{source}->{target}")

    def edge_cost(
        self,
        edge: RoadEdge,
        mode: str,
        traffic_weight: float | None = None,
    ) -> float:
        """Compute edge traversal cost g-step according to routing mode.

        Args:
            edge: Directed road segment being traversed.
            mode: 'shortest' (km) or 'fastest' (minutes).
            traffic_weight: Optional traffic multiplier override (>= 1.0).
        """
        if mode == "shortest":
            return edge.distance_km
        if mode == "fastest":
            return edge.travel_time_min(traffic_weight)
        raise ValueError(f"Invalid routing mode '{mode}'. Expected one of {VALID_MODES}.")

    def validate_admissibility(self) -> list[str]:
        """Validate graph invariants required for admissible A* heuristics.

        Checks:
            1. Every edge satisfies distance_km >= haversine_km(u, v).
            2. Every edge satisfies 0 < speed_limit_kmph <= max_speed_kmph.
            3. Every edge satisfies traffic_weight >= 1.0.
            4. Graph is weakly/strongly connected across all nodes.
        """
        errors: list[str] = []

        for edge in self.raw_edges:
            u = self.nodes.get(edge.source)
            v = self.nodes.get(edge.target)
            if u is None or v is None:
                errors.append(f"Edge {edge.edge_key} references missing endpoint.")
                continue

            straight_km = haversine_km(u.lat, u.lng, v.lat, v.lng)
            if edge.distance_km < straight_km:
                errors.append(
                    f"Edge {edge.edge_key} ({edge.road_name}) has distance_km="
                    f"{edge.distance_km:.4f} < haversine_km={straight_km:.4f}."
                )

            if edge.speed_limit_kmph <= 0 or edge.speed_limit_kmph > self.max_speed_kmph:
                errors.append(
                    f"Edge {edge.edge_key} speed_limit_kmph={edge.speed_limit_kmph} "
                    f"must be in (0, {self.max_speed_kmph}]."
                )

            if edge.traffic_weight < MIN_TRAFFIC_WEIGHT:
                errors.append(
                    f"Edge {edge.edge_key} traffic_weight={edge.traffic_weight} "
                    f"must be >= {MIN_TRAFFIC_WEIGHT}."
                )

        if self.nodes and not self.is_connected():
            errors.append("Graph is not fully connected across all city nodes.")

        return errors

    def is_connected(self, ignore_blocked: bool = False) -> bool:
        """Return True if all nodes are reachable from the first node."""
        if not self.nodes:
            return True
        start_id = next(iter(self.nodes))
        visited: set[str] = {start_id}
        queue: deque[str] = deque([start_id])

        while queue:
            curr = queue.popleft()
            for edge in self.adj[curr]:
                if ignore_blocked and edge.blocked:
                    continue
                if edge.target not in visited:
                    visited.add(edge.target)
                    queue.append(edge.target)

        return len(visited) == len(self.nodes)

    def resolve_overrides(
        self,
        traffic_overrides: dict[str, Any] | None = None,
        traffic_preset: str | None = None,
        preset_seed: int | None = 42,
    ) -> dict[str, tuple[float, bool]]:
        """Build effective (traffic_weight, blocked) map keyed by directed_uid.

        Supports override keys formatted as 'N1->N2' (directed), 'N1<->N2' (both
        directions), or an edge's canonical 'id' (e.g., 'E12'). Override values
        can be a numeric traffic multiplier or a dict with
        {'traffic_weight'|'traffic_factor': float, 'blocked': bool}.
        """
        resolved: dict[str, tuple[float, bool]] = {
            uid: (edge.traffic_weight, edge.blocked)
            for uid, edge in self._uid_lookup.items()
        }

        if traffic_preset and traffic_preset != "normal":
            if traffic_preset not in VALID_PRESETS:
                raise ValueError(
                    f"Unknown traffic preset '{traffic_preset}'. Expected one of {VALID_LIVE_PRESETS}."
                )
            rng = random.Random(preset_seed)
            for edge in self.raw_edges:
                weight = self._preset_weight_for_edge(edge, traffic_preset, rng)
                for target_edge in self._id_lookup.get(edge.id, [edge]):
                    resolved[target_edge.directed_uid] = (weight, False)

        if not traffic_overrides:
            return resolved

        for raw_key, raw_val in traffic_overrides.items():
            clean_key = raw_key.strip()
            target_uids: list[str] = []
            if clean_key in self._id_lookup:
                target_uids = [e.directed_uid for e in self._id_lookup[clean_key]]
            elif "<->" in clean_key:
                left, right = [part.strip() for part in clean_key.split("<->", 1)]
                for pair_key in (f"{left}->{right}", f"{right}->{left}"):
                    target_uids.extend(
                        e.directed_uid for e in self._pair_lookup.get(pair_key, [])
                    )
            else:
                target_uids = [
                    e.directed_uid for e in self._pair_lookup.get(clean_key, [])
                ]

            if not target_uids:
                raise ValueError(f"Unknown edge key in traffic_overrides: '{raw_key}'")

            for uid in target_uids:
                current_weight, current_blocked = resolved[uid]
                if isinstance(raw_val, (int, float)):
                    new_weight = float(raw_val)
                    new_blocked = current_blocked
                elif isinstance(raw_val, dict):
                    weight_val = raw_val.get(
                        "traffic_weight",
                        raw_val.get("traffic_factor", current_weight),
                    )
                    new_weight = float(weight_val)
                    new_blocked = bool(raw_val.get("blocked", current_blocked))
                else:
                    raise ValueError(
                        f"Invalid override payload for '{raw_key}': {raw_val!r}"
                    )

                if new_weight < MIN_TRAFFIC_WEIGHT or new_weight > MAX_TRAFFIC_WEIGHT:
                    raise ValueError(
                        f"traffic_weight for '{raw_key}' must be between "
                        f"{MIN_TRAFFIC_WEIGHT} and {MAX_TRAFFIC_WEIGHT}, got {new_weight}."
                    )
                resolved[uid] = (new_weight, new_blocked)

        return resolved

    def _preset_weight_for_edge(
        self,
        edge: RoadEdge,
        preset: str,
        rng: random.Random,
    ) -> float:
        """Compute a traffic multiplier for an edge under a named preset."""
        name_lower = edge.road_name.lower()
        is_arterial = (
            any(kw in name_lower for kw in RUSH_HOUR_ARTERIAL_KEYWORDS)
            or edge.speed_limit_kmph >= 45
        )
        if preset == "clear":
            return 1.0 if not is_arterial else 1.1
        if preset == "rush_hour":
            return round(
                rng.uniform(1.75, 2.5) if is_arterial else rng.uniform(1.25, 1.75),
                2,
            )
        # random_jam
        roll = rng.random()
        if roll < 0.25:
            return round(rng.uniform(2.2, 3.2), 2)
        if roll < 0.6:
            return round(rng.uniform(1.35, 1.95), 2)
        return round(rng.uniform(1.0, 1.25), 2)

    def apply_preset(self, preset: str, seed: int | None = None) -> None:
        """Mutate active traffic weights on all edges according to a named preset."""
        if preset not in VALID_PRESETS:
            raise ValueError(
                f"Unknown traffic preset '{preset}'. Expected one of {VALID_PRESETS}."
            )

        rng = random.Random(seed)
        for edge in self.raw_edges:
            edge.blocked = False
            weight = self._preset_weight_for_edge(edge, preset, rng)
            edge.traffic_weight = max(MIN_TRAFFIC_WEIGHT, weight)
            reverse = self._directed_lookup.get(f"{edge.target}->{edge.source}")
            if reverse is not None and edge.bidirectional:
                reverse.traffic_weight = edge.traffic_weight
                reverse.blocked = False

    def set_edge_state(
        self,
        source: str,
        target: str,
        traffic_weight: float | None = None,
        blocked: bool | None = None,
        both_directions: bool = True,
    ) -> None:
        """Update traffic_weight and/or blocked state for a road segment."""
        edge = self.get_edge(source, target)
        if edge is None:
            raise KeyError(f"Edge {source}->{target} does not exist.")

        targets = [edge]
        if both_directions and edge.bidirectional:
            rev = self.get_edge(target, source)
            if rev is not None:
                targets.append(rev)

        for target_edge in targets:
            if traffic_weight is not None:
                if (
                    traffic_weight < MIN_TRAFFIC_WEIGHT
                    or traffic_weight > MAX_TRAFFIC_WEIGHT
                ):
                    raise ValueError(
                        f"traffic_weight must be between {MIN_TRAFFIC_WEIGHT} and {MAX_TRAFFIC_WEIGHT}."
                    )
                target_edge.traffic_weight = float(traffic_weight)
            if blocked is not None:
                target_edge.blocked = bool(blocked)

    def to_dict(self) -> dict[str, Any]:
        """Serialize current graph state for REST API responses."""
        return {
            "city": self.city,
            "max_speed_kmph": self.max_speed_kmph,
            "node_count": len(self.nodes),
            "edge_count": len(self.raw_edges),
            "nodes": [node.to_dict() for node in self.nodes.values()],
            "edges": [edge.to_dict() for edge in self.raw_edges],
        }

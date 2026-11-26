"""Standalone CLI interface for the Smart Route Optimization System."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from core.graph import VALID_MODES, VALID_PRESETS, CityGraph
from core.pathfinder import compare_algorithms

DEFAULT_MAP_PATH = Path(__file__).resolve().parent / "data" / "city_map.json"


def _print_nodes_table(graph: CityGraph) -> None:
    """Print all available city intersections in a clean aligned table."""
    print(f"\n=== {graph.city} Intersections ({len(graph.nodes)} nodes) ===")
    print(f"{'ID':<6} {'Intersection Name':<30} {'Latitude':>10} {'Longitude':>11}")
    print("-" * 61)
    for node in graph.nodes.values():
        print(f"{node.id:<6} {node.name:<30} {node.lat:>10.4f} {node.lng:>11.4f}")
    print()


def _print_route_report(
    graph: CityGraph,
    start_id: str,
    end_id: str,
    mode: str,
    preset: str | None,
    result: dict[str, Any],
) -> None:
    """Format and print route itinerary, telemetry, and A* vs Dijkstra comparison."""
    start_name = graph.nodes[start_id].name
    end_name = graph.nodes[end_id].name

    print("\n" + "=" * 78)
    print(f"SMART NAVIGATION REPORT  |  {graph.city}")
    print("=" * 78)
    print(f"Origin      : {start_id} - {start_name}")
    print(f"Destination : {end_id} - {end_name}")
    print(f"Mode        : {mode.upper()} ({'ETA min' if mode == 'fastest' else 'Distance km'})")
    print(f"Traffic     : {preset or 'default map weights'}")
    print("-" * 78)

    if not result["found"]:
        print(f"[NO ROUTE] {result.get('error', 'Destination unreachable.')}")
        print(
            f"Nodes explored before termination: A*={result['nodes_expanded']}, "
            f"Dijkstra={result['dijkstra']['nodes_expanded']}"
        )
        print("=" * 78 + "\n")
        return

    route_chain = " -> ".join(
        f"{nid} ({name})" for nid, name in zip(result["path"], result["path_names"])
    )
    print(f"Optimal Path ({len(result['path'])} nodes): {route_chain}")

    if result["segments"]:
        print("\nTurn-by-Turn Road Segments:")
        print(
            f"{'#':<3} {'Segment':<10} {'Road Name':<30} "
            f"{'Dist(km)':>8} {'Limit':>6} {'Traffic':>8} {'ETA(m)':>8}"
        )
        print("-" * 78)
        for idx, seg in enumerate(result["segments"], start=1):
            pair = f"{seg['from']}->{seg['to']}"
            print(
                f"{idx:<3} {pair:<10} {seg['road_name'][:29]:<30} "
                f"{seg['distance_km']:>8.2f} {seg['speed_limit_kmph']:>6.0f} "
                f"{seg['traffic_weight']:>7.2f}x {seg['travel_time_min']:>8.2f}"
            )
    else:
        print("\nOrigin and destination are identical (0 segments).")

    dijk = result["dijkstra"]
    print("\nAlgorithm Telemetry & Benchmark Comparison:")
    print(f"{'Metric':<28} {'A* Search':>18} {'Dijkstra Baseline':>20}")
    print("-" * 78)
    print(
        f"{'Total Distance (km)':<28} {result['total_distance_km']:>18.3f} "
        f"{dijk['total_distance_km']:>20.3f}"
    )
    print(
        f"{'Estimated Time (min)':<28} {result['estimated_time_min']:>18.2f} "
        f"{dijk['estimated_time_min']:>20.2f}"
    )
    print(
        f"{'Nodes Expanded':<28} {result['nodes_expanded']:>18d} "
        f"{dijk['nodes_expanded']:>20d}"
    )
    print(
        f"{'Runtime (ms)':<28} {result['runtime_ms']:>18.3f} "
        f"{dijk['runtime_ms']:>20.3f}"
    )
    print(f"{'A* Node Reduction (%)':<28} {dijk['node_reduction_pct']:>17.1f}%")
    print("=" * 78 + "\n")


def _prompt_interactive(graph: CityGraph) -> tuple[str, str, str, str | None]:
    """Prompt the user interactively for route parameters."""
    _print_nodes_table(graph)
    start_id = input("Enter Start Node ID (e.g., N1): ").strip().upper()
    end_id = input("Enter Destination Node ID (e.g., N19): ").strip().upper()
    mode_input = (
        input("Routing Mode [fastest/shortest] (default: fastest): ").strip().lower()
    )
    mode = mode_input if mode_input else "fastest"
    preset_input = (
        input("Traffic Preset [none/clear/rush_hour/random_jam] (default: none): ")
        .strip()
        .lower()
    )
    preset = None if preset_input in ("", "none") else preset_input
    return start_id, end_id, mode, preset


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Smart Route Optimization CLI (A* vs Dijkstra on Kolkata Road Network)"
    )
    parser.add_argument(
        "--map",
        type=Path,
        default=DEFAULT_MAP_PATH,
        help="Path to city map JSON file.",
    )
    parser.add_argument(
        "--list-nodes",
        action="store_true",
        help="List all intersections and exit.",
    )
    parser.add_argument("--start", type=str, help="Origin intersection ID (e.g., N1).")
    parser.add_argument(
        "--end",
        "--goal",
        dest="end",
        type=str,
        help="Destination intersection ID (e.g., N15).",
    )
    parser.add_argument(
        "--mode",
        choices=VALID_MODES,
        default="fastest",
        help="Optimization objective: 'fastest' (ETA) or 'shortest' (distance).",
    )
    parser.add_argument(
        "--preset",
        choices=VALID_PRESETS,
        default=None,
        help="Optional traffic simulation preset.",
    )
    parser.add_argument(
        "--block",
        action="append",
        default=[],
        help="Block a road segment, e.g., --block N10<->N16 (can be repeated).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    args = parse_args(argv)
    graph = CityGraph.from_json_file(args.map)

    if args.list_nodes:
        _print_nodes_table(graph)
        return 0

    if not args.start or not args.end:
        start_id, end_id, mode, preset = _prompt_interactive(graph)
    else:
        start_id = args.start.strip().upper()
        end_id = args.end.strip().upper()
        mode = args.mode
        preset = args.preset

    if preset is not None:
        try:
            graph.apply_preset(preset, seed=42)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1

    overrides: dict[str, Any] = {
        edge_key: {"blocked": True} for edge_key in args.block
    }

    try:
        result = compare_algorithms(
            graph=graph,
            start_id=start_id,
            goal_id=end_id,
            mode=mode,
            traffic_overrides=overrides or None,
        )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    _print_route_report(graph, start_id, end_id, mode, preset, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

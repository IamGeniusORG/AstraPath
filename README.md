<p align="center">
  <img src="static/img/astrapath-logo.svg" alt="AstraPath Logo" width="72" height="72" />
</p>

<h1 align="center">AstraPath</h1>

<p align="center">
  <strong>GPS-Based Smart Navigation &amp; Graph Route Optimization Engine</strong><br/>
  From-scratch Python <strong>A*</strong> &amp; <strong>Dijkstra</strong> pathfinding over live OpenStreetMap road networks and offline city graphs.
</p>

---

## Overview

**AstraPath** is a full-stack GPS route optimization system built to model real-world road networks as weighted directed graphs and compute the optimal **Shortest** (minimum distance in km) and **Fastest** (minimum traffic-adjusted travel time in minutes) path between any two intersections.

Unlike wrapper apps that outsource route calculation to external routing engines, AstraPath implements **A\*** and **Dijkstra** completely from scratch using Python's standard-library `heapq` binary min-heap in `core/pathfinder.py`, enforces strict heuristic admissibility invariants, and benchmarks node-expansion efficiency side-by-side.

### Dual Operating Modes

1. **Live Anywhere (OpenStreetMap):**
   - Search any two places worldwide (up to 450 km apart) via Nominatim geocoding, pick coordinates directly on the map, or use browser GPS (`My Location`).
   - Dynamically extracts drivable roads via Overpass (`out geom;`) using adaptive distance-based road tiers, contracts degree-2 shape nodes into curved road edges, isolates the largest connected component via BFS, and caches graphs in memory (15-minute TTL, up to 10 regions).
   - If Overpass mirrors are busy or overloaded, automatically constructs a multi-corridor fallback graph (`build_corridor_fallback_graph`) and still runs our custom Python A\* and Dijkstra on it—preventing demo failures.
2. **Offline Preset (Kolkata Metro):**
   - Runs 100% locally with zero internet dependency on a pre-validated 20-intersection, 40-bidirectional-road Kolkata network (`data/city_map.json`), available both in the browser UI (`Offline` toggle) and via the standalone terminal runner (`cli.py`).

---

## Features

- **Multi-Modal Travel Profiles (6 Modes):** Optimize routes for **Car**, **Bike** (reduced jam sensitivity + 60 km/h cap), **Cycle** (16 km/h, expressway avoidance), **Walk** (5 km/h pedestrian-safe paths), **Train** (32-station Indian & West Bengal rail network with access legs), and **Flight** (22-airport corridor graph with 40-point great-circle arcs for trips >150 km), with live ETA badges across all 6 modes in one response.
- **User-Saved Custom Offline Places:** Save any searched or map-picked place (`POST /api/offline/places`), automatically linked to its 3 nearest offline graph nodes and persisted in `data/offline_places.json` (plus `localStorage` backup) so A\* routes seamlessly even with zero internet.
- **Automatic Online ↔ Offline Sync & Offline GPS:** Checks connectivity at startup and via a visibility-aware heartbeat (`/api/connectivity`), switching cleanly between Live and Offline modes while respecting manual overrides; Offline mode supports one-click live GPS origin routing (`origin_coords`) with `localStorage` last-fix fallback.
- **Dual Optimization Objectives:** Switch instantaneously between **Fastest** (traffic-weighted ETA in minutes) and **Shortest** (road distance in km).
- **From-Scratch Graph Search & Benchmarking:** Pure-Python `heapq` A\* and Dijkstra returning exact path cost, runtime (`ms`), nodes expanded, percentage reduction, and per-node `(g, h, f)` evaluation scores.
- **Interactive Traffic Simulation & Road Closures:** Apply traffic presets (**Normal**, **Rush Hour**, **Heavy**, **Reset**) or click any road segment directly on the map to adjust congestion (`1.0x–3.0x`) or close the road (`blocked: true`).
- **60fps Cartographic Map-First UI:** Full-bleed `100vw × 100vh` Leaflet Canvas map (`preferCanvas: true`) with Google Maps-style **Layers** thumbnail popover (**Default / Dark / Satellite** + **Road Graph** / **Labels**), collapsible floating card, and 3-tab telemetry (**Directions**, **Algorithm**, **Traffic**).
- **Standalone CLI Deliverable:** Flag-based and interactive terminal application (`cli.py`) outputting formatted turn-by-turn road tables and A\* vs. Dijkstra comparisons.

---

## Architecture

```text
+-------------------------------------------------------------------------+
| Browser Frontend (templates/index.html, static/css/style.css, map.js)   |
|  - Leaflet Map (Map Light / Dark / Satellite)                           |
|  - Floating Waypoint Box, 3-Tab Panel (Directions / Algorithm / Traffic)|
|  - Cased Route Rendering, Frontier Wave Animation, Road Inspector       |
+------------------------------------+------------------------------------+
                                     | HTTP / JSON
                                     v
+-------------------------------------------------------------------------+
| Flask REST Server (app.py)                                              |
|  - Offline: GET /api/graph, POST /api/route, POST /api/traffic/preset   |
|  - Live:    GET /api/geocode, GET /api/reverse-geocode, POST /route-live|
+------------------+-----------------------------------+------------------+
                   |                                   |
                   v                                   v
+----------------------------------+  +-----------------------------------+
| Offline Network (data/)          |  | Dynamic OSM Loader (osm_loader.py)|
|  - city_map.json (20 nodes,      |  |  - Nominatim geocode / reverse    |
|    40 bidirectional Kolkata rds) |  |  - Overpass concurrent mirror race|
+------------------+---------------+  |  - Degree-2 graph contraction     |
                   |                  |  - Largest-component BFS snapping |
                   |                  |  - Multi-corridor fallback + cache|
                   |                  +-----------------+-----------------+
                   |                                    |
                   +-----------------+------------------+
                                     v
+-------------------------------------------------------------------------+
| Core Graph & Pathfinding Engine (core/)                                 |
|  - graph.py:      CityNode, RoadEdge, CityGraph, traffic overrides      |
|  - heuristics.py: Haversine great-circle distance & time lower bounds   |
|  - pathfinder.py: From-scratch heapq A* & Dijkstra + (g, h, f) trace    |
+-------------------------------------------------------------------------+
```

---

## Mathematical Model & Complexity

At every visited vertex $n$, A\* evaluates:

$$f(n) = g(n) + h(n)$$

where $g(n)$ is the exact accumulated traversal cost from the origin to $n$, and $h(n)$ is an admissible lower-bound heuristic estimate from $n$ to the goal.

### 1. Great-Circle Distance (Haversine)
Given two GPS coordinates $(\phi_1, \lambda_1)$ and $(\phi_2, \lambda_2)$ in radians with Earth radius $R = 6371.0\text{ km}$:

$$d_{\text{hav}}(u, v) = 2R \cdot \operatorname{atan2}\left(\sqrt{a},\ \sqrt{1 - a}\right), \quad a = \sin^2\left(\frac{\Delta\phi}{2}\right) + \cos\phi_1\cos\phi_2\sin^2\left(\frac{\Delta\lambda}{2}\right)$$

### 2. Shortest Path Mode (Distance in km)
- **Edge Cost:** $c(u, v) = \text{distance\_km}(u, v)$
- **Heuristic:** $h(n) = d_{\text{hav}}(n, \text{goal})$
- **Admissibility:** Every edge satisfies $\text{distance\_km}(u, v) \ge d_{\text{hav}}(u, v)$, so $h(n) \le h^*(n)$ always holds.

### 3. Fastest Path Mode (Travel Time in minutes)
- **Effective Speed:** $v_{\text{eff}}(u, v) = \frac{\text{speed\_limit\_kmph}(u, v)}{\text{traffic\_weight}(u, v)}$ where $\text{traffic\_weight} \ge 1.0$
- **Edge Cost:** $c(u, v) = \frac{\text{distance\_km}(u, v)}{v_{\text{eff}}(u, v)} \times 60$
- **Heuristic:** $h(n) = \frac{d_{\text{hav}}(n, \text{goal})}{\text{max\_speed\_kmph}} \times 60$
- **Admissibility:** Because $\text{speed\_limit\_kmph} \le \text{max\_speed\_kmph}$, $\text{traffic\_weight} \ge 1.0$, and road distance $\ge d_{\text{hav}}$, no real road path can beat straight-line travel at maximum network speed.

### 4. Complexity & Optimality
- **Time Complexity:** $O((V + E)\log V)$ using a binary min-heap (`heapq`) with lazy deletion of stale entries.
- **Space Complexity:** $O(V + E)$ for adjacency lists, `g_scores`, `came_from`, and the priority queue.
- **Optimality Guarantee:** Because both heuristics are admissible and consistent (via the spherical triangle inequality), A\* guarantees the exact same optimal path cost as Dijkstra ($h(n) = 0$) while expanding significantly fewer nodes on goal-directed queries.

---

## Installation & Running

### Prerequisites
- Python **3.10+** (verified on Python 3.14.5)
- `pip`

### Setup

#### Windows (PowerShell)
```powershell
git clone https://github.com/IamGeniusORG/AstraPath.git
cd AstraPath
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

#### macOS / Linux
```bash
git clone https://github.com/IamTeddy/AstraPath.git
cd AstraPath
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Launch the Web Application
```bash
python app.py
```
Then open **`http://127.0.0.1:5000`** in your browser.

### Run the Standalone CLI
```bash
# List all 20 Kolkata Metro intersections
python cli.py --list-nodes

# Fastest route from Howrah Station (N1) to Tollygunge Phari (N15)
python cli.py --start N1 --end N15 --mode fastest

# Shortest route under Rush Hour simulation with a blocked road
python cli.py --start N1 --end N19 --mode shortest --preset rush_hour --block "N10<->N16"

# Interactive guided prompt
python cli.py
```

---

## REST API Reference

| Method | Endpoint | Purpose | Request / Query Parameters |
| --- | --- | --- | --- |
| `GET` | `/` | Serves the AstraPath web dashboard | — |
| `GET` | `/api/connectivity` | Fast 1.5s cached online/offline check | — |
| `GET` | `/api/graph` | Returns merged offline intersections, saved places & edges | — |
| `GET` | `/api/offline/places` | Lists user-saved custom offline places & nodes | — |
| `POST` | `/api/offline/places` | Saves a custom place and links it to 3 nearest offline nodes | `{"name": "...", "lat": float, "lng": float}` |
| `DELETE` | `/api/offline/places/<id>` | Deletes a user-saved custom place | — |
| `POST` | `/api/route` | Runs multi-modal A\* & Dijkstra on offline graph | `{"start": "N1", "end": "N15", "vehicle": "car", "mode": "fastest", "origin_coords": {...}}` |
| `POST` | `/api/traffic/preset` | Updates offline graph traffic preset | `{"preset": "clear" \| "rush_hour" \| "random_jam" \| "default", "seed": 42}` |
| `GET` | `/api/geocode` | Forward-geocodes a place query via Photon (Nominatim fallback) | `?q=<place_query>` (2–120 chars) |
| `GET` | `/api/reverse-geocode` | Reverse-geocodes GPS coordinates into a short label | `?lat=<float>&lng=<float>` |
| `POST` | `/api/route-live` | Extracts/caches OSM graph & runs multi-modal A\* + Dijkstra | `{"start": {...}, "goal": {...}, "vehicle": "car"\|"bike"\|"cycle"\|"walk"\|"train"\|"flight", "mode": "fastest"\|"shortest"}` |
| `GET` | `/api/offline-bundle` | Returns `city_graph`, `rail_network`, and `airports` for browser offline caching | — |
| `GET` | `/sw.js` | Serves the lightweight app-shell PWA Service Worker from root scope | — |

---

## Deploying to Vercel

AstraPath is **100% Vercel-ready** out of the box with zero environment variables, zero external databases, and zero API keys required:

1. Push the repository to GitHub (or import directly via Vercel CLI: `vercel --prod`).
2. `vercel.json` routes `/static/*` directly from edge static hosting and routes `/`, `/sw.js`, and `/api/*` to `api/index.py` (`@vercel/python`).
3. **Read-Only Filesystem Safe:** On Vercel (`VERCEL=1`), user-saved offline places automatically switch to `storage: "browser_only"` (`localStorage`) instead of writing to disk, and `POST /api/route` accepts stateless `custom_places`.
4. **True Wi-Fi-Off Offline Mode:** On first visit, the PWA service worker (`static/sw.js`) caches the app shell and `/api/offline-bundle`, while `static/js/offline_engine.js` runs multi-modal A\*, Dijkstra comparison, and saved-place linking directly in the browser even when the network is completely disconnected.

---

## 100% Free Map Infrastructure & Fair-Use Policy

AstraPath is **100% free** with zero API keys, credit cards, or hidden charges. Every map and road-data layer runs on open-source software and free public OpenStreetMap (OSM) / community infrastructure.

### How AstraPath Accesses Map Data

| Component | What It Does in the App | Cost & Auth | Fair-Use Limits |
| --- | --- | --- | --- |
| **Leaflet.js** | Renders the interactive map viewer, pins, and polylines in the browser | Free (open-source JS library) | Unlimited (runs locally in the browser) |
| **OSM Standard Tiles** (`tile.openstreetmap.org`) | Loads the visual street map images on screen | Free, no API key | Requires `© OpenStreetMap` attribution, browser Referer/User-Agent, and no bulk offline downloading |
| **Overpass API** (`overpass-api.de` & mirrors) | Downloads raw real-world road segments and intersections so Python A\* can build a graph | Free, no API key | Shared community servers; roughly under 10,000 queries / 1 GB per day for one-off use on the main server, with automatic rate-limiting (HTTP 429) under heavy load |
| **Nominatim & Photon APIs** (`photon.komoot.io`, `nominatim.openstreetmap.org`) | Converts typed place names (e.g., *Kalyani City*) to GPS coordinates (Photon primary for autocomplete, Nominatim fallback + reverse geocoding) | Free, no API key | 15-min TTL cache; Nominatim throttled to **1 request/second** with custom `User-Agent` |
| **OSRM Public Server** (`router.project-osrm.org`) | Fallback that supplies alternate road corridors when Overpass mirrors are busy | Free public demo server | Best-effort only (no uptime guarantee; not for commercial traffic) |
| **Esri World Imagery** | Powers the optional **Satellite** basemap toggle | Free for basic non-commercial viewing | Keep Esri attribution visible; commercial/heavy use requires an ArcGIS key |

### Demo vs. Public Deployment Notes

- **Completely Safe for Local Demo & Viva:** A single user running test routes locally on `127.0.0.1:5000` stays well below community fair-use limits, and Leaflet automatically displays the required `© OpenStreetMap` attribution in the bottom-left corner. Extracted region graphs are cached in memory for 15 minutes (`max 10 regions`) so switching `Fastest`/`Shortest`, traffic presets, or roadblocks does not re-query Overpass.
- **If Deploying Publicly (Nominatim Rule):** OSM's public Nominatim server strictly forbids search-as-you-type autocomplete on public production deployments and caps traffic at **1 request/second** across all users combined. For a local college demo this will never bill you, though if you host AstraPath publicly on Vercel/Render/Railway, swap `/api/geocode` to **Photon** (an OSM-based geocoder built specifically for search-as-you-type) or trigger Nominatim only on Enter.
- **Overpass Mirror Note:** The older `overpass.kumi.systems` mirror recently moved to `overpass.private.coffee`, which is why AstraPath includes concurrent mirror racing and automatic corridor-graph fallback when primary Overpass mirrors are congested.

### Why OpenStreetMap Instead of Google Maps?

Google Maps is a paid, closed black-box API that only returns a finished route—it does **not** give you raw intersection nodes and road edges to run your own A\* graph search on. OpenStreetMap gives open access to the actual underlying road graph (under the **ODbL** license), allowing our Python engine to build the intersection graph and compute $f(n) = g(n) + h(n)$ from scratch.

---

## Testing & Verification

Run the full automated unit and integration test suite:
```bash
python -m pytest -v
```

Test suites included:
- **`tests/test_pathfinder.py`:** Validates all 20 Kolkata nodes & 40 edges (`distance_km >= haversine_km`, connectivity), heuristic non-negativity/admissibility, exact A\* vs. Dijkstra cost parity across `fastest` and `shortest` modes, congestion route divergence, identical-node handling, blocked/unreachable graphs, invalid inputs, and traffic presets.
- **`tests/test_osm_loader.py`:** Verifies degree-2 OSM graph contraction (`distance_km >= haversine`), parallel-edge roadblock rerouting, largest-connected-component snapping, adaptive road tiers, 450 km region-limit validation, and multi-corridor fallback A\* execution.
- **`tests/test_api.py`:** Verifies Flask HTML/CSS/JS serving and REST API contracts (`/api/graph`, `/api/route`, `/api/traffic/preset`).

---

## Project Structure

```text
Route Optimization/
├── README.md                  # Complete project documentation
├── requirements.txt           # Python dependencies (flask, requests)
├── app.py                     # Flask REST API & static web server
├── cli.py                     # Standalone terminal navigation & benchmark runner
├── prd.md                     # Product requirements & acceptance criteria
├── architecture.md            # System architecture, schema & math model
├── rules.md                   # Engineering rules (from-scratch heapq only, admissibility)
├── phases.md                  # Phased build checklist & verification gates
├── design.md                  # UI/UX layout & cartographic design specification
├── memory.md                  # Build & verification progress log
├── core/
│   ├── __init__.py
│   ├── graph.py               # CityNode, RoadEdge, CityGraph, traffic & override logic
│   ├── heuristics.py          # Haversine great-circle distance & time heuristics
│   ├── pathfinder.py          # From-scratch heapq A* & Dijkstra + (g, h, f) trace
│   └── osm_loader.py          # Nominatim, Overpass out-geom loader, contraction & corridor fallback
├── data/
│   └── city_map.json          # Offline 20-node, 40-edge Kolkata Metro road network
├── static/
│   ├── css/style.css          # Light & dark neutral graphite cartographic design system
│   ├── img/
│   │   └── astrapath-logo.svg # Custom AstraPath vector brand mark & favicon
│   └── js/map.js              # Full-bleed Leaflet UI, 3-tab panel, cased routes & inspector
├── templates/
│   └── index.html             # Single-page AstraPath web application
└── tests/
    ├── test_pathfinder.py     # Core graph search & admissibility unit tests
    ├── test_osm_loader.py     # OSM contraction, snapping & fallback unit tests
    └── test_api.py            # Flask endpoint & asset integration tests
```

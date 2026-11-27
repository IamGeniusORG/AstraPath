/**
 * AstraPath Browser-Side Offline Routing Engine
 * Pure JavaScript mirror of Haversine A*, Dijkstra comparison, multi-modal profiles,
 * dynamic custom-place linking, and Offline GPS origin resolution.
 */
(function (global) {
  "use strict";

  const EARTH_RADIUS_KM = 6371.0;
  const ROAD_TORTUOSITY = 1.25;
  const CONNECTOR_SPEED_KMPH = 40.0;
  const CONNECTOR_TRAFFIC = 1.2;
  const RAIL_ACCESS_SPEED_KMPH = 28.0;
  const RAIL_BOARDING_OVERHEAD_MIN = 8.0;
  const RAIL_STOP_DWELL_MIN = 2.0;
  const RAIL_MIN_DISTANCE_KM = 2.0;
  const AIR_ACCESS_SPEED_KMPH = 28.0;
  const AIR_CRUISE_SPEED_KMPH = 850.0;
  const AIR_OVERHEAD_MIN = 65.0;
  const AIR_MIN_DISTANCE_KM = 150.0;

  const VEHICLE_LABELS = {
    car: "Car",
    bike: "Bike",
    cycle: "Cycle",
    walk: "Walk",
    train: "Train",
    flight: "Flight",
  };

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
  }

  function maxSpeedForVehicle(vehicle, graphMaxSpeed) {
    if (vehicle === "car") return Math.min(graphMaxSpeed || 80, 120);
    if (vehicle === "bike") return Math.min(graphMaxSpeed || 80, 60);
    if (vehicle === "cycle") return 16;
    if (vehicle === "walk") return 5;
    if (vehicle === "train") return 130;
    if (vehicle === "flight") return 850;
    return 80;
  }

  function heuristicCost(nodeA, nodeB, mode, vehicle, graphMaxSpeed) {
    const distKm = haversineKm(nodeA.lat, nodeA.lng, nodeB.lat, nodeB.lng);
    if (mode === "shortest") return distKm;
    const vmax = maxSpeedForVehicle(vehicle, graphMaxSpeed);
    return (distKm / Math.max(1, vmax)) * 60.0;
  }

  function effectiveEdgeMetrics(edge, vehicle, overrides) {
    const ov = overrides?.[edge.id];
    let blocked = Boolean(edge.blocked);
    let tw = Number(edge.traffic_weight ?? edge.traffic_factor ?? 1.0);
    if (typeof ov === "number") {
      tw = ov;
    } else if (ov && typeof ov === "object") {
      if (typeof ov.blocked === "boolean") blocked = ov.blocked;
      if (typeof ov.traffic_weight === "number") tw = ov.traffic_weight;
      else if (typeof ov.traffic_factor === "number") tw = ov.traffic_factor;
    }
    if (blocked) return { blocked: true, speedKmph: 0, travelMin: Infinity, effTraffic: tw };

    const segType = edge.segment_type || "road";
    if (segType === "rail") {
      const spd = Number(edge.speed_limit_kmph || 65);
      const baseMin = (edge.distance_km / Math.max(1, spd)) * 60.0;
      return { blocked: false, speedKmph: spd, travelMin: baseMin + RAIL_STOP_DWELL_MIN, effTraffic: 1.0 };
    }
    if (segType === "flight") {
      const spd = Number(edge.speed_limit_kmph || AIR_CRUISE_SPEED_KMPH);
      const baseMin = (edge.distance_km / Math.max(1, spd)) * 60.0;
      return { blocked: false, speedKmph: spd, travelMin: baseMin, effTraffic: 1.0 };
    }

    const baseSpeed = Number(edge.speed_limit_kmph || 40);
    const hw = String(edge.highway_type || "").toLowerCase();
    let speed = baseSpeed;
    let effTraffic = tw;
    let penalty = 1.0;

    if (vehicle === "bike") {
      speed = Math.min(baseSpeed, 60);
      effTraffic = 1.0 + (tw - 1.0) * 0.55;
    } else if (vehicle === "cycle") {
      speed = Math.min(baseSpeed, 16);
      effTraffic = 1.0 + (tw - 1.0) * 0.15;
      if (hw === "motorway" || hw === "trunk") penalty = 2.5;
    } else if (vehicle === "walk") {
      speed = 5.0;
      effTraffic = 1.0;
      if (hw === "motorway" || hw === "trunk") penalty = 4.0;
    }

    const travelMin = (edge.distance_km / Math.max(1, speed)) * 60.0 * effTraffic * penalty;
    return { blocked: false, speedKmph: speed, travelMin, effTraffic };
  }

  class MinHeap {
    constructor() {
      this.items = [];
    }
    push(item) {
      this.items.push(item);
      let i = this.items.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.items[p].f <= this.items[i].f) break;
        [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
        i = p;
      }
    }
    pop() {
      if (this.items.length === 0) return null;
      const top = this.items[0];
      const last = this.items.pop();
      if (this.items.length > 0) {
        this.items[0] = last;
        let i = 0;
        const n = this.items.length;
        while (true) {
          let smallest = i;
          const l = 2 * i + 1;
          const r = 2 * i + 2;
          if (l < n && this.items[l].f < this.items[smallest].f) smallest = l;
          if (r < n && this.items[r].f < this.items[smallest].f) smallest = r;
          if (smallest === i) break;
          [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
          i = smallest;
        }
      }
      return top;
    }
    get size() {
      return this.items.length;
    }
  }

  function buildAdjacency(nodesMap, edges) {
    const adj = {};
    Object.keys(nodesMap).forEach((id) => {
      adj[id] = [];
    });
    edges.forEach((e) => {
      if (!adj[e.from] || !adj[e.to]) return;
      adj[e.from].push({ ...e, _from: e.from, _to: e.to });
      if (e.bidirectional !== false) {
        const revGeom = Array.isArray(e.geometry) ? [...e.geometry].reverse() : undefined;
        adj[e.to].push({ ...e, _from: e.to, _to: e.from, geometry: revGeom });
      }
    });
    return adj;
  }

  function runSearch(graph, startId, goalId, { mode = "fastest", vehicle = "car", overrides = null, useHeuristic = true } = {}) {
    const t0 = performance.now();
    const nodesMap = graph.nodesMap;
    const goalNode = nodesMap[goalId];
    const startNode = nodesMap[startId];
    if (!startNode || !goalNode) {
      return { found: false, reason: "Invalid start or goal intersection.", nodes_expanded: 0, runtime_ms: 0 };
    }

    const gScore = { [startId]: 0 };
    const cameFrom = {};
    const closed = new Set();
    const explored = [];
    const nodeScores = {};
    const heap = new MinHeap();
    const h0 = useHeuristic ? heuristicCost(startNode, goalNode, mode, vehicle, graph.maxSpeedKmph) : 0;
    heap.push({ id: startId, f: h0, g: 0 });
    nodeScores[startId] = { g: 0, h: h0, f: h0 };

    while (heap.size > 0) {
      const curr = heap.pop();
      if (!curr || closed.has(curr.id)) continue;
      closed.add(curr.id);
      const currNode = nodesMap[curr.id];
      explored.push([currNode.lat, currNode.lng]);

      if (curr.id === goalId) {
        const path = [];
        const segs = [];
        let cursor = goalId;
        while (cursor !== startId) {
          path.push(cursor);
          const step = cameFrom[cursor];
          if (!step) break;
          segs.push(step);
          cursor = step.from;
        }
        path.push(startId);
        path.reverse();
        segs.reverse();

        const coords = [];
        let totalDist = 0;
        let totalMin = 0;
        segs.forEach((s) => {
          totalDist += s.distance_km;
          totalMin += s.travel_time_min;
          (s.geometry || []).forEach((pt) => {
            if (coords.length === 0 || coords[coords.length - 1][0] !== pt[0] || coords[coords.length - 1][1] !== pt[1]) {
              coords.push(pt);
            }
          });
        });

        return {
          found: true,
          path,
          segments: segs,
          coordinates: coords.length ? coords : [[startNode.lat, startNode.lng]],
          total_distance_km: Math.round(totalDist * 1000) / 1000,
          estimated_time_min: Math.round(totalMin * 100) / 100,
          total_cost: Math.round((gScore[goalId] || 0) * 1000) / 1000,
          nodes_expanded: closed.size,
          runtime_ms: Math.round((performance.now() - t0) * 100) / 100,
          explored_coords: explored,
          node_scores: nodeScores,
        };
      }

      const neighbors = graph.adj[curr.id] || [];
      for (const edge of neighbors) {
        if (closed.has(edge._to)) continue;
        const m = effectiveEdgeMetrics(edge, vehicle, overrides);
        if (m.blocked) continue;
        const stepCost = mode === "shortest" ? edge.distance_km : m.travelMin;
        const tentativeG = curr.g + stepCost;
        if (tentativeG < (gScore[edge._to] ?? Infinity)) {
          gScore[edge._to] = tentativeG;
          const nextNode = nodesMap[edge._to];
          const h = useHeuristic ? heuristicCost(nextNode, goalNode, mode, vehicle, graph.maxSpeedKmph) : 0;
          const f = tentativeG + h;
          nodeScores[edge._to] = { g: tentativeG, h, f };
          const geom =
            Array.isArray(edge.geometry) && edge.geometry.length >= 2
              ? edge.geometry
              : [[currNode.lat, currNode.lng], [nextNode.lat, nextNode.lng]];
          cameFrom[edge._to] = {
            edge_id: edge.id,
            from: edge._from,
            to: edge._to,
            from_name: currNode.name,
            to_name: nextNode.name,
            road_name: edge.road_name,
            distance_km: edge.distance_km,
            speed_limit_kmph: m.speedKmph,
            traffic_weight: Math.round(m.effTraffic * 100) / 100,
            travel_time_min: Math.round(m.travelMin * 100) / 100,
            segment_type: edge.segment_type || "road",
            geometry: geom,
          };
          heap.push({ id: edge._to, f, g: tentativeG });
        }
      }
    }

    return {
      found: false,
      reason: "Destination is unreachable under current road closures.",
      nodes_expanded: closed.size,
      runtime_ms: Math.round((performance.now() - t0) * 100) / 100,
      explored_coords: explored,
      node_scores: nodeScores,
    };
  }

  function mergeOfflineGraph(cityGraph, savedPlaces, originCoords) {
    const nodes = [...(cityGraph.nodes || [])].map((n) => ({ ...n, saved: false }));
    const nodesMap = {};
    nodes.forEach((n) => {
      nodesMap[n.id] = n;
    });

    const edges = [...(cityGraph.edges || [])].map((e) => ({
      ...e,
      traffic_weight: e.traffic_weight ?? e.traffic_factor ?? 1.0,
    }));

    const saved = Array.isArray(savedPlaces) ? savedPlaces : [];
    saved.forEach((p) => {
      const pid = String(p.id);
      const node = { id: pid, name: p.name, lat: Number(p.lat), lng: Number(p.lng), saved: true };
      nodes.push(node);
      nodesMap[pid] = node;
    });

    saved.forEach((p) => {
      const pid = String(p.id);
      const pNode = nodesMap[pid];
      let conns = (p.connectors || []).filter((c) => nodesMap[c.to]);
      if (conns.length === 0) {
        const nearest = nodes
          .filter((n) => n.id !== pid)
          .sort((a, b) => haversineKm(pNode.lat, pNode.lng, a.lat, a.lng) - haversineKm(pNode.lat, pNode.lng, b.lat, b.lng))
          .slice(0, 3);
        conns = nearest.map((t) => {
          const hav = haversineKm(pNode.lat, pNode.lng, t.lat, t.lng);
          const dist = Math.max(0.05, Math.round(hav * ROAD_TORTUOSITY * 1000) / 1000);
          return {
            to: t.id,
            road_name: `${pNode.name} - ${t.name}`,
            distance_km: Math.max(dist, hav),
            speed_limit_kmph: CONNECTOR_SPEED_KMPH,
            traffic_weight: CONNECTOR_TRAFFIC,
            geometry: [[pNode.lat, pNode.lng], [t.lat, t.lng]],
          };
        });
      }
      conns.forEach((c, idx) => {
        const tNode = nodesMap[c.to];
        const hav = haversineKm(pNode.lat, pNode.lng, tNode.lat, tNode.lng);
        edges.push({
          id: `${pid}_CONN_${idx + 1}`,
          from: pid,
          to: c.to,
          road_name: c.road_name || `${pNode.name} Link`,
          distance_km: Math.max(Number(c.distance_km || 0.05), hav),
          speed_limit_kmph: Number(c.speed_limit_kmph || CONNECTOR_SPEED_KMPH),
          traffic_weight: Number(c.traffic_weight || CONNECTOR_TRAFFIC),
          bidirectional: true,
          blocked: false,
          geometry: c.geometry?.length >= 2 ? c.geometry : [[pNode.lat, pNode.lng], [tNode.lat, tNode.lng]],
        });
      });
    });

    if (originCoords && Number.isFinite(Number(originCoords.lat)) && Number.isFinite(Number(originCoords.lng))) {
      const gpsLat = Number(originCoords.lat);
      const gpsLng = Number(originCoords.lng);
      const gpsName = String(originCoords.name || "My Location");
      const nearestTwo = nodes
        .slice()
        .sort((a, b) => haversineKm(gpsLat, gpsLng, a.lat, a.lng) - haversineKm(gpsLat, gpsLng, b.lat, b.lng))
        .slice(0, 2);
      const gpsNode = { id: "GPS_ORIGIN", name: gpsName, lat: gpsLat, lng: gpsLng, saved: false };
      nodes.push(gpsNode);
      nodesMap.GPS_ORIGIN = gpsNode;
      nearestTwo.forEach((t, idx) => {
        const hav = haversineKm(gpsLat, gpsLng, t.lat, t.lng);
        const dist = Math.max(0.02, Math.max(hav, Math.round(hav * ROAD_TORTUOSITY * 1000) / 1000));
        edges.push({
          id: `GPS_LINK_${idx + 1}`,
          from: "GPS_ORIGIN",
          to: t.id,
          road_name: `Access to ${t.name}`,
          distance_km: dist,
          speed_limit_kmph: CONNECTOR_SPEED_KMPH,
          traffic_weight: 1.0,
          bidirectional: true,
          blocked: false,
          geometry: [[gpsLat, gpsLng], [t.lat, t.lng]],
        });
      });
    }

    return {
      city: cityGraph.city || "Kolkata",
      nodes,
      edges,
      nodesMap,
      maxSpeedKmph: 80,
      adj: buildAdjacency(nodesMap, edges),
    };
  }

  function buildRailGraph(railPayload, startNode, goalNode) {
    const stations = railPayload?.stations || [];
    if (stations.length < 2) return { graph: null, reason: "Rail network unavailable offline." };
    const straight = haversineKm(startNode.lat, startNode.lng, goalNode.lat, goalNode.lng);
    const nearS = stations.slice().sort((a, b) => haversineKm(startNode.lat, startNode.lng, a.lat, a.lng) - haversineKm(startNode.lat, startNode.lng, b.lat, b.lng)).slice(0, 2);
    const nearG = stations.slice().sort((a, b) => haversineKm(goalNode.lat, goalNode.lng, a.lat, a.lng) - haversineKm(goalNode.lat, goalNode.lng, b.lat, b.lng)).slice(0, 2);
    if (straight < RAIL_MIN_DISTANCE_KM || nearS[0].id === nearG[0].id) {
      return { graph: null, reason: "Distance is too short for rail; choose Car, Bike, or Walk." };
    }

    const nodesMap = {
      TRIP_START: { id: "TRIP_START", name: startNode.name, lat: startNode.lat, lng: startNode.lng },
      TRIP_GOAL: { id: "TRIP_GOAL", name: goalNode.name, lat: goalNode.lat, lng: goalNode.lng },
    };
    stations.forEach((st) => {
      nodesMap[st.id] = { id: st.id, name: st.name, lat: st.lat, lng: st.lng };
    });

    const edges = [];
    let eid = 1;
    (railPayload.lines || []).forEach((line) => {
      const seq = line.stations || [];
      for (let i = 0; i < seq.length - 1; i++) {
        const a = nodesMap[seq[i]];
        const b = nodesMap[seq[i + 1]];
        if (!a || !b) continue;
        const dist = Math.max(0.5, Math.round(haversineKm(a.lat, a.lng, b.lat, b.lng) * 1.12 * 1000) / 1000);
        edges.push({
          id: `RAIL_${eid++}`,
          from: a.id,
          to: b.id,
          road_name: `${line.name} (${a.name} - ${b.name})`,
          distance_km: dist,
          speed_limit_kmph: Number(line.avg_speed_kmph || 65),
          traffic_weight: 1.0,
          bidirectional: true,
          segment_type: "rail",
          geometry: [[a.lat, a.lng], [b.lat, b.lng]],
        });
      }
    });

    nearS.forEach((st) => {
      const hav = haversineKm(startNode.lat, startNode.lng, st.lat, st.lng);
      edges.push({
        id: `RAIL_ACC_S_${st.id}`,
        from: "TRIP_START",
        to: st.id,
        road_name: `Access to ${st.name}`,
        distance_km: Math.max(0.05, Math.max(hav, Math.round(hav * ROAD_TORTUOSITY * 1000) / 1000)),
        speed_limit_kmph: RAIL_ACCESS_SPEED_KMPH,
        traffic_weight: 1.0,
        bidirectional: true,
        segment_type: "road",
        geometry: [[startNode.lat, startNode.lng], [st.lat, st.lng]],
      });
    });

    nearG.forEach((st) => {
      const hav = haversineKm(st.lat, st.lng, goalNode.lat, goalNode.lng);
      edges.push({
        id: `RAIL_ACC_G_${st.id}`,
        from: st.id,
        to: "TRIP_GOAL",
        road_name: `Exit from ${st.name} to ${goalNode.name}`,
        distance_km: Math.max(0.05, Math.max(hav, Math.round(hav * ROAD_TORTUOSITY * 1000) / 1000)),
        speed_limit_kmph: RAIL_ACCESS_SPEED_KMPH,
        traffic_weight: 1.0,
        bidirectional: true,
        segment_type: "road",
        geometry: [[st.lat, st.lng], [goalNode.lat, goalNode.lng]],
      });
    });

    return {
      graph: { nodesMap, edges, maxSpeedKmph: 130, adj: buildAdjacency(nodesMap, edges) },
      reason: null,
    };
  }

  function buildAirGraph(airportsPayload, startNode, goalNode) {
    const airports = airportsPayload?.airports || [];
    const straight = haversineKm(startNode.lat, startNode.lng, goalNode.lat, goalNode.lng);
    if (straight < AIR_MIN_DISTANCE_KM) {
      return { graph: null, reason: `Flight routing requires >= ${Math.round(AIR_MIN_DISTANCE_KM)} km.` };
    }
    const nearS = airports.slice().sort((a, b) => haversineKm(startNode.lat, startNode.lng, a.lat, a.lng) - haversineKm(startNode.lat, startNode.lng, b.lat, b.lng)).slice(0, 2);
    const nearG = airports.slice().sort((a, b) => haversineKm(goalNode.lat, goalNode.lng, a.lat, a.lng) - haversineKm(goalNode.lat, goalNode.lng, b.lat, b.lng)).slice(0, 2);
    if (!nearS.length || !nearG.length || nearS[0].iata === nearG[0].iata) {
      return { graph: null, reason: "Nearest departure and arrival airports are identical." };
    }

    const nodesMap = {
      TRIP_START: { id: "TRIP_START", name: startNode.name, lat: startNode.lat, lng: startNode.lng },
      TRIP_GOAL: { id: "TRIP_GOAL", name: goalNode.name, lat: goalNode.lat, lng: goalNode.lng },
    };
    airports.forEach((ap) => {
      nodesMap[ap.iata] = { id: ap.iata, name: `${ap.name} (${ap.iata})`, lat: ap.lat, lng: ap.lng };
    });

    const edges = [];
    for (let i = 0; i < airports.length; i++) {
      for (let j = i + 1; j < airports.length; j++) {
        const a = airports[i];
        const b = airports[j];
        const dist = haversineKm(a.lat, a.lng, b.lat, b.lng);
        if (dist < 120) continue;
        const geom = [];
        for (let k = 0; k < 40; k++) {
          const t = k / 39;
          geom.push([a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t]);
        }
        edges.push({
          id: `AIR_${a.iata}_${b.iata}`,
          from: a.iata,
          to: b.iata,
          road_name: `Flight ${a.iata} -> ${b.iata}`,
          distance_km: Math.round(dist * 1000) / 1000,
          speed_limit_kmph: AIR_CRUISE_SPEED_KMPH,
          traffic_weight: 1.0,
          bidirectional: true,
          segment_type: "flight",
          geometry: geom,
        });
      }
    }

    nearS.forEach((ap) => {
      const hav = haversineKm(startNode.lat, startNode.lng, ap.lat, ap.lng);
      edges.push({
        id: `AIR_ACC_S_${ap.iata}`,
        from: "TRIP_START",
        to: ap.iata,
        road_name: `Airport transfer to ${ap.iata}`,
        distance_km: Math.max(0.1, Math.max(hav, Math.round(hav * ROAD_TORTUOSITY * 1000) / 1000)),
        speed_limit_kmph: AIR_ACCESS_SPEED_KMPH,
        traffic_weight: 1.0,
        bidirectional: true,
        segment_type: "road",
        geometry: [[startNode.lat, startNode.lng], [ap.lat, ap.lng]],
      });
    });

    nearG.forEach((ap) => {
      const hav = haversineKm(ap.lat, ap.lng, goalNode.lat, goalNode.lng);
      edges.push({
        id: `AIR_ACC_G_${ap.iata}`,
        from: ap.iata,
        to: "TRIP_GOAL",
        road_name: `Airport exit from ${ap.iata}`,
        distance_km: Math.max(0.1, Math.max(hav, Math.round(hav * ROAD_TORTUOSITY * 1000) / 1000)),
        speed_limit_kmph: AIR_ACCESS_SPEED_KMPH,
        traffic_weight: 1.0,
        bidirectional: true,
        segment_type: "road",
        geometry: [[ap.lat, ap.lng], [goalNode.lat, goalNode.lng]],
      });
    });

    return {
      graph: { nodesMap, edges, maxSpeedKmph: AIR_CRUISE_SPEED_KMPH, adj: buildAdjacency(nodesMap, edges) },
      reason: null,
    };
  }

  function runSingleVehicle(bundle, roadGraph, startId, goalId, { vehicle = "car", mode = "fastest", overrides = null, includeDijkstra = true } = {}) {
    const startNode = roadGraph.nodesMap[startId];
    const goalNode = roadGraph.nodesMap[goalId];
    let targetGraph = roadGraph;
    let sId = startId;
    let gId = goalId;
    let overhead = 0;

    if (vehicle === "train") {
      const built = buildRailGraph(bundle.rail_network, startNode, goalNode);
      if (!built.graph) {
        return { found: false, vehicle, mode, reason: built.reason, nodes_expanded: 0, runtime_ms: 0, dijkstra: null };
      }
      targetGraph = built.graph;
      sId = "TRIP_START";
      gId = "TRIP_GOAL";
      overhead = RAIL_BOARDING_OVERHEAD_MIN;
    } else if (vehicle === "flight") {
      const built = buildAirGraph(bundle.airports, startNode, goalNode);
      if (!built.graph) {
        return { found: false, vehicle, mode, reason: built.reason, nodes_expanded: 0, runtime_ms: 0, dijkstra: null };
      }
      targetGraph = built.graph;
      sId = "TRIP_START";
      gId = "TRIP_GOAL";
      overhead = AIR_OVERHEAD_MIN;
    }

    const astar = runSearch(targetGraph, sId, gId, { mode, vehicle, overrides, useHeuristic: true });
    let dijkstraPayload = null;
    if (includeDijkstra) {
      const dijk = runSearch(targetGraph, sId, gId, { mode, vehicle, overrides, useHeuristic: false });
      const red = dijk.nodes_expanded > 0 ? ((dijk.nodes_expanded - astar.nodes_expanded) / dijk.nodes_expanded) * 100 : 0;
      dijkstraPayload = {
        nodes_expanded: dijk.nodes_expanded,
        runtime_ms: dijk.runtime_ms,
        total_cost: dijk.total_cost || 0,
        node_reduction_pct: Math.round(red * 10) / 10,
      };
    }

    const etaMin = astar.found ? Math.round((astar.estimated_time_min + overhead) * 100) / 100 : 0;
    const transitStats =
      vehicle === "train" || vehicle === "flight"
        ? { total_intersections: Object.keys(targetGraph.nodesMap).length, total_roads: targetGraph.edges.length }
        : null;

    return {
      ...astar,
      vehicle,
      mode,
      estimated_time_min: etaMin,
      total_time_min: etaMin,
      dijkstra: dijkstraPayload,
      transit_graph_stats: transitStats,
    };
  }

  function computeOfflineRouteLocal(bundle, params) {
    const savedPlaces = params.custom_places || [];
    const originCoords = params.origin_coords || null;
    const roadGraph = mergeOfflineGraph(bundle.city_graph, savedPlaces, originCoords);
    const startId = originCoords ? "GPS_ORIGIN" : String(params.start || "").toUpperCase();
    const goalId = String(params.end || "").toUpperCase();
    const vehicle = String(params.vehicle || "car").toLowerCase();
    const mode = String(params.mode || "fastest").toLowerCase();
    const overrides = params.traffic_overrides || {};
    const includeDijkstra = params.compare_dijkstra !== false;

    const active = runSingleVehicle(bundle, roadGraph, startId, goalId, {
      vehicle,
      mode,
      overrides,
      includeDijkstra,
    });

    const modeEstimates = {};
    ["car", "bike", "cycle", "walk", "train", "flight"].forEach((v) => {
      const est =
        v === vehicle
          ? active
          : runSingleVehicle(bundle, roadGraph, startId, goalId, {
              vehicle: v,
              mode,
              overrides,
              includeDijkstra: false,
            });
      modeEstimates[v] = {
        vehicle: v,
        label: VEHICLE_LABELS[v] || v,
        available: Boolean(est.found),
        eta_min: est.found ? est.estimated_time_min : null,
        distance_km: est.found ? est.total_distance_km : null,
        reason: est.found ? null : est.reason || "Unavailable",
      };
    });

    return {
      ...active,
      mode_estimates: modeEstimates,
      offline_engine: "browser",
    };
  }

  global.AstraOfflineEngine = {
    haversineKm,
    mergeOfflineGraph,
    computeOfflineRouteLocal,
  };
})(typeof window !== "undefined" ? window : globalThis);

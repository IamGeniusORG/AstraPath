// RouteOpt — Map-First Cartographic Navigation & A* Visualization Controller

(() => {
  "use strict";

  const DEBOUNCE_MS = 400;
  const FRONTIER_TARGET_MS = 1100;

  const state = {
    sourceMode: "live", // "live" | "offline"
    mode: "fastest",    // "fastest" | "shortest"
    basemap: "light",   // "light" | "dark" | "satellite"
    activeTab: "directions",
    livePreset: "normal",
    liveStart: null,
    liveGoal: null,
    liveEdges: [],
    offlineGraph: null,
    overrides: {},
    selectedEdgeKey: null,
    nextPickTarget: "start",
    animationTimers: [],
    lastResult: null,
    viewBounds: null,
    routeAbortController: null,
    cardCollapsed: false,
    showGraphOverlay: true,
  };

  const dom = {
    navCard: document.getElementById("navCard"),
    navCardBody: document.getElementById("navCardBody"),
    collapseCardBtn: document.getElementById("collapseCardBtn"),
    collapseChevron: document.getElementById("collapseChevron"),
    liveSearchControls: document.getElementById("liveSearchControls"),
    offlineSelectControls: document.getElementById("offlineSelectControls"),
    liveStartInput: document.getElementById("liveStartInput"),
    liveGoalInput: document.getElementById("liveGoalInput"),
    liveStartResults: document.getElementById("liveStartResults"),
    liveGoalResults: document.getElementById("liveGoalResults"),
    clearStartBtn: document.getElementById("clearStartBtn"),
    clearGoalBtn: document.getElementById("clearGoalBtn"),
    swapWaypointsBtn: document.getElementById("swapWaypointsBtn"),
    geoLocateBtn: document.getElementById("geoLocateBtn"),
    pickStartMapBtn: document.getElementById("pickStartMapBtn"),
    pickGoalMapBtn: document.getElementById("pickGoalMapBtn"),
    startSelect: document.getElementById("startSelect"),
    endSelect: document.getElementById("endSelect"),
    findRouteBtn: document.getElementById("findRouteBtn"),
    mapPickHint: document.getElementById("mapPickHint"),
    alertBanner: document.getElementById("alertBanner"),
    resultsContainer: document.getElementById("resultsContainer"),
    metricEta: document.getElementById("metricEta"),
    metricDistance: document.getElementById("metricDistance"),
    graphSourcePill: document.getElementById("graphSourcePill"),
    longDistancePill: document.getElementById("longDistancePill"),
    heroAlgoSummary: document.getElementById("heroAlgoSummary"),
    graphOverlayBtn: document.getElementById("graphOverlayBtn"),
    itineraryList: document.getElementById("itineraryList"),
    graphScaleText: document.getElementById("graphScaleText"),
    efficiencyBadge: document.getElementById("efficiencyBadge"),
    dijkstraCard: document.getElementById("dijkstraCard"),
    astarStatsText: document.getElementById("astarStatsText"),
    dijkstraStatsText: document.getElementById("dijkstraStatsText"),
    astarBar: document.getElementById("astarBar"),
    dijkstraBar: document.getElementById("dijkstraBar"),
    animateToggle: document.getElementById("animateToggle"),
    dijkstraToggle: document.getElementById("dijkstraToggle"),
    replayBtn: document.getElementById("replayBtn"),
    resetTrafficBtn: document.getElementById("resetTrafficBtn"),
    roadInspectorEmpty: document.getElementById("roadInspectorEmpty"),
    roadInspectorActive: document.getElementById("roadInspectorActive"),
    inspectorRoadName: document.getElementById("inspectorRoadName"),
    inspectorRoadMeta: document.getElementById("inspectorRoadMeta"),
    edgeWeightSlider: document.getElementById("edgeWeightSlider"),
    edgeWeightVal: document.getElementById("edgeWeightVal"),
    edgeBlockedToggle: document.getElementById("edgeBlockedToggle"),
    loadingPill: document.getElementById("loadingPill"),
    loadingPillText: document.getElementById("loadingPillText"),
    zoomInBtn: document.getElementById("zoomInBtn"),
    zoomOutBtn: document.getElementById("zoomOutBtn"),
    resetViewBtn: document.getElementById("resetViewBtn"),
  };

  // Initialize Full-Bleed Map (Neutral West Bengal / Kolkata View, Zero Overlays on Load)
  const map = L.map("map", {
    center: [22.65, 88.39],
    zoom: 11,
    zoomControl: false,
    attributionControl: true,
  });

  map.attributionControl.setPosition("bottomleft");

  const baseLayers = {
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }),
    satellite: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Tiles &copy; Esri",
        maxZoom: 19,
      }
    ),
  };

  let activeBaseLayer = baseLayers.osm.addTo(map);

  const layers = {
    edges: L.layerGroup().addTo(map),
    frontier: L.layerGroup().addTo(map),
    routeCasing: L.layerGroup().addTo(map),
    routeInner: L.layerGroup().addTo(map),
    routeReplay: L.layerGroup().addTo(map),
    junctions: L.layerGroup().addTo(map),
    highlightSeg: L.layerGroup().addTo(map),
    nodes: L.layerGroup().addTo(map),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Basemap & Theme Switching
  function switchBasemap(styleKey) {
    state.basemap = styleKey;
    const isDark = styleKey === "dark";
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    document.body.classList.toggle("basemap-dark", isDark);
    document.body.classList.toggle("basemap-light", !isDark);

    const targetLayer = styleKey === "satellite" ? baseLayers.satellite : baseLayers.osm;
    if (activeBaseLayer !== targetLayer) {
      map.removeLayer(activeBaseLayer);
      activeBaseLayer = targetLayer.addTo(map);
    }

    document.querySelectorAll(".basemap-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.basemap === styleKey);
    });
  }

  function setLoading(loading, text = "Finding optimal route…") {
    dom.findRouteBtn.disabled = loading;
    dom.loadingPillText.textContent = text;
    dom.loadingPill.classList.toggle("hidden", !loading);
  }

  function clearAnimations() {
    state.animationTimers.forEach((id) => clearTimeout(id));
    state.animationTimers = [];
  }

  function showNotice(message) {
    dom.alertBanner.textContent = message;
    dom.alertBanner.classList.remove("hidden");
  }

  function hideNotice() {
    dom.alertBanner.classList.add("hidden");
    dom.alertBanner.textContent = "";
  }

  function updateClearButtons() {
    dom.clearStartBtn.classList.toggle("hidden", !dom.liveStartInput.value.trim());
    dom.clearGoalBtn.classList.toggle("hidden", !dom.liveGoalInput.value.trim());
  }

  function updatePickHint() {
    if (state.sourceMode === "live") {
      if (!state.liveStart && !state.liveGoal) {
        dom.mapPickHint.textContent = "Enter locations or click the map to set origin";
      } else if (state.liveStart && !state.liveGoal) {
        dom.mapPickHint.textContent = "Now enter or click the map to set destination";
      } else if (!state.liveStart && state.liveGoal) {
        dom.mapPickHint.textContent = "Now enter or click the map to set origin";
      } else {
        dom.mapPickHint.textContent = "Click the map or edit fields to update route";
      }
    } else {
      const hasStart = Boolean(dom.startSelect.value);
      const hasEnd = Boolean(dom.endSelect.value);
      if (!hasStart) {
        dom.mapPickHint.textContent = "Select or click a map intersection for origin";
      } else if (!hasEnd) {
        dom.mapPickHint.textContent = "Now select or click a map intersection for destination";
      } else {
        dom.mapPickHint.textContent = "Click any intersection on the map to update endpoints";
      }
    }
  }

  function clearActiveRouteDisplay({ keepGraphEdges = false } = {}) {
    clearAnimations();
    if (state.routeAbortController) {
      state.routeAbortController.abort();
      state.routeAbortController = null;
    }
    setLoading(false);
    state.lastResult = null;
    state.selectedEdgeKey = null;
    selectRoadForInspection(null);

    layers.frontier.clearLayers();
    layers.routeCasing.clearLayers();
    layers.routeInner.clearLayers();
    layers.routeReplay.clearLayers();
    layers.junctions.clearLayers();
    layers.highlightSeg.clearLayers();

    if (!keepGraphEdges) {
      state.liveEdges = [];
      layers.edges.clearLayers();
    }

    dom.resultsContainer.classList.add("hidden");
    dom.heroAlgoSummary.classList.add("hidden");
    hideNotice();

    if (state.sourceMode === "live") {
      renderPendingLivePins();
    } else {
      renderOfflineMapLayers();
    }
    updatePickHint();
  }

  function edgeKeyFor(edge) {
    if (state.sourceMode === "live") {
      return edge.id || `${edge.from}<->${edge.to}`;
    }
    return `${edge.from}<->${edge.to}`;
  }

  function effectiveEdgeState(edge) {
    const key = edgeKeyFor(edge);
    const ov = state.overrides[key];
    const baseWeight = edge.traffic_factor ?? edge.traffic_weight ?? 1.0;
    return {
      traffic_weight: ov && ov.traffic_weight !== undefined ? ov.traffic_weight : baseWeight,
      blocked: ov && ov.blocked !== undefined ? ov.blocked : Boolean(edge.blocked),
    };
  }

  function trafficColor(weight, blocked) {
    if (blocked) return "#64748b";
    if (weight < 1.3) return "#16a34a";
    if (weight <= 2.0) return "#d97706";
    return "#dc2626";
  }

  function getActiveEdgesList() {
    if (state.sourceMode === "live") {
      return state.liveEdges || [];
    }
    return state.offlineGraph ? state.offlineGraph.edges : [];
  }

  // Tab Switching
  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.getElementById("tabDirections").classList.toggle("hidden", tabName !== "directions");
    document.getElementById("tabAlgorithm").classList.toggle("hidden", tabName !== "algorithm");
    document.getElementById("tabTraffic").classList.toggle("hidden", tabName !== "traffic");
  }

  // Selected Road Inspector
  function selectRoadForInspection(edgeKey) {
    state.selectedEdgeKey = edgeKey;
    const edge = getActiveEdgesList().find((e) => edgeKeyFor(e) === edgeKey);
    if (!edge) {
      dom.roadInspectorEmpty.classList.remove("hidden");
      dom.roadInspectorActive.classList.add("hidden");
      return;
    }

    const eff = effectiveEdgeState(edge);
    dom.roadInspectorEmpty.classList.add("hidden");
    dom.roadInspectorActive.classList.remove("hidden");
    dom.inspectorRoadName.textContent = edge.road_name;
    dom.inspectorRoadMeta.textContent = `${edge.distance_km.toFixed(2)} km · ${edge.speed_limit_kmph} km/h`;
    dom.edgeWeightSlider.value = Math.min(3.0, Math.max(1.0, eff.traffic_weight)).toFixed(2);
    dom.edgeWeightVal.textContent = `${eff.traffic_weight.toFixed(2)}x`;
    dom.edgeBlockedToggle.checked = Boolean(eff.blocked);
  }

  // Clean Vector Markers (Origin Green Circle + Destination Red SVG Pin)
  function createOriginIcon() {
    return L.divIcon({
      className: "vector-marker-wrapper",
      html: `<div class="origin-circle-pin"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  function createDestIcon() {
    return L.divIcon({
      className: "vector-marker-wrapper",
      html: `<svg class="dest-teardrop-pin" width="24" height="32" viewBox="0 0 24 32" fill="none">
        <path d="M12 0C5.373 0 0 5.373 0 12c0 8.5 12 20 12 20s12-11.5 12-20c0-6.627-5.373-12-12-12z" fill="#DC2626"/>
        <circle cx="12" cy="11.5" r="4.2" fill="#FFFFFF"/>
      </svg>`,
      iconSize: [24, 32],
      iconAnchor: [12, 32],
    });
  }

  function renderPendingLivePins() {
    layers.nodes.clearLayers();
    if (state.liveStart) {
      L.marker([state.liveStart.lat, state.liveStart.lng], {
        icon: createOriginIcon(),
        zIndexOffset: 700,
      })
        .bindTooltip(`Origin: ${escapeHtml(state.liveStart.name)}`, { direction: "top", offset: [0, -8], className: "map-tooltip" })
        .addTo(layers.nodes);
    }
    if (state.liveGoal) {
      L.marker([state.liveGoal.lat, state.liveGoal.lng], {
        icon: createDestIcon(),
        zIndexOffset: 700,
      })
        .bindTooltip(`Destination: ${escapeHtml(state.liveGoal.name)}`, { direction: "top", offset: [0, -28], className: "map-tooltip" })
        .addTo(layers.nodes);
    }
  }

  // Render Network Edges & Markers
  function renderRouteJunctionDots(result) {
    layers.junctions.clearLayers();
    if (!state.showGraphOverlay || !result?.found || !result.segments?.length) {
      return;
    }

    const segs = result.segments;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const pt = seg.geometry?.[seg.geometry.length - 1];
      if (!pt) continue;

      const nodeId = seg.to;
      const nodeLabel = seg.to_name || nodeId;
      const scores = result.node_scores?.[nodeId];
      const scoreHtml = scores
        ? `<div class="num" style="margin-top:2px;">g: ${scores.g.toFixed(2)} &middot; h: ${scores.h.toFixed(2)} &middot; f: ${scores.f.toFixed(2)}</div>`
        : "";

      L.circleMarker(pt, {
        radius: 3.5,
        color: "#ffffff",
        weight: 1.5,
        fillColor: "#1E40AF",
        fillOpacity: 0.92,
      })
        .bindTooltip(`<strong>${escapeHtml(nodeId)}</strong> &middot; ${escapeHtml(nodeLabel)}${scoreHtml}`, {
          direction: "top",
          offset: [0, -6],
          className: "map-tooltip",
        })
        .addTo(layers.junctions);
    }
  }

  function renderLiveMapLayers(result) {
    layers.edges.clearLayers();
    layers.nodes.clearLayers();
    layers.junctions.clearLayers();

    if (state.showGraphOverlay) {
      (state.liveEdges || []).forEach((edge) => {
        if (!edge.geometry || edge.geometry.length < 2) return;
        const eff = effectiveEdgeState(edge);
        const color = trafficColor(eff.traffic_weight, eff.blocked);
        const isSelected = state.selectedEdgeKey === edge.id;

        const line = L.polyline(edge.geometry, {
          color,
          weight: isSelected ? 4.5 : eff.blocked ? 3 : 3,
          opacity: eff.blocked ? 0.65 : isSelected ? 0.92 : 0.55,
          dashArray: eff.blocked ? "6, 6" : null,
        });

        const statusLabel = eff.blocked ? "Closed" : `${eff.traffic_weight.toFixed(2)}x`;
        line.bindTooltip(
          `<strong>${escapeHtml(edge.road_name)}</strong><br/><span class="num">${Number(edge.speed_limit_kmph)} km/h &middot; ${escapeHtml(statusLabel)}</span>`,
          { sticky: true, className: "map-tooltip" }
        );

        line.on("mouseover", () => {
          line.setStyle({ weight: 4.5, opacity: 0.9 });
        });
        line.on("mouseout", () => {
          const selectedNow = state.selectedEdgeKey === edge.id;
          line.setStyle({
            weight: selectedNow ? 4.5 : 3,
            opacity: eff.blocked ? 0.65 : selectedNow ? 0.92 : 0.55,
          });
        });
        line.on("click", (ev) => {
          L.DomEvent.stopPropagation(ev);
          selectRoadForInspection(edge.id);
          switchTab("traffic");
          renderLiveMapLayers(state.lastResult);
        });

        line.addTo(layers.edges);
      });

      renderRouteJunctionDots(result);
    }

    const startPin = result?.snapped_start || state.liveStart;
    const goalPin = result?.snapped_goal || state.liveGoal;

    const scoreLine = (nid) => {
      const s = result?.node_scores?.[nid];
      return s
        ? `<div class="num" style="margin-top:3px;opacity:0.75;">g ${s.g.toFixed(2)} · h ${s.h.toFixed(2)} · f ${s.f.toFixed(2)}</div>`
        : "";
    };

    if (startPin) {
      L.marker([startPin.lat, startPin.lng], {
        icon: createOriginIcon(),
        zIndexOffset: 700,
      })
        .bindTooltip(`<strong>Origin</strong><br/>${escapeHtml(state.liveStart?.name || startPin.name)}${scoreLine(startPin.id)}`, {
          direction: "top",
          offset: [0, -8],
          className: "map-tooltip",
        })
        .addTo(layers.nodes);
    }

    if (goalPin) {
      L.marker([goalPin.lat, goalPin.lng], {
        icon: createDestIcon(),
        zIndexOffset: 700,
      })
        .bindTooltip(`<strong>Destination</strong><br/>${escapeHtml(state.liveGoal?.name || goalPin.name)}${scoreLine(goalPin.id)}`, {
          direction: "top",
          offset: [0, -28],
          className: "map-tooltip",
        })
        .addTo(layers.nodes);
    }
  }

  function renderOfflineMapLayers() {
    if (!state.offlineGraph) return;
    layers.edges.clearLayers();
    layers.nodes.clearLayers();
    layers.junctions.clearLayers();

    const nodeMap = {};
    state.offlineGraph.nodes.forEach((n) => {
      nodeMap[n.id] = n;
    });

    if (state.showGraphOverlay) {
      state.offlineGraph.edges.forEach((edge) => {
        const u = nodeMap[edge.from];
        const v = nodeMap[edge.to];
        if (!u || !v) return;

        const eff = effectiveEdgeState(edge);
        const color = trafficColor(eff.traffic_weight, eff.blocked);
        const key = edgeKeyFor(edge);
        const isSelected = state.selectedEdgeKey === key;

        const line = L.polyline(
          [
            [u.lat, u.lng],
            [v.lat, v.lng],
          ],
          {
            color,
            weight: isSelected ? 4.5 : 3,
            opacity: eff.blocked ? 0.65 : isSelected ? 0.92 : 0.55,
            dashArray: eff.blocked ? "6, 6" : null,
          }
        );

        const statusLabel = eff.blocked ? "Closed" : `${eff.traffic_weight.toFixed(2)}x`;
        line.bindTooltip(
          `<strong>${escapeHtml(edge.road_name)}</strong><br/><span class="num">${Number(edge.speed_limit_kmph)} km/h &middot; ${escapeHtml(statusLabel)}</span>`,
          { sticky: true, className: "map-tooltip" }
        );

        line.on("mouseover", () => line.setStyle({ weight: 4.5, opacity: 0.9 }));
        line.on("mouseout", () => {
          const selectedNow = state.selectedEdgeKey === key;
          line.setStyle({
            weight: selectedNow ? 4.5 : 3,
            opacity: eff.blocked ? 0.65 : selectedNow ? 0.92 : 0.55,
          });
        });
        line.on("click", (ev) => {
          L.DomEvent.stopPropagation(ev);
          selectRoadForInspection(key);
          switchTab("traffic");
          renderOfflineMapLayers();
        });

        line.addTo(layers.edges);
      });
    }

    const startId = dom.startSelect.value;
    const endId = dom.endSelect.value;
    const routeSet = new Set(state.lastResult?.found ? state.lastResult.path : []);

    state.offlineGraph.nodes.forEach((node) => {
      const isStart = node.id === startId;
      const isEnd = node.id === endId;

      if (!isStart && !isEnd && !state.showGraphOverlay) {
        return;
      }

      let marker;
      if (isStart) {
        marker = L.marker([node.lat, node.lng], { icon: createOriginIcon(), zIndexOffset: 700 });
      } else if (isEnd) {
        marker = L.marker([node.lat, node.lng], { icon: createDestIcon(), zIndexOffset: 700 });
      } else {
        const onRoute = routeSet.has(node.id);
        marker = L.circleMarker([node.lat, node.lng], {
          radius: onRoute ? 4 : 3.5,
          fillColor: onRoute ? "#1E40AF" : "#64748b",
          color: "#ffffff",
          weight: 1.5,
          fillOpacity: 0.92,
        });
      }

      const s = state.lastResult?.node_scores?.[node.id];
      const scoreHtml = s
        ? `<div class="num" style="margin-top:3px;opacity:0.75;">g ${s.g.toFixed(2)} · h ${s.h.toFixed(2)} · f ${s.f.toFixed(2)}</div>`
        : "";
      marker.bindTooltip(`<strong>${escapeHtml(node.name)}</strong> (${escapeHtml(node.id)})${scoreHtml}`, {
        direction: "top",
        offset: [0, isEnd ? -28 : -8],
        className: "map-tooltip",
      });

      marker.on("click", (ev) => {
        L.DomEvent.stopPropagation(ev);
        if (state.nextPickTarget === "start" || !dom.startSelect.value) {
          dom.startSelect.value = node.id;
          dom.startSelect.classList.remove("is-placeholder");
          state.nextPickTarget = "end";
        } else {
          dom.endSelect.value = node.id;
          dom.endSelect.classList.remove("is-placeholder");
          state.nextPickTarget = "start";
        }
        updatePickHint();
        if (dom.startSelect.value && dom.endSelect.value) {
          computeRoute({ flyToRoute: true });
        } else {
          renderOfflineMapLayers();
        }
      });

      marker.addTo(layers.nodes);
    });
  }

  // Two-Layer Google Maps / Apple Maps Cased Route
  function drawCasedOptimalRoute(result, { flyToRoute = true, withReplayMotion = false } = {}) {
    layers.routeCasing.clearLayers();
    layers.routeInner.clearLayers();
    layers.routeReplay.clearLayers();
    layers.highlightSeg.clearLayers();

    if (!result.found || !result.coordinates || result.coordinates.length === 0) {
      return;
    }

    if (result.coordinates.length === 1) {
      if (flyToRoute) map.panTo(result.coordinates[0]);
      return;
    }

    L.polyline(result.coordinates, {
      color: "#1E40AF",
      weight: 8,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(layers.routeCasing);

    const innerLine = L.polyline(result.coordinates, {
      color: "#3B82F6",
      weight: 4.5,
      opacity: 1.0,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(layers.routeInner);

    if (withReplayMotion) {
      L.polyline(result.coordinates, {
        color: "#DBEAFE",
        weight: 2.5,
        opacity: 0.9,
        dashArray: "8, 12",
        lineCap: "round",
        className: "route-replay-flow",
        interactive: false,
      }).addTo(layers.routeReplay);

      const clearMotionTimer = setTimeout(() => {
        layers.routeReplay.clearLayers();
      }, 1250);
      state.animationTimers.push(clearMotionTimer);
    }

    if (innerLine.getBounds().isValid()) {
      state.viewBounds = innerLine.getBounds();
      if (flyToRoute) {
        map.flyToBounds(innerLine.getBounds(), { padding: [64, 64], duration: 0.65 });
      }
    }
  }

  function animateFrontierAndRoute(result, { flyToRoute = true, forceReplay = false } = {}) {
    clearAnimations();
    layers.frontier.clearLayers();
    layers.routeCasing.clearLayers();
    layers.routeInner.clearLayers();
    layers.routeReplay.clearLayers();

    if (state.sourceMode === "live") {
      renderLiveMapLayers(result);
    } else {
      renderOfflineMapLayers();
    }

    const coordsList = result.explored_coords || [];
    const shouldAnimate = (dom.animateToggle.checked || forceReplay) && coordsList.length > 1;
    if (!shouldAnimate) {
      drawCasedOptimalRoute(result, { flyToRoute, withReplayMotion: false });
      return;
    }

    let sampled = coordsList;
    if (coordsList.length > 140) {
      const stride = coordsList.length / 140;
      sampled = [];
      for (let i = 0; i < 140; i++) {
        sampled.push(coordsList[Math.min(coordsList.length - 1, Math.floor(i * stride))]);
      }
    }

    const stepDelayMs = Math.max(7, Math.floor(FRONTIER_TARGET_MS / sampled.length));
    sampled.forEach((coord, index) => {
      const timerId = setTimeout(() => {
        L.circleMarker(coord, {
          radius: 3,
          stroke: false,
          fillColor: "#2563EB",
          fillOpacity: 0.35,
          interactive: false,
        }).addTo(layers.frontier);

        if (index === sampled.length - 1) {
          drawCasedOptimalRoute(result, { flyToRoute, withReplayMotion: true });
          // Gently fade frontier dots once optimal route locks in
          const fadeTimer = setTimeout(() => {
            layers.frontier.eachLayer((layer) => {
              if (layer.setStyle) layer.setStyle({ fillOpacity: 0.14 });
            });
          }, 450);
          state.animationTimers.push(fadeTimer);
        }
      }, index * stepDelayMs);

      state.animationTimers.push(timerId);
    });
  }

  function mergeDirectionSteps(rawSegments) {
    if (!rawSegments || rawSegments.length === 0) return [];

    // Filter out tiny < 0.08 km connector micro-hops when longer segments exist
    const nonMicro = rawSegments.filter((seg) => seg.distance_km >= 0.08);
    const source = nonMicro.length > 0 ? nonMicro : rawSegments;

    const merged = [];
    source.forEach((seg) => {
      const weight = seg.traffic_factor ?? seg.traffic_weight ?? 1.0;
      const geom = Array.isArray(seg.geometry) ? seg.geometry : [];
      const prev = merged[merged.length - 1];

      if (prev && prev.road_name === seg.road_name) {
        const combinedDist = prev.distance_km + seg.distance_km;
        prev.traffic_weight =
          combinedDist > 0
            ? (prev.traffic_weight * prev.distance_km + weight * seg.distance_km) / combinedDist
            : weight;
        prev.distance_km = combinedDist;
        prev.travel_time_min += seg.travel_time_min;
        if (geom.length > 1) {
          prev.geometry = prev.geometry.concat(geom.slice(1));
        }
      } else {
        merged.push({
          road_name: seg.road_name,
          distance_km: seg.distance_km,
          travel_time_min: seg.travel_time_min,
          speed_limit_kmph: seg.speed_limit_kmph,
          traffic_weight: weight,
          geometry: [...geom],
        });
      }
    });

    return merged;
  }

  function formatStepDuration(minutes) {
    if (minutes < 1.0) return "< 1 min";
    return `${Math.round(minutes)} min`;
  }

  function formatTrafficSubtitle(step) {
    const w = step.traffic_weight;
    if (w < 1.3) {
      return `Smooth traffic · ${Math.round(step.speed_limit_kmph)} km/h`;
    }
    if (w <= 2.0) {
      return `Moderate traffic · ${w.toFixed(1)}x delay`;
    }
    return `Heavy traffic · ${w.toFixed(1)}x delay`;
  }

  function renderResults(result) {
    dom.resultsContainer.classList.remove("hidden");

    if (state.sourceMode === "live" && result.graph_stats) {
      const gs = result.graph_stats;
      dom.graphScaleText.textContent = `${gs.total_intersections.toLocaleString()} intersections · ${gs.total_roads.toLocaleString()} roads`;
      const srcLabel =
        result.graph_source === "corridor_fallback" || gs.graph_source === "corridor_fallback"
          ? "Corridor Graph"
          : "Live OSM";
      dom.graphSourcePill.textContent = gs.cache_hit ? `${srcLabel} · cached` : srcLabel;
      dom.longDistancePill.classList.toggle("hidden", !result.long_distance_notice);
    } else if (state.offlineGraph) {
      dom.graphScaleText.textContent = `${state.offlineGraph.nodes.length} intersections · ${state.offlineGraph.edges.length} roads`;
      dom.graphSourcePill.textContent = "Offline Graph";
      dom.longDistancePill.classList.add("hidden");
    }

    const dijk = result.dijkstra;
    if (dijk) {
      const pctText =
        dijk.node_reduction_pct > 0
          ? `${dijk.node_reduction_pct.toFixed(0)}% fewer than Dijkstra`
          : "matches Dijkstra";
      dom.heroAlgoSummary.textContent = `A*: ${result.nodes_expanded.toLocaleString()} nodes (${result.runtime_ms.toFixed(1)} ms) · ${pctText}`;
      dom.heroAlgoSummary.classList.remove("hidden");
    } else {
      dom.heroAlgoSummary.classList.add("hidden");
    }

    if (!result.found) {
      showNotice(result.error || "No route available under current road closures.");
      dom.metricEta.textContent = "-- min";
      dom.metricDistance.textContent = "-- km";
      dom.itineraryList.innerHTML = `<li class="inspector-empty">Destination unreachable under active road closures.</li>`;
    } else {
      hideNotice();
      dom.metricEta.textContent = `${Math.round(result.estimated_time_min)} min`;
      dom.metricDistance.textContent = `${result.total_distance_km.toFixed(1)} km`;

      const displaySteps = mergeDirectionSteps(result.segments);
      if (displaySteps.length === 0) {
        dom.itineraryList.innerHTML = `<li class="inspector-empty">Origin and destination share the same intersection.</li>`;
      } else {
        dom.itineraryList.innerHTML = displaySteps
          .map((step, idx) => {
            const dotColor = trafficColor(step.traffic_weight, false);
            const distText =
              step.distance_km >= 10
                ? `${step.distance_km.toFixed(1)} km`
                : `${step.distance_km.toFixed(2)} km`;
            return `
              <li>
                <button type="button" class="direction-step" data-step-idx="${idx}">
                  <span class="step-main">
                    <span class="traffic-dot" style="background:${dotColor};"></span>
                    <span class="step-text">
                      <span class="step-road">${escapeHtml(step.road_name)}</span>
                      <span class="step-sub">${escapeHtml(formatTrafficSubtitle(step))}</span>
                    </span>
                  </span>
                  <span class="step-metrics num">
                    <span class="step-eta">${escapeHtml(formatStepDuration(step.travel_time_min))}</span>
                    <span class="step-dist">${escapeHtml(distText)}</span>
                  </span>
                </button>
              </li>`;
          })
          .join("");

        dom.itineraryList.querySelectorAll(".direction-step").forEach((btn) => {
          btn.addEventListener("click", () => {
            const step = displaySteps[Number(btn.dataset.stepIdx)];
            if (!step || !step.geometry || step.geometry.length < 2) return;
            layers.highlightSeg.clearLayers();
            const segLine = L.polyline(step.geometry, {
              color: "#1D4ED8",
              weight: 7,
              opacity: 0.9,
            }).addTo(layers.highlightSeg);
            if (segLine.getBounds().isValid()) {
              map.flyToBounds(segLine.getBounds(), { padding: [90, 90], maxZoom: 16, duration: 0.5 });
            }
          });
        });
      }
    }

    dom.dijkstraCard.classList.toggle("hidden", !dom.dijkstraToggle.checked);
    if (dijk) {
      const maxNodes = Math.max(1, result.nodes_expanded, dijk.nodes_expanded);
      dom.astarStatsText.textContent = `${result.nodes_expanded.toLocaleString()} nodes · ${result.runtime_ms.toFixed(1)} ms`;
      dom.dijkstraStatsText.textContent = `${dijk.nodes_expanded.toLocaleString()} nodes · ${dijk.runtime_ms.toFixed(1)} ms`;
      dom.astarBar.style.width = `${Math.round((result.nodes_expanded / maxNodes) * 100)}%`;
      dom.dijkstraBar.style.width = `${Math.round((dijk.nodes_expanded / maxNodes) * 100)}%`;
      dom.efficiencyBadge.textContent =
        dijk.node_reduction_pct > 0
          ? `${dijk.node_reduction_pct.toFixed(0)}% fewer nodes`
          : "Optimal parity";
    }
  }

  // API Calls: Live & Offline Routing
  async function computeLiveRoute({ flyToRoute = true } = {}) {
    if (!state.liveStart || !state.liveGoal) {
      showNotice("Please choose both a starting location and destination");
      if (!state.liveStart) {
        dom.liveStartInput.focus();
      } else {
        dom.liveGoalInput.focus();
      }
      return;
    }

    if (state.routeAbortController) {
      state.routeAbortController.abort();
    }
    const controller = new AbortController();
    state.routeAbortController = controller;

    setLoading(true, "Finding optimal route…");
    try {
      const resp = await fetch("/api/route-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: state.liveStart,
          goal: state.liveGoal,
          mode: state.mode,
          traffic_preset: state.livePreset,
          traffic_overrides: state.overrides,
        }),
        signal: controller.signal,
      });
      const data = await resp.json();
      if (state.routeAbortController !== controller || state.sourceMode !== "live") return;

      if (!resp.ok) {
        showNotice(data.error || "Unable to compute live route.");
        return;
      }

      state.liveEdges = data.network_edges || [];
      state.lastResult = data;
      if (state.selectedEdgeKey) selectRoadForInspection(state.selectedEdgeKey);
      renderResults(data);
      animateFrontierAndRoute(data, { flyToRoute });
    } catch (err) {
      if (err.name === "AbortError") return;
      showNotice("Live map services are unreachable. Switch to Offline mode to use the local Kolkata network.");
    } finally {
      if (state.routeAbortController === controller) {
        setLoading(false);
      }
    }
  }

  async function computeOfflineRoute({ flyToRoute = true } = {}) {
    if (!state.offlineGraph) return;
    if (!dom.startSelect.value || !dom.endSelect.value) {
      showNotice("Please choose both a starting intersection and destination");
      if (!dom.startSelect.value) {
        dom.startSelect.focus();
      } else {
        dom.endSelect.focus();
      }
      return;
    }
    if (state.routeAbortController) {
      state.routeAbortController.abort();
    }
    const controller = new AbortController();
    state.routeAbortController = controller;

    setLoading(true, "Calculating offline route…");
    try {
      const resp = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: dom.startSelect.value,
          end: dom.endSelect.value,
          mode: state.mode,
          traffic_overrides: state.overrides,
        }),
        signal: controller.signal,
      });
      const data = await resp.json();
      if (state.routeAbortController !== controller || state.sourceMode !== "offline") return;

      if (!resp.ok) {
        showNotice(data.error || "Failed to compute offline route.");
        return;
      }

      state.lastResult = data;
      if (state.selectedEdgeKey) selectRoadForInspection(state.selectedEdgeKey);
      renderResults(data);
      animateFrontierAndRoute(data, { flyToRoute });
    } catch (err) {
      if (err.name === "AbortError") return;
      showNotice(`Offline calculation error: ${err.message}`);
    } finally {
      if (state.routeAbortController === controller) {
        setLoading(false);
      }
    }
  }

  function computeRoute(opts = { flyToRoute: true }) {
    if (state.sourceMode === "live") {
      return computeLiveRoute(opts);
    }
    return computeOfflineRoute(opts);
  }

  async function loadOfflineGraph() {
    const resp = await fetch("/api/graph");
    if (!resp.ok) throw new Error("Failed to load offline road network.");
    state.offlineGraph = await resp.json();

    const { nodes } = state.offlineGraph;
    dom.startSelect.innerHTML = "";
    dom.endSelect.innerHTML = "";
    dom.startSelect.add(new Option("Select starting intersection...", ""));
    dom.endSelect.add(new Option("Select destination...", ""));

    nodes.forEach((node) => {
      dom.startSelect.add(new Option(`${node.name} (${node.id})`, node.id));
      dom.endSelect.add(new Option(`${node.name} (${node.id})`, node.id));
    });

    dom.startSelect.value = "";
    dom.endSelect.value = "";
    dom.startSelect.classList.add("is-placeholder");
    dom.endSelect.classList.add("is-placeholder");
  }

  async function switchSourceMode(source) {
    if (state.routeAbortController) {
      state.routeAbortController.abort();
      state.routeAbortController = null;
    }
    setLoading(false);
    hideNotice();

    state.sourceMode = source;
    state.overrides = {};
    state.selectedEdgeKey = null;
    state.livePreset = "normal";
    selectRoadForInspection(null);
    clearAnimations();
    layers.frontier.clearLayers();
    layers.routeCasing.clearLayers();
    layers.routeInner.clearLayers();
    layers.routeReplay.clearLayers();
    layers.junctions.clearLayers();
    layers.highlightSeg.clearLayers();

    document.querySelectorAll(".segmented-btn[data-source]").forEach((btn) => {
      const active = btn.dataset.source === source;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    const isLive = source === "live";
    dom.liveSearchControls.classList.toggle("hidden", !isLive);
    dom.offlineSelectControls.classList.toggle("hidden", isLive);

    try {
      if (isLive) {
        if (state.liveStart && state.liveGoal) {
          await computeLiveRoute({ flyToRoute: true });
        } else {
          clearActiveRouteDisplay({ keepGraphEdges: false });
        }
      } else {
        if (!state.offlineGraph) {
          await loadOfflineGraph();
        }
        state.viewBounds = L.latLngBounds(state.offlineGraph.nodes.map((n) => [n.lat, n.lng]));
        map.fitBounds(state.viewBounds, { padding: [55, 55] });
        if (dom.startSelect.value && dom.endSelect.value) {
          await computeOfflineRoute({ flyToRoute: true });
        } else {
          clearActiveRouteDisplay({ keepGraphEdges: true });
        }
      }
    } catch (err) {
      showNotice(`Unable to switch mode: ${err.message}`);
    }
  }

  // Debounced Autocomplete Search
  function setupAutocomplete(inputEl, resultsEl, onInputEmpty, onSelect) {
    let debounceTimer = null;

    inputEl.addEventListener("input", () => {
      updateClearButtons();
      clearTimeout(debounceTimer);
      const query = inputEl.value.trim();
      if (!query) {
        onInputEmpty();
      }
      if (query.length < 2) {
        resultsEl.classList.add("hidden");
        resultsEl.innerHTML = "";
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const resp = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
          const data = await resp.json();
          const items = data.results || [];
          if (!resp.ok) {
            resultsEl.innerHTML = `<div class="autocomplete-item"><span class="autocomplete-sub">${escapeHtml(data.error || "Geocoding unavailable")}</span></div>`;
          } else if (items.length === 0) {
            resultsEl.innerHTML = `<div class="autocomplete-item"><span class="autocomplete-sub">No matching places found</span></div>`;
          } else {
            resultsEl.innerHTML = items
              .map(
                (item, idx) => `
                  <button type="button" data-idx="${idx}" class="autocomplete-item">
                    <span class="autocomplete-name">${escapeHtml(item.name)}</span>
                    <span class="autocomplete-sub">${escapeHtml(item.full_name)}</span>
                  </button>`
              )
              .join("");

            resultsEl.querySelectorAll("button[data-idx]").forEach((btn) => {
              btn.addEventListener("click", () => {
                const chosen = items[Number(btn.dataset.idx)];
                inputEl.value = chosen.name;
                resultsEl.classList.add("hidden");
                onSelect(chosen);
              });
            });
          }
          resultsEl.classList.remove("hidden");
        } catch {
          resultsEl.classList.add("hidden");
        }
      }, DEBOUNCE_MS);
    });

    document.addEventListener("click", (ev) => {
      if (!resultsEl.contains(ev.target) && ev.target !== inputEl) {
        resultsEl.classList.add("hidden");
      }
    });
  }

  setupAutocomplete(
    dom.liveStartInput,
    dom.liveStartResults,
    () => {
      state.liveStart = null;
      state.nextPickTarget = "start";
      clearActiveRouteDisplay({ keepGraphEdges: false });
    },
    (place) => {
      state.liveStart = { lat: place.lat, lng: place.lng, name: place.name };
      state.nextPickTarget = state.liveGoal ? "start" : "goal";
      state.overrides = {};
      hideNotice();
      updateClearButtons();
      updatePickHint();
      renderPendingLivePins();
      map.flyTo([place.lat, place.lng], 13, { duration: 0.6 });
      if (state.liveGoal) {
        computeRoute({ flyToRoute: true });
      }
    }
  );

  setupAutocomplete(
    dom.liveGoalInput,
    dom.liveGoalResults,
    () => {
      state.liveGoal = null;
      state.nextPickTarget = state.liveStart ? "goal" : "start";
      clearActiveRouteDisplay({ keepGraphEdges: false });
    },
    (place) => {
      state.liveGoal = { lat: place.lat, lng: place.lng, name: place.name };
      state.nextPickTarget = "start";
      state.overrides = {};
      hideNotice();
      updateClearButtons();
      updatePickHint();
      renderPendingLivePins();
      if (state.liveStart) {
        computeRoute({ flyToRoute: true });
      } else {
        map.flyTo([place.lat, place.lng], 13, { duration: 0.6 });
      }
    }
  );

  dom.clearStartBtn.addEventListener("click", () => {
    dom.liveStartInput.value = "";
    dom.liveStartResults.classList.add("hidden");
    state.liveStart = null;
    state.nextPickTarget = "start";
    updateClearButtons();
    clearActiveRouteDisplay({ keepGraphEdges: false });
    dom.liveStartInput.focus();
  });

  dom.clearGoalBtn.addEventListener("click", () => {
    dom.liveGoalInput.value = "";
    dom.liveGoalResults.classList.add("hidden");
    state.liveGoal = null;
    state.nextPickTarget = state.liveStart ? "goal" : "start";
    updateClearButtons();
    clearActiveRouteDisplay({ keepGraphEdges: false });
    dom.liveGoalInput.focus();
  });

  // Map Click Pinning (Instant coordinates + async reverse-geocode refinement)
  map.on("click", async (ev) => {
    if (state.sourceMode !== "live") return;
    const { lat, lng } = ev.latlng;
    const target = !state.liveStart
      ? "start"
      : !state.liveGoal
      ? "goal"
      : state.nextPickTarget;
    const coordLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

    if (target === "start") {
      state.liveStart = { lat, lng, name: coordLabel };
      dom.liveStartInput.value = coordLabel;
      state.nextPickTarget = "goal";
    } else {
      state.liveGoal = { lat, lng, name: coordLabel };
      dom.liveGoalInput.value = coordLabel;
      state.nextPickTarget = "start";
    }

    state.overrides = {};
    hideNotice();
    updateClearButtons();
    updatePickHint();
    renderPendingLivePins();

    const routePromise =
      state.liveStart && state.liveGoal
        ? computeRoute({ flyToRoute: true })
        : Promise.resolve();

    try {
      const resp = await fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`);
      if (resp.ok) {
        const geo = await resp.json();
        if (geo.name) {
          if (target === "start" && state.liveStart && Math.abs(state.liveStart.lat - lat) < 1e-6) {
            state.liveStart.name = geo.name;
            dom.liveStartInput.value = geo.name;
            if (!state.liveGoal) renderPendingLivePins();
          } else if (target === "goal" && state.liveGoal && Math.abs(state.liveGoal.lat - lat) < 1e-6) {
            state.liveGoal.name = geo.name;
            dom.liveGoalInput.value = geo.name;
            if (!state.liveStart) renderPendingLivePins();
          }
        }
      }
    } catch {
      // keep instant coordinates
    }
    await routePromise;
  });

  dom.pickStartMapBtn.addEventListener("click", () => {
    state.nextPickTarget = "start";
    dom.mapPickHint.textContent = "Click anywhere on the map to set origin";
  });

  dom.pickGoalMapBtn.addEventListener("click", () => {
    state.nextPickTarget = "goal";
    dom.mapPickHint.textContent = "Click anywhere on the map to set destination";
  });

  dom.geoLocateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      showNotice("Browser geolocation is unavailable.");
      return;
    }
    setLoading(true, "Detecting current location…");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const coordLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

        state.liveStart = { lat, lng, name: coordLabel };
        dom.liveStartInput.value = coordLabel;
        state.nextPickTarget = state.liveGoal ? "start" : "goal";
        state.overrides = {};
        hideNotice();
        updateClearButtons();
        updatePickHint();
        renderPendingLivePins();
        map.flyTo([lat, lng], 13, { duration: 0.7 });

        try {
          const resp = await fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`);
          if (resp.ok) {
            const geo = await resp.json();
            if (geo.name) {
              state.liveStart.name = geo.name;
              dom.liveStartInput.value = geo.name;
              renderPendingLivePins();
            }
          }
        } catch {
          // keep coordinate label
        }

        if (state.liveGoal) {
          await computeRoute({ flyToRoute: true });
        } else {
          setLoading(false);
        }
      },
      (err) => {
        setLoading(false);
        showNotice(`Location unavailable: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  dom.swapWaypointsBtn.addEventListener("click", () => {
    dom.liveStartResults.classList.add("hidden");
    dom.liveGoalResults.classList.add("hidden");

    if (state.sourceMode === "live") {
      if (!dom.liveStartInput.value.trim() || !dom.liveGoalInput.value.trim() || !state.liveStart || !state.liveGoal) {
        showNotice("Enter or pick both origin and destination before swapping.");
        return;
      }
      const tmp = state.liveStart;
      state.liveStart = state.liveGoal;
      state.liveGoal = tmp;
      dom.liveStartInput.value = state.liveStart.name;
      dom.liveGoalInput.value = state.liveGoal.name;
    } else {
      const tmp = dom.startSelect.value;
      dom.startSelect.value = dom.endSelect.value;
      dom.endSelect.value = tmp;
    }
    computeRoute({ flyToRoute: true });
  });

  // Traffic Presets & Road Overrides
  async function applyTrafficPreset(preset) {
    state.overrides = {};
    document.querySelectorAll(".preset-pill[data-preset]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.preset === preset);
    });

    if (state.sourceMode === "live") {
      state.livePreset = preset === "default" ? "normal" : preset;
      await computeLiveRoute({ flyToRoute: false });
      return;
    }

    const apiPreset = preset === "normal" ? "default" : preset;
    const resp = await fetch("/api/traffic/preset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: apiPreset }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showNotice(data.error || "Failed to update traffic preset.");
      return;
    }
    state.offlineGraph = data.graph;
    await computeOfflineRoute({ flyToRoute: false });
  }

  function updateSelectedEdgeOverride() {
    const key = state.selectedEdgeKey;
    if (!key) return;
    const weight = parseFloat(dom.edgeWeightSlider.value);
    const blocked = dom.edgeBlockedToggle.checked;

    dom.edgeWeightVal.textContent = `${weight.toFixed(2)}x`;
    state.overrides[key] = { traffic_weight: weight, traffic_factor: weight, blocked };
    computeRoute({ flyToRoute: false });
  }

  // Collapse Card Toggle
  dom.collapseCardBtn.addEventListener("click", () => {
    state.cardCollapsed = !state.cardCollapsed;
    dom.navCard.classList.toggle("is-collapsed", state.cardCollapsed);
    dom.navCardBody.classList.toggle("hidden", state.cardCollapsed);
    dom.collapseCardBtn.setAttribute("aria-expanded", state.cardCollapsed ? "false" : "true");
    dom.collapseChevron.style.transform = state.cardCollapsed ? "rotate(180deg)" : "rotate(0deg)";
  });

  // Event Bindings
  document.querySelectorAll(".segmented-btn[data-source]").forEach((btn) => {
    btn.addEventListener("click", () => switchSourceMode(btn.dataset.source));
  });

  document.querySelectorAll(".mode-btn[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll(".mode-btn[data-mode]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.mode === state.mode);
      });
      computeRoute({ flyToRoute: false });
    });
  });

  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll(".basemap-btn[data-basemap]").forEach((btn) => {
    btn.addEventListener("click", () => switchBasemap(btn.dataset.basemap));
  });

  document.querySelectorAll(".preset-pill[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => applyTrafficPreset(btn.dataset.preset));
  });

  dom.resetTrafficBtn.addEventListener("click", () => {
    document.querySelectorAll(".preset-pill[data-preset]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.preset === "normal");
    });
    applyTrafficPreset("normal");
  });

  dom.graphOverlayBtn.addEventListener("click", () => {
    state.showGraphOverlay = !state.showGraphOverlay;
    dom.graphOverlayBtn.classList.toggle("is-active", state.showGraphOverlay);
    dom.graphOverlayBtn.setAttribute("aria-pressed", state.showGraphOverlay ? "true" : "false");
    if (state.sourceMode === "live") {
      renderLiveMapLayers(state.lastResult);
    } else {
      renderOfflineMapLayers();
    }
  });

  dom.zoomInBtn.addEventListener("click", () => map.zoomIn());
  dom.zoomOutBtn.addEventListener("click", () => map.zoomOut());
  dom.resetViewBtn.addEventListener("click", () => {
    if (state.viewBounds && state.viewBounds.isValid()) {
      map.flyToBounds(state.viewBounds, { padding: [64, 64], duration: 0.6 });
    }
  });

  dom.startSelect.addEventListener("change", () => {
    dom.startSelect.classList.toggle("is-placeholder", !dom.startSelect.value);
    updatePickHint();
    if (dom.startSelect.value && dom.endSelect.value) {
      computeOfflineRoute({ flyToRoute: true });
    } else {
      clearActiveRouteDisplay({ keepGraphEdges: true });
    }
  });
  dom.endSelect.addEventListener("change", () => {
    dom.endSelect.classList.toggle("is-placeholder", !dom.endSelect.value);
    updatePickHint();
    if (dom.startSelect.value && dom.endSelect.value) {
      computeOfflineRoute({ flyToRoute: true });
    } else {
      clearActiveRouteDisplay({ keepGraphEdges: true });
    }
  });
  dom.findRouteBtn.addEventListener("click", () => computeRoute({ flyToRoute: true }));
  dom.dijkstraToggle.addEventListener("change", () => {
    if (state.lastResult) renderResults(state.lastResult);
  });
  dom.replayBtn.addEventListener("click", () => {
    if (state.lastResult) {
      animateFrontierAndRoute(state.lastResult, { flyToRoute: false, forceReplay: true });
    }
  });

  dom.edgeWeightSlider.addEventListener("input", () => {
    dom.edgeWeightVal.textContent = `${parseFloat(dom.edgeWeightSlider.value).toFixed(2)}x`;
  });
  dom.edgeWeightSlider.addEventListener("change", updateSelectedEdgeOverride);
  dom.edgeBlockedToggle.addEventListener("change", updateSelectedEdgeOverride);

  // Boot Application in Clean Empty Startup State (Zero auto-routing on load)
  dom.liveStartInput.value = "";
  dom.liveGoalInput.value = "";
  updateClearButtons();
  updatePickHint();
})();

// AstraPath — Multi-Modal 60fps Canvas Navigation, Offline Places & Auto-Sync Controller

(() => {
  "use strict";

  const DEBOUNCE_MS = 400;
  const FRONTIER_TARGET_MS = 900;
  const CONNECTIVITY_POLL_MS = 15000;
  const LAST_GPS_KEY = "astrapath_last_gps";
  const SAVED_PLACES_KEY = "astrapath_saved_places_v1";
  const SAVED_ROUTES_KEY = "astrapath_saved_routes_v1";
  const OFFLINE_BUNDLE_KEY = "astrapath_offline_bundle_v1";

  const state = {
    sourceMode: "live", // "live" | "offline"
    mode: "fastest",    // "fastest" | "shortest"
    vehicle: "car",     // "car" | "bike" | "cycle" | "walk" | "train" | "flight"
    basemap: "light",   // "light" | "dark" | "satellite"
    activeTab: "directions",
    livePreset: "normal",
    liveStart: null,
    liveGoal: null,
    liveEdges: [],
    offlineGraph: null,
    offlineOriginCoords: null, // { lat, lng, name } for Offline GPS
    savedPlaces: [],
    savedRoutes: [],
    pendingSaveCoords: null,
    isPickingSaveLocation: false,
    isOnline: navigator.onLine !== false,
    manualOfflineOverride: false,
    overrides: {},
    selectedEdgeKey: null,
    pickMode: null, // null | "start"
    originGeocodeSeq: 0,
    destGeocodeSeq: 0,
    animationTimers: [],
    lastResult: null,
    viewBounds: null,
    routeAbortController: null,
    cardCollapsed: false,
    showGraphOverlay: true,
    showHybridLabels: true,
    layersPopoverOpen: false,
    toastTimer: null,
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
    saveLiveStartBtn: document.getElementById("saveLiveStartBtn"),
    saveLiveGoalBtn: document.getElementById("saveLiveGoalBtn"),
    clearStartBtn: document.getElementById("clearStartBtn"),
    clearGoalBtn: document.getElementById("clearGoalBtn"),
    swapWaypointsBtn: document.getElementById("swapWaypointsBtn"),
    geoLocateBtn: document.getElementById("geoLocateBtn"),
    offlineGeoLocateBtn: document.getElementById("offlineGeoLocateBtn"),
    clearOfflineOriginBtn: document.getElementById("clearOfflineOriginBtn"),
    pickStartMapBtn: document.getElementById("pickStartMapBtn"),
    pickGoalMapBtn: document.getElementById("pickGoalMapBtn"),
    startSelect: document.getElementById("startSelect"),
    endSelect: document.getElementById("endSelect"),
    modeSegmented: document.getElementById("modeSegmented"),
    findRouteBtn: document.getElementById("findRouteBtn"),
    offlinePlacesPanel: document.getElementById("offlinePlacesPanel"),
    toggleSaveOfflineBtn: document.getElementById("toggleSaveOfflineBtn"),
    savedCountBadge: document.getElementById("savedCountBadge"),
    savePlaceForm: document.getElementById("savePlaceForm"),
    saveOnlineSearchWrap: document.getElementById("saveOnlineSearchWrap"),
    saveOfflineHint: document.getElementById("saveOfflineHint"),
    savePlaceSearchInput: document.getElementById("savePlaceSearchInput"),
    savePlaceSearchResults: document.getElementById("savePlaceSearchResults"),
    savePlacePickMapBtn: document.getElementById("savePlacePickMapBtn"),
    savePlaceNameInput: document.getElementById("savePlaceNameInput"),
    savePlaceConfirmBtn: document.getElementById("savePlaceConfirmBtn"),
    savedPlacesList: document.getElementById("savedPlacesList"),
    savedRoutesSection: document.getElementById("savedRoutesSection"),
    savedRoutesList: document.getElementById("savedRoutesList"),
    mapPickHint: document.getElementById("mapPickHint"),
    alertBanner: document.getElementById("alertBanner"),
    resultsContainer: document.getElementById("resultsContainer"),
    metricEta: document.getElementById("metricEta"),
    metricDistance: document.getElementById("metricDistance"),
    graphSourcePill: document.getElementById("graphSourcePill"),
    longDistancePill: document.getElementById("longDistancePill"),
    saveRouteOfflineBtn: document.getElementById("saveRouteOfflineBtn"),
    heroAlgoSummary: document.getElementById("heroAlgoSummary"),
    startJourneyBtn: document.getElementById("startJourneyBtn"),
    journeyTopBanner: document.getElementById("journeyTopBanner"),
    journeyTurnIcon: document.getElementById("journeyTurnIcon"),
    journeyStepDist: document.getElementById("journeyStepDist"),
    journeyStepAction: document.getElementById("journeyStepAction"),
    journeyStepRoad: document.getElementById("journeyStepRoad"),
    journeyVoiceBtn: document.getElementById("journeyVoiceBtn"),
    journeyVoiceIconMuted: document.getElementById("journeyVoiceIconMuted"),
    journeyVoiceIconOn: document.getElementById("journeyVoiceIconOn"),
    journeyGpsFallback: document.getElementById("journeyGpsFallback"),
    journeySwitchSimBtn: document.getElementById("journeySwitchSimBtn"),
    journeyBottomBar: document.getElementById("journeyBottomBar"),
    journeyProgressFill: document.getElementById("journeyProgressFill"),
    journeyRemEta: document.getElementById("journeyRemEta"),
    journeyRemDist: document.getElementById("journeyRemDist"),
    journeySpeed: document.getElementById("journeySpeed"),
    journeyFollowBtn: document.getElementById("journeyFollowBtn"),
    journeyFollowLabel: document.getElementById("journeyFollowLabel"),
    journeySimToggleBtn: document.getElementById("journeySimToggleBtn"),
    journeySimLabel: document.getElementById("journeySimLabel"),
    journeySimSpeedBtn: document.getElementById("journeySimSpeedBtn"),
    journeyEndBtn: document.getElementById("journeyEndBtn"),
    journeyArrivalCard: document.getElementById("journeyArrivalCard"),
    journeyArrivalSummary: document.getElementById("journeyArrivalSummary"),
    journeyDoneBtn: document.getElementById("journeyDoneBtn"),
    layersWidget: document.getElementById("layersWidget"),
    layersTriggerBtn: document.getElementById("layersTriggerBtn"),
    layersTriggerPreview: document.getElementById("layersTriggerPreview"),
    layersPopover: document.getElementById("layersPopover"),
    graphOverlayToggle: document.getElementById("graphOverlayToggle"),
    hybridLabelsToggle: document.getElementById("hybridLabelsToggle"),
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
    statusToast: document.getElementById("statusToast"),
    zoomInBtn: document.getElementById("zoomInBtn"),
    zoomOutBtn: document.getElementById("zoomOutBtn"),
    resetViewBtn: document.getElementById("resetViewBtn"),
  };

  // Initialize Full-Bleed Map with 60fps Canvas Vector Rendering
  const map = L.map("map", {
    center: [22.65, 88.39],
    zoom: 11,
    preferCanvas: true,
    zoomControl: false,
    attributionControl: true,
    fadeAnimation: true,
    zoomAnimation: true,
    wheelPxPerZoomLevel: 90,
  });

  const canvasRenderer = L.canvas({ padding: 0.3 });

  map.attributionControl.setPosition("bottomright");
  L.control.scale({ metric: true, imperial: false, maxWidth: 100, position: "bottomright" }).addTo(map);

  [dom.navCard, dom.layersWidget, document.querySelector(".map-controls-br")].forEach((el) => {
    if (el) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
  });

  const hybridLabelsPane = map.createPane("hybridLabelsPane");
  hybridLabelsPane.style.zIndex = 450;
  hybridLabelsPane.style.pointerEvents = "none";

  const baseLayers = {
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxNativeZoom: 19,
      maxZoom: 19,
      keepBuffer: 2,
      updateWhenIdle: false,
      updateWhenZooming: false,
      crossOrigin: true,
    }),
    satellite: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Tiles &copy; Esri",
        maxNativeZoom: 17,
        maxZoom: 19,
        keepBuffer: 2,
        updateWhenIdle: false,
        updateWhenZooming: false,
        crossOrigin: true,
      }
    ),
    hybridPlaces: L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      {
        pane: "hybridLabelsPane",
        maxNativeZoom: 17,
        maxZoom: 19,
        keepBuffer: 1,
        updateWhenIdle: true,
        updateWhenZooming: false,
        crossOrigin: true,
      }
    ),
  };

  let activeBaseLayer = baseLayers.osm.addTo(map);

  const layers = {
    edges: L.layerGroup().addTo(map),
    frontier: L.layerGroup().addTo(map),
    routeTraveled: L.layerGroup().addTo(map),
    routeCasing: L.layerGroup().addTo(map),
    routeInner: L.layerGroup().addTo(map),
    routeReplay: L.layerGroup().addTo(map),
    junctions: L.layerGroup().addTo(map),
    highlightSeg: L.layerGroup().addTo(map),
    nodes: L.layerGroup().addTo(map),
    journeyNav: L.layerGroup().addTo(map),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(message, durationMs = 3200) {
    clearTimeout(state.toastTimer);
    dom.statusToast.textContent = message;
    dom.statusToast.classList.remove("hidden");
    state.toastTimer = setTimeout(() => {
      dom.statusToast.classList.add("hidden");
    }, durationMs);
  }

  function syncHybridLabelsLayer() {
    const showHybrid = state.isOnline && state.basemap === "satellite" && state.showHybridLabels;
    if (showHybrid) {
      if (!map.hasLayer(baseLayers.hybridPlaces)) {
        baseLayers.hybridPlaces.addTo(map);
      }
    } else if (map.hasLayer(baseLayers.hybridPlaces)) {
      map.removeLayer(baseLayers.hybridPlaces);
    }
  }

  // Basemap & Theme Switching (strict single active basemap lifecycle)
  function switchBasemap(styleKey) {
    state.basemap = styleKey;
    const isDark = styleKey === "dark";
    const isSatellite = styleKey === "satellite";
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    document.body.classList.toggle("basemap-dark", isDark);
    document.body.classList.toggle("basemap-satellite", isSatellite);
    document.body.classList.toggle("basemap-light", !isDark && !isSatellite);

    const targetLayer = isSatellite ? baseLayers.satellite : baseLayers.osm;
    [baseLayers.osm, baseLayers.satellite].forEach((layer) => {
      if (layer !== targetLayer && map.hasLayer(layer)) {
        map.removeLayer(layer);
      }
    });
    if (!map.hasLayer(targetLayer)) {
      targetLayer.addTo(map);
    }
    activeBaseLayer = targetLayer;

    syncHybridLabelsLayer();

    document.querySelectorAll(".map-type-card[data-basemap]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.basemap === styleKey);
    });

    dom.layersTriggerPreview.className = isSatellite
      ? "layers-preview preview-default"
      : "layers-preview preview-satellite";
  }

  function getDynamicPadding() {
    const isDesktopExpanded = window.innerWidth > 768 && !state.cardCollapsed;
    if (isDesktopExpanded) {
      return { paddingTopLeft: [420, 64], paddingBottomRight: [64, 72] };
    }
    return { paddingTopLeft: [56, 64], paddingBottomRight: [56, 72] };
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

  function formatCompactEta(minutes) {
    if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "--";
    const totalMin = Math.max(1, Math.round(minutes));
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  function formatHeroEta(minutes) {
    const totalMin = Math.max(0, Math.round(minutes));
    if (totalMin < 60) return `${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
  }

  function updateVehicleButtonsUI() {
    document.querySelectorAll(".vehicle-btn[data-vehicle]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.vehicle === state.vehicle);
    });
    const trafficImmune = state.vehicle === "walk" || state.vehicle === "train" || state.vehicle === "flight";
    dom.modeSegmented.classList.toggle("is-muted", trafficImmune);
  }

  function updateModeEtaStrip(estimates) {
    const allVehicles = ["car", "bike", "cycle", "walk", "train", "flight"];
    allVehicles.forEach((v) => {
      const btn = document.querySelector(`.vehicle-btn[data-vehicle="${v}"]`);
      const badge = document.querySelector(`[data-eta-for="${v}"]`);
      if (!btn || !badge) return;

      const info = estimates?.[v];
      if (!info) {
        badge.textContent = "--";
        btn.classList.remove("is-unavailable");
        return;
      }

      if (!info.available || info.eta_min === null) {
        badge.textContent = "—";
        btn.classList.add("is-unavailable");
        if (info.reason) btn.title = `${v.toUpperCase()}: ${info.reason}`;
      } else {
        badge.textContent = formatCompactEta(info.eta_min);
        btn.classList.remove("is-unavailable");
        btn.title = `${v.charAt(0).toUpperCase() + v.slice(1)}: ${info.distance_km.toFixed(1)} km`;
      }
    });
  }

  function updateLiveActionIcons() {
    const hasStartText = Boolean(dom.liveStartInput.value.trim());
    const hasGoalText = Boolean(dom.liveGoalInput.value.trim());
    dom.clearStartBtn.classList.toggle("hidden", !hasStartText);
    dom.clearGoalBtn.classList.toggle("hidden", !hasGoalText);
    dom.saveLiveStartBtn.classList.toggle("hidden", !state.liveStart);
    dom.saveLiveGoalBtn.classList.toggle("hidden", !state.liveGoal);
  }

  function updatePickHint() {
    if (state.isPickingSaveLocation) {
      dom.mapPickHint.textContent = "Click anywhere on the map to choose a place to save";
      return;
    }
    if (state.sourceMode === "live") {
      if (state.pickMode === "start") {
        dom.mapPickHint.textContent = "Click anywhere on the map to set origin";
      } else if (!state.liveStart && !state.liveGoal) {
        dom.mapPickHint.textContent = "Enter locations or click the map to set origin";
      } else if (state.liveStart && !state.liveGoal) {
        dom.mapPickHint.textContent = "Now enter or click the map to set destination";
      } else if (!state.liveStart && state.liveGoal) {
        dom.mapPickHint.textContent = "Now enter or click the map to set origin";
      } else {
        dom.mapPickHint.textContent = "Click map to set or change destination";
      }
    } else {
      const hasStart = Boolean(dom.startSelect.value) || Boolean(state.offlineOriginCoords);
      const hasEnd = Boolean(dom.endSelect.value);
      if (!hasStart) {
        dom.mapPickHint.textContent = "Select an intersection or use GPS for origin";
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

    updateModeEtaStrip(null);
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

  function renderRouteJunctionDots(result) {
    layers.junctions.clearLayers();
    if (!result?.found || !result.segments?.length) {
      return;
    }

    const segs = result.segments;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const nextSeg = segs[i + 1];
      const pt = seg.geometry?.[seg.geometry.length - 1];
      if (!pt) continue;

      const isRailNode = seg.segment_type === "rail" || nextSeg?.segment_type === "rail";
      const isAirportNode = seg.segment_type === "flight" || nextSeg?.segment_type === "flight";

      if (!state.showGraphOverlay && !isRailNode && !isAirportNode) {
        continue;
      }

      const nodeId = seg.to;
      const nodeLabel = seg.to_name || nodeId;
      const scores = result.node_scores?.[nodeId];
      const scoreHtml = scores
        ? `<div class="num" style="margin-top:2px;">g: ${scores.g.toFixed(2)} &middot; h: ${scores.h.toFixed(2)} &middot; f: ${scores.f.toFixed(2)}</div>`
        : "";

      const fillColor = isAirportNode ? "#4F46E5" : isRailNode ? "#059669" : "#1E40AF";
      const radius = isAirportNode || isRailNode ? 5.5 : 3.5;

      L.circleMarker(pt, {
        renderer: canvasRenderer,
        radius,
        color: "#ffffff",
        weight: 1.5,
        fillColor,
        fillOpacity: 0.95,
      })
        .bindTooltip(`<strong>${escapeHtml(nodeLabel)}</strong> (${escapeHtml(nodeId)})${scoreHtml}`, {
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

    if (state.showGraphOverlay && (state.vehicle !== "train" && state.vehicle !== "flight")) {
      (state.liveEdges || []).forEach((edge) => {
        if (!edge.geometry || edge.geometry.length < 2) return;
        const eff = effectiveEdgeState(edge);
        const color = trafficColor(eff.traffic_weight, eff.blocked);
        const isSelected = state.selectedEdgeKey === edge.id;

        const line = L.polyline(edge.geometry, {
          renderer: canvasRenderer,
          color,
          weight: isSelected ? 4.5 : 3,
          opacity: eff.blocked ? 0.65 : isSelected ? 0.92 : 0.55,
          dashArray: eff.blocked ? "6, 6" : null,
        });

        const statusLabel = eff.blocked ? "Closed" : `${eff.traffic_weight.toFixed(2)}x`;
        line.bindTooltip(
          `<strong>${escapeHtml(edge.road_name)}</strong><br/><span class="num">${Number(edge.speed_limit_kmph)} km/h &middot; ${escapeHtml(statusLabel)}</span>`,
          { sticky: true, className: "map-tooltip" }
        );

        line.on("mouseover", () => line.setStyle({ weight: 4.5, opacity: 0.9 }));
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
    }

    renderRouteJunctionDots(result);

    const startPin = state.liveStart || result?.snapped_start;
    const goalPin = state.liveGoal || result?.snapped_goal;

    const scoreLine = (nid) => {
      const s = result?.node_scores?.[nid];
      return s
        ? `<div class="num" style="margin-top:3px;opacity:0.75;">g ${s.g.toFixed(2)} &middot; h ${s.h.toFixed(2)} &middot; f ${s.f.toFixed(2)}</div>`
        : "";
    };

    if (startPin) {
      L.marker([startPin.lat, startPin.lng], { icon: createOriginIcon(), zIndexOffset: 700 })
        .bindTooltip(`<strong>Origin</strong><br/>${escapeHtml(state.liveStart?.name || startPin.name)}${scoreLine(startPin.id)}`, {
          direction: "top",
          offset: [0, -8],
          className: "map-tooltip",
        })
        .addTo(layers.nodes);
    }

    if (goalPin) {
      L.marker([goalPin.lat, goalPin.lng], { icon: createDestIcon(), zIndexOffset: 700 })
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

    if (state.showGraphOverlay && state.vehicle !== "train" && state.vehicle !== "flight") {
      state.offlineGraph.edges.forEach((edge) => {
        const u = nodeMap[edge.from];
        const v = nodeMap[edge.to];
        if (!u || !v) return;

        const eff = effectiveEdgeState(edge);
        const color = trafficColor(eff.traffic_weight, eff.blocked);
        const key = edgeKeyFor(edge);
        const isSelected = state.selectedEdgeKey === key;
        const pts = edge.geometry && edge.geometry.length >= 2 ? edge.geometry : [[u.lat, u.lng], [v.lat, v.lng]];

        const line = L.polyline(pts, {
          renderer: canvasRenderer,
          color,
          weight: isSelected ? 4.5 : 3,
          opacity: eff.blocked ? 0.65 : isSelected ? 0.92 : 0.55,
          dashArray: eff.blocked ? "6, 6" : null,
        });

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

    if (state.lastResult) {
      renderRouteJunctionDots(state.lastResult);
    }

    const startId = dom.startSelect.value;
    const endId = dom.endSelect.value;
    const routeSet = new Set(state.lastResult?.found ? state.lastResult.path : []);

    state.offlineGraph.nodes.forEach((node) => {
      const isStart = !state.offlineOriginCoords && node.id === startId;
      const isEnd = node.id === endId;

      if (!isStart && !isEnd && !state.showGraphOverlay && !node.saved) {
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
          renderer: canvasRenderer,
          radius: node.saved ? 5.5 : onRoute ? 4 : 3.5,
          fillColor: node.saved ? "#0284C7" : onRoute ? "#1E40AF" : "#64748b",
          color: "#ffffff",
          weight: 1.5,
          fillOpacity: 0.94,
        });
      }

      const s = state.lastResult?.node_scores?.[node.id];
      const scoreHtml = s
        ? `<div class="num" style="margin-top:3px;opacity:0.75;">g ${s.g.toFixed(2)} · h ${s.h.toFixed(2)} · f ${s.f.toFixed(2)}</div>`
        : "";
      const savedTag = node.saved ? " [Saved]" : "";
      marker.bindTooltip(`<strong>${escapeHtml(node.name)}</strong> (${escapeHtml(node.id)})${savedTag}${scoreHtml}`, {
        direction: "top",
        offset: [0, isEnd ? -28 : -8],
        className: "map-tooltip",
      });

      marker.on("click", (ev) => {
        L.DomEvent.stopPropagation(ev);
        if (state.pickMode === "start" || (!dom.startSelect.value && !state.offlineOriginCoords)) {
          state.offlineOriginCoords = null;
          dom.startSelect.value = node.id;
          dom.startSelect.classList.remove("is-placeholder");
          state.pickMode = null;
        } else {
          dom.endSelect.value = node.id;
          dom.endSelect.classList.remove("is-placeholder");
          state.pickMode = null;
        }
        updatePickHint();
        if ((dom.startSelect.value || state.offlineOriginCoords) && dom.endSelect.value) {
          computeRoute({ flyToRoute: true });
        } else {
          renderOfflineMapLayers();
        }
      });

      marker.addTo(layers.nodes);
    });

    if (state.offlineOriginCoords) {
      L.marker([state.offlineOriginCoords.lat, state.offlineOriginCoords.lng], {
        icon: createOriginIcon(),
        zIndexOffset: 720,
      })
        .bindTooltip(`<strong>Origin</strong><br/>${escapeHtml(state.offlineOriginCoords.name)}`, {
          direction: "top",
          offset: [0, -8],
          className: "map-tooltip",
        })
        .addTo(layers.nodes);
    }
  }

  // Mode-Specific Canvas Route Rendering
  function drawStaticRouteLines(result) {
    layers.routeCasing.clearLayers();
    layers.routeInner.clearLayers();
    layers.routeReplay.clearLayers();
    layers.highlightSeg.clearLayers();

    if (!result.found || !result.coordinates || result.coordinates.length === 0) {
      return null;
    }

    if (result.coordinates.length === 1) {
      return L.latLngBounds([result.coordinates[0]]);
    }

    const vehicle = result.vehicle || state.vehicle;
    const allBounds = L.latLngBounds([]);

    if (vehicle === "flight" || vehicle === "train" || vehicle === "walk" || vehicle === "cycle") {
      (result.segments || []).forEach((seg) => {
        const pts = seg.geometry;
        if (!pts || pts.length < 2) return;
        pts.forEach((p) => allBounds.extend(p));

        if (seg.segment_type === "flight") {
          L.polyline(pts, {
            renderer: canvasRenderer,
            color: "#4F46E5",
            weight: 4,
            opacity: 0.95,
            dashArray: "8, 8",
            lineCap: "round",
            interactive: false,
          }).addTo(layers.routeInner);
        } else if (seg.segment_type === "rail") {
          L.polyline(pts, {
            renderer: canvasRenderer,
            color: "#065F46",
            weight: 7,
            opacity: 0.9,
            lineCap: "round",
            interactive: false,
          }).addTo(layers.routeCasing);
          L.polyline(pts, {
            renderer: canvasRenderer,
            color: "#059669",
            weight: 4,
            opacity: 1.0,
            dashArray: "10, 6",
            lineCap: "round",
            interactive: false,
          }).addTo(layers.routeInner);
        } else if (seg.segment_type === "transfer") {
          L.polyline(pts, {
            renderer: canvasRenderer,
            color: "#2563EB",
            weight: 3.5,
            opacity: 0.85,
            dashArray: "4, 6",
            lineCap: "round",
            interactive: false,
          }).addTo(layers.routeInner);
        } else if (vehicle === "walk") {
          L.polyline(pts, {
            renderer: canvasRenderer,
            color: "#2563EB",
            weight: 4,
            opacity: 0.95,
            dashArray: "2, 8",
            lineCap: "round",
            interactive: false,
          }).addTo(layers.routeInner);
        } else if (vehicle === "cycle") {
          L.polyline(pts, {
            renderer: canvasRenderer,
            color: "#0F766E",
            weight: 7,
            opacity: 0.92,
            lineCap: "round",
            lineJoin: "round",
            interactive: false,
          }).addTo(layers.routeCasing);
          L.polyline(pts, {
            renderer: canvasRenderer,
            color: "#0D9488",
            weight: 4,
            opacity: 1.0,
            lineCap: "round",
            lineJoin: "round",
            interactive: false,
          }).addTo(layers.routeInner);
        }
      });
    } else {
      // Car / Bike: Google Maps two-layer cased Navigation Blue, with dotted GPS access stub if present
      const segs = result.segments || [];
      const hasGpsStub = segs.some((s) => String(s.edge_id || "").startsWith("GPS_LINK_"));

      if (hasGpsStub) {
        segs.forEach((seg) => {
          const pts = seg.geometry;
          if (!pts || pts.length < 2) return;
          pts.forEach((p) => allBounds.extend(p));
          if (String(seg.edge_id || "").startsWith("GPS_LINK_")) {
            L.polyline(pts, {
              renderer: canvasRenderer,
              color: "#2563EB",
              weight: 3.5,
              opacity: 0.85,
              dashArray: "3, 7",
              lineCap: "round",
              interactive: false,
            }).addTo(layers.routeInner);
          } else {
            L.polyline(pts, {
              renderer: canvasRenderer,
              color: "#1E40AF",
              weight: 8,
              opacity: 0.95,
              lineCap: "round",
              lineJoin: "round",
              interactive: false,
            }).addTo(layers.routeCasing);
            L.polyline(pts, {
              renderer: canvasRenderer,
              color: "#3B82F6",
              weight: 4.5,
              opacity: 1.0,
              lineCap: "round",
              lineJoin: "round",
              interactive: false,
            }).addTo(layers.routeInner);
          }
        });
      } else {
        L.polyline(result.coordinates, {
          renderer: canvasRenderer,
          color: "#1E40AF",
          weight: 8,
          opacity: 0.95,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(layers.routeCasing);

        const innerLine = L.polyline(result.coordinates, {
          renderer: canvasRenderer,
          color: "#3B82F6",
          weight: 4.5,
          opacity: 1.0,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(layers.routeInner);

        if (innerLine.getBounds().isValid()) {
          state.viewBounds = innerLine.getBounds();
          return innerLine.getBounds();
        }
      }
    }

    if (allBounds.isValid()) {
      state.viewBounds = allBounds;
      return allBounds;
    }
    return null;
  }

  function playFrontierAndReplayFlow(result, { withReplayMotion = false } = {}) {
    if (withReplayMotion && result.found && result.coordinates?.length > 1) {
      const vehicle = result.vehicle || state.vehicle;
      if (vehicle === "car" || vehicle === "bike") {
        layers.routeReplay.clearLayers();
        L.polyline(result.coordinates, {
          renderer: canvasRenderer,
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
        }, 1050);
        state.animationTimers.push(clearMotionTimer);
      }
    }

    const coordsList = result.explored_coords || [];
    if (coordsList.length <= 1) return;

    let sampled = coordsList;
    if (coordsList.length > 120) {
      const stride = coordsList.length / 120;
      sampled = [];
      for (let i = 0; i < 120; i++) {
        sampled.push(coordsList[Math.min(coordsList.length - 1, Math.floor(i * stride))]);
      }
    }

    const stepDelayMs = Math.max(6, Math.floor(FRONTIER_TARGET_MS / sampled.length));
    sampled.forEach((coord, index) => {
      const timerId = setTimeout(() => {
        L.circleMarker(coord, {
          renderer: canvasRenderer,
          radius: 3,
          stroke: false,
          fillColor: "#2563EB",
          fillOpacity: 0.35,
          interactive: false,
        }).addTo(layers.frontier);

        if (index === sampled.length - 1) {
          const fadeTimer = setTimeout(() => {
            layers.frontier.eachLayer((layer) => {
              if (layer.setStyle) layer.setStyle({ fillOpacity: 0.14 });
            });
          }, 350);
          state.animationTimers.push(fadeTimer);
        }
      }, index * stepDelayMs);

      state.animationTimers.push(timerId);
    });
  }

  function animateFrontierAndRoute(result, { flyToRoute = true, forceReplay = false } = {}) {
    clearAnimations();
    layers.frontier.clearLayers();

    if (state.sourceMode === "live") {
      renderLiveMapLayers(result);
    } else {
      renderOfflineMapLayers();
    }

    const routeBounds = drawStaticRouteLines(result);
    const shouldAnimate =
      (dom.animateToggle.checked || forceReplay) &&
      (result.explored_coords?.length || 0) > 1;

    const runPostFrame = () => {
      if (state.lastResult !== result) return;
      if (shouldAnimate) {
        playFrontierAndReplayFlow(result, { withReplayMotion: true });
      }
    };

    if (flyToRoute && routeBounds && routeBounds.isValid()) {
      let triggered = false;
      const finishOnce = () => {
        if (triggered) return;
        triggered = true;
        runPostFrame();
      };

      map.once("moveend", finishOnce);
      const safetyTimer = setTimeout(finishOnce, 550);
      state.animationTimers.push(safetyTimer);

      if (result.coordinates?.length === 1) {
        map.panTo(result.coordinates[0], { animate: true, duration: 0.45 });
      } else {
        map.fitBounds(routeBounds, {
          ...getDynamicPadding(),
          animate: true,
          duration: 0.45,
          maxZoom: 16,
        });
      }
    } else {
      runPostFrame();
    }
  }

  function mergeDirectionSteps(rawSegments) {
    if (!rawSegments || rawSegments.length === 0) return [];

    const nonMicro = rawSegments.filter(
      (seg) => seg.segment_type !== "road" || seg.distance_km >= 0.08
    );
    const source = nonMicro.length > 0 ? nonMicro : rawSegments;

    const merged = [];
    source.forEach((seg) => {
      const weight = seg.traffic_factor ?? seg.traffic_weight ?? 1.0;
      const geom = Array.isArray(seg.geometry) ? seg.geometry : [];
      const prev = merged[merged.length - 1];

      if (
        prev &&
        prev.road_name === seg.road_name &&
        prev.segment_type === seg.segment_type
      ) {
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
          segment_type: seg.segment_type || "road",
          geometry: [...geom],
        });
      }
    });

    return merged;
  }

  function formatStepDuration(minutes) {
    if (minutes < 1.0) return "< 1 min";
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = Math.round(minutes % 60);
      return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
    return `${Math.round(minutes)} min`;
  }

  function formatTrafficSubtitle(step) {
    if (step.segment_type === "flight") return `Air corridor · ${Math.round(step.speed_limit_kmph)} km/h`;
    if (step.segment_type === "rail") return `Rail transit · ${Math.round(step.speed_limit_kmph)} km/h`;
    if (step.segment_type === "transfer") return "Station / airport access";
    if (state.vehicle === "walk") return "Pedestrian path · 5 km/h";
    if (state.vehicle === "cycle") return "Bicycle route · 16 km/h";

    const w = step.traffic_weight;
    if (w < 1.3) return `Smooth traffic · ${Math.round(step.speed_limit_kmph)} km/h`;
    if (w <= 2.0) return `Moderate traffic · ${w.toFixed(1)}x delay`;
    return `Heavy traffic · ${w.toFixed(1)}x delay`;
  }

  function stepDotColor(step) {
    if (step.segment_type === "flight") return "#4F46E5";
    if (step.segment_type === "rail") return "#059669";
    if (step.segment_type === "transfer") return "#2563EB";
    if (state.vehicle === "cycle") return "#0D9488";
    if (state.vehicle === "walk") return "#2563EB";
    return trafficColor(step.traffic_weight, false);
  }

  function renderResults(result) {
    dom.resultsContainer.classList.remove("hidden");
    updateModeEtaStrip(result.mode_estimates);

    if (state.sourceMode === "live" && result.graph_stats) {
      const gs = result.graph_stats;
      const statsSrc = result.transit_graph_stats || gs;
      dom.graphScaleText.textContent = `${statsSrc.total_intersections.toLocaleString()} nodes · ${statsSrc.total_roads.toLocaleString()} edges`;
      const srcLabel =
        state.vehicle === "train"
          ? "Rail Graph"
          : state.vehicle === "flight"
          ? "Air Graph"
          : result.graph_source === "corridor_fallback" || gs.graph_source === "corridor_fallback"
          ? "Corridor Graph"
          : "Live OSM";
      dom.graphSourcePill.textContent = gs.cache_hit && state.vehicle !== "train" && state.vehicle !== "flight" ? `${srcLabel} · cached` : srcLabel;
      dom.longDistancePill.classList.toggle("hidden", !result.long_distance_notice);
    } else if (state.offlineGraph) {
      const statsSrc = result.transit_graph_stats || {
        total_intersections: state.offlineGraph.nodes.length,
        total_roads: state.offlineGraph.edges.length,
      };
      dom.graphScaleText.textContent = `${statsSrc.total_intersections} nodes · ${statsSrc.total_roads} edges`;
      dom.graphSourcePill.textContent =
        state.vehicle === "train"
          ? "Offline + Rail"
          : state.vehicle === "flight"
          ? "Offline + Air"
          : "Offline Graph";
      dom.longDistancePill.classList.add("hidden");
    }

    const dijk = result.dijkstra;
    if (dijk && result.found) {
      const pctText =
        dijk.node_reduction_pct > 0
          ? `${dijk.node_reduction_pct.toFixed(0)}% fewer than Dijkstra`
          : "matches Dijkstra";
      dom.heroAlgoSummary.textContent = `A*: ${result.nodes_expanded.toLocaleString()} nodes (${result.runtime_ms.toFixed(1)} ms) · ${pctText}`;
      dom.heroAlgoSummary.classList.remove("hidden");
    } else {
      dom.heroAlgoSummary.classList.add("hidden");
    }

    const canSaveLive = state.sourceMode === "live" && Boolean(result.found);
    dom.saveRouteOfflineBtn.classList.toggle("hidden", !canSaveLive);
    const activeVeh = result.vehicle || state.vehicle;
    const canStartJourney =
      state.sourceMode === "live" &&
      Boolean(result.found) &&
      activeVeh !== "flight" &&
      (result.coordinates?.length || 0) >= 2;
    dom.startJourneyBtn.classList.toggle("hidden", !canStartJourney);

    if (!result.found) {
      showNotice(result.reason || result.error || "No route available for this mode.");
      dom.metricEta.textContent = "-- min";
      dom.metricDistance.textContent = "-- km";
      dom.itineraryList.innerHTML = `<li class="inspector-empty">${escapeHtml(result.reason || result.error || "Destination unreachable.")}</li>`;
    } else {
      hideNotice();
      dom.metricEta.textContent = formatHeroEta(result.estimated_time_min);
      dom.metricDistance.textContent = `${result.total_distance_km.toFixed(1)} km`;

      const displaySteps = mergeDirectionSteps(result.segments);
      if (displaySteps.length === 0) {
        dom.itineraryList.innerHTML = `<li class="inspector-empty">Origin and destination share the same intersection.</li>`;
      } else {
        dom.itineraryList.innerHTML = displaySteps
          .map((step, idx) => {
            const dotColor = stepDotColor(step);
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
              renderer: canvasRenderer,
              color: "#1D4ED8",
              weight: 7,
              opacity: 0.9,
            }).addTo(layers.highlightSeg);
            if (segLine.getBounds().isValid()) {
              map.fitBounds(segLine.getBounds(), { ...getDynamicPadding(), animate: true, duration: 0.45, maxZoom: 16 });
            }
          });
        });
      }
    }

    dom.dijkstraCard.classList.toggle("hidden", !dom.dijkstraToggle.checked || !dijk);
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
      if (!state.liveStart) dom.liveStartInput.focus();
      else dom.liveGoalInput.focus();
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
          vehicle: state.vehicle,
          compare_dijkstra: dom.dijkstraToggle.checked,
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
    if ((!dom.startSelect.value && !state.offlineOriginCoords) || !dom.endSelect.value) {
      showNotice("Please choose both a starting intersection and destination");
      if (!dom.startSelect.value && !state.offlineOriginCoords) dom.startSelect.focus();
      else dom.endSelect.focus();
      return;
    }

    if (state.routeAbortController) {
      state.routeAbortController.abort();
    }
    const controller = new AbortController();
    state.routeAbortController = controller;

    setLoading(true, "Calculating offline route…");
    try {
      const payload = {
        start: dom.startSelect.value,
        end: dom.endSelect.value,
        mode: state.mode,
        vehicle: state.vehicle,
        compare_dijkstra: dom.dijkstraToggle.checked,
        traffic_overrides: state.overrides,
        custom_places: state.savedPlaces,
      };
      if (state.offlineOriginCoords) {
        payload.origin_coords = state.offlineOriginCoords;
      }

      const bundle = getCachedOfflineBundle();
      let data = null;
      let ok = false;

      if (bundle && window.AstraOfflineEngine) {
        data = window.AstraOfflineEngine.computeOfflineRouteLocal(bundle, payload);
        ok = Boolean(data);
      } else {
        const resp = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        data = await resp.json();
        ok = resp.ok;
      }

      if (state.routeAbortController !== controller || state.sourceMode !== "offline") return;

      if (!ok || !data) {
        showNotice(data?.error || "Failed to compute offline route.");
        return;
      }

      state.lastResult = data;
      if (state.selectedEdgeKey) selectRoadForInspection(state.selectedEdgeKey);
      renderResults(data);
      animateFrontierAndRoute(data, { flyToRoute });
    } catch (err) {
      if (err.name === "AbortError") return;
      const fallbackBundle = getCachedOfflineBundle();
      if (fallbackBundle && window.AstraOfflineEngine) {
        const localData = window.AstraOfflineEngine.computeOfflineRouteLocal(fallbackBundle, {
          start: dom.startSelect.value,
          end: dom.endSelect.value,
          mode: state.mode,
          vehicle: state.vehicle,
          compare_dijkstra: dom.dijkstraToggle.checked,
          traffic_overrides: state.overrides,
          custom_places: state.savedPlaces,
          origin_coords: state.offlineOriginCoords || undefined,
        });
        state.lastResult = localData;
        renderResults(localData);
        animateFrontierAndRoute(localData, { flyToRoute });
        return;
      }
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

  // Offline Graph & Saved Custom Places Management
  function syncOfflineDropdownsFromGraph() {
    if (!state.offlineGraph) return;
    const prevStart = dom.startSelect.value;
    const prevEnd = dom.endSelect.value;
    const nodes = state.offlineGraph.nodes || [];

    dom.startSelect.innerHTML = "";
    dom.endSelect.innerHTML = "";
    dom.startSelect.add(new Option("Select starting intersection...", ""));
    dom.endSelect.add(new Option("Select destination...", ""));

    if (state.offlineOriginCoords) {
      dom.startSelect.add(new Option("My Location (GPS)", "GPS_ORIGIN"));
    }

    nodes.forEach((node) => {
      if (node.id === "GPS_ORIGIN") return;
      const suffix = node.saved ? "Saved" : node.id;
      dom.startSelect.add(new Option(`${node.name} (${suffix})`, node.id));
      dom.endSelect.add(new Option(`${node.name} (${suffix})`, node.id));
    });

    if (state.offlineOriginCoords) {
      dom.startSelect.value = "GPS_ORIGIN";
      dom.clearOfflineOriginBtn.classList.remove("hidden");
    } else {
      dom.startSelect.value = nodes.some((n) => n.id === prevStart) ? prevStart : "";
      dom.clearOfflineOriginBtn.classList.add("hidden");
    }
    dom.endSelect.value = nodes.some((n) => n.id === prevEnd) ? prevEnd : "";
    dom.startSelect.classList.toggle("is-placeholder", !dom.startSelect.value);
    dom.endSelect.classList.toggle("is-placeholder", !dom.endSelect.value);
  }

  function loadLocalSavedRoutes() {
    try {
      const raw = localStorage.getItem(SAVED_ROUTES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function persistLocalSavedRoutes(routes) {
    try {
      localStorage.setItem(SAVED_ROUTES_KEY, JSON.stringify(routes || []));
    } catch {
      // ignore quota errors
    }
  }

  function renderSavedRoutesList() {
    const routes = state.savedRoutes || [];
    dom.savedRoutesSection.classList.toggle("hidden", routes.length === 0);
    dom.savedRoutesList.innerHTML = routes
      .map(
        (r) => `
        <li class="saved-place-item">
          <button type="button" class="saved-place-main" data-load-route="${escapeHtml(r.id)}" title="Load saved offline route">
            <span class="saved-badge">Route</span>
            <span class="saved-name-text">${escapeHtml(r.name)}</span>
          </button>
          <button type="button" class="inline-icon-btn" data-del-route="${escapeHtml(r.id)}" title="Delete saved route" aria-label="Delete ${escapeHtml(r.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6M14 11v6"></path>
            </svg>
          </button>
        </li>`
      )
      .join("");

    dom.savedRoutesList.querySelectorAll("[data-load-route]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = state.savedRoutes.find((r) => r.id === btn.dataset.loadRoute);
        if (!entry || !entry.result) return;
        state.lastResult = entry.result;
        renderResults(entry.result);
        animateFrontierAndRoute(entry.result, { flyToRoute: true });
        showToast(`Loaded offline route: ${entry.name}`);
      });
    });

    dom.savedRoutesList.querySelectorAll("[data-del-route]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rid = btn.dataset.delRoute;
        state.savedRoutes = state.savedRoutes.filter((r) => r.id !== rid);
        persistLocalSavedRoutes(state.savedRoutes);
        renderSavedRoutesList();
        showToast("Removed saved route");
      });
    });
  }

  function saveActiveRouteOffline() {
    if (!state.lastResult || !state.lastResult.found) return;
    const originName = state.liveStart?.name || "Origin";
    const destName = state.liveGoal?.name || "Destination";
    const snapshot = {
      id: `R_${Date.now()}`,
      name: `${originName} → ${destName}`,
      vehicle: state.vehicle,
      mode: state.mode,
      savedAt: Date.now(),
      result: state.lastResult,
    };
    state.savedRoutes = [snapshot, ...state.savedRoutes.slice(0, 19)];
    persistLocalSavedRoutes(state.savedRoutes);
    renderSavedRoutesList();
    showToast("Saved route for offline viewing");
  }

  function renderSavedPlacesList() {
    const places = state.savedPlaces || [];
    dom.savedCountBadge.textContent = `${places.length} saved`;
    dom.savedPlacesList.classList.toggle("hidden", places.length === 0);

    dom.savedPlacesList.innerHTML = places
      .map(
        (p) => `
        <li class="saved-place-item">
          <button type="button" class="saved-place-main" data-pick-saved="${escapeHtml(p.id)}" title="Set as offline destination">
            <span class="saved-badge">Saved</span>
            <span class="saved-name-text">${escapeHtml(p.name)}</span>
          </button>
          <button type="button" class="inline-icon-btn" data-del-saved="${escapeHtml(p.id)}" title="Delete saved place" aria-label="Delete ${escapeHtml(p.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6M14 11v6"></path>
            </svg>
          </button>
        </li>`
      )
      .join("");

    dom.savedPlacesList.querySelectorAll("[data-pick-saved]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pid = btn.dataset.pickSaved;
        dom.endSelect.value = pid;
        dom.endSelect.classList.remove("is-placeholder");
        updatePickHint();
        if (dom.startSelect.value || state.offlineOriginCoords) {
          computeOfflineRoute({ flyToRoute: true });
        } else {
          renderOfflineMapLayers();
        }
      });
    });

    dom.savedPlacesList.querySelectorAll("[data-del-saved]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.delSaved;
        state.savedPlaces = state.savedPlaces.filter((p) => p.id !== pid);
        persistLocalSavedPlaces(state.savedPlaces);
        try {
          await fetch(`/api/offline/places/${encodeURIComponent(pid)}`, { method: "DELETE" });
        } catch {
          // Offline or browser-only storage; local state is already updated
        }
        rebuildOfflineGraphFromCache();
        syncOfflineDropdownsFromGraph();
        renderSavedPlacesList();
        renderOfflineMapLayers();
        showToast("Removed saved place");
      });
    });
  }

  function getCachedOfflineBundle() {
    try {
      const raw = localStorage.getItem(OFFLINE_BUNDLE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.city_graph ? parsed : null;
    } catch {
      return null;
    }
  }

  function loadLocalSavedPlaces() {
    try {
      const raw = localStorage.getItem(SAVED_PLACES_KEY) || localStorage.getItem("astrapath_saved_places");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function persistLocalSavedPlaces(places) {
    try {
      localStorage.setItem(SAVED_PLACES_KEY, JSON.stringify(places || []));
    } catch {
      // Ignore storage quota errors
    }
  }

  function rebuildOfflineGraphFromCache() {
    const bundle = getCachedOfflineBundle();
    if (bundle && window.AstraOfflineEngine) {
      const merged = window.AstraOfflineEngine.mergeOfflineGraph(
        bundle.city_graph,
        state.savedPlaces,
        state.offlineOriginCoords
      );
      state.offlineGraph = { city: merged.city, nodes: merged.nodes, edges: merged.edges };
      return true;
    }
    return false;
  }

  async function syncOfflineBundleInBackground() {
    try {
      const resp = await fetch("/api/offline-bundle");
      if (!resp.ok) return null;
      const bundle = await resp.json();
      if (bundle && bundle.city_graph) {
        localStorage.setItem(OFFLINE_BUNDLE_KEY, JSON.stringify(bundle));
      }
      return bundle;
    } catch {
      return null;
    }
  }

  function nextLocalPlaceId(places) {
    let maxIdx = 0;
    (places || []).forEach((p) => {
      const m = /^U(\d+)$/.exec(String(p.id || ""));
      if (m) maxIdx = Math.max(maxIdx, Number(m[1]));
    });
    return `U${maxIdx + 1}`;
  }

  async function savePlaceForOffline(name, lat, lng) {
    const cleanName = name.trim().slice(0, 80);
    if (!cleanName) return;

    let savedRecord = null;
    try {
      if (state.isOnline) {
        const resp = await fetch("/api/offline/places", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: cleanName, lat, lng, category: "custom" }),
        });
        if (resp.ok) {
          const data = await resp.json();
          savedRecord = data.place;
        }
      }
    } catch {
      // Fall back to pure browser-side storage when offline
    }

    if (!savedRecord) {
      savedRecord = {
        id: nextLocalPlaceId(state.savedPlaces),
        name: cleanName,
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        category: "custom",
        connectors: [],
      };
    }

    if (!state.savedPlaces.some((p) => p.id === savedRecord.id)) {
      state.savedPlaces.push(savedRecord);
    }
    persistLocalSavedPlaces(state.savedPlaces);
    if (!rebuildOfflineGraphFromCache() && state.isOnline) {
      await loadOfflineGraphAndPlaces();
    }
    if (state.sourceMode === "offline") {
      syncOfflineDropdownsFromGraph();
      renderOfflineMapLayers();
    }
    renderSavedPlacesList();
    showToast(`Saved "${savedRecord.name}" for offline routing`);
  }

  async function loadOfflineGraphAndPlaces() {
    state.savedPlaces = loadLocalSavedPlaces();
    state.savedRoutes = loadLocalSavedRoutes();
    if (!getCachedOfflineBundle() && state.isOnline) {
      await syncOfflineBundleInBackground();
    }

    if (!rebuildOfflineGraphFromCache()) {
      const resp = await fetch("/api/graph");
      if (!resp.ok) throw new Error("Failed to load offline road network.");
      state.offlineGraph = await resp.json();
    }

    if (state.savedPlaces.length === 0 && state.isOnline) {
      try {
        const placesResp = await fetch("/api/offline/places");
        if (placesResp.ok) {
          const pData = await placesResp.json();
          if (Array.isArray(pData.places) && pData.places.length > 0) {
            state.savedPlaces = pData.places;
            persistLocalSavedPlaces(state.savedPlaces);
            rebuildOfflineGraphFromCache();
          }
        }
      } catch {
        // Offline
      }
    }

    syncOfflineDropdownsFromGraph();
    renderSavedPlacesList();
    renderSavedRoutesList();
  }

  function updateOfflineSaveBoxVisibility() {
    const showSearch = state.isOnline;
    dom.saveOnlineSearchWrap.classList.toggle("hidden", !showSearch);
    dom.saveOfflineHint.classList.toggle("hidden", showSearch);
  }

  async function switchSourceMode(source, { isAutoSwitch = false } = {}) {
    if (!isAutoSwitch && source === "offline" && state.isOnline) {
      state.manualOfflineOverride = true;
    } else if (source === "live") {
      state.manualOfflineOverride = false;
    }

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
    state.isPickingSaveLocation = false;
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
    dom.offlinePlacesPanel.classList.toggle("hidden", isLive);
    updateOfflineSaveBoxVisibility();

    try {
      if (isLive) {
        if (state.liveStart && state.liveGoal) {
          await computeLiveRoute({ flyToRoute: true });
        } else {
          clearActiveRouteDisplay({ keepGraphEdges: false });
        }
      } else {
        await loadOfflineGraphAndPlaces();
        state.viewBounds = L.latLngBounds(state.offlineGraph.nodes.map((n) => [n.lat, n.lng]));
        map.fitBounds(state.viewBounds, { ...getDynamicPadding(), animate: true, duration: 0.45, maxZoom: 16 });
        if ((dom.startSelect.value || state.offlineOriginCoords) && dom.endSelect.value) {
          await computeOfflineRoute({ flyToRoute: true });
        } else {
          clearActiveRouteDisplay({ keepGraphEdges: true });
        }
      }
    } catch (err) {
      showNotice(`Unable to switch mode: ${err.message}`);
    }
  }

  // Automatic Online <-> Offline Detection
  function applyConnectivityState(onlineNow, { isInitial = false } = {}) {
    const prevOnline = state.isOnline;
    state.isOnline = Boolean(onlineNow);
    document.body.classList.toggle("is-offline-tiles", !state.isOnline);
    syncHybridLabelsLayer();
    updateOfflineSaveBoxVisibility();

    if (isInitial) {
      if (!state.isOnline) {
        switchSourceMode("offline", { isAutoSwitch: true });
        showToast("Offline mode — using saved places & local graph", 4200);
      }
      return;
    }

    if (prevOnline && !state.isOnline) {
      if (state.sourceMode !== "offline") {
        switchSourceMode("offline", { isAutoSwitch: true });
      }
      showToast("Connection lost — switched to Offline mode", 3800);
    } else if (!prevOnline && state.isOnline) {
      if (!state.manualOfflineOverride && state.sourceMode !== "live") {
        switchSourceMode("live", { isAutoSwitch: true });
        showToast("Back online — switched to Live mode", 3200);
      }
    }
  }

  async function probeConnectivity({ isInitial = false } = {}) {
    if (navigator.onLine === false) {
      applyConnectivityState(false, { isInitial });
      return;
    }
    try {
      const resp = await fetch("/api/connectivity", { cache: "no-store" });
      if (!resp.ok) {
        applyConnectivityState(false, { isInitial });
        return;
      }
      const data = await resp.json();
      applyConnectivityState(Boolean(data.online), { isInitial });
    } catch {
      applyConnectivityState(false, { isInitial });
    }
  }

  window.addEventListener("online", () => probeConnectivity({ isInitial: false }));
  window.addEventListener("offline", () => applyConnectivityState(false, { isInitial: false }));

  setInterval(() => {
    if (document.visibilityState === "visible") {
      probeConnectivity({ isInitial: false });
    }
  }, CONNECTIVITY_POLL_MS);

  // Debounced Autocomplete Search
  function setupAutocomplete(inputEl, resultsEl, onInputEmpty, onSelect) {
    let debounceTimer = null;

    inputEl.addEventListener("input", () => {
      updateLiveActionIcons();
      clearTimeout(debounceTimer);
      const query = inputEl.value.trim();
      if (!query) onInputEmpty();
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
      ++state.originGeocodeSeq;
      state.pickMode = null;
      updateLiveActionIcons();
      updatePickHint();
      clearActiveRouteDisplay({ keepGraphEdges: false });
    },
    (place) => {
      state.liveStart = { lat: place.lat, lng: place.lng, name: place.name };
      ++state.originGeocodeSeq;
      state.pickMode = null;
      state.overrides = {};
      hideNotice();
      updateLiveActionIcons();
      updatePickHint();
      renderPendingLivePins();
      map.flyTo([place.lat, place.lng], 13, { duration: 0.5 });
      if (state.liveGoal) computeRoute({ flyToRoute: true });
    }
  );

  setupAutocomplete(
    dom.liveGoalInput,
    dom.liveGoalResults,
    () => {
      state.liveGoal = null;
      ++state.destGeocodeSeq;
      state.pickMode = null;
      updateLiveActionIcons();
      updatePickHint();
      clearActiveRouteDisplay({ keepGraphEdges: false });
    },
    (place) => {
      state.liveGoal = { lat: place.lat, lng: place.lng, name: place.name };
      ++state.destGeocodeSeq;
      state.pickMode = null;
      state.overrides = {};
      hideNotice();
      updateLiveActionIcons();
      updatePickHint();
      renderPendingLivePins();
      if (state.liveStart) computeRoute({ flyToRoute: true });
      else map.flyTo([place.lat, place.lng], 13, { duration: 0.5 });
    }
  );

  setupAutocomplete(
    dom.savePlaceSearchInput,
    dom.savePlaceSearchResults,
    () => {
      state.pendingSaveCoords = null;
    },
    (place) => {
      state.pendingSaveCoords = { lat: place.lat, lng: place.lng };
      if (!dom.savePlaceNameInput.value.trim()) {
        dom.savePlaceNameInput.value = place.name.split(",")[0].slice(0, 60);
      }
    }
  );

  // Live Save-for-Offline Buttons
  dom.saveLiveStartBtn.addEventListener("click", () => {
    if (state.liveStart) {
      savePlaceForOffline(state.liveStart.name.split(",")[0], state.liveStart.lat, state.liveStart.lng);
    }
  });

  dom.saveLiveGoalBtn.addEventListener("click", () => {
    if (state.liveGoal) {
      savePlaceForOffline(state.liveGoal.name.split(",")[0], state.liveGoal.lat, state.liveGoal.lng);
    }
  });

  dom.toggleSaveOfflineBtn.addEventListener("click", () => {
    dom.savePlaceForm.classList.toggle("hidden");
  });

  dom.savePlacePickMapBtn.addEventListener("click", () => {
    state.isPickingSaveLocation = true;
    updatePickHint();
    showToast("Tap anywhere on the map to pick a location to save");
  });

  dom.savePlaceConfirmBtn.addEventListener("click", async () => {
    const label = dom.savePlaceNameInput.value.trim();
    if (!label) {
      showNotice("Enter a label for the saved offline place.");
      dom.savePlaceNameInput.focus();
      return;
    }
    if (!state.pendingSaveCoords) {
      showNotice("Search a place or tap the map to pick coordinates first.");
      return;
    }
    await savePlaceForOffline(label, state.pendingSaveCoords.lat, state.pendingSaveCoords.lng);
    dom.savePlaceNameInput.value = "";
    dom.savePlaceSearchInput.value = "";
    state.pendingSaveCoords = null;
    state.isPickingSaveLocation = false;
    dom.savePlaceForm.classList.add("hidden");
    updatePickHint();
  });

  dom.clearStartBtn.addEventListener("click", () => {
    dom.liveStartInput.value = "";
    dom.liveStartResults.classList.add("hidden");
    state.liveStart = null;
    ++state.originGeocodeSeq;
    state.pickMode = "start";
    updateLiveActionIcons();
    updatePickHint();
    clearActiveRouteDisplay({ keepGraphEdges: false });
    dom.liveStartInput.focus();
  });

  dom.clearGoalBtn.addEventListener("click", () => {
    dom.liveGoalInput.value = "";
    dom.liveGoalResults.classList.add("hidden");
    state.liveGoal = null;
    ++state.destGeocodeSeq;
    state.pickMode = null;
    updateLiveActionIcons();
    updatePickHint();
    clearActiveRouteDisplay({ keepGraphEdges: false });
    dom.liveGoalInput.focus();
  });

  // Map Click Handler (Supports Save-Pin Picking + Live Waypoint Picking)
  map.on("click", async (ev) => {
    if (state.layersPopoverOpen) setLayersPopoverOpen(false);
    const { lat, lng } = ev.latlng;

    if (state.sourceMode === "offline" && state.isPickingSaveLocation) {
      state.pendingSaveCoords = { lat, lng };
      state.isPickingSaveLocation = false;
      dom.savePlaceForm.classList.remove("hidden");
      if (!dom.savePlaceNameInput.value.trim()) {
        dom.savePlaceNameInput.value = `Pin ${lat.toFixed(3)}, ${lng.toFixed(3)}`;
      }
      dom.savePlaceNameInput.focus();
      updatePickHint();
      return;
    }

    if (state.sourceMode !== "live") return;

    const target = state.pickMode === "start" || !state.liveStart ? "start" : "goal";
    const coordLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    let geocodeSeq = 0;

    if (target === "start") {
      state.liveStart = { lat, lng, name: coordLabel };
      dom.liveStartInput.value = coordLabel;
      state.pickMode = null;
      geocodeSeq = ++state.originGeocodeSeq;
    } else {
      state.liveGoal = { lat, lng, name: coordLabel };
      dom.liveGoalInput.value = coordLabel;
      state.pickMode = null;
      geocodeSeq = ++state.destGeocodeSeq;
    }

    state.overrides = {};
    hideNotice();
    updateLiveActionIcons();
    updatePickHint();
    renderPendingLivePins();

    const routePromise =
      state.liveStart && state.liveGoal ? computeRoute({ flyToRoute: true }) : Promise.resolve();

    try {
      const resp = await fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`);
      if (resp.ok) {
        const geo = await resp.json();
        if (geo.name) {
          if (target === "start") {
            if (geocodeSeq !== state.originGeocodeSeq || !state.liveStart) return;
            state.liveStart.name = geo.name;
            dom.liveStartInput.value = geo.name;
            renderPendingLivePins();
          } else {
            if (geocodeSeq !== state.destGeocodeSeq || !state.liveGoal) return;
            state.liveGoal.name = geo.name;
            dom.liveGoalInput.value = geo.name;
            renderPendingLivePins();
          }
        }
      }
    } catch {
      // keep instant coordinates
    }
    await routePromise;
  });

  dom.pickStartMapBtn.addEventListener("click", () => {
    state.pickMode = "start";
    updatePickHint();
  });

  dom.pickGoalMapBtn.addEventListener("click", () => {
    state.pickMode = null;
    dom.mapPickHint.textContent = "Click anywhere on the map to set destination";
  });

  // 4-Tier Location Resolution Cascade (High-Acc GPS -> Low-Acc Browser -> Server IP -> Cached GPS)
  function getPositionAsync(options) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject({ code: 2, message: "Geolocation unavailable" });
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
  }

  async function resolveUserLocation({ allowApproximate = true, buttonEl = null } = {}) {
    if (buttonEl) buttonEl.classList.add("is-locating");
    let permissionDenied = false;

    try {
      // Tier 1: High-Accuracy GPS (Mobile)
      try {
        const pos = await getPositionAsync({
          enableHighAccuracy: true,
          timeout: 4500,
          maximumAge: 60000,
        });
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        localStorage.setItem(LAST_GPS_KEY, JSON.stringify({ lat, lng, timestamp: Date.now() }));
        return { lat, lng, label: null, source: "gps_high", approximate: false };
      } catch (err1) {
        if (err1 && err1.code === 1) {
          permissionDenied = true;
        } else if (err1 && (err1.code === 2 || err1.code === 3)) {
          // Tier 2: Fast Low-Accuracy Browser Geolocation (Laptops)
          try {
            const pos2 = await getPositionAsync({
              enableHighAccuracy: false,
              timeout: 6000,
              maximumAge: 300000,
            });
            const lat = pos2.coords.latitude;
            const lng = pos2.coords.longitude;
            localStorage.setItem(LAST_GPS_KEY, JSON.stringify({ lat, lng, timestamp: Date.now() }));
            return { lat, lng, label: null, source: "gps_low", approximate: false };
          } catch (err2) {
            if (err2 && err2.code === 1) permissionDenied = true;
          }
        }
      }

      // Tier 3: Instant Server IP Geolocation
      if (allowApproximate && state.isOnline) {
        try {
          const resp = await fetch("/api/ip-location", { cache: "no-store" });
          if (resp.ok) {
            const data = await resp.json();
            if (typeof data.lat === "number" && typeof data.lng === "number") {
              return {
                lat: data.lat,
                lng: data.lng,
                label: data.label || `${data.lat.toFixed(4)}, ${data.lng.toFixed(4)}`,
                source: "ip",
                approximate: true,
                permissionDenied,
              };
            }
          }
        } catch {
          // proceed to Tier 4
        }
      }

      // Tier 4: Cached Last GPS Fix
      try {
        const raw = localStorage.getItem(LAST_GPS_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          if (typeof cached.lat === "number" && typeof cached.lng === "number") {
            return {
              lat: cached.lat,
              lng: cached.lng,
              label: "My Location (Last GPS)",
              source: "cache",
              approximate: true,
              permissionDenied,
            };
          }
        }
      } catch {
        // ignore storage error
      }

      return { error: permissionDenied ? "Location permission denied." : "Location unavailable.", permissionDenied };
    } finally {
      if (buttonEl) buttonEl.classList.remove("is-locating");
    }
  }

  // Live GPS + 4-Tier Fallback
  dom.geoLocateBtn.addEventListener("click", async () => {
    setLoading(true, "Detecting current location…");
    const loc = await resolveUserLocation({ allowApproximate: true, buttonEl: dom.geoLocateBtn });
    if (loc.error) {
      setLoading(false);
      showNotice(loc.error);
      return;
    }

    const { lat, lng } = loc;
    const coordLabel = loc.label || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

    state.liveStart = { lat, lng, name: coordLabel };
    dom.liveStartInput.value = coordLabel;
    state.pickMode = null;
    const geocodeSeq = ++state.originGeocodeSeq;
    state.overrides = {};
    hideNotice();
    updateLiveActionIcons();
    updatePickHint();
    renderPendingLivePins();
    map.flyTo([lat, lng], 13, { duration: 0.5 });

    if (loc.source === "ip") {
      showToast("Using approximate network location — tap the map to fine-tune your exact start point", 4800);
    } else if (loc.source === "cache") {
      showToast("Using last saved GPS location", 3500);
    }

    if (!loc.label) {
      try {
        const resp = await fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`);
        if (resp.ok) {
          const geo = await resp.json();
          if (geo.name) {
            if (geocodeSeq !== state.originGeocodeSeq || !state.liveStart) return;
            state.liveStart.name = geo.name;
            dom.liveStartInput.value = geo.name;
            renderPendingLivePins();
          }
        }
      } catch {
        // keep coordinate label
      }
    }

    if (state.liveGoal) await computeRoute({ flyToRoute: true });
    else setLoading(false);
  });

  // Offline GPS Location (with Last GPS Fix Fallback)
  function applyOfflineGpsOrigin(lat, lng, label) {
    state.offlineOriginCoords = { lat, lng, name: label };
    let gpsOpt = dom.startSelect.querySelector('option[value="GPS_ORIGIN"]');
    if (!gpsOpt) {
      gpsOpt = new Option("My Location (GPS)", "GPS_ORIGIN");
      dom.startSelect.add(gpsOpt, 1);
    }
    dom.startSelect.value = "GPS_ORIGIN";
    dom.startSelect.classList.remove("is-placeholder");
    dom.clearOfflineOriginBtn.classList.remove("hidden");
    updatePickHint();
    renderOfflineMapLayers();
    map.panTo([lat, lng], { animate: true, duration: 0.45 });
    if (dom.endSelect.value) {
      computeOfflineRoute({ flyToRoute: true });
    } else {
      showToast(`${label} ready — select a destination`);
    }
  }

  dom.clearOfflineOriginBtn.addEventListener("click", () => {
    state.offlineOriginCoords = null;
    const gpsOpt = dom.startSelect.querySelector('option[value="GPS_ORIGIN"]');
    if (gpsOpt) gpsOpt.remove();
    dom.startSelect.value = "";
    dom.startSelect.classList.add("is-placeholder");
    dom.clearOfflineOriginBtn.classList.add("hidden");
    updatePickHint();
    clearActiveRouteDisplay({ keepGraphEdges: true });
  });

  dom.offlineGeoLocateBtn.addEventListener("click", async () => {
    setLoading(true, "Acquiring offline GPS fix…");
    const loc = await resolveUserLocation({ allowApproximate: true, buttonEl: dom.offlineGeoLocateBtn });
    setLoading(false);
    if (loc.error) {
      showNotice(`${loc.error} Select an intersection manually.`);
      return;
    }
    applyOfflineGpsOrigin(loc.lat, loc.lng, loc.label || "My Location");
    if (loc.source === "ip") {
      showToast("Using approximate network location — tap the map to fine-tune your exact start point", 4500);
    } else if (loc.source === "cache") {
      showToast("Using last saved GPS location", 3500);
    }
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
      state.offlineOriginCoords = null;
      const tmp = dom.startSelect.value;
      dom.startSelect.value = dom.endSelect.value;
      dom.endSelect.value = tmp;
      dom.startSelect.classList.toggle("is-placeholder", !dom.startSelect.value);
      dom.endSelect.classList.toggle("is-placeholder", !dom.endSelect.value);
    }
    computeRoute({ flyToRoute: true });
  });

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

  dom.collapseCardBtn.addEventListener("click", () => {
    state.cardCollapsed = !state.cardCollapsed;
    dom.navCard.classList.toggle("is-collapsed", state.cardCollapsed);
    dom.navCardBody.classList.toggle("hidden", state.cardCollapsed);
    dom.collapseCardBtn.setAttribute("aria-expanded", state.cardCollapsed ? "false" : "true");
    dom.collapseChevron.style.transform = state.cardCollapsed ? "rotate(180deg)" : "rotate(0deg)";
  });

  document.querySelectorAll(".segmented-btn[data-source]").forEach((btn) => {
    btn.addEventListener("click", () => switchSourceMode(btn.dataset.source, { isAutoSwitch: false }));
  });

  document.querySelectorAll(".vehicle-btn[data-vehicle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.vehicle = btn.dataset.vehicle;
      updateVehicleButtonsUI();
      const ready =
        state.sourceMode === "live"
          ? Boolean(state.liveStart && state.liveGoal)
          : Boolean((dom.startSelect.value || state.offlineOriginCoords) && dom.endSelect.value);
      if (ready) {
        computeRoute({ flyToRoute: state.vehicle === "train" || state.vehicle === "flight" });
      }
    });
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

  function setLayersPopoverOpen(open) {
    state.layersPopoverOpen = open;
    dom.layersPopover.classList.toggle("hidden", !open);
    dom.layersTriggerBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  dom.layersTriggerBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setLayersPopoverOpen(!state.layersPopoverOpen);
  });

  document.addEventListener("click", (ev) => {
    if (state.layersPopoverOpen && !dom.layersWidget.contains(ev.target)) {
      setLayersPopoverOpen(false);
    }
  });

  document.querySelectorAll(".map-type-card[data-basemap]").forEach((btn) => {
    btn.addEventListener("click", () => switchBasemap(btn.dataset.basemap));
  });

  dom.graphOverlayToggle.addEventListener("change", () => {
    state.showGraphOverlay = dom.graphOverlayToggle.checked;
    if (state.sourceMode === "live") renderLiveMapLayers(state.lastResult);
    else renderOfflineMapLayers();
  });

  dom.hybridLabelsToggle.addEventListener("change", () => {
    state.showHybridLabels = dom.hybridLabelsToggle.checked;
    syncHybridLabelsLayer();
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

  dom.zoomInBtn.addEventListener("click", () => map.zoomIn());
  dom.zoomOutBtn.addEventListener("click", () => map.zoomOut());
  dom.resetViewBtn.addEventListener("click", () => {
    if (state.viewBounds && state.viewBounds.isValid()) {
      map.fitBounds(state.viewBounds, { ...getDynamicPadding(), animate: true, duration: 0.45, maxZoom: 16 });
    }
  });

  dom.startSelect.addEventListener("change", () => {
    if (dom.startSelect.value !== "GPS_ORIGIN") {
      state.offlineOriginCoords = null;
      const gpsOpt = dom.startSelect.querySelector('option[value="GPS_ORIGIN"]');
      if (gpsOpt) gpsOpt.remove();
      dom.clearOfflineOriginBtn.classList.add("hidden");
    }
    dom.startSelect.classList.toggle("is-placeholder", !dom.startSelect.value);
    updatePickHint();
    if (dom.startSelect.value && dom.endSelect.value) computeOfflineRoute({ flyToRoute: true });
    else clearActiveRouteDisplay({ keepGraphEdges: true });
  });

  dom.endSelect.addEventListener("change", () => {
    dom.endSelect.classList.toggle("is-placeholder", !dom.endSelect.value);
    updatePickHint();
    if ((dom.startSelect.value || state.offlineOriginCoords) && dom.endSelect.value) {
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
  dom.saveRouteOfflineBtn.addEventListener("click", saveActiveRouteOffline);

  // Google Maps-Style "Start Journey" Live Navigation Controller
  [dom.journeyTopBanner, dom.journeyBottomBar, dom.journeyGpsFallback, dom.journeyArrivalCard].forEach((el) => {
    if (el) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
  });

  const journey = {
    active: false,
    simulating: false,
    simSpeedMult: 1,
    autoFollow: true,
    voiceEnabled: false,
    watchId: null,
    gpsPollTimer: null,
    simTimer: null,
    simDistKm: 0,
    gpsFixCount: 0,
    lastGpsCoords: null,
    headingDeg: 0,
    compassHeading: null,
    prevPos: null,
    marker: null,
    route: null,
    coords: [],
    cumDistKm: [],
    totalDistKm: 0,
    totalEtaMin: 0,
    steps: [],
    stepEndDistKm: [],
    lastSpokenIdx: -1,
    offRouteStreak: 0,
    lastRerouteAt: 0,
    rerouting: false,
    arrived: false,
  };

  function havKm(lat1, lng1, lat2, lng2) {
    if (window.AstraOfflineEngine?.haversineKm) {
      return window.AstraOfflineEngine.haversineKm(lat1, lng1, lat2, lng2);
    }
    const R = 6371.0;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
  }

  function computeBearingDeg(lat1, lng1, lat2, lng2) {
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dLam = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(dLam) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  function createLiveNavIcon(headingDeg) {
    return L.divIcon({
      className: "live-nav-marker-root",
      html: `<div class="live-nav-pointer-wrap">
        <span class="live-nav-pulse"></span>
        <div class="live-nav-rotor" style="transform: rotate(${headingDeg.toFixed(1)}deg);">
          <svg width="44" height="44" viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="navBeamGrad" x1="24" y1="2" x2="24" y2="24" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#3B82F6" stop-opacity="0"/>
                <stop offset="100%" stop-color="#2563EB" stop-opacity="0.42"/>
              </linearGradient>
            </defs>
            <path d="M24 24L11 4H37L24 24Z" fill="url(#navBeamGrad)"/>
            <circle cx="24" cy="24" r="11" fill="#2563EB" stroke="#FFFFFF" stroke-width="3"/>
            <polygon points="24,15 30,29 24,25.5 18,29" fill="#FFFFFF"/>
          </svg>
        </div>
      </div>`,
      iconSize: [56, 56],
      iconAnchor: [28, 28],
    });
  }

  function rotateNavMarker(deg) {
    journey.headingDeg = deg;
    const el = journey.marker?.getElement();
    const rotor = el?.querySelector(".live-nav-rotor");
    if (rotor) {
      rotor.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    }
  }

  function turnArrowSvg(kind) {
    if (kind === "left") {
      return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>`;
    }
    if (kind === "right") {
      return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path></svg>`;
    }
    if (kind === "arrive") {
      return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
    }
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
  }

  function speakNavInstruction(text) {
    if (!journey.voiceEnabled || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
    } catch {
      // ignore speech errors
    }
  }

  function prepareJourneyGeometry(result) {
    const coords = (result.coordinates || []).map((pt) => [Number(pt[0]), Number(pt[1])]);
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      cum.push(cum[i - 1] + havKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    }
    journey.route = result;
    journey.coords = coords;
    journey.cumDistKm = cum;
    journey.totalDistKm = Math.max(0.01, result.total_distance_km || cum[cum.length - 1] || 0.01);
    journey.totalEtaMin = Math.max(0.1, result.estimated_time_min || 1);

    const mergedSteps = mergeDirectionSteps(result.segments || []);
    journey.steps = mergedSteps;
    journey.stepEndDistKm = [];
    let acc = 0;
    mergedSteps.forEach((s) => {
      acc += Number(s.distance_km || 0);
      journey.stepEndDistKm.push(acc);
    });
    journey.lastSpokenIdx = -1;
  }

  function closestPointOnRoute(lat, lng) {
    const coords = journey.coords;
    if (coords.length < 2) {
      return { idx: 0, projLat: lat, projLng: lng, distM: 0, alongKm: 0, tangentDeg: 0 };
    }
    let bestDistM = Infinity;
    let bestIdx = 0;
    let bestAlongKm = 0;
    let bestLat = coords[0][0];
    let bestLng = coords[0][1];
    let bestTan = 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const [aLat, aLng] = coords[i];
      const [bLat, bLng] = coords[i + 1];
      const dx = bLng - aLng;
      const dy = bLat - aLat;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((lng - aLng) * dx + (lat - aLat) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const pLat = aLat + t * dy;
      const pLng = aLng + t * dx;
      const dM = havKm(lat, lng, pLat, pLng) * 1000;
      if (dM < bestDistM) {
        bestDistM = dM;
        bestIdx = i;
        const segLen = journey.cumDistKm[i + 1] - journey.cumDistKm[i];
        bestAlongKm = journey.cumDistKm[i] + t * segLen;
        bestLat = pLat;
        bestLng = pLng;
        bestTan = computeBearingDeg(aLat, aLng, bLat, bLng);
      }
    }
    return {
      idx: bestIdx,
      projLat: bestLat,
      projLng: bestLng,
      distM: bestDistM,
      alongKm: bestAlongKm,
      tangentDeg: bestTan,
    };
  }

  function renderJourneySplitPolylines(segIdx, projLat, projLng) {
    layers.routeTraveled.clearLayers();
    layers.routeCasing.clearLayers();
    layers.routeInner.clearLayers();

    const coords = journey.coords;
    if (coords.length < 2) return;

    const traveledPts = coords.slice(0, segIdx + 1);
    traveledPts.push([projLat, projLng]);
    if (traveledPts.length >= 2) {
      L.polyline(traveledPts, {
        renderer: canvasRenderer,
        color: "#94A3B8",
        weight: 6,
        opacity: 0.65,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(layers.routeTraveled);
    }

    const remainingPts = [[projLat, projLng], ...coords.slice(segIdx + 1)];
    if (remainingPts.length >= 2) {
      L.polyline(remainingPts, {
        renderer: canvasRenderer,
        color: "#1E40AF",
        weight: 8,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(layers.routeCasing);
      L.polyline(remainingPts, {
        renderer: canvasRenderer,
        color: "#3B82F6",
        weight: 4.5,
        opacity: 1.0,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(layers.routeInner);
    }
  }

  function updateTurnBannerForProgress(alongKm) {
    const steps = journey.steps;
    if (!steps.length) return;
    let stepIdx = journey.stepEndDistKm.findIndex((endKm) => alongKm < endKm - 0.015);
    if (stepIdx < 0) stepIdx = steps.length - 1;

    const curr = steps[stepIdx];
    const next = steps[stepIdx + 1] || null;
    const remStepM = Math.max(0, Math.round((journey.stepEndDistKm[stepIdx] - alongKm) * 1000));
    const distLabel = remStepM >= 1000 ? `${(remStepM / 1000).toFixed(1)} km` : `${remStepM} m`;

    let turnKind = "straight";
    let actionLabel = "Continue on";
    if (!next) {
      turnKind = remStepM <= 60 ? "arrive" : "straight";
      actionLabel = remStepM <= 60 ? "Arriving at destination via" : "Continue to destination on";
    } else if (curr.geometry?.length >= 2 && next.geometry?.length >= 2) {
      const b1 = computeBearingDeg(
        curr.geometry[curr.geometry.length - 2][0],
        curr.geometry[curr.geometry.length - 2][1],
        curr.geometry[curr.geometry.length - 1][0],
        curr.geometry[curr.geometry.length - 1][1]
      );
      const b2 = computeBearingDeg(
        next.geometry[0][0],
        next.geometry[0][1],
        next.geometry[1][0],
        next.geometry[1][1]
      );
      const delta = ((b2 - b1 + 540) % 360) - 180;
      if (delta > 30) {
        turnKind = "right";
        actionLabel = `Then turn right onto ${next.road_name}`;
      } else if (delta < -30) {
        turnKind = "left";
        actionLabel = `Then turn left onto ${next.road_name}`;
      }
    }

    dom.journeyTurnIcon.innerHTML = turnArrowSvg(turnKind);
    dom.journeyStepDist.textContent = distLabel;
    dom.journeyStepAction.textContent = actionLabel;
    dom.journeyStepRoad.textContent = curr.road_name || "Current road";

    if (journey.lastSpokenIdx !== stepIdx) {
      journey.lastSpokenIdx = stepIdx;
      speakNavInstruction(`In ${distLabel}, ${actionLabel} ${curr.road_name || ""}`);
    }
  }

  function triggerJourneyArrival() {
    if (journey.arrived) return;
    journey.arrived = true;
    clearInterval(journey.simTimer);
    journey.simTimer = null;
    clearInterval(journey.gpsPollTimer);
    journey.gpsPollTimer = null;
    if (journey.watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(journey.watchId);
      journey.watchId = null;
    }
    dom.journeyBottomBar.classList.add("hidden");
    dom.journeyGpsFallback.classList.add("hidden");
    dom.journeyArrivalSummary.textContent = `${journey.totalDistKm.toFixed(1)} km · ${formatHeroEta(journey.totalEtaMin)}`;
    dom.journeyArrivalCard.classList.remove("hidden");
    speakNavInstruction("You have arrived at your destination.");
  }

  async function triggerOffRouteReroute(lat, lng) {
    if (journey.rerouting || !state.liveGoal) return;
    journey.rerouting = true;
    journey.lastRerouteAt = Date.now();
    journey.offRouteStreak = 0;
    showToast("Off route — recalculating...", 3000);
    try {
      const resp = await fetch("/api/route-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: { lat, lng, name: "Current Location" },
          goal: state.liveGoal,
          mode: state.mode,
          vehicle: state.vehicle,
          compare_dijkstra: false,
          traffic_preset: state.livePreset,
          traffic_overrides: state.overrides,
        }),
      });
      if (!resp.ok || !journey.active) return;
      const data = await resp.json();
      if (data.found && data.coordinates?.length >= 2) {
        state.lastResult = data;
        prepareJourneyGeometry(data);
        renderJourneySplitPolylines(0, data.coordinates[0][0], data.coordinates[0][1]);
      }
    } catch {
      // keep existing route if reroute fails
    } finally {
      journey.rerouting = false;
    }
  }

  function updateJourneyPosition(lat, lng, { gpsHeading = null, speedMps = null, isSim = false } = {}) {
    if (!journey.active || journey.arrived) return;

    const snap = closestPointOnRoute(lat, lng);
    const displayLat = isSim ? lat : snap.distM < 45 ? snap.projLat : lat;
    const displayLng = isSim ? lng : snap.distM < 45 ? snap.projLng : lng;

    if (!journey.marker) {
      journey.marker = L.marker([displayLat, displayLng], {
        icon: createLiveNavIcon(snap.tangentDeg),
        zIndexOffset: 950,
      }).addTo(layers.journeyNav);
    } else {
      journey.marker.setLatLng([displayLat, displayLng]);
    }

    let nextHeading = journey.headingDeg;
    if (typeof gpsHeading === "number" && Number.isFinite(gpsHeading) && (speedMps || 0) > 0.8) {
      nextHeading = gpsHeading;
    } else if (journey.prevPos && havKm(journey.prevPos[0], journey.prevPos[1], lat, lng) > 0.004) {
      nextHeading = computeBearingDeg(journey.prevPos[0], journey.prevPos[1], lat, lng);
    } else if (snap.distM < 60) {
      nextHeading = snap.tangentDeg;
    } else if (journey.compassHeading !== null) {
      nextHeading = journey.compassHeading;
    }
    journey.prevPos = [lat, lng];
    rotateNavMarker(nextHeading);

    renderJourneySplitPolylines(snap.idx, snap.projLat, snap.projLng);

    const maxAlong = Math.max(0.01, journey.cumDistKm[journey.cumDistKm.length - 1] || journey.totalDistKm);
    const frac = Math.max(0, Math.min(1, snap.alongKm / maxAlong));
    const remDistKm = Math.max(0, journey.totalDistKm * (1 - frac));
    const remEtaMin = Math.max(0, journey.totalEtaMin * (1 - frac));
    const speedKmh =
      typeof speedMps === "number" && Number.isFinite(speedMps) && speedMps >= 0
        ? Math.round(speedMps * 3.6)
        : Math.round((journey.totalDistKm / (journey.totalEtaMin / 60)) || 30);

    dom.journeyProgressFill.style.width = `${Math.round(frac * 100)}%`;
    dom.journeyRemEta.textContent = formatHeroEta(remEtaMin);
    dom.journeyRemDist.textContent = `${remDistKm.toFixed(1)} km`;
    dom.journeySpeed.textContent = `${speedKmh} km/h`;

    updateTurnBannerForProgress(snap.alongKm);

    if (journey.autoFollow) {
      map.panTo([displayLat, displayLng], { animate: true, duration: 0.4 });
    }

    const goalPt = journey.coords[journey.coords.length - 1];
    if (goalPt && havKm(lat, lng, goalPt[0], goalPt[1]) * 1000 <= 35) {
      triggerJourneyArrival();
      return;
    }

    if (!isSim) {
      if (snap.distM > 85) {
        journey.offRouteStreak += 1;
        if (journey.offRouteStreak >= 2 && Date.now() - journey.lastRerouteAt > 10000) {
          triggerOffRouteReroute(lat, lng);
        }
      } else {
        journey.offRouteStreak = 0;
      }
    }
  }

  function handleCompassOrientation(ev) {
    let heading = null;
    if (typeof ev.webkitCompassHeading === "number") {
      heading = ev.webkitCompassHeading;
    } else if (ev.absolute && typeof ev.alpha === "number") {
      heading = (360 - ev.alpha) % 360;
    } else if (typeof ev.alpha === "number") {
      heading = (360 - ev.alpha) % 360;
    }
    if (heading !== null && Number.isFinite(heading)) {
      journey.compassHeading = heading;
      if (journey.active && !journey.simulating) {
        rotateNavMarker(heading);
      }
    }
  }

  function stepJourneyAlongRoute(deltaKm) {
    if (!journey.active || journey.arrived || journey.coords.length < 2) return;
    const maxAlong = journey.cumDistKm[journey.cumDistKm.length - 1] || 0;
    journey.simDistKm = Math.max(0, Math.min(maxAlong, journey.simDistKm + deltaKm));
    if (journey.simDistKm >= maxAlong) {
      const last = journey.coords[journey.coords.length - 1];
      updateJourneyPosition(last[0], last[1], { speedMps: 10, isSim: true });
      triggerJourneyArrival();
      return;
    }
    let idx = 0;
    while (idx < journey.cumDistKm.length - 2 && journey.cumDistKm[idx + 1] < journey.simDistKm) {
      idx++;
    }
    const segLen = Math.max(1e-6, journey.cumDistKm[idx + 1] - journey.cumDistKm[idx]);
    const t = Math.max(0, Math.min(1, (journey.simDistKm - journey.cumDistKm[idx]) / segLen));
    const pLat = journey.coords[idx][0] + t * (journey.coords[idx + 1][0] - journey.coords[idx][0]);
    const pLng = journey.coords[idx][1] + t * (journey.coords[idx + 1][1] - journey.coords[idx][1]);
    const segTan = computeBearingDeg(
      journey.coords[idx][0],
      journey.coords[idx][1],
      journey.coords[idx + 1][0],
      journey.coords[idx + 1][1]
    );
    updateJourneyPosition(pLat, pLng, {
      gpsHeading: segTan,
      speedMps: 11.1,
      isSim: true,
    });
  }

  function startSimulationLoop() {
    clearInterval(journey.simTimer);
    clearInterval(journey.gpsPollTimer);
    journey.gpsPollTimer = null;
    if (journey.watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(journey.watchId);
      journey.watchId = null;
    }
    journey.simulating = true;
    journey.simDistKm = 0;
    dom.journeySimLabel.textContent = "Simulate";
    dom.journeySimToggleBtn.classList.add("is-active");
    dom.journeySimSpeedBtn.classList.remove("hidden");
    dom.journeySimSpeedBtn.textContent = `${journey.simSpeedMult}x`;
    dom.journeyGpsFallback.classList.add("hidden");

    const baseKmh = Math.max(12, Math.min(75, journey.totalDistKm / (journey.totalEtaMin / 60)));
    const tickSec = 0.1;

    journey.simTimer = setInterval(() => {
      if (!journey.active || journey.arrived) return;
      const stepKm = ((baseKmh * journey.simSpeedMult * tickSec) / 3600) * 8;
      stepJourneyAlongRoute(stepKm);
    }, 100);
  }

  function handleIncomingLiveGps(pos) {
    if (!journey.active || journey.simulating) return;
    const { latitude, longitude, heading, speed, accuracy } = pos.coords;
    journey.gpsFixCount += 1;

    const movedKm = journey.lastGpsCoords
      ? havKm(journey.lastGpsCoords[0], journey.lastGpsCoords[1], latitude, longitude)
      : 0;
    journey.lastGpsCoords = [latitude, longitude];

    // If laptop Wi-Fi geolocation is coarse (>60m) or stationary across multiple fixes, show Simulate tip
    if (accuracy > 60 || (journey.gpsFixCount >= 2 && movedKm < 0.002)) {
      const accText = Number.isFinite(accuracy) ? ` (±${Math.round(accuracy)} m)` : "";
      const tipEl = document.getElementById("journeyGpsFallbackText");
      if (tipEl) {
        tipEl.textContent = `Laptop Wi-Fi GPS${accText} won't track short indoor steps — switch to Simulate or press ↑ / W.`;
      }
      dom.journeyGpsFallback.classList.remove("hidden");
    } else {
      dom.journeyGpsFallback.classList.add("hidden");
    }

    updateJourneyPosition(latitude, longitude, {
      gpsHeading: heading,
      speedMps: speed,
      isSim: false,
    });
  }

  function startLiveGpsWatch() {
    clearInterval(journey.simTimer);
    clearInterval(journey.gpsPollTimer);
    journey.simTimer = null;
    journey.gpsPollTimer = null;
    journey.simulating = false;
    journey.gpsFixCount = 0;
    journey.lastGpsCoords = null;
    dom.journeySimLabel.textContent = "Live GPS";
    dom.journeySimToggleBtn.classList.remove("is-active");
    dom.journeySimSpeedBtn.classList.add("hidden");

    if (!navigator.geolocation) {
      dom.journeyGpsFallback.classList.remove("hidden");
      return;
    }

    if (journey.watchId !== null) {
      navigator.geolocation.clearWatch(journey.watchId);
    }

    let retriedLowAcc = false;

    const showSimPrompt = () => {
      if (journey.active && !journey.simulating) {
        const tipEl = document.getElementById("journeyGpsFallbackText");
        if (tipEl) {
          tipEl.textContent = "Live GPS unavailable on this device — switch to Simulate to preview live navigation.";
        }
        dom.journeyGpsFallback.classList.remove("hidden");
      }
    };

    const onGpsError = (err) => {
      if (!journey.active || journey.simulating) return;
      if (err && err.code === 3 && !retriedLowAcc) {
        retriedLowAcc = true;
        if (journey.watchId !== null) {
          navigator.geolocation.clearWatch(journey.watchId);
        }
        journey.watchId = navigator.geolocation.watchPosition(
          handleIncomingLiveGps,
          showSimPrompt,
          { enableHighAccuracy: false, maximumAge: 300000, timeout: 6000 }
        );
        return;
      }
      showSimPrompt();
    };

    journey.watchId = navigator.geolocation.watchPosition(
      handleIncomingLiveGps,
      onGpsError,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
    );

    // Laptops often fire watchPosition only once on Wi-Fi; poll getCurrentPosition every 2.5s
    journey.gpsPollTimer = setInterval(() => {
      if (!journey.active || journey.simulating || journey.arrived) return;
      navigator.geolocation.getCurrentPosition(handleIncomingLiveGps, () => undefined, {
        enableHighAccuracy: !retriedLowAcc,
        maximumAge: retriedLowAcc ? 300000 : 0,
        timeout: 5000,
      });
    }, 2500);
  }

  function startJourney() {
    if (!state.lastResult?.found || !state.lastResult.coordinates?.length) return;
    journey.active = true;
    journey.arrived = false;
    journey.autoFollow = true;
    journey.prevPos = null;
    journey.offRouteStreak = 0;
    journey.simDistKm = 0;

    prepareJourneyGeometry(state.lastResult);

    dom.navCard.classList.add("hidden");
    dom.journeyTopBanner.classList.remove("hidden");
    dom.journeyBottomBar.classList.remove("hidden");
    dom.journeyArrivalCard.classList.add("hidden");
    dom.journeyGpsFallback.classList.add("hidden");
    dom.journeyFollowBtn.classList.add("is-active");
    dom.journeyFollowBtn.classList.remove("is-recenter");
    dom.journeyFollowLabel.textContent = "Following";

    const startPt = journey.coords[0];
    map.setView(startPt, 16, { animate: true });
    updateJourneyPosition(startPt[0], startPt[1], { isSim: false });

    window.addEventListener("deviceorientationabsolute", handleCompassOrientation);
    window.addEventListener("deviceorientation", handleCompassOrientation);
    startLiveGpsWatch();
  }

  function endJourney() {
    journey.active = false;
    journey.arrived = false;
    journey.simulating = false;
    clearInterval(journey.simTimer);
    journey.simTimer = null;
    clearInterval(journey.gpsPollTimer);
    journey.gpsPollTimer = null;
    if (journey.watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(journey.watchId);
      journey.watchId = null;
    }
    window.removeEventListener("deviceorientationabsolute", handleCompassOrientation);
    window.removeEventListener("deviceorientation", handleCompassOrientation);
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }

    layers.journeyNav.clearLayers();
    layers.routeTraveled.clearLayers();
    journey.marker = null;

    dom.journeyTopBanner.classList.add("hidden");
    dom.journeyBottomBar.classList.add("hidden");
    dom.journeyArrivalCard.classList.add("hidden");
    dom.journeyGpsFallback.classList.add("hidden");
    dom.navCard.classList.remove("hidden");

    if (state.lastResult?.found) {
      const bounds = drawRouteLines(state.lastResult);
      if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, { ...getDynamicPadding(), animate: true, duration: 0.45, maxZoom: 16 });
      }
    }
  }

  map.on("dragstart", () => {
    if (journey.active && journey.autoFollow) {
      journey.autoFollow = false;
      dom.journeyFollowBtn.classList.remove("is-active");
      dom.journeyFollowBtn.classList.add("is-recenter");
      dom.journeyFollowLabel.textContent = "Recenter";
    }
  });

  dom.startJourneyBtn.addEventListener("click", startJourney);
  dom.journeyEndBtn.addEventListener("click", endJourney);
  dom.journeyDoneBtn.addEventListener("click", endJourney);

  dom.journeyFollowBtn.addEventListener("click", () => {
    journey.autoFollow = true;
    dom.journeyFollowBtn.classList.add("is-active");
    dom.journeyFollowBtn.classList.remove("is-recenter");
    dom.journeyFollowLabel.textContent = "Following";
    const ll = journey.marker?.getLatLng();
    if (ll) map.setView(ll, Math.max(map.getZoom(), 16), { animate: true });
  });

  dom.journeySimToggleBtn.addEventListener("click", () => {
    if (journey.simulating) {
      startLiveGpsWatch();
    } else {
      startSimulationLoop();
    }
  });

  dom.journeySwitchSimBtn.addEventListener("click", () => {
    startSimulationLoop();
  });

  dom.journeySimSpeedBtn.addEventListener("click", () => {
    const order = [1, 3, 5];
    journey.simSpeedMult = order[(order.indexOf(journey.simSpeedMult) + 1) % order.length];
    dom.journeySimSpeedBtn.textContent = `${journey.simSpeedMult}x`;
  });

  dom.journeyVoiceBtn.addEventListener("click", () => {
    journey.voiceEnabled = !journey.voiceEnabled;
    dom.journeyVoiceBtn.setAttribute("aria-pressed", String(journey.voiceEnabled));
    dom.journeyVoiceIconMuted.classList.toggle("hidden", journey.voiceEnabled);
    dom.journeyVoiceIconOn.classList.toggle("hidden", !journey.voiceEnabled);
    if (!journey.voiceEnabled && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  });

  window.addEventListener("keydown", (ev) => {
    if (!journey.active || journey.arrived) return;
    if (ev.target && ["INPUT", "TEXTAREA", "SELECT"].includes(ev.target.tagName)) return;
    if (ev.key === "ArrowUp" || ev.key === "w" || ev.key === "W") {
      ev.preventDefault();
      stepJourneyAlongRoute(0.05);
    } else if (ev.key === "ArrowDown" || ev.key === "s" || ev.key === "S") {
      ev.preventDefault();
      stepJourneyAlongRoute(-0.05);
    }
  });

  // Boot Application in Clean Empty Startup State + Check Connectivity
  const splashEl = document.getElementById("app-splash");
  let splashMinElapsed = false;
  let splashAppReady = false;
  let splashDismissed = false;

  function dismissSplash() {
    if (splashDismissed || !splashEl) return;
    if (!splashMinElapsed || !splashAppReady) return;
    splashDismissed = true;
    splashEl.classList.add("is-hidden");
    const removeEl = () => {
      if (splashEl.parentNode) splashEl.remove();
    };
    splashEl.addEventListener("transitionend", removeEl, { once: true });
    setTimeout(removeEl, 350);
  }

  function markSplashReady() {
    if (splashAppReady) return;
    splashAppReady = true;
    dismissSplash();
  }

  setTimeout(() => {
    splashMinElapsed = true;
    dismissSplash();
  }, 850);

  setTimeout(markSplashReady, 1500);
  baseLayers.osm.once("load", markSplashReady);

  dom.liveStartInput.value = "";
  dom.liveGoalInput.value = "";
  updateVehicleButtonsUI();
  updateLiveActionIcons();
  updatePickHint();
  probeConnectivity({ isInitial: true }).finally(() => {
    if (state.sourceMode === "offline") markSplashReady();
  });
  syncOfflineBundleInBackground();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
})();

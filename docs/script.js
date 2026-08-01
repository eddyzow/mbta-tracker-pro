document.addEventListener("DOMContentLoaded", function () {
  "use strict";

  /* ============================================================
     CONFIG & STATE
     ============================================================ */
  const MBTA_API = "https://api-v3.mbta.com";
  // The Heroku server pushes vehicle updates about every 20s; interpolation
  // glides each train over this window. `measuredUpdateMs` adapts to the real
  // gap between pushes so timing self-corrects if the server rate changes.
  const VEHICLE_UPDATE_MS = 20000;
  let measuredUpdateMs = VEHICLE_UPDATE_MS;
  const ALERTS_REFRESH_MS = 60000;

  let routeDataCache = null;
  let selectedVehicleId = null;
  let selectedRouteId = null;
  let lastClickedShapeId = null;
  let isDeveloperMode = false;
  let crrcOnly = false;
  let showAllLines = true;
  let allVehicleData = { vehicles: [], included: [] };
  let lastUpdateTime = Date.now();
  let updateTimerInterval = null;
  let alertsData = [];
  let alertsByRoute = new Map();

  const interp = new Map();
  let animationFrame = null;
  const vehicleDelays = new Map();

  /* ============================================================
     DOM
     ============================================================ */
  const getEl = (id) => document.getElementById(id);
  const qs = (s) => document.querySelector(s);
  const qsa = (s) => document.querySelectorAll(s);

  const el = {
    updatePill: getEl("update-pill"),
    listContainer: getEl("list-container"),
    alertsList: getEl("alerts-list"),
    vehicleInfo: getEl("vehicle-info-overlay"),
    lineInfo: getEl("line-info-overlay"),
    stationInfo: getEl("station-info-overlay"),
    alertDetail: getEl("alert-detail-overlay"),
    settingsModal: getEl("settings-modal"),
    searchInput: getEl("search-input"),
    routeTabs: getEl("route-tabs"),
    mainTabs: getEl("main-tabs"),
    noResults: getEl("no-results-found"),
    devToggle: getEl("dev-mode-toggle"),
    crrcToggle: getEl("crrc-only-toggle"),
    showAllToggle: getEl("show-all-toggle"),
    loadingOverlay: getEl("loading-overlay"),
    connStatus: getEl("connection-status"),
    alertsBanner: getEl("alerts-banner"),
    alertsBannerText: getEl("alerts-banner-text"),
    alertsBannerCount: getEl("alerts-banner-count"),
    // plan
    planFrom: getEl("plan-from"),
    planTo: getEl("plan-to"),
    planFromSuggest: getEl("plan-from-suggest"),
    planToSuggest: getEl("plan-to-suggest"),
    planWhen: getEl("plan-when"),
    planGo: getEl("plan-go"),
    planSwap: getEl("plan-swap"),
    planResult: getEl("plan-result"),
  };

  // Caches
  const routeInfoCache = new Map();      // routeId -> { stops, shapes }
  const stationToRoutesMap = new Map();  // name -> { routes:Set, id, location }
  const stopIdToName = new Map();         // stopId (child or parent) -> station name
  const allRouteLayers = new Map();
  const routePolylinePts = new Map();
  const routeAllShapePts = new Map(); // routeId -> [ [ [lat,lng], ... ], ... ] all kept shapes (for station snapping across branches)
  const journeyLayer = L.layerGroup();

  /* ============================================================
     MAP INIT
     ============================================================ */
  const map = L.map("map", {
    preferCanvas: true,
    zoomControl: false,
    minZoom: 9,
    maxZoom: 18,
    // Smooth but BOUNDED wheel zoom. zoomSnap:0 continuous was letting a single
    // trackpad flick run to the min zoom; a small snap + gentle wheel step keeps
    // it controlled on both trackpad and mouse.
    scrollWheelZoom: true,
    zoomSnap: 0.5,
    zoomDelta: 0.5,
    wheelDebounceTime: 40,
    wheelPxPerZoomLevel: 220, // larger = each wheel notch zooms less (calmer)
    zoomAnimation: true,
  }).setView([42.3601, -71.0589], 12);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · MBTA v3 API',
    maxZoom: 20,
    subdomains: "abcd",
  }).addTo(map);
  // Labels on a separate pane above routes so street/place names stay readable.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", {
    maxZoom: 20, subdomains: "abcd", pane: "shadowPane", opacity: 0.9,
  }).addTo(map);

  // Stations get their own pane/canvas just above the route pane (410 vs 400) so
  // a station dot wins clicks over the route hit-line where they overlap. A
  // canvas only "hits" where a shape is actually drawn, so empty areas still let
  // route-line clicks through. Vehicles (marker pane, 600) stay on top of both.
  const vehicleLayer = L.layerGroup().addTo(map);
  const vehicleCtxLayer = L.layerGroup().addTo(map); // prev/next stop highlight
  const stationLayer = L.layerGroup().addTo(map);    // one marker per unique station
  const stationMarkers = new Map();                  // name -> marker (for restyle)
  journeyLayer.addTo(map);

  /* ============================================================
     UTILITIES
     ============================================================ */
  const formatRelativeTime = (iso) => {
    if (!iso) return "N/A";
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const formatArrivalTime = (t) => {
    if (!t) return null;
    const d = Math.round((new Date(t) - new Date()) / 60000);
    if (d < 0) return null;
    if (d < 1) return "Arriving";
    if (d === 1) return "1 min";
    return `${d} min`;
  };

  const clockTime = (iso) =>
    !iso ? "—" : new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  const fmtDuration = (mins) => {
    mins = Math.round(mins);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  };

  const MBTA_COLORS = {
    Red: "#DA291C", Mattapan: "#DA291C", Orange: "#ED8B00", Blue: "#003DA5",
    "Green-": "#00843D", "CR-": "#80276C", "Boat-": "#008EAA", Ferry: "#008EAA",
  };
  const getRouteStyle = (routeId) => {
    if (!routeId) return { color: "#80276C", type: "Other" };
    const key = Object.keys(MBTA_COLORS).find((k) => routeId.startsWith(k)) || "CR-";
    return { color: MBTA_COLORS[key], type: getRouteType(routeId) };
  };
  const getRouteType = (idOrType) => {
    if (typeof idOrType !== "string" && typeof idOrType !== "number") return "Other";
    const route = routeDataCache?.find((r) => r.id === idOrType);
    const tn = typeof idOrType === "number" ? idOrType : route?.attributes.type;
    if (tn === 0 || tn === 1) return "Subway";
    if (tn === 2) return "Commuter Rail";
    if (tn === 4) return "Ferry";
    return "Other";
  };
  const routeLongName = (id) =>
    routeDataCache?.find((r) => r.id === id)?.attributes.long_name || id;
  const routeShortLabel = (id) => {
    if (id.startsWith("CR-")) return id.replace("CR-", "");
    if (id.startsWith("Green-")) return id.replace("Green-", "GL ");
    if (id.startsWith("Boat-")) return "Ferry";
    return id;
  };

  // CRRC detection (Orange 1400–1551, Red 1900–2151)
  const isCrrcVehicle = (v) => {
    const routeId = v?.relationships?.route?.data?.id;
    const cars = v?.attributes?.carriages || [];
    let labels = cars.map((c) => parseInt(c.label, 10)).filter((n) => !isNaN(n));
    if (!labels.length) {
      const n = parseInt(v?.attributes?.label, 10);
      if (!isNaN(n)) labels = [n];
    }
    if (routeId === "Orange") return labels.some((n) => n >= 1400 && n <= 1551);
    if (routeId === "Red") return labels.some((n) => n >= 1900 && n <= 2151);
    return false;
  };

  const decodePolyline = (t) => {
    let pts = [], i = 0, len = t.length, lat = 0, lng = 0;
    while (i < len) {
      let b, sh = 0, res = 0;
      do { b = t.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
      lat += res & 1 ? ~(res >> 1) : res >> 1; sh = 0; res = 0;
      do { b = t.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
      lng += res & 1 ? ~(res >> 1) : res >> 1;
      pts.push([lat / 1e5, lng / 1e5]);
    }
    return pts;
  };

  const haversine = (a, b) => {
    const R = 6371, toR = (d) => (d * Math.PI) / 180;
    const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s)); // km
  };

  // ---- Route polyline distance model (for route-following interpolation) ----
  // For each route we precompute the cumulative distance (km) at each vertex so
  // we can map a lat/lng to a distance-along-route and back. This lets a train
  // advance ALONG the tracks by (speed × elapsed), instead of a straight lerp
  // that cuts across corners.
  const routeCumDist = new Map(); // routeId -> { pts:[[lat,lng]], cum:[km] }
  const routeStopDists = new Map(); // routeId -> sorted [km] of stop positions along the line

  const buildRouteDistances = (routeId, pts) => {
    if (!pts || pts.length < 2) return;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + haversine(pts[i - 1], pts[i]);
    routeCumDist.set(routeId, { pts, cum });
  };

  // Ground-truth stop positions (median lat/lng where trains actually reported
  // STOPPED_AT). Refined live as new STOPPED reports arrive.
  const STOP_POSITIONS = Object.assign({}, window.MBTA_STOP_POSITIONS || {});

  // THE canonical on-track point for a station — used for the marker, the
  // next-stop clamp, AND matching where a train actually stops, so all three are
  // the SAME point (this is what stops trains from jumping backward at stations).
  // Priority: observed STOPPED position (snapped to track) > concourse location.
  const stationTrackPoint = (name, routes, fallbackLatLng) => {
    const src = STOP_POSITIONS[name]
      ? STOP_POSITIONS[name]
      : [fallbackLatLng.lat ?? fallbackLatLng[0], fallbackLatLng.lng ?? fallbackLatLng[1]];
    let best = null, bestDist = Infinity;
    (routes || []).forEach((rId) => {
      (routeAllShapePts.get(rId) || []).forEach((pts) => {
        for (let i = 0; i < pts.length - 1; i++) {
          const proj = projectOnSegment(src, pts[i], pts[i + 1]).point;
          const d = haversine(src, proj);
          if (d < bestDist) { bestDist = d; best = proj; }
        }
      });
    });
    return best && bestDist < 0.4 ? best : src;
  };

  // Precompute where each stop falls along the route line (from the SAME canonical
  // track point as the marker), so the next-stop clamp lines up with the marker.
  const buildRouteStopDists = (routeId, stops) => {
    if (!routeCumDist.has(routeId) || !stops) return;
    const ds = [];
    const seen = new Set();
    stops.forEach((s) => {
      const { name, latitude, longitude } = s.attributes;
      if (seen.has(name) || latitude == null) return;
      seen.add(name);
      const tp = stationTrackPoint(name, [routeId], [latitude, longitude]);
      const d = distanceAlongRoute(routeId, tp);
      if (d != null) ds.push(d);
    });
    ds.sort((a, b) => a - b);
    routeStopDists.set(routeId, ds);
  };
  // Smallest stop distance strictly greater than `dist` in the travel direction.
  const nextStopDist = (routeId, dist, forward) => {
    const ds = routeStopDists.get(routeId);
    if (!ds || !ds.length) return null;
    if (forward) { for (const d of ds) if (d > dist + 0.02) return d; return null; }
    for (let i = ds.length - 1; i >= 0; i--) if (ds[i] < dist - 0.02) return ds[i];
    return null;
  };

  // Nearest distance-along-route (km) to a given latlng. When `hintKm` is given,
  // prefer a candidate near that distance so a train doesn't jump to a far,
  // equidistant part of an overlapping/looping track (which flipped headings).
  const distanceAlongRoute = (routeId, latlng, hintKm) => {
    const rd = routeCumDist.get(routeId);
    if (!rd) return null;
    const { pts, cum } = rd;
    const p = [latlng.lat ?? latlng[0], latlng.lng ?? latlng[1]];
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const proj = projectOnSegment(p, pts[i], pts[i + 1]);
      const d = haversine(p, proj.point);
      const along = cum[i] + haversine(pts[i], proj.point);
      // score = perpendicular distance, plus a small penalty for being far from
      // the hint so near-ties resolve to continuity rather than a distant match.
      const score = hintKm != null ? d + Math.min(0.5, Math.abs(along - hintKm) * 0.05) : d;
      if (score < bestScore) { bestScore = score; best = along; }
    }
    return best;
  };

  // Position (lat,lng) at a given distance-along-route (km).
  const positionAtDistance = (routeId, dist) => {
    const rd = routeCumDist.get(routeId);
    if (!rd) return null;
    const { pts, cum } = rd;
    if (dist <= 0) return pts[0];
    const total = cum[cum.length - 1];
    if (dist >= total) return pts[pts.length - 1];
    // binary search the segment containing `dist`
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < dist) lo = mid + 1; else hi = mid; }
    const i = Math.max(1, lo);
    const segLen = cum[i] - cum[i - 1] || 1e-9;
    const t = (dist - cum[i - 1]) / segLen;
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };

  // Project point p onto segment a-b (planar approx, fine at metro scale).
  const projectOnSegment = (p, a, b) => {
    const ax = a[1], ay = a[0], bx = b[1], by = b[0], px = p[1], py = p[0];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return { point: [ay + dy * t, ax + dx * t], t };
  };

  // Min distance (km) from point p to polyline pts.
  const distToPolyline = (p, pts) => {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = haversine(p, projectOnSegment(p, pts[i], pts[i + 1]).point);
      if (d < best) best = d;
    }
    return best;
  };
  const polyKm = (pts) => { let k = 0; for (let i = 1; i < pts.length; i++) k += haversine(pts[i - 1], pts[i]); return k; };
  // True only if shape A is essentially the SAME line as B (a redundant
  // duplicate), not merely sharing a trunk. Requires both: ~all of A lies on B,
  // AND A isn't much longer than B (a longer branch that happens to overlap the
  // trunk is NOT a duplicate and must be kept).
  const shapesOverlap = (aPts, bPts) => {
    if (aPts.length < 2 || bPts.length < 2) return false;
    const aKm = polyKm(aPts), bKm = polyKm(bPts);
    if (aKm > bKm * 1.15) return false; // A extends meaningfully beyond B -> distinct branch
    const step = Math.max(1, Math.floor(aPts.length / 30));
    let near = 0, total = 0;
    for (let i = 0; i < aPts.length; i += step) {
      total++;
      if (distToPolyline(aPts[i], bPts) < 0.03) near++;
    }
    return total > 0 && near / total > 0.9;
  };

  // Bearing (deg from north, clockwise) of the route at a given distance —
  // used to point the train arrow along the track.
  const bearingAtDistance = (routeId, dist) => {
    const a = positionAtDistance(routeId, Math.max(0, dist - 0.03));
    const b = positionAtDistance(routeId, dist + 0.03);
    if (!a || !b) return null;
    const toR = (d) => (d * Math.PI) / 180, toD = (r) => (r * 180) / Math.PI;
    const y = Math.sin(toR(b[1] - a[1])) * Math.cos(toR(b[0]));
    const x = Math.cos(toR(a[0])) * Math.sin(toR(b[0])) - Math.sin(toR(a[0])) * Math.cos(toR(b[0])) * Math.cos(toR(b[1] - a[1]));
    return (toD(Math.atan2(y, x)) + 360) % 360;
  };

  const angleDelta = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  // Which way along the track is the train travelling, inferred from its reported
  // compass bearing vs the track's increasing-distance tangent. Used on the FIRST
  // report (no movement history yet) so trains don't start off going backward.
  const forwardFromBearing = (routeId, dist, apiBearing) => {
    if (apiBearing == null) return true;
    const tangent = bearingAtDistance(routeId, dist);
    if (tangent == null) return true;
    return angleDelta(apiBearing, tangent) <= 90; // within 90° of "increasing" = forward
  };

  /* ============================================================
     DIRECT MBTA API CLIENT
     ============================================================ */
  const mbtaApi = {
    async get(path, params = {}) {
      const url = new URL(MBTA_API + path);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      });
      // Abort after 8s so a slow/hung request never leaves the UI stuck loading.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`MBTA API ${res.status} on ${path}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },
    alerts() { return this.get("/alerts", { "filter[datetime]": "NOW" }); },
    vehiclesForRoute(routeId) {
      return this.get("/vehicles", { "filter[route]": routeId, include: "trip,stop", "page[limit]": 120 });
    },
    allVehicles() {
      // Every subway + commuter rail + ferry vehicle in one call (for first-load
      // and as a fallback when the socket is slow/unavailable).
      return this.get("/vehicles", { "filter[route_type]": "0,1,2,4", include: "trip,stop", "page[limit]": 500 });
    },
    predictionsForStop(stopId) {
      return this.get("/predictions", { "filter[stop]": stopId, include: "trip,route", "page[limit]": 60, sort: "arrival_time" });
    },
    tripPredictions(tripId) {
      return this.get("/predictions", { "filter[trip]": tripId, include: "stop,schedule", sort: "stop_sequence" });
    },
    scheduleForRouteStops(routeId, stopIds) {
      return this.get("/schedules", {
        "filter[route]": routeId, "filter[stop]": stopIds.join(","),
        include: "trip,stop", sort: "departure_time", "page[limit]": 600,
      });
    },
  };
  const parentStationId = (stopObj, fb) =>
    stopObj?.relationships?.parent_station?.data?.id || fb;

  /* ============================================================
     SOCKET.IO
     ============================================================ */
  const SOCKET_URL = "https://eddyzow.herokuapp.com";
  const MOCK_MODE = new URLSearchParams(location.search).has("mock");

  const setConn = (state, label) => {
    el.connStatus.className = "conn-status " + state;
    el.connStatus.querySelector(".conn-label").textContent = label;
  };
  const socket = MOCK_MODE
    ? { on() {}, once() {}, emit() {} }
    : io(SOCKET_URL, { transports: ["websocket", "polling"] });

  socket.on("connect", () => { setConn("online", "live"); startUpdateTimer(); socket.emit("request-initial-data"); });
  socket.on("reconnect", () => { setConn("online", "live"); socket.emit("request-initial-data"); });
  socket.on("disconnect", () => { setConn("offline", "reconnecting…"); el.updatePill.textContent = "Reconnecting…"; });
  socket.on("connect_error", () => setConn("offline", "reconnecting…"));
  socket.on("mbta-route-data", (d) => processRouteData(d));
  socket.on("mbta-vehicle-update", (d) => handleVehicleUpdate(d));

  const handleVehicleUpdate = (data) => {
    allVehicleData = data;
    // Measure the real gap between server pushes and smooth it, so interpolation
    // glides trains over the actual update interval (~20s) rather than a guess.
    const now = Date.now();
    const gap = now - lastUpdateTime;
    if (gap > 3000 && gap < 90000) measuredUpdateMs = Math.round(measuredUpdateMs * 0.7 + gap * 0.3);
    lastUpdateTime = now;
    if (!MOCK_MODE) setConn("online", "live");
    const plot = getVehiclesForSelection();
    plotVehicles(plot, allVehicleData.included);
    if (selectedRouteId) updateLineInfoVehicleList(selectedRouteId, plot, allVehicleData.included);
    if (selectedVehicleId && !el.vehicleInfo.classList.contains("hidden")) {
      const v = allVehicleData.vehicles.find((x) => x.id === selectedVehicleId);
      if (v) refreshVehiclePanelData(v);
    }
  };

  // Safety net: if the socket feed goes quiet (dyno idle, dropped push) while a
  // route is selected, pull fresh vehicles straight from the MBTA API so trains
  // keep updating without a page reload.
  if (!MOCK_MODE) {
    setInterval(() => {
      const stale = Date.now() - lastUpdateTime > 45000;
      if (stale && selectedRouteId) refreshRouteVehiclesNow(selectedRouteId);
      // keep the animation loop alive regardless
      startAnimation();
    }, 15000);
  }

  // Mock replay
  if (MOCK_MODE) {
    fetch("__mock.json").then((r) => r.json()).then((m) => {
      setConn("online", "mock");
      startUpdateTimer();
      processRouteData(m.routeData);
      const pump = () => handleVehicleUpdate(m.vehicles);
      pump();
      setInterval(pump, VEHICLE_UPDATE_MS);
      // Debug hook (only with ?mock&debug) for verifying interpolation.
      if (new URLSearchParams(location.search).has("debug")) {
        window.__mbtaDebug = {
          push: (vehicles) => handleVehicleUpdate({ vehicles, included: m.vehicles.included }),
          interpState: () => [...interp.entries()].map(([id, s]) => ({ id, fromDist: s.fromDist, toDist: s.toDist, curDist: s.curDist, deg: s._lastDeg })),
          raw: m.vehicles,
          distAlong: (routeId, lat, lng) => distanceAlongRoute(routeId, L.latLng(lat, lng)),
          posAt: (routeId, d) => positionAtDistance(routeId, d),
          clickStation: (name) => { const mk = stationMarkers.get(name); if (mk) mk.fire("click", { originalEvent: new MouseEvent("click") }); return !!mk; },
          stationPixel: (name) => { const mk = stationMarkers.get(name); if (!mk) return null; const p = map.latLngToContainerPoint(mk.getLatLng()); const r = map.getContainer().getBoundingClientRect(); return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y) }; },
          stationCount: () => stationMarkers.size,
          routeShapeCounts: () => [...routeAllShapePts.entries()].map(([id, sh]) => ({ id, shapes: sh.length })),
          hitLineInfo: () => { let n=0,interactive=0,click=0; allRouteLayers.forEach((L2)=>L2.shapes&&L2.shapes.eachLayer((l)=>{ if(l._isHit){n++; if(l.options.interactive!==false)interactive++; if(l._events&&l._events.click)click++;} })); return {n,interactive,click}; },
          clickLineAt: (name, dyPx) => { const p=map.latLngToContainerPoint(stationMarkers.get(name).getLatLng()); const ll=map.containerPointToLatLng([p.x, p.y+(dyPx||0)]); let hit=null; allRouteLayers.forEach((L2,rid)=>L2.shapes&&L2.shapes.eachLayer((l)=>{ if(l._isHit && L.GeometryUtil){ const d=L.GeometryUtil.distance(map, ll, L.GeometryUtil.closest(map,l,ll)); if(d<20&&!hit)hit=rid; } })); return hit; },
        };
      }
    }).catch((e) => console.warn("mock load failed", e));
  }

  /* ============================================================
     ROUTE DATA + NETWORK GRAPH
     ============================================================ */
  // Graph: station name -> { name, location, routes:Set, neighbors: Map(routeId -> [orderedStationNames]) }
  const graph = new Map();
  // routeId -> ordered array of station names (deduped along the route)
  const routeStationOrder = new Map();

  const processRouteData = (data) => {
    routeDataCache = data;
    data.forEach((route) => {
      const routeInfo = { stops: route.stops || [], shapes: route.shapes || [] };
      routeInfoCache.set(route.id, routeInfo);

      const orderedNames = [];
      if (route.stops) {
        route.stops.forEach((stop) => {
          const { name, latitude, longitude } = stop.attributes;
          stopIdToName.set(stop.id, name);
          const parent = stop.relationships?.parent_station?.data?.id;
          if (parent) stopIdToName.set(parent, name);
          const existing = stationToRoutesMap.get(name) || {
            routes: new Set(), id: parent || stop.id, location: L.latLng(latitude, longitude),
          };
          existing.routes.add(route.id);
          if (parent) existing.id = parent;
          stationToRoutesMap.set(name, existing);
          if (orderedNames[orderedNames.length - 1] !== name) orderedNames.push(name);

          // graph node
          if (!graph.has(name)) graph.set(name, { name, location: [latitude, longitude], routes: new Set(), neighbors: new Map() });
          graph.get(name).routes.add(route.id);
        });
      }
      routeStationOrder.set(route.id, orderedNames);
      drawRoute(route.id, routeInfo, true);
    });

    buildGraphEdges();
    drawAllStations();
    displayList("Subway");
    populatePlanner();
    loadAlerts();
    setInterval(loadAlerts, ALERTS_REFRESH_MS);
    if (el.loadingOverlay) el.loadingOverlay.classList.add("hidden");
    requestAnimationFrame(() => map.invalidateSize());
    setTimeout(() => map.invalidateSize(), 300);
    // Show live trains network-wide immediately, and keep them fresh from the
    // MBTA API even when the socket feed is slow/unavailable.
    if (!MOCK_MODE) {
      refreshAllVehiclesNow();
      setInterval(() => { if (Date.now() - lastUpdateTime > 18000) refreshAllVehiclesNow(); }, 20000);
    }
  };

  // Connect adjacent stations along each route (ride edges).
  const buildGraphEdges = () => {
    routeStationOrder.forEach((names, routeId) => {
      for (let i = 0; i < names.length; i++) {
        const node = graph.get(names[i]);
        if (!node) continue;
        if (!node.neighbors.has(routeId)) node.neighbors.set(routeId, new Set());
        if (i > 0) node.neighbors.get(routeId).add(names[i - 1]);
        if (i < names.length - 1) node.neighbors.get(routeId).add(names[i + 1]);
      }
    });
  };

  /* ============================================================
     LIST RENDERING (Lines tab)
     ============================================================ */
  const displayList = (activeType, searchTerm = "") => {
    if (!routeDataCache) return;
    el.listContainer.innerHTML = "";
    el.noResults.classList.add("hidden");

    const sysToggle = qs(`.system-toggle[data-system="${activeType}"]`);
    if (sysToggle && !sysToggle.checked) {
      el.listContainer.innerHTML = `<p class="empty-note">Enable “${activeType}” in Settings to see its routes.</p>`;
      return;
    }
    const lower = searchTerm.toLowerCase();
    const results = [];
    routeDataCache.forEach((r) => {
      const name = isDeveloperMode ? r.id : r.attributes.long_name;
      if (getRouteType(r.id) === activeType && (isDeveloperMode ? r.id : r.attributes.long_name).toLowerCase().includes(lower))
        results.push({ type: "route", id: r.id, name });
    });
    if (searchTerm.length > 1) {
      stationToRoutesMap.forEach((d, name) => {
        if ((isDeveloperMode ? d.id : name).toLowerCase().includes(lower) &&
          [...d.routes].some((rId) => getRouteType(rId) === activeType))
          results.push({ type: "station", id: d.id, name: isDeveloperMode ? d.id : name, originalName: name, location: d.location });
      });
    }
    if (!results.length) { el.noResults.classList.remove("hidden"); el.listContainer.appendChild(el.noResults); return; }

    const list = document.createElement("ul");
    results.forEach((item) => {
      const itemRoutes = stationToRoutesMap.get(item.originalName || item.name)?.routes;
      const firstRouteId = item.type === "route" ? item.id : itemRoutes ? [...itemRoutes][0] : "";
      const { color } = getRouteStyle(firstRouteId);
      const li = document.createElement("li");
      li.className = "list-item";
      const row = document.createElement("a");
      row.href = "#"; row.className = "list-row";
      row.dataset.id = item.id; row.dataset.type = item.type; row.dataset.name = item.originalName || item.name;
      let badge = "";
      if (item.type === "route") {
        const a = alertsByRoute.get(item.id);
        if (a && a.length) {
          const worst = a.some((x) => ["SHUTTLE", "SUSPENSION", "STATION_CLOSURE"].includes(x.attributes.effect));
          badge = `<span class="mini-badge ${worst ? "shuttle" : "alert"}">${worst ? "Shuttle" : "Alert"}</span>`;
        }
      }
      row.innerHTML = `<span class="list-swatch" style="background:${color}"></span>
        <span>${item.name}${item.type === "station" ? '<div class="sub">Station</div>' : ""}</span>
        <span class="list-meta">${badge}</span>`;
      if (item.type === "route" && item.id === selectedRouteId) { row.classList.add("active"); }
      li.appendChild(row); list.appendChild(li);
    });
    el.listContainer.appendChild(list);
  };

  /* ============================================================
     ROUTE DRAWING + STATION MARKERS
     ============================================================ */
  const majorStations = new Set(["North Station", "South Station", "Back Bay", "Park Street", "Downtown Crossing", "Government Center", "Airport", "Ruggles", "JFK/UMass"]);

  const drawRoute = (routeId, { stops, shapes }, isInactive) => {
    const layerGroup = allRouteLayers.get(routeId) || { shapes: L.featureGroup(), stops: L.featureGroup() };
    Object.values(layerGroup).forEach((lg) => lg.clearLayers());
    allRouteLayers.set(routeId, layerGroup);
    // Respect show-all + system visibility on (re)draw
    const { color, type } = getRouteStyle(routeId);
    const sysVisible = qs(`.system-toggle[data-system="${type}"]`)?.checked ?? true;
    if (sysVisible && (showAllLines || !isInactive || routeId === selectedRouteId)) {
      Object.values(layerGroup).forEach((lg) => lg.addTo(map));
    }

    const style = { color, weight: isInactive ? 3 : 6, opacity: isInactive ? 0.4 : 0.95, lineCap: "round", lineJoin: "round" };
    if (!stops || !shapes || !shapes.length) return;

    // Decode all shapes with geometry stats.
    const decoded = shapes
      .filter((s) => s && s.attributes.polyline)
      .map((s) => {
        const pts = decodePolyline(s.attributes.polyline);
        let km = 0;
        for (let i = 1; i < pts.length; i++) km += haversine(pts[i - 1], pts[i]);
        return { id: s.id, pts, km, density: pts.length / (km || 1e-6), canonical: !!s.id?.startsWith("canonical") };
      })
      .filter((s) => s.pts.length >= 2);

    // Prefer canonical shapes (the MBTA's representative geographic geometry).
    // NEVER let a route end up with zero shapes.
    let finalShapes = decoded.filter((s) => s.canonical);
    if (!finalShapes.length) finalShapes = decoded;

    // Drop only NEAR-IDENTICAL duplicates (e.g. an inbound shape that retraces an
    // outbound one) so a route isn't drawn as a doubled line — but keep genuinely
    // different branches. Longest first so branches survive; always keep at least
    // one shape.
    finalShapes.sort((a, b) => b.km - a.km);
    const kept = [];
    finalShapes.forEach((s) => {
      if (!kept.some((k) => shapesOverlap(s.pts, k.pts))) kept.push(s);
    });
    finalShapes = kept.length ? kept : [finalShapes[0]];

    let longest = null, longestLen = -1;
    finalShapes.forEach((shape) => {
      const pts = shape.pts;
      if (pts.length > longestLen) { longestLen = pts.length; longest = pts; }
      const hit = L.polyline(pts, { color, weight: 12, opacity: 0, lineCap: "round" });
      hit.on("click", (e) => { L.DomEvent.stop(e); lastClickedShapeId = shape.id; selectRoute(routeId); });
      hit.bindTooltip(isDeveloperMode ? `${routeId} / ${shape.id}` : routeLongName(routeId), { className: "line-label-tooltip", sticky: true });
      hit._isHit = true;
      layerGroup.shapes.addLayer(hit);
      const pl = L.polyline(pts, { ...style, interactive: false });
      pl._isVisibleLine = true;
      layerGroup.shapes.addLayer(pl);
    });
    if (longest) { routePolylinePts.set(routeId, longest); buildRouteDistances(routeId, longest); buildRouteStopDists(routeId, stops); }
    routeAllShapePts.set(routeId, finalShapes.map((s) => s.pts));
    // Stations are drawn once, globally, by drawAllStations() — not per route —
    // so transfer stations aren't stacked/duplicated.
  };

  // Draw exactly one marker per unique station, snapped onto its route line.
  const drawAllStations = () => {
    stationLayer.clearLayers();
    stationMarkers.clear();
    stationToRoutesMap.forEach((data, name) => {
      const routes = [...data.routes];
      // primary route = the one whose color/label we use, prefer non-CR subway
      const primary = routes.find((r) => !r.startsWith("CR-") && !r.startsWith("Boat-")) || routes[0];
      const { color } = getRouteStyle(primary);
      const isTransfer = data.routes.size > 1;
      const isMajor = majorStations.has(name);

      // Canonical on-track point for this station — the SAME point used for the
      // marker, the next-stop clamp, and where trains stop (see stationTrackPoint).
      const tp = stationTrackPoint(name, routes, data.location);
      const latlng = L.latLng(tp[0], tp[1]);

      // DOM divIcon marker (marker pane) instead of a canvas circle: it only
      // captures clicks on its small dot, so route lines underneath stay fully
      // clickable, and it renders above the canvas route lines.
      const r = isTransfer ? 6 : 5;
      const dot = `<span class="station-dot${isTransfer ? " transfer" : ""}" style="--sc:${color};width:${r * 2}px;height:${r * 2}px"></span>`;
      const marker = L.marker(latlng, {
        icon: L.divIcon({ className: "station-div", html: dot, iconSize: [r * 2, r * 2] }),
        interactive: true,
        keyboard: false,
        zIndexOffset: -500, // below vehicles (which use +1000), above lines
      });
      marker._stationName = name;
      marker._baseColor = color;
      marker._isTransfer = isTransfer;
      marker._radius = r;
      marker.on("click", (e) => { L.DomEvent.stop(e); showStationInfo(name); });
      marker.bindTooltip(isDeveloperMode ? data.id : name, {
        permanent: isMajor, direction: "top", offset: [0, -r - 2],
        className: isMajor ? "station-name-tooltip" : "station-label-tooltip",
      });
      marker.addTo(stationLayer);
      stationMarkers.set(name, marker);
    });
  };

  const setLineVisibility = () => {
    allRouteLayers.forEach((layers, routeId) => {
      const { type } = getRouteStyle(routeId);
      const sysVisible = qs(`.system-toggle[data-system="${type}"]`)?.checked ?? true;
      const visible = sysVisible && (showAllLines || routeId === selectedRouteId);
      Object.values(layers).forEach((lg) => (visible ? map.addLayer(lg) : map.removeLayer(lg)));
    });
    // Show a station if any of its routes' systems is currently visible (and, when
    // not showing all lines, only stations on the selected route).
    stationMarkers.forEach((m, name) => {
      const routes = [...(stationToRoutesMap.get(name)?.routes || [])];
      const anySysVisible = routes.some((r) => qs(`.system-toggle[data-system="${getRouteStyle(r).type}"]`)?.checked ?? true);
      const onSelected = !selectedRouteId || (routeStationOrder.get(selectedRouteId) || []).includes(name);
      const visible = anySysVisible && (showAllLines || onSelected);
      if (visible) { if (!stationLayer.hasLayer(m)) m.addTo(stationLayer); }
      else stationLayer.removeLayer(m);
    });
  };

  /* ============================================================
     VEHICLES + INTERPOLATION
     ============================================================ */
  const getVehiclesForSelection = () => {
    let list;
    if (selectedRouteId) {
      list = allVehicleData.vehicles.filter((v) => v.relationships.route.data.id === selectedRouteId);
    } else {
      // Nothing selected → show ALL vehicles whose system is visible, so the map
      // is alive on first load instead of empty until a route is picked.
      list = allVehicleData.vehicles.filter((v) => {
        const t = getRouteType(v.relationships.route.data.id);
        return qs(`.system-toggle[data-system="${t}"]`)?.checked ?? true;
      });
    }
    if (crrcOnly) list = list.filter(isCrrcVehicle);
    return list;
  };
  // Build a vehicle icon. Bearing is derived from the ROUTE TANGENT (direction
  // of travel) when we know the along-route distance; otherwise from the API
  // bearing field. The SVG arrow tip points up (north) at 0°.
  const buildVehicleIcon = (v, headingDeg) => {
    const { color } = getRouteStyle(v.relationships.route.data.id);
    const crrc = isCrrcVehicle(v);
    const delayed = (vehicleDelays.get(v.id) || 0) >= 180;
    const cls = ["vehicle-icon-svg"];
    if (crrc) cls.push("crrc");
    if (delayed) cls.push("delayed");
    if (v.id === selectedVehicleId) cls.push("active");
    const deg = headingDeg != null ? headingDeg : (v.attributes.bearing || 0);
    return L.divIcon({ className: "", iconSize: [26, 26],
      html: `<svg class="${cls.join(" ")}" style="--bearing:${deg}deg" width="26" height="26" viewBox="0 0 32 32"><path fill="${color}" d="M16 3 L27 27 L16 21 L5 27 Z"/></svg>` });
  };

  // Along-route heading in the direction the train is moving.
  const headingForState = (routeId, dist, forward) => {
    let deg = bearingAtDistance(routeId, dist);
    if (deg == null) return null;
    if (forward === false) deg = (deg + 180) % 360; // travelling toward decreasing distance
    return deg;
  };

  // Max realistic ground distance (km) a vehicle covers between two ~30s reports.
  // A jump bigger than this is a bad/duplicate report or a branch-id switch — we
  // SNAP to it instead of animating a "race across the map".
  const MAX_LEG_KM = 1.6; // ~55 mph over 30s + margin

  const MAX_PREDICT_S = 75;   // cap forward prediction (stale reports don't fling)
  const MAX_EST_SPEED = 30;   // m/s sanity cap (~67 mph)
  const SEGMENT_TIMES = window.MBTA_SEGMENT_TIMES || {}; // learned median seconds per route|A|B

  // Learned travel seconds for a route segment (either direction), if known.
  const learnedSegmentSeconds = (routeId, a, b) =>
    SEGMENT_TIMES[`${routeId}|${a}|${b}`] ?? SEGMENT_TIMES[`${routeId}|${b}|${a}`] ?? null;

  // Ingest a report: record its position + timestamp, estimate speed from the
  // change since the previous report, and set up the on-route prediction anchor.
  const plotVehicles = (vehicles, included) => {
    if (!vehicles) vehicles = [];
    const seen = new Set();
    vehicles.forEach((v) => {
      const { latitude, longitude, bearing, current_status, updated_at, speed } = v.attributes;
      if (latitude == null || longitude == null) return;
      const routeId = v.relationships.route.data.id;
      const { type } = getRouteStyle(routeId);
      seen.add(v.id);

      const rawTarget = [latitude, longitude];
      const reportTime = updated_at ? new Date(updated_at).getTime() : Date.now();
      const hasDist = routeCumDist.has(routeId);
      const ex = interp.get(v.id);
      const prevDistHint = ex ? (ex.reportDist != null ? ex.reportDist : null) : null;
      // When a train reports STOPPED_AT a named station, that GPS is ground truth
      // for where trains stop there: learn it and snap the train's along-track
      // position to the station's canonical point, so the marker, the stop clamp,
      // and the train coincide (kills the backward-jump-at-stations bug).
      const stopId = v.relationships.stop?.data?.id;
      const stopName = stopIdToName.get(stopId);
      let reportDist;
      if (current_status === "STOPPED_AT" && stopName && hasDist) {
        // refine the learned stop position toward this report
        const cur = STOP_POSITIONS[stopName];
        STOP_POSITIONS[stopName] = cur
          ? [cur[0] * 0.8 + latitude * 0.2, cur[1] * 0.8 + longitude * 0.2]
          : [latitude, longitude];
        const tp = stationTrackPoint(stopName, [routeId], rawTarget);
        reportDist = distanceAlongRoute(routeId, tp, prevDistHint);
      } else {
        reportDist = hasDist ? distanceAlongRoute(routeId, rawTarget, prevDistHint) : null;
      }

      if (ex && ex.marker) {
        // Only treat as a NEW report when updated_at actually advanced.
        const isNewReport = reportTime !== ex.reportTime;
        if (isNewReport) {
          // Estimate speed (m/s) from along-track movement since last report.
          const dtReport = (reportTime - ex.reportTime) / 1000;
          let estMps = ex.estMps || 0;
          if (dtReport > 2 && dtReport < 240) {
            let moved;
            if (hasDist && reportDist != null && ex.reportDist != null) {
              moved = Math.abs(reportDist - ex.reportDist) * 1000; // km->m
              // guard route-ambiguity jumps: fall back to straight-line
              if (moved > MAX_LEG_KM * 1000) moved = haversine([...(ex.reportPos)], rawTarget) * 1000;
            } else {
              moved = haversine(ex.reportPos, rawTarget) * 1000;
            }
            const inst = moved / dtReport;
            // Speed sample; prefer API speed when present (CR sometimes has it).
            const sample = speed != null ? speed : inst;
            // Average speed over a short history to cancel the ~60m per-report
            // jitter in raw positions (the raw feed is noisy; averaging the data
            // we already have is the only route to a truer speed/position).
            (ex.speedHist = ex.speedHist || []).push(sample);
            if (ex.speedHist.length > 4) ex.speedHist.shift();
            const sorted = [...ex.speedHist].sort((a, b) => a - b);
            estMps = sorted[Math.floor(sorted.length / 2)]; // median of recent samples
          }
          // Decide travel direction along the track. A clear move (>150m) sets it
          // from actual displacement; otherwise fall back to the API bearing so a
          // (near-)stationary train still faces the right way.
          let forward = ex.forward !== undefined ? ex.forward : true;
          if (hasDist && reportDist != null && ex.reportDist != null && Math.abs(reportDist - ex.reportDist) > 0.15)
            forward = reportDist >= ex.reportDist;
          else if (hasDist && reportDist != null && bearing != null)
            forward = forwardFromBearing(routeId, reportDist, bearing);
          ex.reportPos = rawTarget;
          ex.reportTime = reportTime;
          ex.reportDist = reportDist;
          ex.estMps = Math.max(0, Math.min(MAX_EST_SPEED, estMps));
          ex.forward = forward;
          ex.status = current_status;
          ex.apiBearing = bearing;
          // Refresh the hover tooltip so its status/next-stop/destination update
          // live, and keep the marker's stored vehicle current for click/details.
          ex.marker.options.vehicleData = v;
          updateVehicleTooltip(ex.marker, v, type);
        }
        ex.vehicle = v; ex.routeId = routeId; ex.hasDist = hasDist;
      } else {
        const marker = L.marker(rawTarget, { icon: buildVehicleIcon(v, bearing), zIndexOffset: 1000, vehicleData: v });
        updateVehicleTooltip(marker, v, type);
        marker.on("click", (e) => { L.DomEvent.stop(e); displayVehicleDetails(marker); });
        marker.addTo(vehicleLayer);
        // First report: infer travel direction from the API bearing so the train
        // doesn't start off dead-reckoning the wrong way.
        const initForward = hasDist && reportDist != null ? forwardFromBearing(routeId, reportDist, bearing) : true;
        interp.set(v.id, {
          marker, routeId, vehicle: v, hasDist,
          reportPos: rawTarget, reportTime, reportDist,
          estMps: speed != null ? speed : 0, forward: initForward,
          status: current_status, apiBearing: bearing, _lastDeg: bearing ?? null,
        });
      }
    });
    interp.forEach((st, id) => { if (!seen.has(id)) { if (st.marker) vehicleLayer.removeLayer(st.marker); interp.delete(id); } });
    startAnimation();
  };

  // Resolve a vehicle's next stop name and its trip destination (headsign) from
  // the included data (works for both socket and direct-API payloads).
  const vehicleContextText = (v) => {
    const inc = new Map((allVehicleData.included || []).map((i) => [`${i.type}:${i.id}`, i]));
    const stopId = v.relationships.stop?.data?.id;
    const tripId = v.relationships.trip?.data?.id;
    const nextStop =
      stopIdToName.get(stopId) ||
      inc.get(`stop:${stopId}`)?.attributes?.name ||
      (inc.get(`stop:${stopId}`)?.relationships?.parent_station?.data?.id &&
        stopIdToName.get(inc.get(`stop:${stopId}`).relationships.parent_station.data.id)) ||
      null;
    const headsign = inc.get(`trip:${tripId}`)?.attributes?.headsign || null;
    return { nextStop, headsign };
  };

  const updateVehicleTooltip = (marker, v, type) => {
    const crrc = isCrrcVehicle(v);
    // Reflect the predicted-stopped state (kept in interp) so the marker text and
    // the panel status change together, not one report behind the other.
    const st = interp.get(v.id);
    const predStopped = st && st.predictedStopped && v.attributes.current_status !== "STOPPED_AT";
    const status = predStopped
      ? "stopped (predicted)"
      : (v.attributes.current_status || "").replace(/_/g, " ").toLowerCase();
    const { nextStop, headsign } = vehicleContextText(v);
    // Prefer showing the destination; add the next stop with status when known.
    let line2 = "";
    if (nextStop) line2 = `${status || "next"}: ${nextStop}`;
    else if (headsign) line2 = `${status} · to ${headsign}`;
    else if (status) line2 = status;
    const destLine = headsign && nextStop ? `<br><span style="opacity:.6">→ ${headsign}</span>` : "";
    const text = isDeveloperMode
      ? v.id
      : `<b>${crrc ? "✦ " : ""}Train ${v.attributes.label || v.id}</b>${line2 ? `<br><span style="opacity:.8">${line2}</span>` : ""}${destLine}`;
    const opts = { className: "vehicle-hover-tooltip", permanent: type === "Commuter Rail", direction: "right", offset: [12, 0] };
    if (type === "Commuter Rail") opts.className += " cr-vehicle-tooltip";
    marker.unbindTooltip(); marker.bindTooltip(text, opts);
  };

  // Bearing (deg from north, clockwise) from point a to point b.
  const bearingBetween = (a, b) => {
    const toR = (d) => (d * Math.PI) / 180, toD = (r) => (r * 180) / Math.PI;
    const y = Math.sin(toR(b[1] - a[1])) * Math.cos(toR(b[0]));
    const x = Math.cos(toR(a[0])) * Math.sin(toR(b[0])) - Math.sin(toR(a[0])) * Math.cos(toR(b[0])) * Math.cos(toR(b[1] - a[1]));
    return (toD(Math.atan2(y, x)) + 360) % 360;
  };

  // Reconciliation tuning. The DISPLAYED position eases toward the dead-reckoned
  // target very gently so corrections never look like a snap/dash — even when a
  // predicted-stopped train suddenly reports far ahead.
  const RECONCILE_KM_PER_S = 0.18;   // hard cap on correction speed (~gentle)
  const RECONCILE_TAU_S = 6;         // time-constant: close the gap over ~6s, not 2.5s

  let lastFrameMs = null;
  const animateVehicles = () => {
    const nowMs = Date.now();
    const frameDt = lastFrameMs ? Math.min(0.5, (nowMs - lastFrameMs) / 1000) : 0.016;
    lastFrameMs = nowMs;

    interp.forEach((st) => {
      if (!st.marker) return;

      if (st.hasDist && st.reportDist != null) {
        // 1) TARGET = where the train should be NOW (dead reckon from report).
        const elapsed = Math.min(MAX_PREDICT_S, Math.max(0, (nowMs - st.reportTime) / 1000));
        let mps = st.estMps || 0;
        if (st.status === "STOPPED_AT") mps = Math.min(mps, 1.2) * Math.max(0, 1 - elapsed / 25);
        let targetDist = st.reportDist + (st.forward ? 1 : -1) * (mps * elapsed) / 1000;
        const ns = nextStopDist(st.routeId, st.reportDist, st.forward);
        if (ns != null) targetDist = st.forward ? Math.min(targetDist, ns) : Math.max(targetDist, ns);

        // 2) DISPLAY moves at the train's own speed, GRADUALLY sped up or slowed
        // down to close the gap to the target — a smooth rubber-band, never a
        // snap. gap>0 means the truth is ahead (speed up); gap<0 means we're ahead
        // of the truth (slow down / briefly hold).
        if (st.displayDist == null) st.displayDist = targetDist;
        const dir = st.forward ? 1 : -1;
        const gapKm = (targetDist - st.displayDist) * dir; // + = target ahead of us
        let baseKmS = mps / 1000;
        // Decelerate approaching the next station: within ~250m, taper speed down
        // so the train eases in. If the next report says STOPPED we're already
        // near-stopped (no rebound); if it skips, we haven't overshot much.
        if (ns != null) {
          const toStopKm = Math.abs(ns - st.displayDist);
          const BRAKE_KM = 0.25;
          if (toStopKm < BRAKE_KM) baseKmS *= Math.max(0.12, toStopKm / BRAKE_KM);
        }
        // correction proportional to the gap (closes it over ~RECONCILE_TAU_S),
        // capped low so catch-up stays gentle rather than a dash.
        let corrKmS = gapKm / RECONCILE_TAU_S;
        corrKmS = Math.max(-RECONCILE_KM_PER_S, Math.min(RECONCILE_KM_PER_S, corrKmS));
        // effective forward speed = base + correction, never negative (no reversing).
        let stepKm = Math.max(0, baseKmS + corrKmS) * frameDt;
        // don't overshoot the target this frame.
        if (stepKm > Math.abs(targetDist - st.displayDist)) stepKm = Math.abs(targetDist - st.displayDist);
        st.displayDist += dir * stepKm;

        // Predicted-stop: the model says the train has reached its next station
        // (clamped to it) but the last report still says in-transit. Flag it so
        // the UI can show "stopped (predicted)".
        const wasPred = st.predictedStopped;
        st.predictedStopped = ns != null && Math.abs(ns - st.displayDist) < 0.03 &&
          st.status !== "STOPPED_AT" && targetDist === ns;
        // When it flips, update the marker tooltip AND (if watched) the panel
        // status together, so they never disagree.
        if (st.predictedStopped !== wasPred) {
          updateVehicleTooltip(st.marker, st.vehicle, getRouteStyle(st.routeId).type);
          if (st.vehicle.id === selectedVehicleId) {
            const el2 = getEl("veh-status");
            if (el2) el2.textContent = st.predictedStopped
              ? "stopped (predicted)"
              : (st.status || "").replace(/_/g, " ").toLowerCase();
          }
        }

        const pos = positionAtDistance(st.routeId, st.displayDist) || st.reportPos;
        st.marker.setLatLng(pos);

        // Heading: while moving, follow the track tangent in the travel
        // direction; while stopped (real or predicted), use the reported API
        // bearing (which reflects the train's actual facing) instead of a stale
        // frozen tangent — so a stopped train doesn't point the wrong way.
        const movingNow = stepKm > 0.0008; // >~0.8m this frame
        let deg;
        if (movingNow) deg = headingForState(st.routeId, st.displayDist, st.forward) ?? st.apiBearing;
        else deg = st.apiBearing ?? headingForState(st.routeId, st.displayDist, st.forward);
        if (deg != null && (st._lastDeg == null || angleDiff(st._lastDeg, deg) > 10)) {
          st._lastDeg = deg; st.marker.setIcon(buildVehicleIcon(st.vehicle, deg));
        }
      } else {
        // No route geometry: ease raw lat/lng toward the reported point.
        if (!st.displayPos) st.displayPos = st.reportPos.slice();
        const target = st.reportPos;
        const dMeters = haversine(st.displayPos, target);
        const maxM = RECONCILE_KM_PER_S * 1000 * frameDt;
        if (dMeters <= maxM || dMeters < 2) st.displayPos = target.slice();
        else {
          const f = maxM / dMeters;
          st.displayPos = [st.displayPos[0] + (target[0] - st.displayPos[0]) * f,
                           st.displayPos[1] + (target[1] - st.displayPos[1]) * f];
        }
        st.marker.setLatLng(st.displayPos);
      }
    });
    animationFrame = interp.size > 0 ? requestAnimationFrame(animateVehicles) : null;
  };
  // Smallest absolute difference between two angles in degrees (0..180).
  const angleDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const reapplyTooltip = (st) => {
    // Only rebuild the tooltip HTML when the vehicle object actually changed,
    // not on every heading tweak (which was thrashing bind/unbind each frame).
    if (st._tooltipVehicle === st.vehicle) return;
    st._tooltipVehicle = st.vehicle;
    const { type } = getRouteStyle(st.routeId);
    updateVehicleTooltip(st.marker, st.vehicle, type);
  };
  const startAnimation = () => {
    if (animationFrame == null && interp.size > 0) animationFrame = requestAnimationFrame(animateVehicles);
  };
  // Re-arm the animation loop whenever the tab becomes visible again — rAF is
  // suspended in background tabs and can otherwise stay stopped after focus.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { animationFrame = null; startAnimation(); }
  });

  /* ============================================================
     DELAY + VEHICLE PANEL + TRIP TRACKER
     ============================================================ */
  const delayBadge = (sec) => {
    if (sec == null) return "";
    const m = Math.round(sec / 60);
    if (m <= 0) return `<span class="badge ontime">On time</span>`;
    return `<span class="badge late">${m}m late</span>`;
  };
  const computeVehicleDelay = async (v) => {
    const tripId = v.relationships.trip?.data?.id;
    if (!tripId) return null;
    try {
      const data = await mbtaApi.tripPredictions(tripId);
      const inc = new Map((data.included || []).map((i) => [`${i.type}:${i.id}`, i]));
      const seq = v.attributes.current_stop_sequence;
      const upcoming = data.data.filter((p) => p.attributes.arrival_time || p.attributes.departure_time)
        .sort((a, b) => a.attributes.stop_sequence - b.attributes.stop_sequence);
      const next = upcoming.find((p) => p.attributes.stop_sequence >= seq) || upcoming[0];
      let delay = null;
      if (next) {
        const sid = next.relationships?.schedule?.data?.id;
        const sched = sid ? inc.get(`schedule:${sid}`) : null;
        if (sched) {
          const pT = new Date(next.attributes.arrival_time || next.attributes.departure_time);
          const sT = new Date(sched.attributes.arrival_time || sched.attributes.departure_time);
          delay = Math.round((pT - sT) / 1000);
          vehicleDelays.set(v.id, delay);
        }
      }
      return { delay, predictions: upcoming, included: inc };
    } catch { return null; }
  };

  const displayVehicleDetails = (marker) => {
    [el.lineInfo, el.stationInfo, el.alertDetail].forEach((o) => o.classList.add("hidden"));
    const v = marker.options.vehicleData;
    const live = allVehicleData.vehicles.find((x) => x.id === v?.id) || v;
    if (!live) return;
    selectedVehicleId = live.id;
    _lastTripKey = null; // force trip/delay (re)load for the newly selected train
    refreshVehiclePanelData(live);
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 14));
    plotVehicles(getVehiclesForSelection(), allVehicleData.included);
  };

  // Highlight the watched train's prev/current/next STATIONS by enlarging their
  // existing dots (no separate rings). Tracks which were highlighted so we can
  // reset them when the selection changes or clears.
  let _highlightedStations = [];
  const clearStationHighlights = () => {
    _highlightedStations.forEach((m) => {
      const e = m.getElement && m.getElement();
      if (e) { const d = e.querySelector(".station-dot"); if (d) d.classList.remove("hl"); }
    });
    _highlightedStations = [];
  };
  const drawVehicleContext = (v, res) => {
    clearStationHighlights();
    if (selectedVehicleId !== v.id || !res || !res.predictions) return;
    const seq = v.attributes.current_stop_sequence;
    const inc = res.included;
    const sorted = res.predictions.slice().sort((a, b) => a.attributes.stop_sequence - b.attributes.stop_sequence);
    const idx = sorted.findIndex((p) => p.attributes.stop_sequence >= seq);
    [sorted[idx - 1], sorted[idx], sorted[idx + 1]].filter(Boolean).forEach((p) => {
      const sid = p.relationships?.stop?.data?.id;
      const name = inc.get(`stop:${sid}`)?.attributes?.name || stopIdToName.get(sid);
      const m = name && stationMarkers.get(name);
      if (!m) return;
      const e = m.getElement && m.getElement();
      const d = e && e.querySelector(".station-dot");
      if (d) { d.classList.add("hl"); _highlightedStations.push(m); }
    });
  };

  // Rebuild the panel SHELL once (on select / when the tracked train changes),
  // then only update the dynamic field values on subsequent refreshes — so the
  // trip-timeline div is NOT wiped back to "Loading trip…" on every update.
  const buildVehiclePanelShell = (v) => {
    const routeId = v.relationships.route.data.id;
    const { color } = getRouteStyle(routeId);
    const crrc = isCrrcVehicle(v);
    const label = v.attributes.label;
    el.vehicleInfo.innerHTML = `
      <button class="close-button">&times;</button>
      <h4 class="info-header" style="color:${color}">${isDeveloperMode ? v.id : `Train ${label || "—"}`}
        ${crrc ? '<span class="badge new">New CRRC</span>' : ""}<span id="veh-delay-badge"></span></h4>
      <div class="info-subheader" id="veh-sub"></div>
      <div class="info-content">
        <div class="info-row"><span class="info-label">Status</span><span class="info-value" id="veh-status" style="text-transform:capitalize"></span></div>
        <div class="info-row"><span class="info-label">Next stop</span><span class="info-value" id="veh-next"></span></div>
        <div class="info-row" id="veh-speed-row" style="display:none"><span class="info-label">Speed</span><span class="info-value" id="veh-speed"></span></div>
        <div class="info-row" id="veh-cars-row" style="display:none"><span class="info-label">Cars</span><span class="info-value" id="veh-cars"></span></div>
        <div class="info-row" id="veh-occ-row" style="display:none"><span class="info-label">Occupancy</span><span class="info-value" id="veh-occ" style="text-transform:capitalize"></span></div>
        <div class="info-row"><span class="info-label">Updated</span><span class="info-value" id="veh-updated"></span></div>
      </div>
      <div class="section-title">Trip tracker</div>
      <div id="trip-timeline" class="trip-timeline"><p class="empty-note">Loading trip…</p></div>`;
    el.vehicleInfo.classList.remove("hidden");
    el.vehicleInfo.querySelector(".close-button").onclick = () => {
      selectedVehicleId = null; _shellVehicleId = null; el.vehicleInfo.classList.add("hidden");
      clearStationHighlights();
      plotVehicles(getVehiclesForSelection(), allVehicleData.included);
    };
  };

  const refreshVehiclePanelData = (v) => {
    // (Re)build the shell only when the selected train changed.
    if (_shellVehicleId !== v.id) { _shellVehicleId = v.id; buildVehiclePanelShell(v); }

    const lookup = new Map(allVehicleData.included?.map((i) => [i.id, i]));
    const { current_status, updated_at, speed } = v.attributes;
    const routeId = v.relationships.route.data.id;
    const { color } = getRouteStyle(routeId);
    const tripId = v.relationships.trip?.data?.id;
    const stopId = v.relationships.stop?.data?.id;
    const nextStop = stopIdToName.get(stopId) || lookup.get(stopId)?.attributes?.name || "N/A";
    const headsign = lookup.get(tripId)?.attributes?.headsign;
    const cars = (v.attributes.carriages || []).map((c) => c.label).filter(Boolean);
    const occ = (v.attributes.carriages || []).map((c) => c.occupancy_status).filter(Boolean);
    const occTxt = occ.length ? occ[0].replace(/_/g, " ").toLowerCase() : null;
    const set = (id, txt) => { const e = getEl(id); if (e) e.textContent = txt; };

    // Update only the dynamic fields in place (never touches #trip-timeline).
    set("veh-sub", routeLongName(routeId) + (headsign ? " → " + headsign : ""));
    const st = interp.get(v.id);
    set("veh-status", st && st.predictedStopped && current_status !== "STOPPED_AT"
      ? "stopped (predicted)"
      : (current_status || "").replace(/_/g, " ").toLowerCase());
    set("veh-next", nextStop);
    set("veh-updated", formatRelativeTime(updated_at));
    if (speed != null) { getEl("veh-speed-row").style.display = ""; set("veh-speed", Math.round(speed * 2.237) + " mph"); }
    if (cars.length) { getEl("veh-cars-row").style.display = ""; set("veh-cars", cars.join(", ")); }
    if (occTxt) { getEl("veh-occ-row").style.display = ""; set("veh-occ", occTxt); }

    // Re-fetch the trip/delay only when the stop sequence advanced (a real change).
    const tripKey = `${v.id}|${tripId}|${v.attributes.current_stop_sequence}`;
    if (tripKey !== _lastTripKey) {
      _lastTripKey = tripKey;
      computeVehicleDelay(v).then((res) => {
        if (selectedVehicleId !== v.id) return;
        const b = getEl("veh-delay-badge");
        if (b && res && res.delay != null) b.innerHTML = delayBadge(res.delay);
        renderTripTimeline(v, res, color); // renders data OR "No trip data available"
        drawVehicleContext(v, res);
      }).catch(() => {
        if (selectedVehicleId === v.id) {
          const c = getEl("trip-timeline");
          if (c) c.innerHTML = `<p class="empty-note">Trip data unavailable — retrying…</p>`;
        }
        _lastTripKey = null; // allow retry next refresh
      });
    }
  };
  let _lastTripKey = null;
  let _shellVehicleId = null;

  const renderTripTimeline = (v, res, color) => {
    const c = getEl("trip-timeline");
    if (!c) return;
    if (!res || !res.predictions || !res.predictions.length) { c.innerHTML = `<p class="empty-note">No trip data available.</p>`; return; }
    const seq = v.attributes.current_stop_sequence, inc = res.included;
    const routeId = v.relationships.route.data.id;
    // Pre-resolve names; then fill any downstream stop lacking a live prediction
    // with a learned-segment estimate chained from the previous known time.
    let rows = res.predictions.map((p) => {
      const sid = p.relationships?.stop?.data?.id;
      return {
        name: inc.get(`stop:${sid}`)?.attributes?.name || stopIdToName.get(sid) || sid || "Stop",
        s: p.attributes.stop_sequence,
        t: p.attributes.arrival_time || p.attributes.departure_time,
      };
    });
    // Dedupe consecutive stops with the same NAME (a line and its branch variant,
    // e.g. Franklin vs Franklin/Foxboro, list the same platform twice). Keep the
    // first occurrence, preferring one that has a time.
    const deduped = [];
    rows.forEach((r) => {
      const last = deduped[deduped.length - 1];
      if (last && last.name === r.name) { if (!last.t && r.t) last.t = r.t; return; }
      deduped.push(r);
    });
    rows = deduped;
    let lastMs = null;
    rows.forEach((r) => {
      if (r.t) { lastMs = new Date(r.t).getTime(); r.est = false; }
      else if (lastMs != null) {
        const prev = rows[rows.indexOf(r) - 1];
        const seg = prev ? learnedSegmentSeconds(routeId, prev.name, r.name) : null;
        if (seg) { lastMs += seg * 1000; r.t = new Date(lastMs).toISOString(); r.est = true; }
      }
    });
    c.innerHTML = rows.map((r) => {
      const passed = r.s < seq, current = r.s === seq;
      let timeStr = current ? "Here" : passed ? "" : (formatArrivalTime(r.t) || clockTime(r.t) || "");
      if (r.est && timeStr) timeStr += "*"; // learned-estimate marker
      return `<div class="trip-stop ${passed ? "passed" : current ? "current" : ""}">
        <div class="dot-col"><span class="t-dot" style="background:${passed ? "#6b6b73" : color}"></span>
        <span class="t-line" style="background:${passed ? "#2a2a30" : color}"></span></div>
        <span class="t-name">${r.name}</span><span class="t-time">${timeStr}</span></div>`;
    }).join("");
  };

  /* ============================================================
     STATION INFO + PREDICTIONS
     ============================================================ */
  const showStationInfo = (stationName, selectLine = true) => {
    const servicing = stationToRoutesMap.get(stationName);
    if (!servicing) return;
    if (selectLine && servicing.routes.size) {
      const primary = [...servicing.routes].find((r) => !r.startsWith("CR-")) || [...servicing.routes][0];
      const t = getRouteType(primary);
      if (qs(`.system-toggle[data-system="${t}"]`)?.checked) selectRoute(primary, false); else deselectAll();
    }
    const routeListHtml = [...servicing.routes].map((rId) => {
      const { color } = getRouteStyle(rId);
      return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0"><span style="width:11px;height:11px;border-radius:3px;background:${color}"></span>${isDeveloperMode ? rId : routeLongName(rId)}</div>`;
    }).join("");
    el.stationInfo.innerHTML = `<button class="close-button">&times;</button>
      <h4 class="info-header">${isDeveloperMode ? servicing.id : stationName}</h4>
      <div class="info-content"><div>${routeListHtml}</div>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="mini-plan-btn" data-dir="from">Trip from here</button><button class="mini-plan-btn" data-dir="to">Trip to here</button></div>
      <div class="section-title">Upcoming arrivals</div><div id="prediction-list"><p class="empty-note">Loading…</p></div></div>`;
    qsa(".info-overlay").forEach((p) => { if (p !== el.stationInfo) p.classList.add("hidden"); });
    el.stationInfo.classList.remove("hidden");
    el.stationInfo.querySelector(".close-button").onclick = () => { el.stationInfo.classList.add("hidden"); deselectAll(); };
    el.stationInfo.querySelectorAll(".mini-plan-btn").forEach((b) => b.addEventListener("click", () => {
      switchMainTab("plan");
      if (b.dataset.dir === "from") { el.planFrom.value = stationName; el.planTo.focus(); }
      else { el.planTo.value = stationName; el.planFrom.focus(); }
    }));
    // style mini buttons
    el.stationInfo.querySelectorAll(".mini-plan-btn").forEach((b) => {
      b.style.cssText = "flex:1;padding:8px;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;color:var(--text-1);font:inherit;font-size:0.78rem;font-weight:600;cursor:pointer";
    });
    fetchAndDisplayPredictions(servicing.id);
    if (servicing.location) map.flyTo(servicing.location, Math.max(map.getZoom(), 14), { animate: true, duration: 0.5 });
  };

  const fetchAndDisplayPredictions = async (stationId) => {
    const listEl = getEl("prediction-list");
    if (!listEl) return;
    try {
      const data = await mbtaApi.predictionsForStop(stationId);
      const inc = new Map((data.included || []).map((i) => [`${i.type}:${i.id}`, i]));
      const groups = {};
      data.data.forEach((p) => {
        const trip = inc.get(`trip:${p.relationships.trip?.data?.id}`);
        const headsign = trip?.attributes?.headsign;
        if (!headsign) return;
        const routeId = p.relationships.route?.data?.id;
        const f = formatArrivalTime(p.attributes.arrival_time || p.attributes.departure_time);
        if (!f) return;
        const key = `${routeId}|${headsign}`;
        if (!groups[key]) groups[key] = { dest: headsign, color: getRouteStyle(routeId).color, arrivals: [] };
        if (groups[key].arrivals.length < 3) groups[key].arrivals.push(f);
      });
      const valid = Object.values(groups).filter((g) => g.arrivals.length);
      if (!valid.length) { listEl.innerHTML = `<p class="empty-note">No upcoming arrivals.</p>`; return; }
      listEl.innerHTML = valid.map((g) => `<div class="pred-group"><div class="pred-dest"><span class="pred-dot" style="background:${g.color}"></span>${g.dest}</div>
        <div class="pred-times">${g.arrivals.map((a) => (a === "Arriving" ? `<span class="now">${a}</span>` : a)).join(" · ")}</div></div>`).join("");
    } catch { listEl.innerHTML = `<p class="empty-note">Could not load arrivals.</p>`; }
  };

  /* ============================================================
     LINE INFO PANEL
     ============================================================ */
  const showLineInfo = (routeId) => {
    const route = routeDataCache.find((r) => r.id === routeId);
    if (!route) return;
    const { type, color } = getRouteStyle(routeId);
    const info = routeInfoCache.get(routeId);
    const dests = route.attributes.direction_destinations;
    const routeAlerts = alertsByRoute.get(routeId) || [];
    const alertsHtml = routeAlerts.length
      ? `<div class="section-title">Service alerts (${routeAlerts.length})</div>` + routeAlerts.slice(0, 4).map((a) => {
          const eff = (a.attributes.effect || "").toLowerCase();
          return `<div class="alert-card" data-alert-id="${a.id}"><div class="alert-top"><span class="alert-effect eff-${eff || "default"}">${(a.attributes.effect || "info").replace(/_/g, " ")}</span></div><div class="alert-head">${a.attributes.short_header || a.attributes.header || ""}</div></div>`;
        }).join("")
      : "";
    const uniqStops = [];
    const seen = new Set();
    info.stops.forEach((s) => { if (!seen.has(s.attributes.name)) { seen.add(s.attributes.name); uniqStops.push(s); } });
    const stationList = uniqStops.map((stop, i) => {
      const name = isDeveloperMode ? stop.id : stop.attributes.name;
      let transfers = "";
      const tr = stationToRoutesMap.get(stop.attributes.name)?.routes;
      if (tr && tr.size > 1) {
        const s2 = new Map();
        tr.forEach((tId) => { if (tId === routeId) return; const st = getRouteStyle(tId); s2.set(st.type === "Commuter Rail" ? "CR" : st.color, st.color); });
        transfers = `<span class="transfer-dots">${[...s2.values()].map((c) => `<span style="background:${c}"></span>`).join("")}</span>`;
      }
      let term = "";
      if (i === 0 && dests[0]) term = `<span class="terminus">to ${dests[0]}</span>`;
      if (i === uniqStops.length - 1 && dests[1]) term = `<span class="terminus">to ${dests[1]}</span>`;
      return `<li data-station="${stop.attributes.name}">${name} ${term}${transfers}</li>`;
    }).join("");
    el.lineInfo.innerHTML = `<button class="close-button">&times;</button>
      <h4 class="info-header" style="color:${color}">${isDeveloperMode ? route.id : route.attributes.long_name}</h4>
      <div class="info-subheader">${route.attributes.description || ""} · ${type}</div>
      <div class="info-content">${alertsHtml}
        <div class="section-title">Active vehicles</div><div id="vehicle-list-container" class="sub-list"><p class="empty-note">Loading…</p></div>
        <div class="section-title">Stations (${uniqStops.length})</div><ul id="station-list-container" class="station-list">${stationList}</ul></div>`;
    qsa(".info-overlay").forEach((p) => { if (p !== el.lineInfo) p.classList.add("hidden"); });
    el.lineInfo.classList.remove("hidden");
    el.lineInfo.querySelector(".close-button").onclick = () => { el.lineInfo.classList.add("hidden"); deselectAll(); };
    el.lineInfo.querySelectorAll(".alert-card").forEach((c) => c.addEventListener("click", () => showAlertDetail(c.dataset.alertId)));
    el.lineInfo.querySelectorAll("#station-list-container li").forEach((li) => li.addEventListener("click", () => showStationInfo(li.dataset.station, false)));
  };

  const updateLineInfoVehicleList = (routeId, vehicles, included) => {
    if (routeId !== selectedRouteId || el.lineInfo.classList.contains("hidden")) return;
    const c = getEl("vehicle-list-container");
    if (!c) return;
    if (!vehicles || !vehicles.length) { c.innerHTML = `<p class="empty-note">No active vehicles${crrcOnly ? " (CRRC filter on)" : ""}.</p>`; return; }
    const lookup = new Map(included?.map((i) => [i.id, i.attributes]));
    c.innerHTML = vehicles.map((v) => {
      const stopId = v.relationships.stop?.data?.id;
      const nextStop = stopIdToName.get(stopId) || lookup.get(stopId)?.name || "N/A";
      const crrc = isCrrcVehicle(v), delay = vehicleDelays.get(v.id);
      return `<div class="sub-item" data-vehicle-id="${v.id}"><div class="si-top"><span class="si-title">${isDeveloperMode ? v.id : `Train ${v.attributes.label || v.id}`}</span>
        ${crrc ? '<span class="badge new">New</span>' : ""}${delay != null ? delayBadge(delay) : ""}</div>
        <div class="si-meta" style="text-transform:capitalize">${(v.attributes.current_status || "").replace(/_/g, " ").toLowerCase()} · Next: ${nextStop}</div></div>`;
    }).join("");
    c.querySelectorAll(".sub-item").forEach((item) => item.addEventListener("click", () => {
      const st = interp.get(item.dataset.vehicleId);
      if (st && st.marker) { map.flyTo(st.marker.getLatLng(), Math.max(map.getZoom(), 15)); displayVehicleDetails(st.marker); }
    }));
  };

  /* ============================================================
     ALERTS
     ============================================================ */
  const severeEffects = ["SHUTTLE", "SUSPENSION", "STATION_CLOSURE", "DETOUR"];
  const loadAlerts = async () => {
    try {
      const data = await mbtaApi.alerts();
      alertsData = data.data || [];
      alertsByRoute = new Map();
      alertsData.forEach((a) => (a.attributes.informed_entity || []).forEach((e) => {
        if (e.route) { if (!alertsByRoute.has(e.route)) alertsByRoute.set(e.route, []); const arr = alertsByRoute.get(e.route); if (!arr.find((x) => x.id === a.id)) arr.push(a); }
      }));
      renderAlertsBanner(); renderAlertsList(); onSearchOrTabChange();
    } catch (e) { console.warn("Alerts load failed", e); }
  };
  const renderAlertsBanner = () => {
    const severe = alertsData.filter((a) => severeEffects.includes(a.attributes.effect));
    if (!severe.length) { el.alertsBanner.classList.add("hidden"); return; }
    el.alertsBanner.classList.remove("hidden");
    el.alertsBannerText.textContent = severe[0].attributes.short_header || severe[0].attributes.header || "Service disruption";
    el.alertsBannerCount.textContent = severe.length;
  };
  const renderAlertsList = () => {
    if (!el.alertsList) return;
    if (!alertsData.length) { el.alertsList.innerHTML = `<p class="empty-note">No active service alerts. 🎉</p>`; return; }
    const sorted = [...alertsData].sort((a, b) => {
      const sa = severeEffects.includes(a.attributes.effect) ? 1 : 0, sb = severeEffects.includes(b.attributes.effect) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return (b.attributes.severity || 0) - (a.attributes.severity || 0);
    });
    el.alertsList.innerHTML = sorted.map((a) => {
      const eff = (a.attributes.effect || "").toLowerCase();
      const routes = (a.attributes.informed_entity || []).map((e) => e.route).filter((v, i, ar) => v && ar.indexOf(v) === i).slice(0, 6);
      const dots = routes.map((r) => `<span class="alert-route-dot" style="background:${getRouteStyle(r).color}"></span>`).join("");
      return `<div class="alert-card" data-alert-id="${a.id}"><div class="alert-top"><span class="alert-effect eff-${eff || "default"}">${(a.attributes.effect || "info").replace(/_/g, " ")}</span><span class="alert-routes">${dots}</span></div><div class="alert-head">${a.attributes.short_header || a.attributes.header || ""}</div></div>`;
    }).join("");
    el.alertsList.querySelectorAll(".alert-card").forEach((c) => c.addEventListener("click", () => showAlertDetail(c.dataset.alertId)));
  };
  const showAlertDetail = (id) => {
    const a = alertsData.find((x) => x.id === id);
    if (!a) return;
    const at = a.attributes, eff = (at.effect || "").toLowerCase();
    const routes = (at.informed_entity || []).map((e) => e.route).filter((v, i, ar) => v && ar.indexOf(v) === i);
    qsa(".info-overlay").forEach((p) => p.classList.add("hidden"));
    el.alertDetail.innerHTML = `<button class="close-button">&times;</button>
      <h4 class="info-header"><span class="alert-effect eff-${eff || "default"}">${(at.effect || "info").replace(/_/g, " ")}</span></h4>
      <div class="info-content"><p style="font-weight:600;line-height:1.45;margin:0 0 10px">${at.header || ""}</p>
      ${at.description ? `<p style="color:var(--text-1);font-size:0.82rem;line-height:1.55;white-space:pre-line">${at.description}</p>` : ""}
      ${routes.length ? `<div class="section-title">Affected lines</div><div style="display:flex;gap:6px;flex-wrap:wrap">${routes.map((r) => `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--bg-2);padding:4px 9px;border-radius:8px;font-size:0.78rem"><span style="width:10px;height:10px;border-radius:3px;background:${getRouteStyle(r).color}"></span>${routeLongName(r)}</span>`).join("")}</div>` : ""}</div>`;
    el.alertDetail.classList.remove("hidden");
    el.alertDetail.querySelector(".close-button").onclick = () => el.alertDetail.classList.add("hidden");
  };

  /* ============================================================
     JOURNEY PLANNER (network-wide, transfer-aware)
     ============================================================ */
  // Typical per-hop ride time cache: `${routeId}|${A}|${B}` -> minutes
  const hopTimeCache = new Map();
  const TRANSFER_PENALTY_MIN = 4;      // avg wait+walk at a transfer
  const DEFAULT_HOP_MIN = { Subway: 2, "Commuter Rail": 4, Ferry: 8, Other: 3 };

  const stationNames = () => [...graph.keys()].sort();

  const populatePlanner = () => {
    setupStationAutocomplete(el.planFrom, el.planFromSuggest);
    setupStationAutocomplete(el.planTo, el.planToSuggest);
    el.planGo.addEventListener("click", runPlanner);
    el.planSwap.addEventListener("click", () => {
      const a = el.planFrom.value; el.planFrom.value = el.planTo.value; el.planTo.value = a;
    });
  };

  const setupStationAutocomplete = (input, box) => {
    let hi = -1;
    const render = () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { box.classList.add("hidden"); return; }
      const matches = stationNames().filter((n) => n.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) { box.classList.add("hidden"); return; }
      hi = -1;
      box.innerHTML = matches.map((n) => {
        const routes = [...(graph.get(n)?.routes || [])];
        const dots = routes.slice(0, 5).map((r) => `<span style="background:${getRouteStyle(r).color}"></span>`).join("");
        return `<div class="suggest-item" data-name="${n.replace(/"/g, "&quot;")}">${n}<span class="s-dots">${dots}</span></div>`;
      }).join("");
      box.classList.remove("hidden");
      box.querySelectorAll(".suggest-item").forEach((it) => it.addEventListener("mousedown", (e) => {
        e.preventDefault(); input.value = it.dataset.name; box.classList.add("hidden");
      }));
    };
    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    input.addEventListener("blur", () => setTimeout(() => box.classList.add("hidden"), 150));
    input.addEventListener("keydown", (e) => {
      const items = [...box.querySelectorAll(".suggest-item")];
      if (!items.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hi + 1, items.length - 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(hi - 1, 0); }
      else if (e.key === "Enter" && hi >= 0) { e.preventDefault(); input.value = items[hi].dataset.name; box.classList.add("hidden"); return; }
      else return;
      items.forEach((it, i) => it.classList.toggle("hi", i === hi));
    });
  };

  // Dijkstra across the station graph. State cost = minutes; transfers add penalty.
  // Returns array of legs: {routeId, type, stops:[names], from, to}
  const planRoute = (fromName, toName) => {
    if (!graph.has(fromName) || !graph.has(toName)) return null;
    if (fromName === toName) return [];
    // Priority queue via simple array (network is small ~250 nodes)
    const dist = new Map();     // key `${station}|${route}` -> minutes
    const prev = new Map();     // key -> { station, route }
    const startKeys = [];
    // Start: can board any route at fromName; also a "walk" pseudo-route null
    graph.get(fromName).routes.forEach((r) => {
      const k = `${fromName}|${r}`; dist.set(k, 0); startKeys.push(k);
    });
    const pq = startKeys.map((k) => ({ k, d: 0 }));
    const visited = new Set();
    let endKey = null;

    while (pq.length) {
      pq.sort((a, b) => a.d - b.d);
      const { k, d } = pq.shift();
      if (visited.has(k)) continue;
      visited.add(k);
      const [station, route] = splitKey(k);
      if (station === toName) { endKey = k; break; }
      const node = graph.get(station);
      if (!node) continue;
      // 1) Continue riding current route to neighbors
      const nbrs = node.neighbors.get(route);
      if (nbrs) nbrs.forEach((nb) => {
        const cost = hopTime(route, station, nb);
        relax(`${nb}|${route}`, d + cost, { station, route }, dist, prev, pq);
      });
      // 2) Transfer to another route at this station (penalty)
      node.routes.forEach((r2) => {
        if (r2 === route) return;
        relax(`${station}|${r2}`, d + TRANSFER_PENALTY_MIN, { station, route }, dist, prev, pq);
      });
    }
    if (!endKey) {
      // fallback: reach toName on any route
      let best = null, bd = Infinity;
      dist.forEach((v, k) => { if (splitKey(k)[0] === toName && v < bd) { bd = v; best = k; } });
      if (!best) return null;
      endKey = best;
    }
    // Reconstruct path of {station, route}
    const path = [];
    let cur = endKey;
    while (cur) {
      const [st, rt] = splitKey(cur);
      path.unshift({ station: st, route: rt });
      const p = prev.get(cur);
      cur = p ? `${p.station}|${p.route}` : null;
      if (path.length > 400) break;
    }
    return pathToLegs(path);
  };

  const splitKey = (k) => { const i = k.lastIndexOf("|"); return [k.slice(0, i), k.slice(i + 1)]; };
  const relax = (nk, nd, from, dist, prev, pq) => {
    if (nd < (dist.get(nk) ?? Infinity)) { dist.set(nk, nd); prev.set(nk, from); pq.push({ k: nk, d: nd }); }
  };
  const hopTime = (route, a, b) => {
    const key = `${route}|${a}|${b}`;
    if (hopTimeCache.has(key)) return hopTimeCache.get(key);
    const rk = `${route}|${b}|${a}`;
    if (hopTimeCache.has(rk)) return hopTimeCache.get(rk);
    // distance-based fallback
    const na = graph.get(a), nb = graph.get(b);
    if (na && nb) {
      const km = haversine(na.location, nb.location);
      const { type } = getRouteStyle(route);
      const speed = type === "Commuter Rail" ? 0.9 : type === "Ferry" ? 0.5 : 0.55; // km per min
      return Math.max(1, km / speed);
    }
    return DEFAULT_HOP_MIN[getRouteStyle(route).type] || 3;
  };

  // Collapse consecutive same-route steps into legs.
  const pathToLegs = (path) => {
    const legs = [];
    let i = 0;
    while (i < path.length - 1) {
      const route = path[i + 1].route === path[i].route ? path[i].route : path[i + 1].route;
      // Determine the route used to travel from path[i] to path[i+1]:
      // if station changes, it's the route on path[i+1]; if only route changes (transfer), skip.
      if (path[i].station === path[i + 1].station) { i++; continue; } // transfer node
      const legRoute = path[i + 1].route;
      const stops = [path[i].station];
      let j = i;
      while (j < path.length - 1 && path[j + 1].route === legRoute && path[j + 1].station !== path[j].station) {
        stops.push(path[j + 1].station); j++;
      }
      legs.push({ routeId: legRoute, type: getRouteStyle(legRoute).type, from: stops[0], to: stops[stops.length - 1], stops });
      i = j;
    }
    // merge legs that are same route back-to-back
    const merged = [];
    legs.forEach((lg) => {
      const last = merged[merged.length - 1];
      if (last && last.routeId === lg.routeId && last.to === lg.from) {
        last.to = lg.to; last.stops = last.stops.concat(lg.stops.slice(1));
      } else merged.push(lg);
    });
    return merged;
  };

  // Estimate leg minutes from typical hop times.
  const legMinutes = (leg) => {
    let m = 0;
    for (let i = 0; i < leg.stops.length - 1; i++) m += hopTime(leg.routeId, leg.stops[i], leg.stops[i + 1]);
    return m;
  };

  // Find the soonest live/predicted departure for a leg's boarding station toward its direction.
  const liveDepartureForLeg = async (leg, notBefore) => {
    const boardStation = stationToRoutesMap.get(leg.from);
    if (!boardStation) return null;
    try {
      const data = await mbtaApi.predictionsForStop(boardStation.id);
      const inc = new Map((data.included || []).map((i) => [`${i.type}:${i.id}`, i]));
      const cands = data.data.filter((p) => p.relationships.route?.data?.id === leg.routeId)
        .map((p) => {
          const t = p.attributes.departure_time || p.attributes.arrival_time;
          const trip = inc.get(`trip:${p.relationships.trip?.data?.id}`);
          return t ? { time: new Date(t), headsign: trip?.attributes?.headsign } : null;
        })
        .filter((x) => x && x.time >= notBefore)
        .sort((a, b) => a.time - b.time);
      return cands[0] || null;
    } catch { return null; }
  };

  const runPlanner = async () => {
    const from = el.planFrom.value.trim();
    const to = el.planTo.value.trim();
    if (!from || !to) { el.planResult.innerHTML = `<p class="empty-note">Enter both a start and destination.</p>`; return; }
    // normalize to a known station name (case-insensitive / partial)
    const norm = (v) => graph.has(v) ? v : stationNames().find((n) => n.toLowerCase() === v.toLowerCase()) || stationNames().find((n) => n.toLowerCase().includes(v.toLowerCase()));
    const fromN = norm(from), toN = norm(to);
    if (!fromN || !toN) { el.planResult.innerHTML = `<p class="empty-note">Couldn’t find ${!fromN ? `“${from}”` : `“${to}”`}. Pick a station from the suggestions.</p>`; return; }
    if (fromN === toN) { el.planResult.innerHTML = `<p class="empty-note">Start and destination are the same station.</p>`; return; }

    el.planResult.innerHTML = `<div class="journey-summary"><div class="journey-sub">Finding the best route…</div></div>`;

    const legs = planRoute(fromN, toN);
    if (!legs || !legs.length) { el.planResult.innerHTML = `<p class="empty-note">No connecting route found between these stations.</p>`; return; }

    const whenVal = el.planWhen.value;
    const leaveNow = whenVal === "now";
    let departAt = new Date(Date.now() + (leaveNow ? 0 : parseInt(whenVal, 10) * 60000));

    // Build timeline: for each leg, find catchable departure (live if now), then add ride time.
    const rendered = [];
    let cursor = new Date(departAt);
    let usedLive = false, firstBoard = null;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const ride = legMinutes(leg);
      let board = null;
      if (leaveNow || i > 0) {
        board = await liveDepartureForLeg(leg, cursor);
      }
      if (board) { usedLive = true; cursor = new Date(board.time); if (i === 0) firstBoard = board.time; }
      const arrive = new Date(cursor.getTime() + ride * 60000);
      rendered.push({ leg, ride, boardTime: board ? board.time : null, arriveTime: arrive, headsign: board?.headsign });
      cursor = new Date(arrive.getTime() + (i < legs.length - 1 ? TRANSFER_PENALTY_MIN * 60000 : 0));
    }

    const totalMin = (cursor.getTime() - departAt.getTime()) / 60000 - (legs.length > 1 ? TRANSFER_PENALTY_MIN : 0);
    const arriveTime = rendered[rendered.length - 1].arriveTime;
    renderJourney(fromN, toN, rendered, totalMin, arriveTime, usedLive && leaveNow, departAt);
    highlightJourneyOnMap(rendered);
  };

  const renderJourney = (fromN, toN, rendered, totalMin, arriveTime, live, departAt) => {
    const transfers = rendered.length - 1;
    const legsHtml = rendered.map((r) => {
      const { color } = getRouteStyle(r.leg.routeId);
      const isWalk = false;
      const label = routeShortLabel(r.leg.routeId);
      let catchHtml = "";
      if (r.boardTime) {
        const mins = Math.round((new Date(r.boardTime) - Date.now()) / 60000);
        const tight = mins <= 3;
        catchHtml = `<div class="leg-detail"><span class="catch ${tight ? "tight" : ""}">${mins <= 0 ? "Board now" : `Catch in ${mins} min`}</span> · departs ${clockTime(r.boardTime)}${r.headsign ? ` → ${r.headsign}` : ""}</div>`;
      } else {
        catchHtml = `<div class="leg-detail">${routeLongName(r.leg.routeId)}</div>`;
      }
      return `<div class="leg" style="--leg-color:${color}">
        <div class="leg-badge ${isWalk ? "walk" : ""}" style="--leg-color:${color}">${label}</div>
        <div class="leg-title">${r.leg.from} → ${r.leg.to}</div>
        ${catchHtml}
        <div class="transfer-note">${r.leg.stops.length - 1} stop${r.leg.stops.length - 1 === 1 ? "" : "s"} · ~${fmtDuration(r.ride)} · arrive ${clockTime(r.arriveTime)}</div>
      </div>`;
    }).join("");

    el.planResult.innerHTML = `
      <div class="journey-summary">
        <div class="journey-eta"><span class="big">${fmtDuration(totalMin)}</span>
          <span class="unit">total</span>
          <span class="live-tag ${live ? "" : "sched"}">${live ? "Live trains" : "Scheduled"}</span></div>
        <div class="journey-sub">${fromN} → ${toN}</div>
        <div class="journey-arrive">${transfers === 0 ? "Direct" : transfers + " transfer" + (transfers > 1 ? "s" : "")} · arrive ~${clockTime(arriveTime)}</div>
      </div>
      ${legsHtml}`;
  };

  const highlightJourneyOnMap = (rendered) => {
    journeyLayer.clearLayers();
    const allPts = [];
    rendered.forEach((r) => {
      const { color } = getRouteStyle(r.leg.routeId);
      const pts = r.leg.stops.map((n) => graph.get(n)?.location).filter(Boolean);
      allPts.push(...pts);
      if (pts.length >= 2) {
        L.polyline(pts, { color: "#000", weight: 10, opacity: 0.5, lineCap: "round" }).addTo(journeyLayer);
        L.polyline(pts, { color, weight: 6, opacity: 1, lineCap: "round" }).addTo(journeyLayer);
      }
      // endpoints
      [r.leg.stops[0], r.leg.stops[r.leg.stops.length - 1]].forEach((n) => {
        const loc = graph.get(n)?.location;
        if (loc) L.circleMarker(loc, { radius: 6, fillColor: "#fff", color, weight: 3, fillOpacity: 1 }).addTo(journeyLayer);
      });
    });
    if (allPts.length) map.flyToBounds(L.latLngBounds(allPts).pad(0.2), { animate: true, duration: 0.8 });
  };

  /* ============================================================
     SELECTION LOGIC
     ============================================================ */
  const selectRoute = (routeId, showInfo = true) => {
    if (selectedRouteId === routeId) { if (showInfo) showLineInfo(routeId); return; }
    deselectAll(true);
    selectedRouteId = routeId;
    const { color, type } = getRouteStyle(routeId);
    setLineVisibility();

    switchMainTab("lines");
    const activeTab = qs("#route-tabs .active");
    if (activeTab && activeTab.dataset.type !== type) {
      activeTab.classList.remove("active");
      const nt = qs(`#route-tabs [data-type="${type}"]`); if (nt) nt.classList.add("active");
      displayList(type);
    }
    qsa("#list-container .list-row").forEach((a) => a.classList.remove("active"));
    const li = qs(`#list-container .list-row[data-id='${CSS.escape(routeId)}']`);
    if (li) li.classList.add("active");

    allRouteLayers.forEach((layers, id) => {
      const sel = id === selectedRouteId;
      if (layers.shapes) { layers.shapes.eachLayer((l) => { if (l._isVisibleLine) l.setStyle({ weight: sel ? 6 : 3, opacity: sel ? 0.95 : 0.4 }); }); if (sel) layers.shapes.bringToFront(); }
    });
    // Brighten stations on the selected route; dim the rest (DOM divIcon opacity).
    const onRoute = new Set(routeStationOrder.get(routeId) || []);
    stationMarkers.forEach((m, name) => {
      if (m.setOpacity) m.setOpacity(onRoute.has(name) ? 1 : 0.35);
    });

    const selLayers = allRouteLayers.get(routeId);
    if (showInfo && selLayers?.shapes?.getLayers().length) map.flyToBounds(selLayers.shapes.getBounds().pad(0.1), { animate: true, duration: 0.75 });
    if (showInfo) showLineInfo(routeId);

    const rv = getVehiclesForSelection();
    plotVehicles(rv, allVehicleData.included);
    if (showInfo) updateLineInfoVehicleList(routeId, rv, allVehicleData.included);
    // Fetch fresh positions immediately so trains aren't static until the next
    // 30s server push (esp. in mock mode / on first select).
    refreshRouteVehiclesNow(routeId);
  };

  // Directly pull current vehicles for a route from the MBTA API and merge them
  // into allVehicleData so plotting reflects live positions without waiting.
  const refreshRouteVehiclesNow = async (routeId) => {
    try {
      const data = await mbtaApi.vehiclesForRoute(routeId);
      if (selectedRouteId !== routeId) return;
      const fresh = data.data || [];
      if (!fresh.length) return;
      const freshIds = new Set(fresh.map((v) => v.id));
      const others = allVehicleData.vehicles.filter((v) => v.relationships.route.data.id !== routeId || !freshIds.has(v.id));
      // replace this route's vehicles with fresh ones
      const kept = others.filter((v) => v.relationships.route.data.id !== routeId);
      allVehicleData = {
        vehicles: kept.concat(fresh),
        included: mergeIncluded(allVehicleData.included, data.included || []),
      };
      lastUpdateTime = Date.now();
      const rv = getVehiclesForSelection();
      plotVehicles(rv, allVehicleData.included);
      updateLineInfoVehicleList(routeId, rv, allVehicleData.included);
    } catch (e) { /* rate limit or offline — the socket feed still updates */ }
  };
  const mergeIncluded = (a = [], b = []) => {
    const m = new Map(a.map((i) => [`${i.type}:${i.id}`, i]));
    b.forEach((i) => m.set(`${i.type}:${i.id}`, i));
    return [...m.values()];
  };

  // Pull the whole network's live vehicles directly from the MBTA API so trains
  // are moving from the very first load (before/without the socket feed).
  let allVehFetchInFlight = false;
  const refreshAllVehiclesNow = async () => {
    if (allVehFetchInFlight) return;
    allVehFetchInFlight = true;
    try {
      const data = await mbtaApi.allVehicles();
      const fresh = data.data || [];
      if (fresh.length) {
        allVehicleData = { vehicles: fresh, included: mergeIncluded(allVehicleData.included, data.included || []) };
        lastUpdateTime = Date.now();
        if (!MOCK_MODE) setConn("online", "live · direct");
        const rv = getVehiclesForSelection();
        plotVehicles(rv, allVehicleData.included);
        if (selectedRouteId) updateLineInfoVehicleList(selectedRouteId, rv, allVehicleData.included);
        // Keep an open vehicle panel's status/next-stop current.
        if (selectedVehicleId && !el.vehicleInfo.classList.contains("hidden")) {
          const v = allVehicleData.vehicles.find((x) => x.id === selectedVehicleId);
          if (v) refreshVehiclePanelData(v);
        }
      }
    } catch (e) { /* rate limited/offline — socket feed still applies */ }
    finally { allVehFetchInFlight = false; }
  };

  const deselectAll = (soft = false) => {
    lastClickedShapeId = null;
    if (!soft || isDeveloperMode) qsa(".info-overlay").forEach((p) => p.classList.add("hidden"));
    if (soft) return;
    selectedRouteId = null; selectedVehicleId = null; _shellVehicleId = null;
    vehicleLayer.clearLayers(); interp.clear(); clearStationHighlights();
    qsa(".list-row").forEach((a) => a.classList.remove("active"));
    allRouteLayers.forEach((layers) => {
      if (layers.shapes) layers.shapes.eachLayer((l) => { if (l._isVisibleLine) l.setStyle({ weight: 3, opacity: 0.4 }); });
    });
    // Reset all stations to full opacity.
    stationMarkers.forEach((m) => m.setOpacity && m.setOpacity(1));
    setLineVisibility();
  };

  /* ============================================================
     UPDATE TIMER + TABS + EVENTS
     ============================================================ */
  const startUpdateTimer = () => {
    if (updateTimerInterval) clearInterval(updateTimerInterval);
    updateTimerInterval = setInterval(() => {
      el.updatePill.textContent = `Updated ${Math.round((Date.now() - lastUpdateTime) / 1000)}s ago`;
    }, 1000);
  };

  const switchMainTab = (name) => {
    qsa(".main-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    qsa(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  };
  el.mainTabs.addEventListener("click", (e) => { const t = e.target.closest(".main-tab"); if (t) switchMainTab(t.dataset.tab); });

  const onSearchOrTabChange = () => {
    const t = qs("#route-tabs .active"); if (t) displayList(t.dataset.type, el.searchInput.value);
  };

  el.devToggle.addEventListener("change", (e) => {
    isDeveloperMode = e.target.checked;
    const cur = selectedRouteId; deselectAll();
    allRouteLayers.forEach((layers, id) => { const info = routeInfoCache.get(id); if (info) drawRoute(id, info, true); });
    drawAllStations();
    onSearchOrTabChange(); if (cur) selectRoute(cur);
  });
  el.crrcToggle.addEventListener("change", (e) => {
    crrcOnly = e.target.checked;
    plotVehicles(getVehiclesForSelection(), allVehicleData.included);
    if (selectedRouteId) updateLineInfoVehicleList(selectedRouteId, getVehiclesForSelection(), allVehicleData.included);
  });
  el.showAllToggle.addEventListener("change", (e) => { showAllLines = e.target.checked; setLineVisibility(); });

  el.routeTabs.addEventListener("click", (e) => {
    if (!e.target.classList.contains("route-tab")) return;
    qs("#route-tabs .active")?.classList.remove("active");
    e.target.classList.add("active");
    const { color } = getRouteStyle(e.target.dataset.type === "Subway" ? "Blue" : e.target.dataset.type);
    e.target.style.setProperty("--active-tab-color", color);
    el.searchInput.value = ""; onSearchOrTabChange();
  });
  el.searchInput.addEventListener("input", onSearchOrTabChange);
  el.listContainer.addEventListener("click", (e) => {
    const a = e.target.closest(".list-row"); if (!a) return;
    e.preventDefault();
    if (a.dataset.type === "route") selectRoute(a.dataset.id); else showStationInfo(a.dataset.name);
  });

  qsa(".system-toggle").forEach((toggle) => toggle.addEventListener("change", function () {
    const system = this.dataset.system;
    if (selectedRouteId && getRouteType(selectedRouteId) === system && !this.checked) deselectAll();
    setLineVisibility(); onSearchOrTabChange();
  }));

  map.on("click", (e) => { if (e.originalEvent.target === map.getContainer()) deselectAll(); });

  getEl("settings-button").onclick = () => el.settingsModal.classList.remove("hidden");
  el.settingsModal.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-container") || e.target.closest(".close-button")) el.settingsModal.classList.add("hidden");
  });
  getEl("alerts-banner-btn").addEventListener("click", () => switchMainTab("alerts"));

  let resizeRaf = null;
  window.addEventListener("resize", () => { if (resizeRaf) cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => map.invalidateSize()); });
});

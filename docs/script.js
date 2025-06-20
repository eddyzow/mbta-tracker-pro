document.addEventListener("DOMContentLoaded", function () {
  // --- CONFIGURATION & STATE ---
  let routeDataCache, selectedVehicleId, selectedRouteId, lastClickedShapeId;
  let isDeveloperMode = false;
  let allVehicleData = { vehicles: [], included: [] };
  let lastUpdateTime = Date.now();
  let updateTimerInterval;

  // --- DOM REFERENCES ---
  const getEl = (id) => document.getElementById(id);
  const querySel = (sel) => document.querySelector(sel);

  const updateTimerDiv = getEl("update-timer");
  const listContainer = getEl("list-container");
  const vehicleInfoOverlay = getEl("vehicle-info-overlay");
  const lineInfoOverlay = getEl("line-info-overlay");
  const stationInfoOverlay = getEl("station-info-overlay");
  const aboutModal = getEl("about-modal");
  const searchInput = getEl("search-input");
  const routeTabs = getEl("route-tabs");
  const loadingRoutesEl = getEl("loading-routes");
  const noResultsFoundEl = getEl("no-results-found");
  const devModeToggle = getEl("dev-mode-toggle");
  const loadingOverlay = getEl("loading-overlay");

  // --- SOCKET.IO CONNECTION ---
  // Note: This assumes a local server is running on localhost:3000
  // to proxy requests and manage websockets. This will not work in a
  // static environment without that server.
  const socket = io("eddyzow.herokuapp.com", {
    transports: ["websocket"],
  });

  socket.on("connect", () => {
    console.log("Connected to server via Socket.IO");
    startUpdateTimer();
    // Request initial vehicle data. Route data is now sent automatically by the server.
    socket.emit("request-initial-data");
  });

  // Listen for the static route data from the server
  socket.on("mbta-route-data", (data) => {
    processRouteData(data);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected from server");
    if (updateTimerDiv) updateTimerDiv.textContent = "Offline";
    if (updateTimerInterval) clearInterval(updateTimerInterval);
  });

  socket.on("mbta-vehicle-update", (data) => {
    allVehicleData = data; // This can be { vehicles: [], included: [] }
    lastUpdateTime = Date.now();

    // Determine which vehicles to plot.
    // If a route is selected, show only those vehicles.
    // Otherwise, show an empty array so the map is clear on load.
    const vehiclesToPlot = selectedRouteId
      ? allVehicleData.vehicles.filter(
          (v) => v.relationships.route.data.id === selectedRouteId
        )
      : [];

    // Always re-plot vehicles on an update. This will clear the layer
    // and draw the new set, even if that new set is empty.
    plotVehicles(vehiclesToPlot, allVehicleData.included);

    // Only update the line info panel if it's currently relevant.
    if (selectedRouteId) {
      updateLineInfoVehicleList(
        selectedRouteId,
        vehiclesToPlot,
        allVehicleData.included
      );
    }
  });

  // Caching maps
  const routeInfoCache = new Map();
  const stationToRoutesMap = new Map();
  const allRouteLayers = new Map();

  // --- MAP INITIALIZATION ---
  const map = L.map("map", { preferCanvas: true, zoomControl: false }).setView(
    [42.3601, -71.0589],
    12
  );
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
  }).addTo(map);

  const vehicleLayer = L.layerGroup().addTo(map);

  // --- UTILITY & HELPER FUNCTIONS ---
  const handleApiError = async (response) => {
    if (!response.ok) {
      const error = new Error(`API Error: ${response.statusText}`);
      try {
        error.data = await response.json();
      } catch (e) {}
      throw error;
    }
    return response.json();
  };

  const handleFetchError = (error) => {
    console.error("Fetch Error:", error);
    if (loadingRoutesEl) loadingRoutesEl.classList.add("hidden");
    listContainer.innerHTML = `<p class="text-center text-red-500 p-4">Failed to load data. Please check your connection and API key.</p>`;
  };

  /**
   * Defines the missing formatRelativeTime function.
   * Converts an ISO date string to a human-readable relative time.
   * @param {string} isoString - The ISO 8601 date string to convert.
   * @returns {string} A string like "just now", "5m ago", etc.
   */
  const formatRelativeTime = (isoString) => {
    if (!isoString) return "N/A";
    const now = new Date();
    const past = new Date(isoString);
    const secondsPast = Math.round((now.getTime() - past.getTime()) / 1000);

    if (secondsPast < 5) {
      return "just now";
    }
    if (secondsPast < 60) {
      return `${secondsPast}s ago`;
    }
    const minutesPast = Math.floor(secondsPast / 60);
    if (minutesPast < 60) {
      return `${minutesPast}m ago`;
    }
    const hoursPast = Math.floor(minutesPast / 60);
    if (hoursPast < 24) {
      return `${hoursPast}h ago`;
    }
    const daysPast = Math.floor(hoursPast / 24);
    return `${daysPast}d ago`;
  };

  const formatArrivalTime = (time) => {
    if (!time) return "N/A";
    const date = new Date(time);
    const now = new Date();
    const diffMinutes = Math.round((date - now) / 60000);

    if (diffMinutes < 1) return "Arriving";
    if (diffMinutes === 1) return "1 min";
    return `${diffMinutes} min`;
  };

  const getRouteStyle = (routeId) => {
    const styles = {
      Red: "#DA291C",
      Mattapan: "#DA291C",
      Orange: "#ED8B00",
      Blue: "#003DA5",
      "Green-": "#00843D",
      "CR-": "#80276C",
      "Boat-": "#008EAA",
      Ferry: "#008EAA",
    };
    if (!routeId) return { color: "#80276C", type: "Other" };
    const key = Object.keys(styles).find((k) => routeId.startsWith(k)) || "CR-";
    return { color: styles[key], type: getRouteType(routeId) };
  };

  const getRouteType = (routeIdOrType) => {
    if (typeof routeIdOrType !== "string" && typeof routeIdOrType !== "number")
      return "Other";
    const route = routeDataCache?.find((r) => r.id === routeIdOrType);
    const typeNumber =
      typeof routeIdOrType === "number"
        ? routeIdOrType
        : route?.attributes.type;
    if (typeNumber === 0 || typeNumber === 1) return "Subway";
    if (typeNumber === 2) return "Commuter Rail";
    if (typeNumber === 4) return "Ferry";
    return "Other";
  };

  const decodePolyline = (t) => {
    let points = [],
      index = 0,
      len = t.length,
      lat = 0,
      lng = 0;
    while (index < len) {
      let b,
        shift = 0,
        result = 0;
      do {
        b = t.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      let dlat = result & 1 ? ~(result >> 1) : result >> 1;
      lat += dlat;
      shift = 0;
      result = 0;
      do {
        b = t.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      let dlng = result & 1 ? ~(result >> 1) : result >> 1;
      lng += dlng;
      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  };

  // --- DATA & API FUNCTIONS ---
  const processRouteData = (data) => {
    routeDataCache = data;
    data.forEach((route) => {
      // Populate routeInfoCache
      const routeInfo = {
        stops: route.stops || [],
        shapes: route.shapes || [],
      };
      routeInfoCache.set(route.id, routeInfo);

      // Populate stationToRoutesMap
      if (route.stops) {
        route.stops.forEach((stop) => {
          const { name, latitude, longitude } = stop.attributes;
          const existing = stationToRoutesMap.get(name) || {
            routes: new Set(),
            id: stop.id,
            location: L.latLng(latitude, longitude),
          };
          existing.routes.add(route.id);
          stationToRoutesMap.set(name, existing);
        });
      }

      // Draw the route on the map
      drawRoute(route.id, routeInfo, true);
    });

    // Display the initial list and hide the loading overlay
    displayList("Subway");
    if (loadingOverlay) loadingOverlay.classList.add("hidden");
  };

  // --- UI & PLOTTING ---
  const displayList = (activeType, searchTerm = "") => {
    if (!routeDataCache) return;
    listContainer.innerHTML = "";
    if (noResultsFoundEl) noResultsFoundEl.classList.add("hidden");

    const systemVisibleToggle = querySel(
      `.system-toggle[data-system="${activeType}"]`
    );
    if (!systemVisibleToggle || !systemVisibleToggle.checked) {
      listContainer.innerHTML = `<p class="text-center text-gray-500 p-4">Enable the "${activeType}" system view.</p>`;
      return;
    }

    const lowerSearchTerm = searchTerm.toLowerCase();
    let results = [];

    routeDataCache.forEach((r) => {
      const name = isDeveloperMode ? r.id : r.attributes.long_name;
      const searchName = isDeveloperMode
        ? r.id.toLowerCase()
        : r.attributes.long_name.toLowerCase();
      if (
        getRouteType(r.id) === activeType &&
        searchName.includes(lowerSearchTerm)
      ) {
        results.push({ type: "route", id: r.id, name: name });
      }
    });

    if (searchTerm.length > 1) {
      stationToRoutesMap.forEach((data, name) => {
        const searchName = isDeveloperMode
          ? data.id.toLowerCase()
          : name.toLowerCase();
        const displayName = isDeveloperMode ? data.id : name;
        if (
          searchName.includes(lowerSearchTerm) &&
          Array.from(data.routes).some(
            (rId) => getRouteType(rId) === activeType
          )
        ) {
          results.push({
            type: "station",
            id: data.id,
            name: displayName,
            originalName: name,
            location: data.location,
          });
        }
      });
    }

    if (results.length === 0) {
      if (noResultsFoundEl) noResultsFoundEl.classList.remove("hidden");
      return;
    }

    const list = document.createElement("ul");
    list.className = "space-y-1";
    results.forEach((item) => {
      const itemRoutes = stationToRoutesMap.get(
        item.originalName || item.name
      )?.routes;
      const firstRouteId =
        item.type === "route"
          ? item.id
          : itemRoutes
          ? Array.from(itemRoutes)[0]
          : "";
      const { color } = getRouteStyle(firstRouteId);

      const li = document.createElement("li");
      li.className = "list-item";
      const a = document.createElement("a");
      a.href = "#";
      a.className = "block w-full text-left p-2 rounded-md transition-all";
      a.dataset.id = item.id;
      a.dataset.type = item.type;
      a.dataset.name = item.originalName || item.name;
      a.textContent = item.name;

      if (item.type === "route" && item.id === selectedRouteId) {
        a.classList.add("active");
        a.style.backgroundColor = `${color}20`;
        a.style.color = color;
      }
      li.appendChild(a);
      list.appendChild(li);
    });
    listContainer.appendChild(list);
  };

  const drawRoute = (routeId, { stops, shapes }, isInactive) => {
    const layerGroup = allRouteLayers.get(routeId) || {
      shapes: L.featureGroup(),
      stops: L.featureGroup(),
    };
    Object.values(layerGroup).forEach((lg) => lg.clearLayers().addTo(map));
    allRouteLayers.set(routeId, layerGroup);

    const { color, type } = getRouteStyle(routeId);
    const style = {
      color,
      weight: isInactive ? 3 : 7,
      opacity: isInactive ? 0.35 : 0.9,
      lineCap: "round",
      lineJoin: "round",
    };

    if (!stops || !shapes || shapes.length === 0) return;

    let finalShapes = shapes;
    if (type === "Subway" || type === "Commuter Rail") {
      const canonicalShapes = shapes.filter((s) =>
        s.id?.startsWith("canonical")
      );
      if (canonicalShapes.length > 0) {
        finalShapes = canonicalShapes;
      }
    }

    finalShapes.forEach((shape, index) => {
      if (!shape || !shape.attributes.polyline) return;
      const polyline = L.polyline(decodePolyline(shape.attributes.polyline), {
        ...style,
        offset: (index - (finalShapes.length - 1) / 2) * (isInactive ? 2 : 4),
      });

      const routeName =
        routeDataCache.find((r) => r.id === routeId)?.attributes.long_name ||
        routeId;
      let tooltipContent = isDeveloperMode
        ? `Route: ${routeId}<br>Shape: ${shape.id}`
        : routeName;
      polyline.bindTooltip(tooltipContent, {
        className: "line-label-tooltip",
        sticky: true,
      });

      polyline.on("click", (e) => {
        L.DomEvent.stop(e);
        lastClickedShapeId = shape.id;
        selectRoute(routeId);
      });
      layerGroup.shapes.addLayer(polyline);
    });

    const drawnStations = new Set();
    stops.forEach((stop) => {
      const { name, latitude, longitude } = stop.attributes;
      if (drawnStations.has(name) || !latitude || !longitude) return;

      const isMajorStation =
        name.includes("North Station") || name.includes("South Station");
      const servicingRoutesData = stationToRoutesMap.get(name);
      const isTransfer =
        servicingRoutesData && servicingRoutesData.routes.size > 1;
      const displayName = isDeveloperMode ? stop.id : name;

      let marker;
      if (isMajorStation) {
        marker = L.marker([latitude, longitude], {
          icon: L.divIcon({
            className: "major-station-icon",
            html: "✪",
            iconSize: [24, 24],
          }),
        });
      } else {
        marker = L.circleMarker([latitude, longitude], {
          radius: isInactive ? 4 : isTransfer ? 7 : 5,
          fillColor: isInactive ? "#fff" : isTransfer ? "#fff" : color,
          color: color,
          weight: isTransfer ? 3 : 2,
          opacity: style.opacity,
          fillOpacity: style.opacity,
        });
      }

      marker.on("click", (e) => {
        L.DomEvent.stop(e);
        showStationInfo(name);
      });

      marker
        .bindTooltip(displayName, {
          className: "station-label-tooltip",
          direction: "top",
          offset: [0, -5],
        })
        .addTo(layerGroup.stops);
      drawnStations.add(name);
    });

    layerGroup.stops.bringToFront();
  };

  const plotVehicles = (vehicles, includedData) => {
    vehicleLayer.clearLayers();
    if (!vehicles) return;
    const lookup = new Map(
      includedData?.map((item) => [item.id, item.attributes])
    );

    vehicles.forEach((vehicle) => {
      const { latitude, longitude, label, bearing } = vehicle.attributes;
      const routeId = vehicle.relationships.route.data.id;
      const { color, type } = getRouteStyle(routeId);
      const isActive = vehicle.id === selectedVehicleId;
      const vehicleSVG = `<svg class="vehicle-icon-svg ${
        isActive ? "active" : ""
      }" style="--bearing: ${
        bearing || 0
      }deg" width="24" height="24" viewBox="0 0 32 32"><path fill="${color}" d="M16 2 L2 25 L16 19 L30 25 z"/></svg>`;
      const vehicleIcon = L.divIcon({
        className: "",
        html: vehicleSVG,
        iconSize: [24, 24],
      });
      const marker = L.marker([latitude, longitude], {
        icon: vehicleIcon,
        zIndexOffset: 1000,
        vehicleData: vehicle,
        includedData: lookup,
      });

      const tooltipText = isDeveloperMode
        ? vehicle.id
        : `Train ${label || vehicle.id}`;
      const tooltipOptions = {
        className: "station-label-tooltip",
        permanent: type === "Commuter Rail",
        direction: "right",
        offset: [12, 0],
      };
      if (type === "Commuter Rail")
        tooltipOptions.className += " cr-vehicle-tooltip";

      marker.bindTooltip(tooltipText, tooltipOptions);

      marker.on("click", (e) => {
        L.DomEvent.stop(e);
        displayVehicleDetails(e.target);
      });
      marker.addTo(vehicleLayer);
    });
  };

  const displayVehicleDetails = (marker) => {
    [lineInfoOverlay, stationInfoOverlay].forEach((o) =>
      o.classList.add("hidden")
    );

    const { vehicleData, includedData } = marker.options;
    selectedVehicleId = vehicleData.id;

    const { label, current_status, updated_at } = vehicleData.attributes;
    const stopId = vehicleData.relationships.stop.data?.id;
    const tripId = vehicleData.relationships.trip.data?.id;
    const nextStopName = includedData.get(stopId)?.name || "N/A";
    const trip = includedData.get(tripId);
    const direction =
      trip &&
      routeDataCache.find((r) => r.id === selectedRouteId)?.attributes
        .direction_names[trip.direction_id]
        ? routeDataCache.find((r) => r.id === selectedRouteId)?.attributes
            .direction_names[trip.direction_id]
        : "N/A";

    const headerText = isDeveloperMode
      ? vehicleData.id
      : `Vehicle ${label || "Details"}`;
    const content = `
            <button class="close-button">&times;</button>
            <h4 class="info-header">${headerText}</h4>
            <div class="info-content">
                <div class="info-row"><span class="info-label">Status</span><span class="capitalize">${current_status.replace(
                  /_/g,
                  " "
                )}</span></div>
                <div class="info-row"><span class="info-label">Direction</span><span>${direction}</span></div>
                <div class="info-row"><span class="info-label">Next Stop</span><span class="text-right">${nextStopName}</span></div>
                <div class="info-row"><span class="info-label">Updated</span><span class="text-right">${formatRelativeTime(
                  updated_at
                )}</span></div>
            </div>`;

    vehicleInfoOverlay.innerHTML = content;
    vehicleInfoOverlay.classList.remove("hidden");
    vehicleInfoOverlay.querySelector(".close-button").onclick = () => {
      selectedVehicleId = null;
      vehicleInfoOverlay.classList.add("hidden");
      const routeVehicles = allVehicleData.vehicles.filter(
        (v) => v.relationships.route.data.id === selectedRouteId
      );
      plotVehicles(routeVehicles, allVehicleData.included);
    };

    const routeVehicles = allVehicleData.vehicles.filter(
      (v) => v.relationships.route.data.id === selectedRouteId
    );
    plotVehicles(routeVehicles, allVehicleData.included);
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 15));
  };

  // --- INFO PANELS ---
  const showInfoPanel = (panel, title, content, onClose = () => {}) => {
    document
      .querySelectorAll(".info-overlay")
      .forEach((p) => p.classList.add("hidden"));
    const html = `<button class="close-button">&times;</button><h4 class="info-header">${title}</h4><div class="info-content">${content}</div>`;
    panel.innerHTML = html;
    panel.classList.remove("hidden");
    panel.querySelector(".close-button").onclick = () => {
      panel.classList.add("hidden");
      onClose();
    };
  };

  const showStationInfo = (stationName, shouldSelectLine = true) => {
    if (shouldSelectLine) {
      const servicingData = stationToRoutesMap.get(stationName);
      if (servicingData && servicingData.routes.size > 0) {
        const primaryRoute =
          Array.from(servicingData.routes).find((r) => !r.startsWith("CR-")) ||
          Array.from(servicingData.routes)[0];
        const routeType = getRouteType(primaryRoute);
        const systemVisible = querySel(
          `.system-toggle[data-system="${routeType}"]`
        ).checked;
        if (systemVisible) {
          selectRoute(primaryRoute, false);
        } else {
          deselectAll();
        }
      }
    }

    const servicingData = stationToRoutesMap.get(stationName);
    if (!servicingData) return;

    const title = isDeveloperMode ? servicingData.id : stationName;
    const routeListHtml = Array.from(servicingData.routes)
      .map((routeId) => {
        const { color } = getRouteStyle(routeId);
        const name = isDeveloperMode
          ? routeId
          : routeDataCache.find((r) => r.id === routeId)?.attributes
              .long_name || routeId;
        return `<div class="flex items-center p-1"><span class="w-3 h-3 rounded-full mr-3" style="background-color: ${color}"></span>${name}</div>`;
      })
      .join("");

    const content = `
            <div class="space-y-1">${routeListHtml}</div>
            <div class="mt-3">
                <h5 class="font-bold text-sm">Upcoming Arrivals</h5>
                <div id="prediction-list" class="mt-1 text-xs">Loading...</div>
            </div>`;

    showInfoPanel(stationInfoOverlay, title, content, () => deselectAll());
    fetchAndDisplayPredictions(servicingData.id);

    if (servicingData.location) {
      map.flyTo(servicingData.location, Math.max(map.getZoom(), 16), {
        animate: true,
        duration: 0.5,
      });
    }
  };

  const fetchAndDisplayPredictions = async (stationId) => {
    const predictionListEl = getEl("prediction-list");
    if (!predictionListEl) return;

    // Listen for the prediction data for this specific station
    socket.once(`prediction-data-${stationId}`, (predictionData) => {
      const lookup = new Map(
        predictionData.included?.map((item) => [item.id, item]) || []
      );
      const predictionsByDirection = {};

      predictionData.data.forEach((prediction) => {
        const tripId = prediction.relationships.trip.data?.id;
        const trip = lookup.get(tripId);
        if (!trip || !trip.attributes.headsign) {
          return;
        }

        const arrivalTime =
          prediction.attributes.arrival_time ||
          prediction.attributes.departure_time;

        const directionId = trip.attributes.direction_id;
        const destination = trip.attributes.headsign;
        const routeId = prediction.relationships.route.data?.id;
        if (!routeId) return;

        const { color } = getRouteStyle(routeId);

        const key = `${destination}-${directionId}`;
        if (!predictionsByDirection[key]) {
          predictionsByDirection[key] = {
            destination: destination,
            color: color,
            arrivals: [],
          };
        }

        if (arrivalTime) {
          predictionsByDirection[key].arrivals.push(
            formatArrivalTime(arrivalTime)
          );
        }
      });

      const validGroups = Object.values(predictionsByDirection).filter(
        (group) => group.arrivals.length > 0
      );

      if (validGroups.length === 0) {
        predictionListEl.innerHTML = "No upcoming arrivals.";
        return;
      }

      let html = '<ul class="space-y-2">';
      validGroups.forEach((group) => {
        html += `
                        <li class="border-b pb-1">
                            <div class="font-bold flex items-center">
                                <span class="w-3 h-3 rounded-full mr-2" style="background-color: ${
                                  group.color
                                }"></span>
                                To: ${group.destination}
                            </div>
                            <div class="pl-5 text-gray-700">${group.arrivals.join(
                              ", "
                            )}</div>
                        </li>
                    `;
      });
      html += "</ul>";
      predictionListEl.innerHTML = html;
    });

    // Request the prediction data from the server
    socket.emit("request-predictions", stationId);
  };

  const showLineInfo = (routeId) => {
    const route = routeDataCache.find((r) => r.id === routeId);
    if (!route) return;
    const { type, color } = getRouteStyle(routeId);
    const routeInfo = routeInfoCache.get(routeId);

    let devContent = "";
    if (isDeveloperMode) {
      const shapeNames = routeInfo.shapes.map((s) => s.id).join("<br>");
      const clickedShapeInfo = lastClickedShapeId
        ? `<div class="mt-1"><strong>Clicked Shape:</strong> ${lastClickedShapeId}</div>`
        : "";
      devContent = `<div class="mt-2 text-xs text-gray-400 p-1 bg-gray-50 rounded"><strong>Loaded Shapes:</strong><br>${
        shapeNames || "None"
      }${clickedShapeInfo}</div>`;
    }

    const destinations = route.attributes.direction_destinations;
    const stationList = routeInfo.stops
      .map((stop, index) => {
        const stationName = isDeveloperMode ? stop.id : stop.attributes.name;
        let transferIcons = "";

        const transferRoutes = stationToRoutesMap.get(
          stop.attributes.name
        )?.routes;
        if (transferRoutes && transferRoutes.size > 1) {
          const transferTypes = new Map();
          transferRoutes.forEach((transferRouteId) => {
            if (transferRouteId === routeId) return;
            const style = getRouteStyle(transferRouteId);
            const key =
              style.type === "Commuter Rail"
                ? "CR"
                : style.type === "Subway" && style.color === "#00843D"
                ? "Green"
                : style.color;
            if (!transferTypes.has(key)) {
              transferTypes.set(key, style.color);
            }
          });

          transferIcons = `<span class="flex items-center ml-auto">${Array.from(
            transferTypes.values()
          )
            .map(
              (c) =>
                `<span class="w-2 h-2 rounded-full ml-1" style="background-color: ${c}"></span>`
            )
            .join("")}</span>`;
        }

        let terminusInfo = "";
        if (index === 0 && destinations[0])
          terminusInfo = `<span class="text-gray-400 text-xs ml-1">(to ${destinations[0]})</span>`;
        if (index === routeInfo.stops.length - 1 && destinations[1])
          terminusInfo = `<span class="text-gray-400 text-xs ml-1">(to ${destinations[1]})</span>`;

        return `<li class="p-1.5 border-b flex items-center">${stationName}${terminusInfo}${transferIcons}</li>`;
      })
      .join("");

    const content = `
            <p class="text-sm text-gray-600">${route.attributes.description} (${type})</p>
            <div class="mt-3">
                <h5 class="font-bold text-sm">Active Vehicles</h5>
                <div id="vehicle-list-container" class="mt-1 text-xs text-gray-500 max-h-48 overflow-y-auto">Loading...</div>
            </div>
            <div class="mt-3">
                 <h5 class="font-bold text-sm">Stations</h5>
                 <ul id="station-list-container" class="mt-1 text-xs text-gray-500 max-h-48 overflow-y-auto">${stationList}</ul>
            </div>
            ${devContent} 
        `;
    const title = isDeveloperMode ? route.id : route.attributes.long_name;
    showInfoPanel(lineInfoOverlay, title, content, deselectAll);
    const header = lineInfoOverlay.querySelector(".info-header");
    if (header) header.style.color = color;
  };

  const updateLineInfoVehicleList = (routeId, vehicles, includedData) => {
    if (
      routeId !== selectedRouteId ||
      lineInfoOverlay.classList.contains("hidden")
    )
      return;

    const container = getEl("vehicle-list-container");
    if (!container) return;

    if (!vehicles || vehicles.length === 0) {
      container.innerHTML = `No active vehicles found.`;
      return;
    }

    const lookup = new Map(
      includedData?.map((item) => [item.id, item.attributes])
    );
    const listHtml = vehicles
      .map((vehicle) => {
        const { label, current_status } = vehicle.attributes;
        const stopId = vehicle.relationships.stop.data?.id;
        const nextStopName = lookup.get(stopId)?.name || "N/A";
        const displayName = isDeveloperMode
          ? vehicle.id
          : `Train ${label || vehicle.id}`;
        return `
                <li class="p-2 hover:bg-gray-100 rounded-md cursor-pointer border-b" data-vehicle-id="${
                  vehicle.id
                }">
                    <div class="font-bold">${displayName}</div>
                    <div class="text-gray-600 text-xs">Status: <span class="capitalize">${current_status.replace(
                      /_/g,
                      " "
                    )}</span></div>
                    <div class="text-gray-600 text-xs">Next Stop: ${nextStopName}</div>
                </li>
            `;
      })
      .join("");

    container.innerHTML = `<ul class="space-y-1">${listHtml}</ul>`;

    container.querySelectorAll("li").forEach((item) => {
      item.addEventListener("click", () => {
        const vehicleId = item.dataset.vehicleId;
        const marker = vehicleLayer
          .getLayers()
          .find((l) => l.options.vehicleData?.id === vehicleId);
        if (marker) {
          map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 16), {
            animate: true,
            duration: 0.5,
          });
          selectedVehicleId = vehicleId;
          plotVehicles(vehicles, includedData);
        }
      });
    });
  };

  // --- SELECTION & STATE LOGIC ---
  const selectRoute = (routeId, shouldShowInfo = true) => {
    if (selectedRouteId === routeId) {
      if (shouldShowInfo) showLineInfo(routeId);
      return;
    }

    deselectAll(true);
    selectedRouteId = routeId;

    const { color, type } = getRouteStyle(routeId);

    const activeTab = querySel("#route-tabs .active");
    if (activeTab && activeTab.dataset.type !== type) {
      activeTab.classList.remove("active");
      const newTab = querySel(`#route-tabs [data-type="${type}"]`);
      if (newTab) newTab.classList.add("active");
      displayList(type);
    }

    document.querySelectorAll("#list-container a").forEach((a) => {
      a.classList.remove("active");
      a.style.backgroundColor = "";
      a.style.color = "";
    });
    const listItem = querySel(`#list-container a[data-id='${routeId}']`);
    if (listItem) {
      listItem.classList.add("active");
      listItem.style.backgroundColor = color + "20";
      listItem.style.color = color;
    }

    allRouteLayers.forEach((layers, id) => {
      const isSelected = id === selectedRouteId;
      const style = {
        weight: isSelected ? 7 : 3,
        opacity: isSelected ? 0.9 : 0.35,
      };
      if (layers.shapes) {
        layers.shapes.eachLayer((l) => l.setStyle(style));
        if (isSelected) layers.shapes.bringToFront();
      }
      if (layers.stops) {
        layers.stops.eachLayer((l) => {
          if (l.setStyle)
            l.setStyle({
              radius: isSelected ? (l.options.weight > 2 ? 7 : 5) : 4,
              opacity: isSelected ? 1 : 0.5,
              fillOpacity: isSelected ? 1 : 0.5,
            });
        });
        if (isSelected) layers.stops.bringToFront();
      }
    });

    const selectedLayers = allRouteLayers.get(routeId);
    if (
      shouldShowInfo &&
      selectedLayers &&
      selectedLayers.shapes &&
      typeof selectedLayers.shapes.getBounds === "function" &&
      selectedLayers.shapes.getLayers().length > 0
    ) {
      map.flyToBounds(selectedLayers.shapes.getBounds().pad(0.1), {
        animate: true,
        duration: 0.75,
      });
    }

    if (shouldShowInfo) {
      showLineInfo(routeId);
    }

    const routeVehicles = allVehicleData.vehicles.filter(
      (v) => v.relationships.route.data.id === routeId
    );
    plotVehicles(routeVehicles, allVehicleData.included);
    if (shouldShowInfo) {
      updateLineInfoVehicleList(
        routeId,
        routeVehicles,
        allVehicleData.included
      );
    }
  };

  const deselectAll = (soft = false) => {
    lastClickedShapeId = null;
    if (!soft || isDeveloperMode) {
      document
        .querySelectorAll(".info-overlay")
        .forEach((p) => p.classList.add("hidden"));
    }

    if (soft) return;

    selectedRouteId = null;
    selectedVehicleId = null;
    vehicleLayer.clearLayers();

    document.querySelectorAll(".list-item a").forEach((a) => {
      a.classList.remove("active");
      a.style.backgroundColor = "";
      a.style.color = "";
    });

    allRouteLayers.forEach((layers) => {
      const style = { weight: 3, opacity: 0.35 };
      if (layers.shapes) layers.shapes.eachLayer((l) => l.setStyle(style));
      if (layers.stops) {
        layers.stops.eachLayer((l) => {
          if (l.setStyle)
            l.setStyle({ radius: 4, opacity: 0.5, fillOpacity: 0.5 });
        });
      }
    });
  };

  // --- LIVE UPDATES ---
  const startUpdateTimer = () => {
    if (updateTimerInterval) clearInterval(updateTimerInterval);
    updateTimerInterval = setInterval(() => {
      const secondsAgo = Math.round((Date.now() - lastUpdateTime) / 1000);
      if (updateTimerDiv)
        updateTimerDiv.textContent = `Updated ${secondsAgo}s ago`;
    }, 1000);
  };

  // --- EVENT LISTENERS ---
  const onSearchOrTabChange = () => {
    const activeTab = querySel("#route-tabs .active");
    if (activeTab) {
      const activeType = activeTab.dataset.type;
      displayList(activeType, searchInput.value);
    }
  };

  if (devModeToggle) {
    devModeToggle.addEventListener("change", (e) => {
      isDeveloperMode = e.target.checked;
      const currentSelected = selectedRouteId;
      deselectAll();
      allRouteLayers.forEach((layers, routeId) => {
        const info = routeInfoCache.get(routeId);
        if (info) drawRoute(routeId, info, true);
      });
      onSearchOrTabChange();
      if (currentSelected) {
        selectRoute(currentSelected);
      }
    });
  }

  if (routeTabs) {
    routeTabs.addEventListener("click", (e) => {
      if (e.target.classList.contains("route-tab")) {
        const activeTab = routeTabs.querySelector(".active");
        if (activeTab) activeTab.classList.remove("active");
        e.target.classList.add("active");
        const type = e.target.dataset.type;
        const { color } = getRouteStyle(type === "Subway" ? "Blue" : type);
        document
          .querySelectorAll(".route-tab")
          .forEach((t) => (t.style.borderColor = "transparent"));
        e.target.style.setProperty("--active-tab-color", color);
        searchInput.value = "";
        onSearchOrTabChange();
      }
    });
  }

  if (searchInput) searchInput.addEventListener("input", onSearchOrTabChange);

  if (listContainer) {
    listContainer.addEventListener("click", (e) => {
      const anchor = e.target.closest("a");
      if (anchor) {
        e.preventDefault();
        const { type, id, name } = anchor.dataset;
        if (type === "route") {
          selectRoute(id);
        } else if (type === "station") {
          showStationInfo(name);
        }
      }
    });
  }

  document.querySelectorAll(".system-toggle").forEach((toggle) => {
    toggle.addEventListener("change", function () {
      const system = this.dataset.system;
      const isVisible = this.checked;

      if (
        selectedRouteId &&
        getRouteType(selectedRouteId).type === system &&
        !isVisible
      ) {
        deselectAll();
      }

      if (routeDataCache) {
        routeDataCache.forEach((route) => {
          if (getRouteType(route.id) === system) {
            const layers = allRouteLayers.get(route.id);
            if (layers) {
              Object.values(layers).forEach((layerGroup) => {
                isVisible
                  ? map.addLayer(layerGroup)
                  : map.removeLayer(layerGroup);
              });
            }
          }
        });
      }
      onSearchOrTabChange();
    });
  });

  map.on("click", (e) => {
    if (e.originalEvent.target === map.getContainer()) {
      deselectAll();
    }
  });

  const aboutButton = getEl("about-button");
  if (aboutButton) {
    aboutButton.onclick = () => {
      aboutModal.classList.remove("hidden");
    };
  }

  if (aboutModal) {
    aboutModal.addEventListener("click", (e) => {
      if (
        e.target.classList.contains("modal-container") ||
        e.target.closest(".close-button") ||
        e.target.closest(".modal-close-button")
      ) {
        aboutModal.classList.add("hidden");
      }
    });
  }
});

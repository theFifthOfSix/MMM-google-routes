/*
 * MMM-google-route.js
 * Routes API migration for the MagicMirror MMM-google-route module.
 *
 * Keeps the original module name/configuration shape where practical.
 * The legacy `directionsRequest` object is translated into a Routes API
 * ComputeRoutes request. See the notes following this file for differences.
 */

Module.register("MMM-google-route", {
  defaults: {
    key: "api_key",
    height: "300px",
    width: "300px",
    title: "",
    refreshPeriod: 10,
    minimumRefreshPeriod: 0,
    showAge: true,
    showMap: true,
    mapOptions: {},
    language: "en",
    directionsRequest: {},
    fontSize: undefined,
    listen: []
  },

  state: {
    refreshTimer: undefined,
    lastRefresh: undefined,
    ageTimer: undefined,
    overrideDestination: undefined,
    initialized: false
  },

  getDirections: function () {},

  getScripts: function () {
    return [this.file("map-styles.js")];
  },

  getDom: function () {
    const self = this;
    const main = document.createElement("div");
    main.style.width = this.config.width;

    const title = document.createElement("div");
    title.id = "title";
    title.style.width = "100%";
    title.style.fontSize = this.config.fontSize || "";
    title.textContent = this.config.title || "";
    main.appendChild(title);

    const mapElement = document.createElement("div");
    mapElement.id = "map";
    mapElement.style.height = this.config.height;
    mapElement.style.width = "100%";
    mapElement.style.display = this.config.showMap ? "block" : "none";
    if (this.config.showMap) main.appendChild(mapElement);

    const info = document.createElement("div");
    info.style.width = "100%";
    const infoTable = document.createElement("table");
    infoTable.id = "info";
    infoTable.style.width = "100%";
    info.appendChild(infoTable);
    main.appendChild(info);

    const age = document.createElement("div");
    age.style.width = "100%";
    age.style.fontSize = this.config.fontSize || "";
    age.style.textAlign = "right";
    age.classList.add("small", "dimmed");
    if (this.config.showAge) main.appendChild(age);

    function clearInfo() {
      while (infoTable.firstChild) infoTable.removeChild(infoTable.firstChild);
    }

    function addError(message) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.classList.add("small");
      cell.textContent = message;
      row.appendChild(cell);
      infoTable.appendChild(row);
    }

    function addCell(row, className, value) {
      const cell = document.createElement("td");
      if (className) cell.classList.add(className);
      const span = document.createElement("span");
      span.style.fontSize = self.config.fontSize || "";
      span.textContent = value || "";
      cell.appendChild(span);
      row.appendChild(cell);
    }

    // Decode Google's encoded-polyline format without requiring the geometry library.
    function decodePolyline(encoded) {
      const points = [];
      let index = 0;
      let latitude = 0;
      let longitude = 0;

      while (index < encoded.length) {
        let result = 0;
        let shift = 0;
        let byte;
        do {
          byte = encoded.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20 && index < encoded.length);
        latitude += (result & 1) ? ~(result >> 1) : (result >> 1);

        result = 0;
        shift = 0;
        do {
          byte = encoded.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20 && index < encoded.length);
        longitude += (result & 1) ? ~(result >> 1) : (result >> 1);

        points.push({ lat: latitude / 1e5, lng: longitude / 1e5 });
      }
      return points;
    }

    function clearRouteLines() {
      (self._routeLines || []).forEach((line) => line.setMap(null));
      self._routeLines = [];
    }

    function drawRoutes(routes) {
      if (!self.config.showMap || !self._map) return;
      clearRouteLines();
      const bounds = new google.maps.LatLngBounds();

      routes.slice(0, 2).forEach((route, index) => {
        const encoded = route.polyline && route.polyline.encodedPolyline;
        if (!encoded) return;
        const path = decodePolyline(encoded).map((point) => {
          const latLng = new google.maps.LatLng(point.lat, point.lng);
          bounds.extend(latLng);
          return latLng;
        });
        const line = new google.maps.Polyline({
          path: path,
          geodesic: true,
          strokeColor: index === 0 ? "#ffffff" : "#aaaaaa",
          strokeOpacity: 1,
          strokeWeight: index === 0 ? 7 : 5,
          map: self._map,
          zIndex: index === 0 ? 2 : 1
        });
        self._routeLines.push(line);
      });

      if (!bounds.isEmpty()) self._map.fitBounds(bounds);
    }

    function formatDistance(meters, units) {
      if (meters === undefined || meters === null) return "";
      if (units === "IMPERIAL") {
        const miles = meters / 1609.344;
        return miles < 10 ? miles.toFixed(1) + " mi" : Math.round(miles) + " mi";
      }
      const km = meters / 1000;
      return km < 10 ? km.toFixed(1) + " km" : Math.round(km) + " km";
    }

    function formatDuration(duration) {
      if (!duration) return "";
      const seconds = Number(String(duration).replace(/s$/, ""));
      if (!Number.isFinite(seconds)) return String(duration);
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + " min";
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      return remainder ? hours + " hr " + remainder + " min" : hours + " hr";
    }

    function addRouteInfo(route, index, units) {
      const row = document.createElement("tr");
      if (index === 0) row.classList.add("bright");
      const localized = route.localizedValues || {};
      const duration = localized.duration && localized.duration.text
        ? localized.duration.text
        : formatDuration(route.duration);
      const distance = localized.distance && localized.distance.text
        ? localized.distance.text
        : formatDistance(route.distanceMeters, units);
      const summary = route.description || (index === 0 ? "Recommended route" : "Alternative route");
      addCell(row, "", duration);
      addCell(row, "small", ""); // Routes API does not return the old departure_time field.
      addCell(row, "small", distance);
      addCell(row, "small", summary);
      infoTable.appendChild(row);
    }

    function asWaypoint(value) {
      if (typeof value === "string") return { address: value };
      if (!value || typeof value !== "object") {
        throw new Error("Origin, destination, and waypoints must be strings or location objects.");
      }

      // Accept legacy DirectionsService LatLng literals and {lat,lng} objects.
      if (typeof value.lat === "function" && typeof value.lng === "function") {
        return { location: { latLng: { latitude: value.lat(), longitude: value.lng() } } };
      }
      if (typeof value.lat === "number" && typeof value.lng === "number") {
        return { location: { latLng: { latitude: value.lat, longitude: value.lng } } };
      }
      if (value.location && value.location.latLng) return value;
      if (value.placeId) return { placeId: value.placeId };
      if (value.address) return { address: value.address };
      throw new Error("Unsupported waypoint format: " + JSON.stringify(value));
    }

    function toRoutesRequest(legacy) {
      const request = Object.assign({}, legacy);
      const destination = self.state.overrideDestination || request.destination;
      if (!request.origin || !destination) {
        throw new Error("directionsRequest must include both origin and destination.");
      }

      const travelModeMap = {
        DRIVING: "DRIVE",
        DRIVE: "DRIVE",
        WALKING: "WALK",
        WALK: "WALK",
        BICYCLING: "BICYCLE",
        BICYCLE: "BICYCLE",
        TRANSIT: "TRANSIT",
        TWO_WHEELER: "TWO_WHEELER"
      };
      const legacyMode = String(request.travelMode || "DRIVING").toUpperCase();
      const travelMode = travelModeMap[legacyMode];
      if (!travelMode) throw new Error("Unsupported travelMode: " + legacyMode);

      const body = {
        origin: asWaypoint(request.origin),
        destination: asWaypoint(destination),
        travelMode: travelMode,
        languageCode: request.language || self.config.language || "en",
        units: (request.unitSystem === "IMPERIAL" || request.unitSystem === 1) ? "IMPERIAL" : "METRIC",
        computeAlternativeRoutes: request.provideRouteAlternatives !== false
      };

      if (travelMode === "DRIVE" || travelMode === "TWO_WHEELER") {
        body.routingPreference = "TRAFFIC_AWARE";
        const drivingOptions = request.drivingOptions || {};
        const departureTime = drivingOptions.departureTime
          ? new Date(drivingOptions.departureTime)
          : new Date(Date.now() + 60 * 1000);
        const minimumDeparture = new Date(Date.now() + 60 * 1000);
        body.departureTime = (departureTime < minimumDeparture ? minimumDeparture : departureTime).toISOString();
      }

      const modifiers = request.avoid || {};
      body.routeModifiers = {
        avoidTolls: !!(request.avoidTolls || modifiers.tolls),
        avoidHighways: !!(request.avoidHighways || modifiers.highways),
        avoidFerries: !!(request.avoidFerries || modifiers.ferries)
      };

      if (Array.isArray(request.waypoints) && request.waypoints.length) {
        body.intermediates = request.waypoints.map((waypoint) => {
          const location = asWaypoint(waypoint.location || waypoint);
          if (waypoint.stopover === false && location.location) location.via = true;
          return location;
        });
      }

      return { body: body, units: body.units };
    }

    function updateAge() {
      if (self.config.showAge && self.state.lastRefresh) {
        age.textContent = moment(self.state.lastRefresh).fromNow();
      }
    }

    function getDirections() {
      const now = Date.now();
      if (self.config.minimumRefreshPeriod && self._lastDirectionsTime &&
          now - self._lastDirectionsTime < self.config.minimumRefreshPeriod * 60 * 1000) {
        return;
      }

      let converted;
      try {
        converted = toRoutesRequest(self.config.directionsRequest || {});
      } catch (error) {
        clearInfo();
        addError("Route request configuration error: " + error.message);
        return;
      }

      const fieldMask = [
        "routes.duration",
        "routes.distanceMeters",
        "routes.description",
        "routes.localizedValues.duration",
        "routes.localizedValues.distance",
        "routes.polyline.encodedPolyline"
      ].join(",");

      fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": self.config.key,
          "X-Goog-FieldMask": fieldMask
        },
        body: JSON.stringify(converted.body)
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) {
            const detail = data.error && data.error.message ? data.error.message : response.statusText;
            throw new Error("Routes API error (" + response.status + "): " + detail);
          }
          return data;
        })
        .then((data) => {
          const routes = data.routes || [];
          if (!routes.length) throw new Error("Routes API returned no routes.");
          clearInfo();
          drawRoutes(routes);
          routes.slice(0, 2).forEach((route, index) => addRouteInfo(route, index, converted.units));
          mapElement.style.display = self.config.showMap ? "block" : "none";
          self.state.lastRefresh = new Date();
          self._lastDirectionsTime = Date.now();
          updateAge();
        })
        .catch((error) => {
          clearInfo();
          addError("Unable to retrieve route: " + error.message);
          console.error("MMM-google-route Routes API request failed:", error);
        });
    }

    function initializeMap() {
      if (self.state.initialized) return;
      self.state.initialized = true;
      if (self.config.showMap) {
        self._map = new google.maps.Map(mapElement, Object.assign({
          styles: typeof mmmGoogleRouteMapStyles !== "undefined" ? mmmGoogleRouteMapStyles : [],
          zoomControl: false,
          streetViewControl: false,
          scaleControl: false,
          rotateControl: false,
          panControl: false,
          mapTypeControl: false,
          fullscreenControl: false
        }, self.config.mapOptions || {}));
      }

      self.getDirections = getDirections;
      getDirections();

      if (self.config.refreshPeriod) {
        if (self.state.refreshTimer) clearInterval(self.state.refreshTimer);
        self.state.refreshTimer = setInterval(getDirections, self.config.refreshPeriod * 60 * 1000);
      }
      if (self.config.showAge && !self.state.ageTimer) {
        self.state.ageTimer = setInterval(updateAge, 5000);
      }
    }

    const mapsSrc = "https://maps.googleapis.com/maps/api/js?key=" +
      encodeURIComponent(this.config.key) + "&language=" + encodeURIComponent(this.config.language || "en");
    const existingScript = Array.from(document.scripts).find((script) => script.src === mapsSrc);

    if (window.google && google.maps && google.maps.Map) {
      initializeMap();
    } else if (!existingScript) {
      const script = document.createElement("script");
      script.src = mapsSrc;
      script.async = true;
      script.defer = true;
      script.onload = initializeMap;
      script.onerror = () => addError("Unable to load the Google Maps JavaScript API.");
      document.head.appendChild(script);
    } else {
      existingScript.addEventListener("load", initializeMap, { once: true });
      // Covers the case where another module loaded the script before this module initialized.
      const waitForMaps = setInterval(() => {
        if (window.google && google.maps && google.maps.Map) {
          clearInterval(waitForMaps);
          initializeMap();
        }
      }, 250);
    }

    return main;
  },

  notificationReceived: function (notification, payload) {
    if (notification === "MMM-google-route/refresh") {
      this.getDirections();
      return;
    }
    if (this.config.listen.indexOf(notification) < 0) return;

    if (notification !== "CALENDAR_EVENTS") {
      this.getDirections();
      return;
    }

    let override;
    if (Array.isArray(payload)) {
      const event = payload.find((item) => item && item.location);
      if (event) override = event.location;
    } else if (payload && typeof payload === "object") {
      for (const key of Object.keys(payload)) {
        if (payload[key] && payload[key].location) {
          override = payload[key].location;
          break;
        }
      }
    }

    if (JSON.stringify(this.state.overrideDestination) !== JSON.stringify(override)) {
      this.state.overrideDestination = override;
      this.getDirections();
    }
  },

  suspend: function () {
    if (this.state.refreshTimer) clearInterval(this.state.refreshTimer);
    if (this.state.ageTimer) clearInterval(this.state.ageTimer);
  },

  resume: function () {
    if (this.getDirections) this.getDirections();
  }
});
import { qs } from "./dom.js";
import { state } from "./state.js";

let deps = {
  setStatus: (_msg, _isError) => {}
};

export function setMapPickerDeps(d) {
  deps = { ...deps, ...d };
}

let _gmapsLoaded = false;
let _gmapsLoading = false;
const _gmapsWaiters = [];

function loadGoogleMapsApi(apiKey) {
  return new Promise((resolve, reject) => {
    if (_gmapsLoaded) { resolve(); return; }
    _gmapsWaiters.push({ resolve, reject });
    if (_gmapsLoading) return;
    _gmapsLoading = true;
    window.__gmapsReady = () => {
      _gmapsLoaded = true;
      _gmapsWaiters.splice(0).forEach(w => w.resolve());
    };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=__gmapsReady&libraries=places`;
    s.async = true;
    s.defer = true;
    s.onerror = () => {
      _gmapsLoading = false;
      _gmapsWaiters.splice(0).forEach(w => w.reject(new Error("Failed to load Google Maps API.")));
    };
    document.head.appendChild(s);
  });
}

let _mapInst = null;
let _mapMarker = null;
let _mapPickedCoords = null;
let _mapPickerOnConfirm = null;

function updateMapCoordsDisplay(lat, lng) {
  _mapPickedCoords = { lat, lng };
  const el = qs("#map-coords-display");
  if (el) el.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const btn = qs("#map-picker-confirm");
  if (btn) btn.disabled = false;
}

function initGoogleMap(lat, lng) {
  const canvas = qs("#map-picker-canvas");
  if (!canvas) return;
  qs("#map-picker-loading")?.remove();

  const center = { lat, lng };
  _mapInst = new google.maps.Map(canvas, {
    center,
    zoom: 15,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    zoomControl: true
  });

  _mapMarker = new google.maps.Marker({
    position: center,
    map: _mapInst,
    draggable: true,
    title: "Visit location"
  });

  if (_mapPickedCoords) {
    updateMapCoordsDisplay(_mapPickedCoords.lat, _mapPickedCoords.lng);
  }

  _mapInst.addListener("click", (e) => {
    const lat = e.latLng.lat();
    const lng = e.latLng.lng();
    _mapMarker.setPosition(e.latLng);
    updateMapCoordsDisplay(lat, lng);
  });

  _mapMarker.addListener("dragend", () => {
    const pos = _mapMarker.getPosition();
    updateMapCoordsDisplay(pos.lat(), pos.lng());
  });

  const searchInput = qs("#map-search-input");
  if (searchInput && window.google?.maps?.places) {
    const autocomplete = new google.maps.places.Autocomplete(searchInput, {
      fields: ["geometry", "name"]
    });
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (place.geometry?.location) {
        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();
        _mapInst.setCenter(place.geometry.location);
        _mapInst.setZoom(16);
        _mapMarker.setPosition(place.geometry.location);
        updateMapCoordsDisplay(lat, lng);
      }
    });
  }
}

export async function openMapPicker(defaultLat, defaultLng, onConfirm) {
  if (!state.googleMapsApiKey) {
    try {
      const cfg = await fetch("/api/v1/config/public").then(r => r.ok ? r.json() : {});
      state.googleMapsApiKey = cfg.googleMapsApiKey ?? null;
    } catch (_) {}
  }

  const apiKey = state.googleMapsApiKey;
  if (!apiKey) {
    deps.setStatus("Google Maps API key is not configured. Please set GOOGLE_MAPS_API_KEY in server settings.", true);
    return;
  }

  _mapPickerOnConfirm = onConfirm;
  _mapPickedCoords = defaultLat && defaultLng ? { lat: defaultLat, lng: defaultLng } : null;
  const modal = qs("#map-picker-modal");
  if (!modal) return;

  const canvas = qs("#map-picker-canvas");
  if (canvas) {
    canvas.innerHTML = `<div class="map-picker-loading" id="map-picker-loading">Loading map…</div>`;
  }
  const coordsEl = qs("#map-coords-display");
  if (coordsEl) coordsEl.textContent = "Click on map to set location";
  const confirmBtn = qs("#map-picker-confirm");
  if (confirmBtn) confirmBtn.disabled = !_mapPickedCoords;
  const searchInput = qs("#map-search-input");
  if (searchInput) searchInput.value = "";

  modal.hidden = false;
  _mapInst = null;
  _mapMarker = null;

  try {
    await loadGoogleMapsApi(apiKey);
    const lat = defaultLat ?? 13.7563;
    const lng = defaultLng ?? 100.5018;
    initGoogleMap(lat, lng);
    if (_mapPickedCoords) {
      updateMapCoordsDisplay(_mapPickedCoords.lat, _mapPickedCoords.lng);
    }
  } catch (err) {
    modal.hidden = true;
    deps.setStatus(err.message || "Failed to load Google Maps. Please check your connection.", true);
  }
}

export function closeMapPicker() {
  const modal = qs("#map-picker-modal");
  if (modal) modal.hidden = true;
  _mapInst = null;
  _mapMarker = null;
  _mapPickerOnConfirm = null;
}

export function initMapPicker() {
  qs("#map-picker-close")?.addEventListener("click", closeMapPicker);
  qs("#map-picker-cancel")?.addEventListener("click", closeMapPicker);
  qs("#map-picker-backdrop")?.addEventListener("click", closeMapPicker);

  qs("#map-picker-confirm")?.addEventListener("click", () => {
    if (_mapPickedCoords && _mapPickerOnConfirm) {
      _mapPickerOnConfirm(_mapPickedCoords.lat, _mapPickedCoords.lng);
    }
    closeMapPicker();
  });

  qs("#map-my-location-btn")?.addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!_mapInst) return;
        const loc = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
        _mapInst.setCenter(loc);
        _mapInst.setZoom(16);
        _mapMarker.setPosition(loc);
        updateMapCoordsDisplay(pos.coords.latitude, pos.coords.longitude);
      },
      () => alert("Could not retrieve your location.")
    );
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && qs("#map-picker-modal") && !qs("#map-picker-modal").hidden) {
      closeMapPicker();
    }
  });
}

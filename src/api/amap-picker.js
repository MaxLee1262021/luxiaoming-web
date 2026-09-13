/*
 * Runtime AMap loader and coordinate picker.
 *
 * The public JavaScript API always returns GCJ-02 coordinates. Runtime
 * configuration is deliberately read from window.LXM_AMAP_CONFIG so the
 * admin app does not bake a deployment key or securityJsCode into source.
 */
(function attachAmapPicker(global) {
  "use strict";

  const SCRIPT_ID = "lxm-amap-js-api";
  const CALLBACK_NAME = "__lxmAmapJsApiReady";
  const DEFAULT_TIMEOUT_MS = 15000;
  const DEFAULT_ZOOM = 15;
  const ERROR_CODES = {
    DISABLED: "AMAP_DISABLED",
    KEY_MISSING: "AMAP_KEY_MISSING",
    DOCUMENT_UNAVAILABLE: "AMAP_DOCUMENT_UNAVAILABLE",
    LOAD_FAILED: "AMAP_LOAD_FAILED",
    LOAD_TIMEOUT: "AMAP_LOAD_TIMEOUT",
    API_UNAVAILABLE: "AMAP_API_UNAVAILABLE",
    CONTAINER_MISSING: "AMAP_CONTAINER_MISSING",
    MAP_INIT_FAILED: "AMAP_MAP_INIT_FAILED",
    INVALID_COORDINATE: "AMAP_INVALID_COORDINATE",
    GEOCODER_UNAVAILABLE: "AMAP_GEOCODER_UNAVAILABLE",
    REVERSE_GEOCODE_FAILED: "AMAP_REVERSE_GEOCODE_FAILED",
    PLACE_SEARCH_UNAVAILABLE: "AMAP_PLACE_SEARCH_UNAVAILABLE",
    PLACE_SEARCH_FAILED: "AMAP_PLACE_SEARCH_FAILED"
  };

  let loadPromise = null;

  class AmapPickerError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = "AmapPickerError";
      this.code = code;
      this.cause = cause;
      this.userMessage = userMessageFor(code);
    }
  }

  function userMessageFor(code) {
    const messages = {
      [ERROR_CODES.DISABLED]: "高德地图选点当前未启用，请手动填写经纬度。",
      [ERROR_CODES.KEY_MISSING]: "未配置高德地图 Key，暂时无法打开地图选点；仍可手动填写经纬度。",
      [ERROR_CODES.DOCUMENT_UNAVAILABLE]: "当前页面环境无法加载高德地图，请手动填写经纬度。",
      [ERROR_CODES.LOAD_FAILED]: "高德地图加载失败，请检查网络、Key 和域名白名单后重试。",
      [ERROR_CODES.LOAD_TIMEOUT]: "高德地图加载超时，请检查网络后重试。",
      [ERROR_CODES.API_UNAVAILABLE]: "高德地图未能初始化，请检查 Key 和域名白名单。",
      [ERROR_CODES.CONTAINER_MISSING]: "地图容器未准备好，无法打开地图选点。",
      [ERROR_CODES.MAP_INIT_FAILED]: "高德地图初始化失败，请稍后重试。",
      [ERROR_CODES.INVALID_COORDINATE]: "请选择有效的中国大陆经纬度坐标。",
      [ERROR_CODES.GEOCODER_UNAVAILABLE]: "高德地址服务未加载，仍可手动填写地址。",
      [ERROR_CODES.REVERSE_GEOCODE_FAILED]: "未能查询该坐标的详细地址，仍可手动填写。",
      [ERROR_CODES.PLACE_SEARCH_UNAVAILABLE]: "高德地点搜索服务未加载，仍可直接在地图上选点。",
      [ERROR_CODES.PLACE_SEARCH_FAILED]: "地点搜索失败，请更换关键词或直接在地图上选点。"
    };
    return messages[code] || "地图选点暂不可用，请手动填写经纬度。";
  }

  function trim(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }

  function getDocument() {
    return global.document || (typeof document !== "undefined" ? document : null);
  }

  function getAmap() {
    return global.AMap && typeof global.AMap.Map === "function" ? global.AMap : null;
  }

  function normalizeTimeout(value) {
    const timeout = Number(value);
    if (!Number.isFinite(timeout)) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(timeout, 1000), 60000);
  }

  function readRuntimeConfig(options) {
    const runtime = global.LXM_AMAP_CONFIG && typeof global.LXM_AMAP_CONFIG === "object"
      ? global.LXM_AMAP_CONFIG
      : {};
    const overrides = options && typeof options === "object" ? options : {};
    return {
      enabled: runtime.enabled !== false && overrides.enabled !== false,
      key: trim(overrides.key || runtime.key),
      serviceHost: trim(overrides.serviceHost || runtime.serviceHost),
      version: trim(overrides.version || runtime.version) || "2.0",
      plugins: trim(overrides.plugins || runtime.plugins) || "AMap.ToolBar,AMap.Scale,AMap.Geocoder,AMap.PlaceSearch",
      timeoutMs: normalizeTimeout(overrides.timeoutMs || runtime.timeoutMs)
    };
  }

  function getStatus(options) {
    const config = readRuntimeConfig(options);
    return {
      enabled: config.enabled,
      configured: Boolean(config.key),
      loaded: Boolean(getAmap()),
      serviceHost: config.serviceHost
    };
  }

  function normalizeCoordinate(value) {
    if (!value || typeof value !== "object") return null;
    const longitude = Number(value.longitude ?? value.lng ?? value.lon ?? (Array.isArray(value) ? value[0] : undefined));
    const latitude = Number(value.latitude ?? value.lat ?? (Array.isArray(value) ? value[1] : undefined));
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
    return {
      longitude: Number(longitude.toFixed(6)),
      latitude: Number(latitude.toFixed(6)),
      coordType: "gcj02"
    };
  }

  function eventCoordinate(event) {
    const lngLat = event && (event.lnglat || event.lngLat || event);
    if (!lngLat) return null;
    const longitude = typeof lngLat.getLng === "function" ? lngLat.getLng() : (lngLat.lng ?? lngLat.longitude);
    const latitude = typeof lngLat.getLat === "function" ? lngLat.getLat() : (lngLat.lat ?? lngLat.latitude);
    return normalizeCoordinate({ longitude, latitude });
  }

  function addressText(value) {
    if (Array.isArray(value)) return value.map(addressText).filter(Boolean).join("");
    return trim(value);
  }

  function addressFromRegeocode(result) {
    const regeocode = result && result.regeocode && typeof result.regeocode === "object" ? result.regeocode : null;
    if (!regeocode) return null;
    const component = regeocode.addressComponent && typeof regeocode.addressComponent === "object"
      ? regeocode.addressComponent
      : {};
    const address = addressText(regeocode.formattedAddress);
    const district = addressText(component.district);
    if (!address && !district) return null;
    return {
      address,
      district,
      province: addressText(component.province),
      city: addressText(component.city),
      township: addressText(component.township),
      street: addressText(component.street),
      streetNumber: addressText(component.streetNumber),
      adcode: addressText(component.adcode)
    };
  }

  function normalizePlaceSearchResult(poi, index) {
    if (!poi || typeof poi !== "object") return null;
    const position = eventCoordinate(poi.location || poi.lnglat || poi);
    if (!position) return null;
    const name = addressText(poi.name || poi.poiName);
    const address = addressText(poi.address);
    const district = addressText(poi.adname || poi.district);
    return {
      id: trim(poi.id || poi.uid || poi.poiid) || [position.longitude, position.latitude, index].join(","),
      name: name || "未命名地点",
      address,
      district,
      city: addressText(poi.cityname || poi.city),
      province: addressText(poi.pname || poi.province),
      adcode: addressText(poi.adcode),
      longitude: position.longitude,
      latitude: position.latitude,
      coordType: "gcj02"
    };
  }

  function placeSearchResults(result) {
    const poiList = result && result.poiList && typeof result.poiList === "object" ? result.poiList : {};
    const pois = Array.isArray(poiList.pois) ? poiList.pois : [];
    return pois.map(normalizePlaceSearchResult).filter(Boolean);
  }

  function buildScriptUrl(config) {
    const params = [
      "v=" + encodeURIComponent(config.version),
      "key=" + encodeURIComponent(config.key),
      "callback=" + encodeURIComponent(CALLBACK_NAME)
    ];
    if (config.plugins) params.push("plugin=" + encodeURIComponent(config.plugins));
    return "https://webapi.amap.com/maps?" + params.join("&");
  }

  function configureSecurityHost(serviceHost) {
    if (!serviceHost) return;
    const existing = global._AMapSecurityConfig && typeof global._AMapSecurityConfig === "object"
      ? global._AMapSecurityConfig
      : {};
    global._AMapSecurityConfig = { ...existing, serviceHost };
  }

  function createError(code, message, cause) {
    return new AmapPickerError(code, message || userMessageFor(code), cause);
  }

  function load(options) {
    const api = getAmap();
    if (api) return Promise.resolve(api);
    if (loadPromise) return loadPromise;

    const config = readRuntimeConfig(options);
    if (!config.enabled) return Promise.reject(createError(ERROR_CODES.DISABLED));
    if (!config.key) return Promise.reject(createError(ERROR_CODES.KEY_MISSING));

    const doc = getDocument();
    if (!doc || !doc.createElement || !doc.head) return Promise.reject(createError(ERROR_CODES.DOCUMENT_UNAVAILABLE));
    configureSecurityHost(config.serviceHost);

    loadPromise = new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const previousCallback = global[CALLBACK_NAME];
      const existingScript = doc.getElementById && doc.getElementById(SCRIPT_ID);
      const script = existingScript || doc.createElement("script");
      const createdScript = !existingScript;

      function removeFailedScript() {
        if (!createdScript || !script || !script.parentNode || typeof script.parentNode.removeChild !== "function") return;
        script.parentNode.removeChild(script);
      }

      function clearPending() {
        if (timeoutId !== null) {
          (global.clearTimeout || clearTimeout)(timeoutId);
          timeoutId = null;
        }
        if (global[CALLBACK_NAME] === onApiReady) {
          if (typeof previousCallback === "function") global[CALLBACK_NAME] = previousCallback;
          else {
            try { delete global[CALLBACK_NAME]; } catch (_) { global[CALLBACK_NAME] = undefined; }
          }
        }
      }

      function settle(error) {
        if (settled) return;
        settled = true;
        clearPending();
        if (error) reject(error);
        else resolve(getAmap());
      }

      function onApiReady() {
        if (typeof previousCallback === "function") {
          try { previousCallback(); } catch (_) {}
        }
        const loadedApi = getAmap();
        if (loadedApi) settle();
        else settle(createError(ERROR_CODES.API_UNAVAILABLE));
      }

      function onLoadError(error) {
        removeFailedScript();
        settle(createError(ERROR_CODES.LOAD_FAILED, undefined, error));
      }

      function onLoad() {
        // AMap invokes callback in normal operation. The small fallback covers
        // deployments where an existing static script omits that callback.
        (global.setTimeout || setTimeout)(() => {
          if (!settled && getAmap()) settle();
        }, 0);
      }

      global[CALLBACK_NAME] = onApiReady;
      timeoutId = (global.setTimeout || setTimeout)(() => {
        removeFailedScript();
        settle(createError(ERROR_CODES.LOAD_TIMEOUT));
      }, config.timeoutMs);

      if (existingScript) {
        if (getAmap()) return settle();
        if (typeof script.addEventListener === "function") {
          script.addEventListener("load", onLoad, { once: true });
          script.addEventListener("error", onLoadError, { once: true });
        } else {
          script.onload = onLoad;
          script.onerror = onLoadError;
        }
        return;
      }

      script.id = SCRIPT_ID;
      script.async = true;
      script.defer = true;
      script.src = buildScriptUrl(config);
      script.onload = onLoad;
      script.onerror = onLoadError;
      doc.head.appendChild(script);
    }).catch((error) => {
      // A transient network or whitelist failure should be retryable from the
      // dialog without reloading the entire admin page.
      loadPromise = null;
      throw error;
    });

    return loadPromise;
  }

  function mapListener(AMap, map, eventName, handler) {
    if (map && typeof map.on === "function") {
      map.on(eventName, handler);
      return () => {
        if (typeof map.off === "function") map.off(eventName, handler);
      };
    }
    if (AMap.event && typeof AMap.event.addListener === "function") {
      const listener = AMap.event.addListener(map, eventName, handler);
      return () => {
        if (AMap.event && typeof AMap.event.removeListener === "function") AMap.event.removeListener(listener);
      };
    }
    return () => {};
  }

  async function mount(container, options) {
    if (!container) throw createError(ERROR_CODES.CONTAINER_MISSING);
    const settings = options && typeof options === "object" ? options : {};
    const AMap = await load(settings);
    const initialPosition = normalizeCoordinate(settings.initialPosition || settings.position);
    const fallbackCenter = normalizeCoordinate(settings.fallbackCenter || settings.center);
    const mapOptions = {
      viewMode: "2D",
      resizeEnable: true,
      ...(settings.mapOptions || {})
    };
    if (!Number.isFinite(Number(mapOptions.zoom))) mapOptions.zoom = Number.isFinite(Number(settings.zoom)) ? Number(settings.zoom) : DEFAULT_ZOOM;
    const center = initialPosition || fallbackCenter;
    if (center) mapOptions.center = [center.longitude, center.latitude];

    let map;
    try {
      map = new AMap.Map(container, mapOptions);
    } catch (error) {
      throw createError(ERROR_CODES.MAP_INIT_FAILED, undefined, error);
    }

    let marker = null;
    let selectedPosition = null;
    let removeMapClick = () => {};
    let removeMarkerDrag = () => {};
    let geocoder = null;
    let geocoderError = null;
    let placeSearch = null;
    let placeSearchError = null;
    let placeSearchRequest = 0;
    let reverseGeocodeRequest = 0;
    let destroyed = false;

    function notifyPick(position, event) {
      if (typeof settings.onPick === "function") settings.onPick({ ...position, coordType: "gcj02" }, event);
    }

    function notifyAddress(address, position) {
      if (typeof settings.onAddress === "function") settings.onAddress({ ...address }, { ...position, coordType: "gcj02" });
    }

    function notifyAddressError(error, position) {
      if (typeof settings.onAddressError === "function") settings.onAddressError(error, { ...position, coordType: "gcj02" });
    }

    function invalidateReverseGeocode() {
      reverseGeocodeRequest += 1;
      return reverseGeocodeRequest;
    }

    function isCurrentReverseGeocode(request) {
      return !destroyed && request === reverseGeocodeRequest;
    }

    function getGeocoder() {
      if (geocoder) return geocoder;
      if (geocoderError) throw geocoderError;
      if (typeof AMap.Geocoder !== "function") {
        geocoderError = createError(ERROR_CODES.GEOCODER_UNAVAILABLE);
        throw geocoderError;
      }
      try {
        const geocoderOptions = settings.geocoderOptions && typeof settings.geocoderOptions === "object"
          ? settings.geocoderOptions
          : {};
        geocoder = new AMap.Geocoder(geocoderOptions);
        return geocoder;
      } catch (error) {
        geocoderError = createError(ERROR_CODES.GEOCODER_UNAVAILABLE, undefined, error);
        throw geocoderError;
      }
    }

    function reverseGeocode(position) {
      const request = invalidateReverseGeocode();
      const selected = { ...position, coordType: "gcj02" };
      let geocoderInstance;
      try {
        geocoderInstance = getGeocoder();
      } catch (error) {
        if (isCurrentReverseGeocode(request)) notifyAddressError(error, selected);
        return;
      }

      if (!geocoderInstance || typeof geocoderInstance.getAddress !== "function") {
        if (isCurrentReverseGeocode(request)) notifyAddressError(createError(ERROR_CODES.GEOCODER_UNAVAILABLE), selected);
        return;
      }

      try {
        geocoderInstance.getAddress([selected.longitude, selected.latitude], (status, result) => {
          if (!isCurrentReverseGeocode(request)) return;
          const complete = status === "complete" && result && (result.info === undefined || result.info === "OK");
          const address = complete ? addressFromRegeocode(result) : null;
          if (address) {
            notifyAddress(address, selected);
            return;
          }
          notifyAddressError(createError(ERROR_CODES.REVERSE_GEOCODE_FAILED), selected);
        });
      } catch (error) {
        if (isCurrentReverseGeocode(request)) notifyAddressError(createError(ERROR_CODES.REVERSE_GEOCODE_FAILED, undefined, error), selected);
      }
    }

    function getPlaceSearch() {
      if (placeSearch) return placeSearch;
      if (placeSearchError) throw placeSearchError;
      if (typeof AMap.PlaceSearch !== "function") {
        placeSearchError = createError(ERROR_CODES.PLACE_SEARCH_UNAVAILABLE);
        throw placeSearchError;
      }
      try {
        const pageSize = Number(settings.searchPageSize);
        const options = {
          pageSize: Number.isFinite(pageSize) ? Math.min(Math.max(Math.floor(pageSize), 1), 20) : 8,
          pageIndex: 1,
          extensions: "base",
          map: null,
          panel: false,
          autoFitView: false
        };
        const city = trim(settings.searchCity);
        if (city) {
          options.city = city;
          options.citylimit = settings.searchCityLimit !== false;
        }
        placeSearch = new AMap.PlaceSearch(options);
        return placeSearch;
      } catch (error) {
        placeSearchError = createError(ERROR_CODES.PLACE_SEARCH_UNAVAILABLE, undefined, error);
        throw placeSearchError;
      }
    }

    function searchPlaces(value) {
      const keyword = trim(value);
      if (!keyword || destroyed) {
        placeSearchRequest += 1;
        return Promise.resolve([]);
      }
      const request = ++placeSearchRequest;
      let searchInstance;
      try {
        searchInstance = getPlaceSearch();
      } catch (error) {
        return Promise.reject(error);
      }
      if (!searchInstance || typeof searchInstance.search !== "function") {
        return Promise.reject(createError(ERROR_CODES.PLACE_SEARCH_UNAVAILABLE));
      }
      return new Promise((resolve, reject) => {
        try {
          searchInstance.search(keyword, (status, result) => {
            if (destroyed || request !== placeSearchRequest) return resolve([]);
            if (status === "complete") return resolve(placeSearchResults(result));
            if (status === "no_data") return resolve([]);
            return reject(createError(ERROR_CODES.PLACE_SEARCH_FAILED));
          });
        } catch (error) {
          reject(createError(ERROR_CODES.PLACE_SEARCH_FAILED, undefined, error));
        }
      });
    }

    function selectSearchResult(value) {
      if (destroyed || !map) throw createError(ERROR_CODES.MAP_INIT_FAILED);
      placeSearchRequest += 1;
      const position = setPosition(value, { center: true, zoom: Number(settings.searchZoom) || 16 });
      notifyPick(position);
      reverseGeocode(position);
      return { ...position };
    }

    function removeMarker() {
      removeMarkerDrag();
      removeMarkerDrag = () => {};
      if (marker && typeof marker.setMap === "function") marker.setMap(null);
      marker = null;
    }

    function setPosition(value, setOptions) {
      const position = normalizeCoordinate(value);
      if (!position) throw createError(ERROR_CODES.INVALID_COORDINATE);
      const optionsForSet = setOptions && typeof setOptions === "object" ? setOptions : {};
      const lngLat = [position.longitude, position.latitude];
      invalidateReverseGeocode();
      selectedPosition = position;

      if (!marker) {
        marker = new AMap.Marker({
          position: lngLat,
          draggable: settings.draggable !== false,
          cursor: "move"
        });
        if (typeof marker.setMap === "function") marker.setMap(map);
        if (settings.draggable !== false) {
          removeMarkerDrag = mapListener(AMap, marker, "dragend", (event) => {
            const draggedPosition = eventCoordinate(event);
            if (!draggedPosition) return;
            const position = setPosition(draggedPosition, { center: false });
            notifyPick(position, event);
            reverseGeocode(position);
          });
        }
      } else if (typeof marker.setPosition === "function") {
        marker.setPosition(lngLat);
      }

      if (optionsForSet.center !== false && map && typeof map.setCenter === "function") map.setCenter(lngLat);
      if (optionsForSet.zoom && map && typeof map.setZoom === "function") map.setZoom(Number(optionsForSet.zoom));
      return { ...selectedPosition };
    }

    function clearPosition() {
      invalidateReverseGeocode();
      selectedPosition = null;
      removeMarker();
    }

    removeMapClick = mapListener(AMap, map, "click", (event) => {
      const position = eventCoordinate(event);
      if (!position) return;
      const pickedPosition = setPosition(position, { center: false });
      notifyPick(pickedPosition, event);
      reverseGeocode(pickedPosition);
    });

    if (initialPosition) setPosition(initialPosition, { center: true });
    if (typeof settings.onReady === "function") settings.onReady({ map, setPosition, clearPosition });

    return {
      map,
      getPosition: () => selectedPosition ? { ...selectedPosition } : null,
      setPosition,
      searchPlaces,
      selectSearchResult,
      clearPosition,
      resize: () => {
        if (map && typeof map.resize === "function") map.resize();
      },
      destroy: () => {
        destroyed = true;
        invalidateReverseGeocode();
        placeSearchRequest += 1;
        removeMapClick();
        removeMapClick = () => {};
        removeMarker();
        if (map && typeof map.destroy === "function") map.destroy();
        map = null;
      }
    };
  }

  global.LXM_AMAP_PICKER = Object.freeze({
    ERROR_CODES,
    AmapPickerError,
    getStatus,
    normalizeCoordinate,
    eventCoordinate,
    buildScriptUrl: (options) => buildScriptUrl(readRuntimeConfig(options)),
    load,
    mount,
    createMapPicker: mount,
    userMessageFor
  });
})(typeof window !== "undefined" ? window : globalThis);

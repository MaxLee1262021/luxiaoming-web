"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../src/api/amap-picker.js"), "utf8");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadPicker(windowOverrides = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    ...windowOverrides
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "amap-picker.js" });
  return sandbox;
}

test("高德选点器规范化点击坐标为六位 GCJ-02", () => {
  const window = loadPicker();
  const picker = window.LXM_AMAP_PICKER;

  assert.deepEqual(
    plain(picker.normalizeCoordinate({ longitude: "112.9500004", latitude: "28.1950006", coordType: "wgs84" })),
    { longitude: 112.95, latitude: 28.195001, coordType: "gcj02" }
  );
  assert.deepEqual(
    plain(picker.eventCoordinate({ lnglat: { getLng: () => 112.94981234, getLat: () => 28.18634567 } })),
    { longitude: 112.949812, latitude: 28.186346, coordType: "gcj02" }
  );
  assert.equal(picker.normalizeCoordinate({ longitude: 181, latitude: 28 }), null);
});

test("未配置高德 Key 时给出可降级错误", async () => {
  const window = loadPicker({ LXM_AMAP_CONFIG: { enabled: true } });
  await assert.rejects(
    window.LXM_AMAP_PICKER.load(),
    (error) => error.code === "AMAP_KEY_MISSING" && /手动填写经纬度/.test(error.userMessage)
  );
});

test("默认地图加载包含高德地址反查和地点搜索插件", () => {
  const window = loadPicker();
  const url = new URL(window.LXM_AMAP_PICKER.buildScriptUrl({ key: "web-key" }));
  assert.equal(url.searchParams.get("plugin"), "AMap.ToolBar,AMap.Scale,AMap.Geocoder,AMap.PlaceSearch");
});

test("加载失败会回传可重试的网络错误", async () => {
  const document = {
    scripts: new Map(),
    head: {
      appendChild(script) {
        script.parentNode = document.head;
        document.scripts.set(script.id, script);
        setTimeout(() => script.onerror(new Error("network unavailable")), 0);
      },
      removeChild(script) {
        document.scripts.delete(script.id);
        script.parentNode = null;
      }
    },
    createElement() { return {}; },
    getElementById(id) { return document.scripts.get(id) || null; }
  };
  const window = loadPicker({
    document,
    LXM_AMAP_CONFIG: { enabled: true, key: "web-key", serviceHost: "https://amap-proxy.example.test" }
  });

  await assert.rejects(window.LXM_AMAP_PICKER.load(), (error) => error.code === "AMAP_LOAD_FAILED");
  assert.equal(window._AMapSecurityConfig.serviceHost, "https://amap-proxy.example.test");
  assert.equal(document.scripts.has("lxm-amap-js-api"), false);
});

test("地图点击填充 GCJ-02 坐标并在销毁时释放实例", async () => {
  class FakeMap {
    constructor(container, options) {
      this.container = container;
      this.options = options;
      this.handlers = new Map();
      this.center = null;
      this.destroyed = false;
    }
    on(name, handler) { this.handlers.set(name, handler); }
    off(name, handler) { if (this.handlers.get(name) === handler) this.handlers.delete(name); }
    setCenter(center) { this.center = center; }
    resize() { this.resized = true; }
    destroy() { this.destroyed = true; }
  }
  class FakeMarker {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      this.position = options.position;
    }
    on(name, handler) { this.handlers.set(name, handler); }
    off(name, handler) { if (this.handlers.get(name) === handler) this.handlers.delete(name); }
    setMap(map) { this.map = map; }
    setPosition(position) { this.position = position; }
  }
  const window = loadPicker({ AMap: { Map: FakeMap, Marker: FakeMarker } });
  const picked = [];
  const controller = await window.LXM_AMAP_PICKER.mount({ id: "map" }, {
    initialPosition: { longitude: 112.95, latitude: 28.195 },
    onPick: (position) => picked.push(position)
  });

  const click = controller.map.handlers.get("click");
  click({ lnglat: { getLng: () => 112.94981234, getLat: () => 28.18634567 } });
  assert.deepEqual(plain(controller.getPosition()), { longitude: 112.949812, latitude: 28.186346, coordType: "gcj02" });
  assert.deepEqual(plain(picked), [{ longitude: 112.949812, latitude: 28.186346, coordType: "gcj02" }]);
  assert.deepEqual(plain(controller.map.center), [112.95, 28.195]);

  const map = controller.map;
  controller.resize();
  assert.equal(map.resized, true);
  controller.destroy();
  assert.equal(map.destroyed, true);
  assert.equal(map.handlers.has("click"), false);
});

test("地图选点地址反查只回填最新点击或拖拽的结果，失败不影响坐标", async () => {
  const markers = [];
  const requests = [];
  class FakeMap {
    constructor(container, options) {
      this.container = container;
      this.options = options;
      this.handlers = new Map();
    }
    on(name, handler) { this.handlers.set(name, handler); }
    off(name, handler) { if (this.handlers.get(name) === handler) this.handlers.delete(name); }
    setCenter(center) { this.center = center; }
    destroy() { this.destroyed = true; }
  }
  class FakeMarker {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      this.position = options.position;
      markers.push(this);
    }
    on(name, handler) { this.handlers.set(name, handler); }
    off(name, handler) { if (this.handlers.get(name) === handler) this.handlers.delete(name); }
    setMap(map) { this.map = map; }
    setPosition(position) { this.position = position; }
  }
  class FakeGeocoder {
    getAddress(position, callback) {
      requests.push({ position, callback });
    }
  }

  const window = loadPicker({ AMap: { Map: FakeMap, Marker: FakeMarker, Geocoder: FakeGeocoder } });
  const picks = [];
  const addresses = [];
  const addressErrors = [];
  const controller = await window.LXM_AMAP_PICKER.mount({ id: "map" }, {
    onPick: (position) => picks.push(position),
    onAddress: (address, position) => addresses.push({ address, position }),
    onAddressError: (error, position) => addressErrors.push({ error, position })
  });
  const click = controller.map.handlers.get("click");

  click({ lnglat: { getLng: () => 112.94981234, getLat: () => 28.18634567 } });
  click({ lnglat: { getLng: () => 112.95000123, getLat: () => 28.18765432 } });
  assert.equal(requests.length, 2);
  assert.deepEqual(plain(picks), [
    { longitude: 112.949812, latitude: 28.186346, coordType: "gcj02" },
    { longitude: 112.950001, latitude: 28.187654, coordType: "gcj02" }
  ]);

  requests[0].callback("complete", {
    info: "OK",
    regeocode: { formattedAddress: "过期地址", addressComponent: { district: "过期区" } }
  });
  assert.equal(addresses.length, 0);

  requests[1].callback("complete", {
    info: "OK",
    regeocode: {
      formattedAddress: "湖南省长沙市开福区芙蓉北路 1 号",
      addressComponent: {
        province: "湖南省",
        city: "长沙市",
        district: "开福区",
        township: "芙蓉北路街道",
        street: "芙蓉北路",
        streetNumber: "1号",
        adcode: "430105"
      }
    }
  });
  assert.deepEqual(plain(addresses), [{
    address: {
      address: "湖南省长沙市开福区芙蓉北路 1 号",
      district: "开福区",
      province: "湖南省",
      city: "长沙市",
      township: "芙蓉北路街道",
      street: "芙蓉北路",
      streetNumber: "1号",
      adcode: "430105"
    },
    position: { longitude: 112.950001, latitude: 28.187654, coordType: "gcj02" }
  }]);

  const dragend = markers[0].handlers.get("dragend");
  dragend({ lnglat: { getLng: () => 112.95123456, getLat: () => 28.18876543 } });
  assert.equal(requests.length, 3);
  requests[2].callback("error", { info: "SERVICE_NOT_AVAILABLE" });
  assert.equal(addressErrors.length, 1);
  assert.equal(addressErrors[0].error.code, "AMAP_REVERSE_GEOCODE_FAILED");
  assert.deepEqual(plain(addressErrors[0].position), { longitude: 112.951235, latitude: 28.188765, coordType: "gcj02" });
  assert.deepEqual(plain(controller.getPosition()), { longitude: 112.951235, latitude: 28.188765, coordType: "gcj02" });

  click({ lnglat: { getLng: () => 112.95234567, getLat: () => 28.18987654 } });
  assert.equal(requests.length, 4);
  controller.destroy();
  requests[3].callback("complete", {
    info: "OK",
    regeocode: { formattedAddress: "已关闭选点器的地址", addressComponent: { district: "开福区" } }
  });
  assert.equal(addresses.length, 1);
});

test("地点搜索按城市返回可定位 POI，并复用选点与地址反查流程", async () => {
  const searches = [];
  const reverseGeocodeRequests = [];
  class FakeMap {
    constructor() {
      this.handlers = new Map();
    }
    on(name, handler) { this.handlers.set(name, handler); }
    off(name, handler) { if (this.handlers.get(name) === handler) this.handlers.delete(name); }
    setCenter(center) { this.center = center; }
    setZoom(zoom) { this.zoom = zoom; }
    destroy() { this.destroyed = true; }
  }
  class FakeMarker {
    constructor(options) {
      this.position = options.position;
      this.handlers = new Map();
    }
    on(name, handler) { this.handlers.set(name, handler); }
    off(name, handler) { if (this.handlers.get(name) === handler) this.handlers.delete(name); }
    setMap(map) { this.map = map; }
    setPosition(position) { this.position = position; }
  }
  class FakeGeocoder {
    getAddress(position, callback) {
      reverseGeocodeRequests.push({ position, callback });
    }
  }
  class FakePlaceSearch {
    constructor(options) {
      this.options = options;
      searches.options = options;
    }
    search(keyword, callback) {
      searches.push({ keyword, callback });
    }
  }

  const window = loadPicker({ AMap: { Map: FakeMap, Marker: FakeMarker, Geocoder: FakeGeocoder, PlaceSearch: FakePlaceSearch } });
  const picked = [];
  const controller = await window.LXM_AMAP_PICKER.mount({ id: "map" }, {
    searchCity: "长沙",
    onPick: (position) => picked.push(position)
  });

  const firstSearch = controller.searchPlaces("岳麓书院");
  assert.deepEqual(plain(searches.options), {
    pageSize: 8,
    pageIndex: 1,
    extensions: "base",
    map: null,
    panel: false,
    autoFitView: false,
    city: "长沙",
    citylimit: true
  });
  searches[0].callback("complete", {
    poiList: {
      pois: [
        {
          id: "poi-yuelu",
          name: "岳麓书院",
          location: { getLng: () => 112.9440312, getLat: () => 28.1788016 },
          address: "岳麓山南路273号",
          adname: "岳麓区",
          cityname: "长沙市",
          pname: "湖南省",
          adcode: "430104"
        },
        { id: "invalid-poi", name: "无坐标结果" }
      ]
    }
  });
  const places = await firstSearch;
  assert.deepEqual(plain(places), [{
    id: "poi-yuelu",
    name: "岳麓书院",
    address: "岳麓山南路273号",
    district: "岳麓区",
    city: "长沙市",
    province: "湖南省",
    adcode: "430104",
    longitude: 112.944031,
    latitude: 28.178802,
    coordType: "gcj02"
  }]);

  assert.deepEqual(plain(controller.selectSearchResult(places[0])), {
    longitude: 112.944031,
    latitude: 28.178802,
    coordType: "gcj02"
  });
  assert.deepEqual(plain(controller.map.center), [112.944031, 28.178802]);
  assert.equal(controller.map.zoom, 16);
  assert.deepEqual(plain(picked), [{ longitude: 112.944031, latitude: 28.178802, coordType: "gcj02" }]);
  assert.equal(reverseGeocodeRequests.length, 1);

  const staleSearch = controller.searchPlaces("旧关键词");
  const latestSearch = controller.searchPlaces("新关键词");
  searches[1].callback("complete", {
    poiList: {
      pois: [{
        id: "stale-poi",
        name: "不应覆盖的新结果",
        location: { getLng: () => 112.95, getLat: () => 28.18 }
      }]
    }
  });
  assert.deepEqual(plain(await staleSearch), []);
  searches[2].callback("no_data", {});
  assert.deepEqual(plain(await latestSearch), []);

  const failedSearch = controller.searchPlaces("服务失败");
  searches[3].callback("error", {});
  await assert.rejects(failedSearch, (error) => error.code === "AMAP_PLACE_SEARCH_FAILED" && /地点搜索失败/.test(error.userMessage));
});

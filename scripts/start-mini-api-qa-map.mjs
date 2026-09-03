/**
 * Local UI-QA server entrypoint with deterministic Tencent Maps fixtures.
 *
 * This file is intentionally separate from the normal server entrypoint. It
 * does not relax location-proof, quote-snapshot, or payment validation. The
 * application still resolves the selected coordinate, signs locationProof,
 * persists a quote whose distanceSource is tencent_matrix, and re-validates
 * that snapshot before payment. Only the outbound Tencent HTTP responses are
 * replaced so the native mini-program flow can run without a real map key.
 */

const isProduction = process.env.NODE_ENV === "production"
  || process.env.YUXIAOMAN_ENV === "production";

if (isProduction) {
  throw new Error("start-mini-api-qa-map.mjs must never run in production");
}

const qaSchema = process.env.YUXIAOMAN_DB_SCHEMA?.trim();
if (!qaSchema || qaSchema === "public") {
  throw new Error("Set YUXIAOMAN_DB_SCHEMA to an isolated QA schema before starting the map fixture server");
}

process.env.NODE_ENV = "test";
process.env.YUXIAOMAN_ENV = "test";
process.env.TENCENT_MAP_KEY = "local-ui-qa-tencent-stub";

const nativeFetch = globalThis.fetch;

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requestUrl(input) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function coordinate(value) {
  const [latitude, longitude] = String(value || "").split(",").map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`Invalid Tencent fixture coordinate: ${value}`);
  }
  return { latitude, longitude };
}

function haversineKm(from, to) {
  const radians = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = radians(to.latitude - from.latitude);
  const dLng = radians(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(from.latitude))
      * Math.cos(radians(to.latitude))
      * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeElement(from, to) {
  // Deterministic road-like distance and a conservative urban average speed.
  const distanceKm = Math.max(0.8, haversineKm(from, to) * 1.22);
  return {
    distance: Math.round(distanceKm * 1000),
    duration: Math.max(300, Math.round((distanceKm / 28) * 3600)),
  };
}

function tencentFixture(url) {
  if (url.pathname === "/ws/geocoder/v1/") {
    const selected = coordinate(url.searchParams.get("location"));
    return jsonResponse({
      status: 0,
      message: "query ok",
      result: {
        address: "天津市河西区乐园道9号",
        location: { lat: selected.latitude, lng: selected.longitude },
        formatted_addresses: {
          recommend: "天津万象城停车场",
          rough: "天津市河西区乐园道9号",
        },
        address_component: {
          province: "天津市",
          city: "天津市",
          district: "河西区",
          street: "乐园道",
          street_number: "9号",
        },
        ad_info: { adcode: "120103", name: "河西区" },
        pois: [{
          id: "qa-tencent-poi-tianjin-wanxiangcheng",
          title: "天津万象城停车场",
          address: "天津市河西区乐园道9号",
        }],
      },
    });
  }

  if (url.pathname === "/ws/distance/v1/matrix/") {
    const from = coordinate(url.searchParams.get("from"));
    const destinations = String(url.searchParams.get("to") || "")
      .split(";")
      .filter(Boolean)
      .map(coordinate);
    return jsonResponse({
      status: 0,
      message: "query ok",
      result: {
        rows: [{ elements: destinations.map((destination) => routeElement(from, destination)) }],
      },
    });
  }

  if (url.pathname === "/ws/place/v1/suggestion/") {
    const keyword = url.searchParams.get("keyword")?.trim() || "天津取车点";
    return jsonResponse({
      status: 0,
      message: "query ok",
      data: [{
        id: "qa-tencent-poi-tianjin-wanxiangcheng",
        title: keyword,
        address: "天津市河西区乐园道9号",
        district: "河西区",
        location: { lat: 39.0896, lng: 117.2138 },
      }],
    });
  }

  throw new Error(`Unhandled Tencent Maps fixture endpoint: ${url.pathname}`);
}

globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  if (url.hostname === "apis.map.qq.com") return tencentFixture(url);
  return nativeFetch(input, init);
};

console.log("[ui-qa-map] Tencent geocoder/matrix/suggestion responses are locally simulated; production validation remains enabled.");

await import("./start-mini-api.mjs");

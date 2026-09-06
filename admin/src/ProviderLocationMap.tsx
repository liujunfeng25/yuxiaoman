import { CircleNotch, MapPin, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { operatorErrorMessage } from "./operatorError";

type TencentLatLng = {
  getLat: () => number;
  getLng: () => number;
};

type TencentMapClickEvent = { latLng?: TencentLatLng };
type TencentMarkerGeometry = { id: string; position: TencentLatLng };

type TencentMapInstance = {
  on: (event: string, listener: (event: TencentMapClickEvent) => void) => void;
  off?: (event: string, listener: (event: TencentMapClickEvent) => void) => void;
  setCenter: (point: TencentLatLng) => void;
  destroy: () => void;
};

type TencentMarkerInstance = {
  updateGeometries: (geometries: TencentMarkerGeometry[]) => void;
  setMap?: (map: TencentMapInstance | null) => void;
};

type TencentMapNamespace = {
  LatLng: new (latitude: number, longitude: number) => TencentLatLng;
  Map: new (container: HTMLElement, options: {
    center: TencentLatLng;
    zoom: number;
    pitch: number;
    rotation: number;
    showControl: boolean;
  }) => TencentMapInstance;
  MultiMarker: new (options: {
    map: TencentMapInstance;
    geometries: TencentMarkerGeometry[];
  }) => TencentMarkerInstance;
};

type TencentMapWindow = Window & typeof globalThis & { TMap?: TencentMapNamespace };
type MapState = "missing" | "loading" | "ready" | "error";

const mapWebKey = String((import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env?.VITE_TENCENT_MAP_WEB_KEY || "").trim();

let mapSdkPromise: Promise<TencentMapNamespace> | null = null;

function loadTencentMapSdk(): Promise<TencentMapNamespace> {
  const mapWindow = window as TencentMapWindow;
  if (mapWindow.TMap) return Promise.resolve(mapWindow.TMap);
  if (mapSdkPromise) return mapSdkPromise;

  mapSdkPromise = new Promise<TencentMapNamespace>((resolve, reject) => {
    const scriptId = "yuxiaoman-tencent-map-sdk";
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
      if (error) reject(error);
      else if (mapWindow.TMap) resolve(mapWindow.TMap);
      else reject(new Error("腾讯地图脚本已加载，但地图能力不可用"));
    };
    const loaded = () => finish();
    const failed = () => finish(new Error("腾讯地图加载失败"));
    const timeout = window.setTimeout(() => finish(new Error("腾讯地图加载超时")), 10_000);

    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.id = scriptId;
      script.async = true;
      script.charset = "utf-8";
      script.src = `https://map.qq.com/api/gljs?v=1.exp&key=${encodeURIComponent(mapWebKey)}`;
      document.head.appendChild(script);
    }
  }).catch((reason) => {
    mapSdkPromise = null;
    document.getElementById("yuxiaoman-tencent-map-sdk")?.remove();
    throw reason;
  });

  return mapSdkPromise;
}

export function ProviderLocationMap({
  latitude,
  longitude,
  busy,
  feedback,
  error,
  onPick,
}: {
  latitude: number;
  longitude: number;
  busy: boolean;
  feedback: string;
  error: string;
  onPick: (latitude: number, longitude: number) => void | Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<TencentMapInstance | null>(null);
  const markerRef = useRef<TencentMarkerInstance | null>(null);
  const namespaceRef = useRef<TencentMapNamespace | null>(null);
  const onPickRef = useRef(onPick);
  const [mapState, setMapState] = useState<MapState>(mapWebKey ? "loading" : "missing");
  const [mapError, setMapError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => { onPickRef.current = onPick; }, [onPick]);

  useEffect(() => {
    if (!mapWebKey || !containerRef.current) {
      setMapState("missing");
      return;
    }
    let disposed = false;
    let clickListener: ((event: TencentMapClickEvent) => void) | null = null;
    setMapState("loading");
    setMapError("");

    void loadTencentMapSdk().then((tencentMap) => {
      if (disposed || !containerRef.current) return;
      const center = new tencentMap.LatLng(latitude, longitude);
      const map = new tencentMap.Map(containerRef.current, {
        center,
        zoom: 16,
        pitch: 0,
        rotation: 0,
        showControl: true,
      });
      const marker = new tencentMap.MultiMarker({
        map,
        geometries: [{ id: "wash-store", position: center }],
      });
      clickListener = (event) => {
        const point = event.latLng;
        if (!point) return;
        void onPickRef.current(point.getLat(), point.getLng());
      };
      map.on("click", clickListener);
      namespaceRef.current = tencentMap;
      mapRef.current = map;
      markerRef.current = marker;
      setMapState("ready");
    }).catch((reason) => {
      if (disposed) return;
      setMapState("error");
      setMapError(operatorErrorMessage(reason, "腾讯地图加载失败，请稍后重试"));
    });

    return () => {
      disposed = true;
      if (mapRef.current && clickListener) mapRef.current.off?.("click", clickListener);
      markerRef.current?.setMap?.(null);
      mapRef.current?.destroy();
      namespaceRef.current = null;
      markerRef.current = null;
      mapRef.current = null;
    };
  }, [retry]);

  useEffect(() => {
    const tencentMap = namespaceRef.current;
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!tencentMap || !map || !marker || mapState !== "ready") return;
    const point = new tencentMap.LatLng(latitude, longitude);
    map.setCenter(point);
    marker.updateGeometries([{ id: "wash-store", position: point }]);
  }, [latitude, longitude, mapState]);

  const unavailable = mapState === "missing" || mapState === "error";
  return <section className="provider-location-map-picker" aria-label="腾讯地图扎针选址">
    <header>
      <div><strong>地图扎针</strong><small>点击地图落点，地址和行政区以服务端反查结果为准</small></div>
      {mapState === "error" ? <button type="button" onClick={() => setRetry((value) => value + 1)}>重新加载</button> : null}
    </header>
    <div className="provider-location-map-shell">
      <div ref={containerRef} className="provider-location-map" aria-label="门店地图选点区域" />
      {mapState === "loading" ? <div className="provider-location-map-state"><CircleNotch className="backoffice-spinner" /><strong>正在加载腾讯地图…</strong><small>网络代理环境下可能需要更长时间</small></div> : null}
      {unavailable ? <div className="provider-location-map-state unavailable"><WarningCircle /><strong>{mapState === "missing" ? "地图选点尚未配置" : mapError}</strong><small>{mapState === "missing" ? "请配置独立的浏览器地图密钥；仍可使用上方地址联想" : "当前可信位置未改变，可继续使用地址联想或稍后重试"}</small></div> : null}
      {busy ? <div className="provider-location-map-state resolving"><CircleNotch className="backoffice-spinner" /><strong>正在核验落点…</strong><small>核验完成前不会修改当前门店地址</small></div> : null}
      {mapState === "ready" && !busy ? <span className="provider-location-map-hint"><MapPin weight="fill" />点击地图重新落针</span> : null}
    </div>
    {error ? <p className="provider-location-map-feedback error" role="alert"><WarningCircle />{error}</p> : feedback ? <p className="provider-location-map-feedback success" role="status"><MapPin weight="fill" />{feedback}</p> : null}
  </section>;
}

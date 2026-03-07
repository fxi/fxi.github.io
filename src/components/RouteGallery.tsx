import { useState, useEffect, useRef, useCallback } from "react";

const MAPTILER_KEY = import.meta.env.PUBLIC_MAPTILER_KEY ?? "";
const STYLE_URL = `https://api.maptiler.com/maps/01984598-44d5-70a4-b028-6ce2d6f3027a/style.json?key=${MAPTILER_KEY}`;

export interface Track {
  id: string;
  name: string;
  date: string;
  sport_type: string;
  distance_km: number;
  elevation_gain_m: number;
  moving_time_s: number;
  difficulty: number | null;
  scenic: number | null;
  endurance: number | null;
  map_url: string;
  gpx_url: string;
  bbox: [number, number, number, number];
  geometry: [number, number, number][];
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDistance(km: number) {
  return `${km.toFixed(1)} km`;
}
function fmtElevation(m: number) {
  return `+${m.toLocaleString()} m`;
}
function fmtTime(s: number): string | null {
  if (!s) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m >= 6 ? `~${h}.${Math.round(m / 6)} h` : `~${h} h`;
}

// ── ElevationSparkline ─────────────────────────────────────────────────────────

function ElevationSparkline({
  geometry,
}: {
  geometry: [number, number, number][];
}) {
  if (geometry.length < 2) return null;

  const elevations = geometry.map((p) => p[2]);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);
  const range = maxEle - minEle || 1;

  const W = 240;
  const H = 40;
  const padY = 2;

  const pts = elevations.map((ele, i) => {
    const x = (i / (elevations.length - 1)) * W;
    const y = H - padY - ((ele - minEle) / range) * (H - padY * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const lineD = `M${pts.join("L")}`;
  const areaD = `M0,${H}L${pts.join("L")}L${W},${H}Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="route-item-elevation"
      aria-hidden="true"
    >
      <path d={areaD} className="route-elev-fill" />
      <path d={lineD} className="route-elev-line" />
    </svg>
  );
}

// ── RouteItem ─────────────────────────────────────────────────────────────────

function RouteItem({
  track,
  isActive,
  onSelect,
}: {
  track: Track;
  isActive: boolean;
  onSelect: () => void;
}) {
  const time = fmtTime(track.moving_time_s);

  const copyLink = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const url = `${window.location.origin}${window.location.pathname}?route=${track.id}`;
      navigator.clipboard.writeText(url).catch(() => {});
    },
    [track.id],
  );

  return (
    <div
      className={`route-item${isActive ? " route-item--active" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
    >
      <div className="route-item-name">{track.name}</div>
      <ElevationSparkline geometry={track.geometry} />
      <div className="route-item-stats">
        {fmtDistance(track.distance_km)}
        {" · "}
        {fmtElevation(track.elevation_gain_m)}
        {time && ` · ${time}`}
      </div>
      <div className="route-item-actions">
        <a
          className="route-btn"
          href={track.gpx_url}
          download
          onClick={(e) => e.stopPropagation()}
          title="Download GPX"
        >
          ⬇ GPX
        </a>
        <button className="route-btn" onClick={copyLink} title="Copy link">
          ⧉
        </button>
      </div>
    </div>
  );
}

// ── RouteMap ──────────────────────────────────────────────────────────────────

function RouteMap({
  tracks,
  previewId,
}: {
  tracks: Track[];
  previewId: string | null;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const mapLoadedRef = useRef(false);

  // Build GeoJSON FeatureCollection containing all tracks
  const geojson = {
    type: "FeatureCollection" as const,
    features: tracks.map((t) => ({
      type: "Feature" as const,
      properties: { id: t.id },
      geometry: {
        type: "LineString" as const,
        coordinates: t.geometry.map(([lon, lat]) => [lon, lat]),
      },
    })),
  };

  const updateFilters = useCallback(
    (map: any) => {
      const filter = previewId 
        ? ["==", ["to-string", ["get", "id"]], String(previewId)] 
        : ["==", ["get", "id"], ""];
        
      map.setFilter("routes-glow", filter);
      map.setFilter("routes-highlight", filter);
    },
    [previewId],
  );

  const fitToTrack = useCallback(
    (map: any, id: string | null) => {
      if (!id) return;
      const track = tracks.find((t) => t.id === id);
      if (!track) return;
      map.fitBounds(
        [
          [track.bbox[0], track.bbox[1]],
          [track.bbox[2], track.bbox[3]],
        ],
        { padding: 48, duration: 600 },
      );
    },
    [tracks],
  );

  // Mount map once
  useEffect(() => {
    if (!mapRef.current) return;
    let map: any;

    if (!mapRef.current) return;

    const initialTrack = previewId
      ? tracks.find((t) => t.id === previewId)
      : tracks[0];
    const bounds = initialTrack
      ? ([
          [initialTrack.bbox[0], initialTrack.bbox[1]],
          [initialTrack.bbox[2], initialTrack.bbox[3]],
        ] as [[number, number], [number, number]])
      : undefined;

    const Map = (window as any).maplibregl.Map;
    map = new Map({
      container: mapRef.current,
      style: STYLE_URL,
      bounds,
      fitBoundsOptions: { padding: 48 },
      attributionControl: false,
    });
    //map.addControl(new AttributionControl({ compact: true }), "bottom-left");
    mapInstanceRef.current = map;

    map.on("load", () => {
      mapLoadedRef.current = true;

      map.addSource("routes", { type: "geojson", data: geojson });

      map.addLayer({
        id: "routes-dim",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#888",
          "line-width": 1,
          "line-opacity": 0.25,
        },
      });

      map.addLayer({
        id: "routes-glow",
        type: "line",
        source: "routes",
        filter: ["in", ["get", "id"], ["literal", []]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ee7107",
          "line-width": 10,
          "line-blur": 8,
          "line-opacity": 0.4,
        },
      });

      map.addLayer({
        id: "routes-highlight",
        type: "line",
        source: "routes",
        filter: ["in", ["get", "id"], ["literal", []]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ee7107", "line-width": 2.5 },
      });

      updateFilters(map);
    });

    return () => {
      map?.remove();
      mapInstanceRef.current = null;
      mapLoadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update filters whenever previewId or addedIds changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapLoadedRef.current) return;
    updateFilters(map);
  }, [updateFilters]);

  // Fly to track when previewId changes
  const prevPreviewRef = useRef<string | null>(null);
  useEffect(() => {
    if (previewId === prevPreviewRef.current) return;
    prevPreviewRef.current = previewId;
    const map = mapInstanceRef.current;
    if (!map || !mapLoadedRef.current) return;
    fitToTrack(map, previewId);
  }, [previewId, fitToTrack]);

  return <div ref={mapRef} className="route-map-panel" />;
}

// ── RouteGallery ──────────────────────────────────────────────────────────────

export default function RouteGallery({ tracks }: { tracks: Track[] }) {
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Init from URL or default to first track
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("route");
    if (id && tracks.some((t) => t.id === id)) {
      setPreviewId(id);
    } else if (tracks.length > 0) {
      setPreviewId(tracks[0].id);
    }
  }, []);

  const selectTrack = useCallback((id: string) => {
    setPreviewId(id);
    history.pushState({}, "", `?route=${id}`);
  }, []);

  if (tracks.length === 0) {
    return <p className="placeholder-note">No routes yet.</p>;
  }

  return (
    <div className="route-gallery">
      <RouteMap tracks={tracks} previewId={previewId} />
      <div className="route-list-panel">
        {tracks.map((track) => (
          <RouteItem
            key={track.id}
            track={track}
            isActive={previewId === track.id}
            onSelect={() => selectTrack(track.id)}
          />
        ))}
      </div>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from "react";
import { Download, Copy, Map as MapIcon, X, Zap, Activity, Camera } from "lucide-react";

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
  photos: string[];
  gpx_url: string;
  bbox: [number, number, number, number];
  elevation: number[];
}

// ── helpers ───────────────────────────────────────────────────────────────────

const SPORT_LABELS: Record<string, string> = {
  MountainBikeRide: "MTB",
  GravelRide:       "Gravel",
  Ride:             "Road bike",
  EBikeRide:        "E-bike",
  VirtualRide:      "Virtual ride",
  Run:              "Run",
  TrailRun:         "Trail run",
  Hike:             "Hike",
  Walk:             "Walk",
  BackcountrySki:   "Backcountry ski",
  AlpineSki:        "Alpine ski",
  NordicSki:        "Nordic ski",
  Snowboard:        "Snowboard",
  Swim:             "Swim",
  Kayaking:         "Kayaking",
  Rowing:           "Rowing",
};

function sportLabel(type: string): string {
  return SPORT_LABELS[type] ?? type.replace(/([A-Z])/g, " $1").trim();
}

function fmtDistance(km: number) { return `${km.toFixed(1)} km`; }
function fmtElevation(m: number) { return `+${m.toLocaleString()} m`; }
function fmtTime(s: number): string | null {
  if (!s) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m >= 6 ? `~${h}.${Math.round(m / 6)} h` : `~${h} h`;
}
function fmtDate(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function calcOverallBbox(tracks: Track[]): [[number, number], [number, number]] | null {
  if (tracks.length === 0) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const t of tracks) {
    if (t.bbox[0] < minLon) minLon = t.bbox[0];
    if (t.bbox[1] < minLat) minLat = t.bbox[1];
    if (t.bbox[2] > maxLon) maxLon = t.bbox[2];
    if (t.bbox[3] > maxLat) maxLat = t.bbox[3];
  }
  return [[minLon, minLat], [maxLon, maxLat]];
}

// ── GPX parser ────────────────────────────────────────────────────────────────

function parseGpxCoords(gpxText: string): [number, number][] {
  const doc = new DOMParser().parseFromString(gpxText, "application/xml");
  const pts = doc.querySelectorAll("trkpt");
  const coords: [number, number][] = [];
  pts.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute("lat") ?? "");
    const lon = parseFloat(pt.getAttribute("lon") ?? "");
    if (!isNaN(lat) && !isNaN(lon)) coords.push([lon, lat]);
  });
  return coords;
}

// ── ElevationSparkline ────────────────────────────────────────────────────────

function ElevationSparkline({ elevation }: { elevation: number[] }) {
  if (elevation.length < 2) return null;

  const minEle = Math.min(...elevation);
  const maxEle = Math.max(...elevation);
  const range = maxEle - minEle || 1;

  const W = 300;
  const H = 56;
  const padY = 4;

  const pts = elevation.map((ele, i) => {
    const x = (i / (elevation.length - 1)) * W;
    const y = H - padY - ((ele - minEle) / range) * (H - padY * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const lineD = `M${pts.join("L")}`;
  const areaD = `M0,${H}L${pts.join("L")}L${W},${H}Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="route-entry-elevation"
      aria-hidden="true"
    >
      <path d={areaD} className="route-elev-fill" />
      <path d={lineD} className="route-elev-line" />
    </svg>
  );
}

// ── ElevationProfileInteractive ───────────────────────────────────────────────

function ElevationProfileInteractive({
  elevation,
  onHoverProgress,
}: {
  elevation: number[];
  onHoverProgress: (p: number | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [cursor, setCursor] = useState<number | null>(null);

  if (elevation.length < 2) return null;

  const minEle = Math.min(...elevation);
  const maxEle = Math.max(...elevation);
  const range = maxEle - minEle || 1;

  const W = 300;
  const H = 72;
  const padY = 6;

  const pts = elevation.map((ele, i) => {
    const x = (i / (elevation.length - 1)) * W;
    const y = H - padY - ((ele - minEle) / range) * (H - padY * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const lineD = `M${pts.join("L")}`;
  const areaD = `M0,${H}L${pts.join("L")}L${W},${H}Z`;

  const handleMove = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setCursor(p);
    onHoverProgress(p);
  };

  const handleLeave = () => {
    setCursor(null);
    onHoverProgress(null);
  };

  const cursorElevIdx = cursor !== null ? Math.round(cursor * (elevation.length - 1)) : null;
  const cursorEle = cursorElevIdx !== null ? elevation[cursorElevIdx] : null;
  const cursorX = cursor !== null ? cursor * W : null;
  // Keep label inside SVG bounds
  const labelX = cursorX !== null ? Math.min(cursorX + 4, W - 38) : null;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="route-summary-profile"
      aria-hidden="true"
      onMouseMove={(e) => handleMove(e.clientX)}
      onMouseLeave={handleLeave}
      onTouchMove={(e) => { e.preventDefault(); handleMove(e.touches[0].clientX); }}
      onTouchEnd={handleLeave}
    >
      <path d={areaD} className="route-elev-fill" />
      <path d={lineD} className="route-elev-line" />
      {cursorX !== null && (
        <>
          <line
            x1={cursorX} y1={0}
            x2={cursorX} y2={H}
            className="route-profile-cursor"
          />
          {cursorEle !== null && labelX !== null && (
            <text x={labelX} y={14} className="route-profile-label">
              {Math.round(cursorEle)} m
            </text>
          )}
        </>
      )}
    </svg>
  );
}

// ── ScoreTag ───────────────────────────────────────────────────────────────────

function ScoreTag({ icon: Icon, value, max = 5 }: { icon: React.ElementType; value: number | null; max?: number }) {
  if (value === null) return null;
  return (
    <span className="route-score-tag">
      <Icon size={11} aria-hidden />
      {value}/{max}
    </span>
  );
}

function TrackScores({ track }: { track: Track }) {
  if (track.difficulty === null && track.endurance === null && track.scenic === null) return null;
  return (
    <span className="route-scores">
      <ScoreTag icon={Zap}      value={track.difficulty} />
      <ScoreTag icon={Activity} value={track.endurance} />
      <ScoreTag icon={Camera}   value={track.scenic} />
    </span>
  );
}

// ── RouteSummaryPanel ─────────────────────────────────────────────────────────

function RouteSummaryPanel({
  track,
  onClose,
  onHoverProgress,
}: {
  track: Track;
  onClose: () => void;
  onHoverProgress: (p: number | null) => void;
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
    <div className="route-summary-panel">
      <p className="route-summary-meta">
        <span style={{ fontWeight: 700 }}>{sportLabel(track.sport_type)}</span>
        {" · "}{fmtDistance(track.distance_km)}
        {" · "}{fmtElevation(track.elevation_gain_m)}
        {time && ` · ${time}`}
      </p>
      <p className="route-summary-name">{track.name}</p>
      <TrackScores track={track} />
      <ElevationProfileInteractive
        elevation={track.elevation}
        onHoverProgress={onHoverProgress}
      />
      <div className="route-summary-actions">
        <a
          className="route-btn"
          href={track.gpx_url}
          download
          onClick={(e) => e.stopPropagation()}
          title="Download GPX"
        >
          <Download size={14} aria-hidden /> GPX
        </a>
        <button className="route-btn" onClick={copyLink} title="Copy link">
          <Copy size={14} aria-hidden />
        </button>
        <button className="route-btn" onClick={onClose} title="Close">
          <X size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ── PhotoStrip ────────────────────────────────────────────────────────────────

function PhotoStrip({ photos }: { photos: string[] }) {
  const [idx, setIdx] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || photos.length <= 1) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const i = Array.from(strip.children).indexOf(entry.target as HTMLElement);
            if (i >= 0) setIdx(i);
          }
        }
      },
      { root: strip, threshold: 0.6 },
    );
    Array.from(strip.children).forEach((c) => observer.observe(c));
    return () => observer.disconnect();
  }, [photos.length]);

  const scrollTo = (i: number) => {
    const child = stripRef.current?.children[i] as HTMLElement;
    child?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  };

  if (photos.length === 0) return null;

  return (
    <div
      className="route-photo-wrap"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div ref={stripRef} className="route-photo-strip">
        {photos.map((url, i) => (
          <img key={i} src={url} alt="" className="route-photo-img" loading="lazy" />
        ))}
      </div>
      {photos.length > 1 && (
        <div className="route-photo-dots">
          {photos.map((_, i) => (
            <button
              key={i}
              className={`route-photo-dot${i === idx ? " route-photo-dot--on" : ""}`}
              onClick={() => scrollTo(i)}
              aria-label={`Photo ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── RouteEntry ────────────────────────────────────────────────────────────────

function RouteEntry({
  track,
  isActive,
  onToggle,
  onShowOnMap,
}: {
  track: Track;
  isActive: boolean;
  onToggle: () => void;
  onShowOnMap: () => void;
}) {
  const time = fmtTime(track.moving_time_s);
  const date = fmtDate(track.date);

  const copyLink = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const url = `${window.location.origin}${window.location.pathname}?route=${track.id}`;
      navigator.clipboard.writeText(url).catch(() => {});
    },
    [track.id],
  );

  return (
    <article className={`route-entry${isActive ? " route-entry--active" : ""}`}>
      <div
        className="route-entry-header"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggle(); }}
      >
        <h2 className="route-entry-title">{track.name}</h2>
        <p className="route-entry-meta">
          <span className="route-sport-tag">{sportLabel(track.sport_type)}</span>
          {" · "}{fmtDistance(track.distance_km)}
          {" · "}{fmtElevation(track.elevation_gain_m)}
          {time && ` · ${time}`}
          {date && <span className="route-entry-date"> · {date}</span>}
          <TrackScores track={track} />
        </p>
      </div>
      <PhotoStrip photos={track.photos} />
      <ElevationSparkline elevation={track.elevation} />
      <div className="route-entry-actions">
        <a
          className="route-btn"
          href={track.gpx_url}
          download
          onClick={(e) => e.stopPropagation()}
          title="Download GPX"
        >
          <Download size={14} aria-hidden /> GPX
        </a>
        <button className="route-btn" onClick={copyLink} title="Copy link">
          <Copy size={14} aria-hidden />
        </button>
        <button
          className="route-btn route-btn--map-toggle"
          onClick={(e) => { e.stopPropagation(); onShowOnMap(); }}
          title="Show on map"
        >
          <MapIcon size={14} aria-hidden /> map
        </button>
      </div>
    </article>
  );
}

// ── RouteMap ──────────────────────────────────────────────────────────────────

function RouteMap({
  tracks,
  activeIds,
  onClose,
}: {
  tracks: Track[];
  activeIds: Set<string>;
  onClose: () => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const mapLoadedRef = useRef(false);
  const activeIdsRef = useRef(activeIds);
  const loadedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  const hoverMarkerRef = useRef<any>(null);

  const [loadedCoords, setLoadedCoords] = useState<Map<string, [number, number][]>>(new Map());
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);

  activeIdsRef.current = activeIds;

  const addTrackToMap = useCallback(
    async (map: any, track: Track) => {
      if (pendingRef.current.has(track.id) || loadedRef.current.has(track.id)) return;
      pendingRef.current.add(track.id);
      try {
        const res = await fetch(track.gpx_url);
        if (!res.ok) return;
        const coords = parseGpxCoords(await res.text());
        if (coords.length < 2) return;
        if (!activeIdsRef.current.has(track.id) || !mapInstanceRef.current) return;

        const m = mapInstanceRef.current;
        m.addSource(`route-${track.id}`, {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords },
          },
        });
        m.addLayer({
          id: `route-${track.id}-glow`,
          type: "line",
          source: `route-${track.id}`,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#ffffff",
            "line-width": 10,
            "line-blur": 0,
            "line-opacity": 0.8,
          },
        });
        m.addLayer({
          id: `route-${track.id}-line`,
          type: "line",
          source: `route-${track.id}`,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#00d4ff", "line-width": 2.5 },
        });
        loadedRef.current.add(track.id);
        setLoadedCoords((prev) => {
          const next = new Map(prev);
          next.set(track.id, coords);
          return next;
        });

        m.fitBounds(
          [
            [track.bbox[0], track.bbox[1]],
            [track.bbox[2], track.bbox[3]],
          ],
          { padding: 48, duration: 600 },
        );
      } finally {
        pendingRef.current.delete(track.id);
      }
    },
    [],
  );

  const removeTrackFromMap = useCallback((map: any, id: string) => {
    if (map.getLayer(`route-${id}-glow`)) map.removeLayer(`route-${id}-glow`);
    if (map.getLayer(`route-${id}-line`)) map.removeLayer(`route-${id}-line`);
    if (map.getSource(`route-${id}`)) map.removeSource(`route-${id}`);
    loadedRef.current.delete(id);
    setLoadedCoords((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const syncTracks = useCallback(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapLoadedRef.current) return;
    const active = activeIdsRef.current;
    for (const id of [...loadedRef.current]) {
      if (!active.has(id)) removeTrackFromMap(map, id);
    }
    for (const id of active) {
      if (!loadedRef.current.has(id)) {
        const track = tracks.find((t) => t.id === id);
        if (track) addTrackToMap(map, track);
      }
    }
  }, [tracks, addTrackToMap, removeTrackFromMap]);

  useEffect(() => {
    if (!mapRef.current) return;

    const overallBbox = calcOverallBbox(tracks);
    const Map = (window as any).maplibregl.Map;
    const map = new Map({
      container: mapRef.current,
      style: STYLE_URL,
      ...(overallBbox
        ? { bounds: overallBbox, fitBoundsOptions: { padding: 48 } }
        : { center: [6.8, 46.2], zoom: 8 }),
      attributionControl: false,
    });
    mapInstanceRef.current = map;

    map.on("load", () => {
      mapLoadedRef.current = true;
      syncTracks();
    });

    return () => {
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      map.remove();
      mapInstanceRef.current = null;
      mapLoadedRef.current = false;
      loadedRef.current.clear();
      pendingRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    syncTracks();
  }, [activeIds, syncTracks]);

  // Move hover marker when progress changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapLoadedRef.current) return;

    const singleId = activeIds.size === 1 ? [...activeIds][0] : null;
    const coords = singleId ? loadedCoords.get(singleId) : null;

    if (hoverProgress === null || !coords || coords.length === 0) {
      hoverMarkerRef.current?.remove();
      return;
    }

    const idx = Math.min(Math.round(hoverProgress * (coords.length - 1)), coords.length - 1);
    const [lng, lat] = coords[idx];

    if (!hoverMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "route-hover-marker";
      hoverMarkerRef.current = new (window as any).maplibregl.Marker({ element: el });
    }

    hoverMarkerRef.current.setLngLat([lng, lat]).addTo(map);
  }, [hoverProgress, activeIds, loadedCoords]);

  // Deselect active track when it's removed from loadedCoords (marker cleanup)
  useEffect(() => {
    if (hoverProgress !== null && activeIds.size !== 1) {
      hoverMarkerRef.current?.remove();
    }
  }, [activeIds, hoverProgress]);

  const singleActive = activeIds.size === 1 ? tracks.find((t) => activeIds.has(t.id)) : null;

  return (
    <div className="route-map-wrapper">
      <div ref={mapRef} className="route-map-panel" />
      {singleActive && (
        <RouteSummaryPanel
          track={singleActive}
          onClose={onClose}
          onHoverProgress={setHoverProgress}
        />
      )}
    </div>
  );
}

// ── RouteGallery ──────────────────────────────────────────────────────────────

export default function RouteGallery({ tracks }: { tracks: Track[] }) {
  const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());
  const [mobileView, setMobileView] = useState<"list" | "map">("list");

  // Init from URL
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("route");
    if (id && tracks.some((t) => t.id === id)) {
      setActiveIds(new Set([id]));
    }
  }, []);

  const toggleTrack = useCallback((id: string) => {
    setActiveIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const showOnMap = useCallback((id: string) => {
    setActiveIds(new Set([id]));
    setMobileView("map");
  }, []);

  if (tracks.length === 0) {
    return <p className="placeholder-note">No routes yet.</p>;
  }

  return (
    <div className={`route-gallery${mobileView === "map" ? " route-gallery--map-view" : ""}`}>
      <RouteMap
        tracks={tracks}
        activeIds={activeIds}
        onClose={() => {
          setActiveIds(new Set());
          setMobileView("list");
        }}
      />
      <div className="route-journal">
        {tracks.map((track) => (
          <RouteEntry
            key={track.id}
            track={track}
            isActive={activeIds.has(track.id)}
            onToggle={() => toggleTrack(track.id)}
            onShowOnMap={() => showOnMap(track.id)}
          />
        ))}
      </div>
    </div>
  );
}

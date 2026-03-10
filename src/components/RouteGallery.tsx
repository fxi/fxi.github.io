import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Download, Copy, X, Zap, Activity, Camera, ChevronLeft, ChevronRight, ExternalLink, Map as MapIcon } from "lucide-react";

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
  first_point: [number, number] | null;
  last_point: [number, number] | null;
  high_point: [number, number] | null;
  strava_url?: string;
  description?: string;
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

function distMeters([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clusterByFirstPoint(
  tracks: Track[],
  thresholdM = 5000
): { centroid: [number, number]; tracks: Track[] }[] {
  const clusters: { centroid: [number, number]; tracks: Track[] }[] = [];
  const assigned = new Set<string>();

  for (const track of tracks) {
    if (assigned.has(track.id) || !track.first_point) continue;
    const seed = track.first_point;
    const group = [track];
    assigned.add(track.id);

    for (const other of tracks) {
      if (assigned.has(other.id) || !other.first_point) continue;
      if (distMeters(seed, other.first_point) < thresholdM) {
        group.push(other);
        assigned.add(other.id);
      }
    }

    const lons = group.map((t) => t.first_point![0]);
    const lats = group.map((t) => t.first_point![1]);
    const centroid: [number, number] = [
      lons.reduce((a, b) => a + b, 0) / lons.length,
      lats.reduce((a, b) => a + b, 0) / lats.length,
    ];

    clusters.push({ centroid, tracks: group });
  }
  return clusters;
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
      <text x={3} y={11} className="route-profile-minmax">{Math.round(maxEle)} m</text>
      <text x={3} y={H - 3} className="route-profile-minmax">{Math.round(minEle)} m</text>
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

// ── useCopyLink ───────────────────────────────────────────────────────────────

function useCopyLink(id: string) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}${window.location.pathname}?route=${id}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }, [id]);

  return { copy, copied };
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

// ── RouteDescription ──────────────────────────────────────────────────────────

function RouteDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTrunc = text.length > 120 || text.includes('\n');

  if (!needsTrunc) {
    return <p className="route-description">{text}</p>;
  }

  const preview = text.split('\n')[0].slice(0, 120);

  return (
    <p className="route-description">
      {expanded ? text : `${preview}…`}
      {' '}
      <button
        className="route-desc-more"
        onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
      >
        [{expanded ? 'less' : 'more'}]
      </button>
    </p>
  );
}

// ── RouteLightbox ─────────────────────────────────────────────────────────────

function RouteLightbox({ photos, initialIdx, onClose }: {
  photos: string[];
  initialIdx: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(initialIdx);
  const backdropRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    backdropRef.current?.focus();
  }, []);

  const goNext = useCallback(() => setIdx(i => Math.min(i + 1, photos.length - 1)), [photos.length]);
  const goPrev = useCallback(() => setIdx(i => Math.max(i - 1, 0)), []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [goNext, goPrev, onClose]);

  function handleTouchStart(e: React.TouchEvent) {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (!touchStart.current) return;
    const dx = e.changedTouches[0].clientX - touchStart.current.x;
    const dy = e.changedTouches[0].clientY - touchStart.current.y;
    touchStart.current = null;
    if (dy > 60 && Math.abs(dy) > Math.abs(dx)) { onClose(); return; }
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) goNext(); else goPrev();
    }
  }

  if (photos.length === 0) return null;

  return createPortal(
    <div
      ref={backdropRef}
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {idx > 0 && (
        <button
          className="lightbox-zone lightbox-zone--prev"
          onClick={(e) => { e.stopPropagation(); goPrev(); }}
          aria-label="Previous photo"
        >
          <span className="lightbox-zone-icon"><ChevronLeft aria-hidden /></span>
        </button>
      )}
      {idx < photos.length - 1 && (
        <button
          className="lightbox-zone lightbox-zone--next"
          onClick={(e) => { e.stopPropagation(); goNext(); }}
          aria-label="Next photo"
        >
          <span className="lightbox-zone-icon"><ChevronRight aria-hidden /></span>
        </button>
      )}
      <img src={photos[idx]} alt="" className="lightbox-img" />
      {photos.length > 1 && (
        <div className="lightbox-counter" aria-live="polite">{idx + 1} / {photos.length}</div>
      )}
      <button
        className="lightbox-close"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
      >
        <X aria-hidden />
      </button>
    </div>,
    document.body
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
  const { copy, copied } = useCopyLink(track.id);

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
        <button className="route-btn" onClick={copy} title="Copy link">
          {copied ? "copied!" : <Copy size={14} aria-hidden />}
        </button>
        {track.strava_url && (
          <a
            className="route-btn"
            href={track.strava_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="View on Strava"
          >
            <ExternalLink size={14} aria-hidden /> Strava
          </a>
        )}
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
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
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
          <img
            key={i}
            src={url}
            alt=""
            className="route-photo-img"
            loading="lazy"
            onClick={() => setLightboxIdx(i)}
            style={{ cursor: "zoom-in" }}
          />
        ))}
      </div>
      {photos.length > 1 && (
        <div className="route-photo-dots">
          {photos.length <= 5
            ? photos.map((_, i) => (
                <button
                  key={i}
                  className={`route-photo-dot${i === idx ? " route-photo-dot--on" : ""}`}
                  onClick={() => scrollTo(i)}
                  aria-label={`Photo ${i + 1}`}
                />
              ))
            : null}
          <span className="route-photo-count">{idx + 1} / {photos.length}</span>
        </div>
      )}
      {lightboxIdx !== null && (
        <RouteLightbox
          photos={photos}
          initialIdx={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}

// ── RouteEntry ────────────────────────────────────────────────────────────────

function RouteEntry({
  track,
  isActive,
  onShowOnMap,
}: {
  track: Track;
  isActive: boolean;
  onShowOnMap: () => void;
}) {
  const time = fmtTime(track.moving_time_s);
  const date = fmtDate(track.date);
  const { copy, copied } = useCopyLink(track.id);

  return (
    <article
      className={`route-entry${isActive ? " route-entry--active" : ""}`}
      onClick={onShowOnMap}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onShowOnMap(); }}
    >
      <div className="route-entry-header">
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
      {track.description && <RouteDescription text={track.description} />}
      <div className="route-photo-container">
        <PhotoStrip photos={track.photos} />
        <ElevationSparkline elevation={track.elevation} />
      </div>
      <div
        className="route-entry-actions"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <button className="route-btn" onClick={onShowOnMap} title="Show on map">
          <MapIcon size={14} aria-hidden /> Map
        </button>
        <a
          className="route-btn"
          href={track.gpx_url}
          download
          title="Download GPX"
        >
          <Download size={14} aria-hidden /> GPX
        </a>
        <button className="route-btn" onClick={copy} title="Copy link">
          {copied ? "copied!" : <Copy size={14} aria-hidden />}
        </button>
        {track.strava_url && (
          <a
            className="route-btn"
            href={track.strava_url}
            target="_blank"
            rel="noopener noreferrer"
            title="View on Strava"
          >
            <ExternalLink size={14} aria-hidden /> Strava
          </a>
        )}
      </div>
    </article>
  );
}

// ── RouteMap ──────────────────────────────────────────────────────────────────

function RouteMap({
  tracks,
  activeIds,
  onClose,
  onToggleTrack,
}: {
  tracks: Track[];
  activeIds: Set<string>;
  onClose: () => void;
  onToggleTrack: (id: string) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const mapLoadedRef = useRef(false);
  const activeIdsRef = useRef(activeIds);
  const loadedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  const hoverMarkerRef = useRef<any>(null);
  const markersRef = useRef<Map<string, {
    startEl: HTMLElement;
    labelEl: HTMLElement;
    endEl: HTMLElement;
    summaryEl: HTMLButtonElement;
  }>>(new Map());

  const [loadedCoords, setLoadedCoords] = useState<Map<string, [number, number][]>>(new Map());
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(0);

  activeIdsRef.current = activeIds;

  const addTrackToMap = useCallback(
    async (map: any, track: Track) => {
      if (pendingRef.current.has(track.id) || loadedRef.current.has(track.id)) return;
      pendingRef.current.add(track.id);
      setLoadingCount((c) => c + 1);
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
        setLoadingCount((c) => c - 1);
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

    const maplibregl = (window as any).maplibregl;
    if (!maplibregl) {
      console.error("RouteMap: maplibregl not loaded");
      return;
    }

    const overallBbox = calcOverallBbox(tracks);
    const map = new maplibregl.Map({
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

      const mgl = (window as any).maplibregl;

      // Pass 1: per-track start/end dots
      const tempDots = new Map<string, { startEl: HTMLElement; endEl: HTMLElement }>();
      for (const track of tracks) {
        if (!track.first_point) continue;

        const startEl = document.createElement("button");
        startEl.className = "route-marker-dot";
        startEl.setAttribute("aria-label", `Start of ${track.name}`);
        startEl.onclick = () => onToggleTrack(track.id);
        new mgl.Marker({ element: startEl, anchor: "center" })
          .setLngLat(track.first_point)
          .addTo(map);

        const endEl = document.createElement("button");
        endEl.className = "route-marker-dot";
        endEl.setAttribute("aria-label", `End of ${track.name}`);
        endEl.onclick = () => onToggleTrack(track.id);
        new mgl.Marker({ element: endEl, anchor: "center" })
          .setLngLat(track.last_point ?? track.first_point)
          .addTo(map);

        tempDots.set(track.id, { startEl, endEl });
      }

      // Pass 2: clustered trailhead labels
      const clusters = clusterByFirstPoint(tracks);
      for (const { centroid, tracks: group } of clusters) {
        if (group.length === 1) {
          // Solo: plain label
          const track = group[0];
          const { startEl, endEl } = tempDots.get(track.id)!;
          const labelEl = document.createElement("button");
          labelEl.className = "route-marker-label";
          labelEl.textContent = track.name;
          labelEl.onclick = () => onToggleTrack(track.id);
          new mgl.Marker({ element: labelEl, anchor: "bottom" })
            .setLngLat(centroid)
            .addTo(map);
          markersRef.current.set(track.id, { startEl, labelEl, endEl, summaryEl: labelEl as unknown as HTMLButtonElement });
          continue;
        }

        // Multi: pancake stack widget
        const stackEl = document.createElement("div");
        stackEl.className = "route-marker-stack";

        const deckEl = document.createElement("div");
        deckEl.className = "route-marker-stack__deck";

        const defaultLabel = `${group.length} routes`;
        const summaryEl = document.createElement("button");
        summaryEl.className = "route-marker-stack__summary";
        summaryEl.textContent = defaultLabel;
        summaryEl.dataset.default = defaultLabel;
        summaryEl.onclick = (e) => {
          e.stopPropagation();
          stackEl.classList.toggle("route-marker-stack--open");
        };
        deckEl.appendChild(summaryEl);
        stackEl.appendChild(deckEl);

        const listEl = document.createElement("div");
        listEl.className = "route-marker-stack__list";

        for (const track of group) {
          const { startEl, endEl } = tempDots.get(track.id)!;
          const labelEl = document.createElement("button");
          labelEl.className = "route-marker-label";
          labelEl.textContent = track.name;
          labelEl.onclick = (e) => {
            e.stopPropagation();
            onToggleTrack(track.id);
            stackEl.classList.remove("route-marker-stack--open");
          };
          listEl.appendChild(labelEl);
          markersRef.current.set(track.id, { startEl, labelEl, endEl, summaryEl });
        }

        stackEl.appendChild(listEl);
        new mgl.Marker({ element: stackEl, anchor: "bottom" })
          .setLngLat(centroid)
          .addTo(map);
      }
    });

    return () => {
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      markersRef.current.forEach(({ startEl, labelEl, endEl }) => {
        startEl.closest(".maplibregl-marker")?.remove();
        labelEl.closest(".maplibregl-marker")?.remove();
        endEl.closest(".maplibregl-marker")?.remove();
      });
      markersRef.current.clear();
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
      const mgl = (window as any).maplibregl;
      if (!mgl) return;
      hoverMarkerRef.current = new mgl.Marker({ element: el });
    }

    hoverMarkerRef.current.setLngLat([lng, lat]).addTo(map);
  }, [hoverProgress, activeIds, loadedCoords]);

  useEffect(() => {
    if (hoverProgress !== null && activeIds.size !== 1) {
      hoverMarkerRef.current?.remove();
    }
  }, [activeIds, hoverProgress]);

  useEffect(() => {
    const summaryActiveName = new Map<HTMLButtonElement, string>();

    markersRef.current.forEach(({ startEl, labelEl, endEl, summaryEl }, id) => {
      const on = activeIds.has(id);
      startEl.classList.toggle("route-marker-dot--active", on);
      labelEl.classList.toggle("route-marker-label--active", on);
      endEl.classList.toggle("route-marker-dot--active", on);

      if (on && summaryEl !== (labelEl as unknown as HTMLButtonElement)) {
        summaryActiveName.set(summaryEl, tracks.find((t) => t.id === id)?.name ?? "");
      }
    });

    const allSummaries = new Set<HTMLButtonElement>();
    markersRef.current.forEach(({ summaryEl, labelEl }) => {
      if (summaryEl !== (labelEl as unknown as HTMLButtonElement)) allSummaries.add(summaryEl);
    });

    allSummaries.forEach((summaryEl) => {
      const activeName = summaryActiveName.get(summaryEl);
      if (activeName) {
        summaryEl.textContent = activeName;
        summaryEl.closest(".route-marker-stack")?.classList.remove("route-marker-stack--open");
      } else {
        summaryEl.textContent = summaryEl.dataset.default ?? "";
      }
    });
  }, [activeIds, tracks]);

  const singleActive = activeIds.size === 1 ? tracks.find((t) => activeIds.has(t.id)) : null;

  return (
    <div className="route-map-wrapper">
      <div ref={mapRef} className="route-map-panel" />
      {loadingCount > 0 && (
        <div className="route-map-loading" aria-live="polite">
          <div className="route-map-loading-dot" />
          loading
        </div>
      )}
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
  const [filterSport, setFilterSport] = useState<string | null>(null);

  // Init from URL
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("route");
    if (id && tracks.some((t) => t.id === id)) {
      setActiveIds(new Set([id]));
    }
  }, []);

  const sports = useMemo(() => {
    const set = new Set(tracks.map((t) => t.sport_type));
    return [...set].sort();
  }, [tracks]);

  const filteredTracks = useMemo(
    () => (filterSport ? tracks.filter((t) => t.sport_type === filterSport) : tracks),
    [tracks, filterSport],
  );

  // Drop active IDs that got filtered out
  useEffect(() => {
    const filteredIds = new Set(filteredTracks.map((t) => t.id));
    setActiveIds((prev) => {
      const next = new Set([...prev].filter((id) => filteredIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredTracks]);

  const totalKm = useMemo(
    () => filteredTracks.reduce((s, t) => s + t.distance_km, 0),
    [filteredTracks],
  );
  const totalGain = useMemo(
    () => filteredTracks.reduce((s, t) => s + t.elevation_gain_m, 0),
    [filteredTracks],
  );

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
        tracks={filteredTracks}
        activeIds={activeIds}
        onClose={() => {
          setActiveIds(new Set());
          setMobileView("list");
        }}
        onToggleTrack={showOnMap}
      />
      <div className="route-journal">
        <div className="route-journal-header">
          <p className="route-stats-header">
            {filteredTracks.length} route{filteredTracks.length !== 1 ? "s" : ""}
            {" · "}{Math.round(totalKm).toLocaleString()} km
            {" · "}+{Math.round(totalGain).toLocaleString()} m
          </p>
          {sports.length > 1 && (
            <div className="route-filter-pills">
              <button
                className={`route-filter-pill${filterSport === null ? " route-filter-pill--active" : ""}`}
                onClick={() => setFilterSport(null)}
              >
                All
              </button>
              {sports.map((s) => (
                <button
                  key={s}
                  className={`route-filter-pill${filterSport === s ? " route-filter-pill--active" : ""}`}
                  onClick={() => setFilterSport(s === filterSport ? null : s)}
                >
                  {sportLabel(s)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="route-journal-list">
          {filteredTracks.map((track) => (
            <RouteEntry
              key={track.id}
              track={track}
              isActive={activeIds.has(track.id)}
              onShowOnMap={() => showOnMap(track.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

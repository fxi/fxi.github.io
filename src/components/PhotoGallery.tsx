import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import PhotoLightbox from './PhotoLightbox';

export interface Photo {
  id: string;
  filename: string;
  album: string;
  date_taken: string;
  date_uploaded: string;
  width: number;
  height: number;
  thumb_url: string;
  preview_url: string;
  exif: {
    camera?: string;
    lens?: string;
    focal_length?: string;
    focal_length_35mm?: string;
    aperture?: string;
    shutter_speed?: string;
    iso?: number;
    exposure_compensation?: string;
  };
  luminance: number; // CIE L*, 0–100
}

interface Props {
  photos: Photo[];
}

type LayoutMode = 'flat' | 'year';
type FilterId   = 'none' | 'noir' | 'vibrant' | 'fun' | 'spectacular' | 'acid' | 'underground';

const FILTERS: Record<FilterId, string> = {
  none:        '',
  noir:        'grayscale(1) contrast(1.3) brightness(0.9)',
  vibrant:     'saturate(2.2) contrast(1.1)',
  fun:         'hue-rotate(90deg) saturate(1.4)',
  spectacular: 'saturate(1.8) brightness(1.1) contrast(1.15)',
  acid:        'hue-rotate(160deg) saturate(3) contrast(1.2)',
  underground: 'brightness(0.65) saturate(0.4) contrast(1.5)',
};

const FILTER_LABELS: Record<FilterId, string> = {
  none: 'None', noir: 'Noir', vibrant: 'Vibrant', fun: 'Fun',
  spectacular: 'Spectacular', acid: 'Acid', underground: 'Underground',
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Split into bright/dark pools, shuffle each, then interleave.
// Works as a true 2D checkerboard with any odd column count.
const THRESHOLD = 50; // CIE L* midpoint

function checkerboard(photos: Photo[]): Photo[] {
  const bright = shuffle(photos.filter(p => p.luminance >= THRESHOLD));
  const dark = shuffle(photos.filter(p => p.luminance < THRESHOLD));
  const result: Photo[] = [];
  const n = Math.max(bright.length, dark.length);
  for (let i = 0; i < n; i++) {
    if (bright[i]) result.push(bright[i]);
    if (dark[i]) result.push(dark[i]);
  }
  return result;
}

function groupByYear(photos: Photo[]): [string, Photo[]][] {
  const sorted = [...photos].sort((a, b) => b.date_taken.localeCompare(a.date_taken));
  const map = new Map<string, Photo[]>();
  for (const p of sorted) {
    const y = p.date_taken.slice(0, 4);
    if (!map.has(y)) map.set(y, []);
    map.get(y)!.push(p);
  }
  return [...map.entries()]; // newest year first
}

// ── GalleryDrawer ────────────────────────────────────────────────────────────

interface DrawerProps {
  open: boolean;
  layout: LayoutMode;
  onLayout: (l: LayoutMode) => void;
  filter: FilterId;
  onFilter: (f: FilterId) => void;
  onClose: () => void;
}

function GalleryDrawer({ open, layout, onLayout, filter, onFilter, onClose }: DrawerProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(
    <>
      {open && <div className="gallery-drawer-backdrop" onClick={onClose} />}
      <div className={`gallery-drawer${open ? ' gallery-drawer--open' : ''}`}>
        <p className="drawer-section-label">Layout</p>
        <div className="drawer-btn-group">
          {(['flat', 'year'] as LayoutMode[]).map(l => (
            <button
              key={l}
              className={`drawer-btn${layout === l ? ' drawer-btn--active' : ''}`}
              onClick={() => onLayout(l)}
            >
              {l === 'flat' ? 'Flat' : 'By Year'}
            </button>
          ))}
        </div>

        <p className="drawer-section-label">Filter</p>
        <div className="drawer-btn-group">
          {(Object.keys(FILTER_LABELS) as FilterId[]).map(f => (
            <button
              key={f}
              className={`drawer-btn${filter === f ? ' drawer-btn--active' : ''}`}
              onClick={() => onFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── PhotoGallery ─────────────────────────────────────────────────────────────

export default function PhotoGallery({ photos }: Props) {
  const [activeId, setActiveId]     = useState<string | null>(null);
  const [sorted, setSorted]         = useState<Photo[]>(photos);
  const [layout, setLayoutState]    = useState<LayoutMode>('flat');
  const [filter, setFilterState]    = useState<FilterId>('none');
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Persist helpers
  const setLayout = useCallback((l: LayoutMode) => {
    setLayoutState(l);
    localStorage.setItem('gallery-layout', l);
  }, []);

  const setFilter = useCallback((f: FilterId) => {
    setFilterState(f);
    localStorage.setItem('gallery-filter', f);
  }, []);

  // Restore from localStorage on mount
  useEffect(() => {
    const savedLayout = localStorage.getItem('gallery-layout') as LayoutMode | null;
    const savedFilter = localStorage.getItem('gallery-filter') as FilterId | null;
    if (savedLayout === 'flat' || savedLayout === 'year') setLayoutState(savedLayout);
    if (savedFilter && savedFilter in FILTERS) setFilterState(savedFilter);
  }, []);

  // Checkerboard — only in flat mode
  useEffect(() => {
    if (layout === 'flat') setSorted(checkerboard(photos));
  }, [layout, photos]);

  // Open lightbox from URL param on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const photoId = params.get('photo');
    if (photoId && photos.some((p) => p.id === photoId)) {
      setActiveId(photoId);
    }
  }, []);

  const openLightbox = useCallback((id: string) => {
    setActiveId(id);
    history.pushState({ photoId: id }, '', `?photo=${id}`);
  }, []);

  const closeLightbox = useCallback(() => {
    setActiveId(null);
    history.pushState({}, '', window.location.pathname);
  }, []);

  const years = photos.map(p => parseInt(p.date_taken.slice(0, 4)));
  const yearMin = Math.min(...years);
  const yearMax = Math.max(...years);
  const yearLabel = yearMin === yearMax ? String(yearMin) : `${yearMin}–${yearMax}`;

  if (photos.length === 0) {
    return <p className="placeholder-note">No photos yet.</p>;
  }

  // Lightbox photo list: flat uses checkerboard order; year mode uses date-descending
  const lightboxPhotos = layout === 'flat'
    ? sorted
    : [...photos].sort((a, b) => b.date_taken.localeCompare(a.date_taken));

  const gridStyle = filter !== 'none' ? { filter: FILTERS[filter] } : undefined;

  return (
    <div className="photo-gallery">
      <div className="gallery-header">
        <h3 className="gallery-title">
          Photos <span className="gallery-year-range">{yearLabel}</span>
        </h3>
        <button
          className="gallery-config-btn"
          onClick={() => setDrawerOpen(true)}
          aria-label="Gallery settings"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>
      {/* Grid (filter applied here, not to lightbox) */}
      <div style={gridStyle}>
        {layout === 'flat' ? (
          <div className="photo-grid">
            {sorted.map((photo) => (
              <button
                key={photo.id}
                className="photo-cell"
                onClick={() => openLightbox(photo.id)}
                aria-label={`Photo from ${photo.album}`}
              >
                <img
                  src={photo.thumb_url}
                  alt={`Photo from ${photo.album}`}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ))}
          </div>
        ) : (
          groupByYear(photos).map(([year, yearPhotos]) => (
            <section key={year}>
              <h2 className="gallery-year">{year}</h2>
              <div className="photo-grid">
                {yearPhotos.map((photo) => (
                  <button
                    key={photo.id}
                    className="photo-cell"
                    onClick={() => openLightbox(photo.id)}
                    aria-label={`Photo from ${photo.album}`}
                  >
                    <img
                      src={photo.thumb_url}
                      alt={`Photo from ${photo.album}`}
                      loading="lazy"
                      decoding="async"
                    />
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {/* Drawer */}
      <GalleryDrawer
        open={drawerOpen}
        layout={layout}
        onLayout={setLayout}
        filter={filter}
        onFilter={setFilter}
        onClose={() => setDrawerOpen(false)}
      />

      {/* Lightbox */}
      {activeId && (
        <PhotoLightbox
          photos={lightboxPhotos}
          initialId={activeId}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
}

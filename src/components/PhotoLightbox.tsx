import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Photo } from './PhotoGallery';

interface Props {
  photos: Photo[];
  initialId: string;
  onClose: () => void;
}

export default function PhotoLightbox({ photos, initialId, onClose }: Props) {
  // Track by ID to avoid stale-index bugs when photos array is reshuffled
  const [currentId, setCurrentId] = useState(initialId);
  const [showExif, setShowExif] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const currentIndex = photos.findIndex(p => p.id === currentId);
  const photo = photos[currentIndex >= 0 ? currentIndex : 0];
  const isFirst = currentIndex <= 0;
  const isLast = currentIndex >= photos.length - 1;

  // Save + restore focus around dialog
  useEffect(() => {
    prevFocusRef.current = document.activeElement;
    backdropRef.current?.focus();
    return () => { (prevFocusRef.current as HTMLElement | null)?.focus?.(); };
  }, []);

  // Preload adjacent images
  useEffect(() => {
    [photos[currentIndex - 1], photos[currentIndex + 1]].forEach(p => {
      if (p) new Image().src = p.preview_url;
    });
  }, [currentIndex, photos]);

  // Keep URL in sync
  useEffect(() => {
    if (photo) history.replaceState({ photoId: photo.id }, '', `?photo=${photo.id}`);
  }, [photo]);

  const goNext = useCallback(() => {
    const next = photos[currentIndex + 1];
    if (next) setCurrentId(next.id);
  }, [currentIndex, photos]);

  const goPrev = useCallback(() => {
    const prev = photos[currentIndex - 1];
    if (prev) setCurrentId(prev.id);
  }, [currentIndex, photos]);

  // Keyboard: arrows + Escape
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
    // Swipe down to close (dominant vertical downward gesture)
    if (dy > 60 && Math.abs(dy) > Math.abs(dx)) { onClose(); return; }
    // Swipe left/right to navigate
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) goNext(); else goPrev();
    }
  }

  if (!photo) return null;

  const { exif } = photo;
  const formattedDate = photo.date_taken
    ? new Date(photo.date_taken).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

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
      {/* Desktop nav zones — hidden on touch devices via CSS */}
      {!isFirst && (
        <button
          className="lightbox-zone lightbox-zone--prev"
          onClick={(e) => { e.stopPropagation(); goPrev(); }}
          aria-label="Previous photo"
        >
          <span className="lightbox-zone-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </span>
        </button>
      )}
      {!isLast && (
        <button
          className="lightbox-zone lightbox-zone--next"
          onClick={(e) => { e.stopPropagation(); goNext(); }}
          aria-label="Next photo"
        >
          <span className="lightbox-zone-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </button>
      )}

      {/* Photo */}
      <img
        src={photo.preview_url}
        alt={`Photo from ${photo.album}`}
        className="lightbox-img"
      />

      {/* Counter — top center */}
      <div className="lightbox-counter" aria-live="polite">
        {currentIndex + 1} / {photos.length}
      </div>

      {/* Close button — top right, desktop only */}
      <button
        className="lightbox-close"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
      >
        ✕
      </button>

      {/* Camera / info button — bottom right */}
      <button
        className={`lightbox-info-btn${showExif ? ' lightbox-info-btn--active' : ''}`}
        onClick={(e) => { e.stopPropagation(); setShowExif(v => !v); }}
        aria-label="Toggle photo info"
        aria-pressed={showExif}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>

      {/* EXIF panel — floating above info button */}
      {showExif && (
        <div
          className="lightbox-exif"
          role="region"
          aria-label="Photo metadata"
          onClick={(e) => e.stopPropagation()}
        >
          {exif.camera && <div className="exif-row"><span>Camera</span><span>{exif.camera}</span></div>}
          {exif.lens && <div className="exif-row"><span>Lens</span><span>{exif.lens}</span></div>}
          {exif.aperture && <div className="exif-row"><span>Aperture</span><span>{exif.aperture}</span></div>}
          {exif.shutter_speed && <div className="exif-row"><span>Shutter</span><span>{exif.shutter_speed}</span></div>}
          {exif.iso != null && <div className="exif-row"><span>ISO</span><span>{exif.iso}</span></div>}
          {exif.focal_length && (
            <div className="exif-row">
              <span>Focal length</span>
              <span>
                {exif.focal_length}
                {exif.focal_length_35mm ? ` (${exif.focal_length_35mm} eq.)` : ''}
              </span>
            </div>
          )}
          {exif.exposure_compensation && <div className="exif-row"><span>Exp. comp.</span><span>{exif.exposure_compensation}</span></div>}
          {formattedDate && <div className="exif-row"><span>Date</span><span>{formattedDate}</span></div>}
        </div>
      )}
    </div>,
    document.body
  );
}

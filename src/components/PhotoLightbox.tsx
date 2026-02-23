import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Photo } from './PhotoGallery';

interface Props {
  photos: Photo[];
  initialId: string;
  onClose: () => void;
}

export default function PhotoLightbox({ photos, initialId, onClose }: Props) {
  const [currentIndex, setCurrentIndex] = useState(
    () => photos.findIndex((p) => p.id === initialId)
  );
  const [showExif, setShowExif] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(null);
  const touchStartX = useRef(0);

  // Save + restore focus around the dialog lifecycle
  useEffect(() => {
    prevFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      (prevFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  // Preload adjacent images on index change
  useEffect(() => {
    [photos[currentIndex - 1], photos[currentIndex + 1]].forEach((p) => {
      if (p) new Image().src = p.preview_url;
    });
  }, [currentIndex, photos]);

  // Keep URL in sync while navigating inside the lightbox
  useEffect(() => {
    const photo = photos[currentIndex];
    if (photo) {
      history.replaceState({ photoId: photo.id }, '', `?photo=${photo.id}`);
    }
  }, [currentIndex, photos]);

  const goNext = useCallback(() => {
    setCurrentIndex((i) => Math.min(i + 1, photos.length - 1));
  }, [photos.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(i - 1, 0));
  }, []);

  // Keyboard: arrows, Space, Escape, Tab (focus trap)
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'Tab') {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables?.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [goNext, goPrev, onClose]);

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (delta < -50) goNext();
    else if (delta > 50) goPrev();
  }

  const photo = photos[currentIndex];
  if (!photo) return null;

  const { exif } = photo;
  const formattedDate = photo.date_taken
    ? new Date(photo.date_taken).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

  return createPortal(
    <div
      className="lightbox-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Photo viewer"
        className="lightbox-dialog"
        tabIndex={-1}
      >
        <div className="lightbox-image-area">
          <img
            src={photo.preview_url}
            alt={`Photo from ${photo.album}`}
            className="lightbox-img"
          />
        </div>

        <div className="lightbox-controls">
          <button
            className="lightbox-btn"
            onClick={goPrev}
            disabled={currentIndex === 0}
            aria-label="Previous photo"
          >
            ←
          </button>
          <span className="lightbox-counter">
            {currentIndex + 1} / {photos.length}
          </span>
          <button
            className="lightbox-btn"
            onClick={goNext}
            disabled={currentIndex === photos.length - 1}
            aria-label="Next photo"
          >
            →
          </button>
          <button
            className={`lightbox-btn${showExif ? ' lightbox-btn--active' : ''}`}
            onClick={() => setShowExif((v) => !v)}
            aria-label="Toggle photo info"
            aria-pressed={showExif}
          >
            ℹ
          </button>
          <button
            className="lightbox-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {showExif && (
          <div className="lightbox-exif" role="region" aria-label="Photo metadata">
            {exif.camera && (
              <div className="exif-row"><span>Camera</span><span>{exif.camera}</span></div>
            )}
            {exif.lens && (
              <div className="exif-row"><span>Lens</span><span>{exif.lens}</span></div>
            )}
            {exif.aperture && (
              <div className="exif-row"><span>Aperture</span><span>{exif.aperture}</span></div>
            )}
            {exif.shutter_speed && (
              <div className="exif-row"><span>Shutter</span><span>{exif.shutter_speed}</span></div>
            )}
            {exif.iso != null && (
              <div className="exif-row"><span>ISO</span><span>{exif.iso}</span></div>
            )}
            {exif.focal_length && (
              <div className="exif-row">
                <span>Focal length</span>
                <span>
                  {exif.focal_length}
                  {exif.focal_length_35mm ? ` (${exif.focal_length_35mm} eq.)` : ''}
                </span>
              </div>
            )}
            {exif.exposure_compensation && (
              <div className="exif-row"><span>Exp. comp.</span><span>{exif.exposure_compensation}</span></div>
            )}
            {formattedDate && (
              <div className="exif-row"><span>Date</span><span>{formattedDate}</span></div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

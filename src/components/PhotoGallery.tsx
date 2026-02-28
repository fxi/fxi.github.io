import { useState, useEffect, useCallback } from 'react';
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

export default function PhotoGallery({ photos }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Start with the original order so server and client HTML match (no
  // hydration mismatch). Shuffle in an effect — runs only on the client,
  // after hydration is complete.
  const [sorted, setSorted] = useState<Photo[]>(photos);
  useEffect(() => { setSorted(checkerboard(photos)); }, []);

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

  if (photos.length === 0) {
    return <p className="placeholder-note">No photos yet.</p>;
  }

  return (
    <div className="photo-gallery">
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
              width={photo.width}
              height={photo.height}
              alt={`Photo from ${photo.album}`}
              loading="lazy"
              decoding="async"
            />
          </button>
        ))}
      </div>

      {activeId && (
        <PhotoLightbox
          photos={sorted}
          initialId={activeId}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
}

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
}

interface Props {
  photos: Photo[];
}

export default function PhotoGallery({ photos }: Props) {
  const [thumbSize, setThumbSize] = useState(200);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Group photos by album, albums sorted descending
  const albumMap = photos.reduce<Record<string, Photo[]>>((acc, photo) => {
    (acc[photo.album] ??= []).push(photo);
    return acc;
  }, {});
  const albumKeys = Object.keys(albumMap).sort((a, b) => b.localeCompare(a));
  const flatPhotos = albumKeys.flatMap((k) => albumMap[k]);

  // On mount: check ?photo= param for direct link support
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
      <div className="gallery-controls">
        <span className="gallery-count">{photos.length} photos</span>
        <input
          type="range"
          min={120}
          max={400}
          step={10}
          value={thumbSize}
          onChange={(e) => setThumbSize(Number(e.target.value))}
          aria-label="Thumbnail size"
          className="gallery-slider"
        />
      </div>

      {albumKeys.map((album) => (
        <div key={album} className="album-group">
          <div className="album-label">{album}</div>
          <div
            className="photo-grid"
            style={{ '--thumb-size': `${thumbSize}px` } as React.CSSProperties}
          >
            {albumMap[album].map((photo) => (
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
        </div>
      ))}

      {activeId && (
        <PhotoLightbox
          photos={flatPhotos}
          initialId={activeId}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
}

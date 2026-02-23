/**
 * photos-sync.js
 *
 * Processes new photos from public/photos/, uploads resized versions to
 * Exoscale SOS (S3-compatible), and updates src/data/photos.json.
 *
 * Usage:
 *   EXOSCALE_ENDPOINT_STORAGE=https://sos-ch-gva-2.exo.io \
 *   EXOSCALE_S3_BUCKET=fxi-io-media \
 *   EXOSCALE_API_KEY=... \
 *   EXOSCALE_API_SECRET=... \
 *   node scripts/photos-sync.js
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import exifr from 'exifr';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PHOTOS_DIR = join(ROOT, 'public', 'photos');
const CATALOGUE_PATH = join(ROOT, 'src', 'data', 'photos.json');

const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic']);

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256File(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/** Parse a folder name to an ISO date string (YYYY-MM-DD). */
function parseFolderDate(name) {
  // Already ISO: 2025-01-26
  const m1 = name.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;

  // Underscored with month name: 2025_january_26
  const m2 = name.toLowerCase().match(/^(\d{4})_([a-z]+)_(\d{1,2})/);
  if (m2) {
    const month = MONTH_NAMES[m2[2]];
    if (month) {
      return `${m2[1]}-${String(month).padStart(2, '0')}-${String(m2[3]).padStart(2, '0')}`;
    }
  }

  // Fallback: return the folder name as-is
  return name;
}

function formatShutter(val) {
  if (val == null) return null;
  if (val >= 1) return `${val}s`;
  return `1/${Math.round(1 / val)}s`;
}

function formatEV(val) {
  if (val == null) return null;
  if (val === 0) return '0 EV';
  return `${val > 0 ? '+' : ''}${val} EV`;
}

function formatFocalLength(mm) {
  if (mm == null) return null;
  return `${Math.round(mm * 10) / 10}mm`;
}

/** Recursively collect all supported image files under a directory. */
function walkImages(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkImages(full));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) {
        results.push(full);
      }
    }
  }
  return results;
}

// ── S3 client ─────────────────────────────────────────────────────────────────

const endpoint = process.env.EXOSCALE_ENDPOINT_STORAGE;
const region = process.env.EXOSCALE_S3_REGION;
const bucket = process.env.EXOSCALE_S3_BUCKET;
const accessKeyId = process.env.EXOSCALE_API_KEY;
const secretAccessKey = process.env.EXOSCALE_API_SECRET;

if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
  console.error(
    'Missing env vars. Set EXOSCALE_ENDPOINT_STORAGE, EXOSCALE_S3_REGION, EXOSCALE_S3_BUCKET, EXOSCALE_API_KEY, EXOSCALE_API_SECRET.'
  );
  process.exit(1);
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: false,
});

const publicBase = `${endpoint.replace(/\/$/, '')}/${bucket}`;

async function uploadBuffer(key, buffer, contentType = 'image/jpeg') {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      ACL: 'public-read',
    })
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load existing catalogue
  let catalogue = [];
  if (existsSync(CATALOGUE_PATH)) {
    try {
      catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8'));
    } catch {
      catalogue = [];
    }
  }
  const knownIds = new Set(catalogue.map((e) => e.id));

  const images = walkImages(PHOTOS_DIR);
  console.log(`Found ${images.length} image(s) in ${PHOTOS_DIR}`);

  let added = 0;
  let skipped = 0;

  for (const filePath of images) {
    const filename = basename(filePath);
    const buf = readFileSync(filePath);
    const id = sha256File(buf);

    if (knownIds.has(id)) {
      skipped++;
      continue;
    }

    console.log(`Processing ${filename} (${id})…`);

    try {
      // ── EXIF ──────────────────────────────────────────────────────────────
      const raw = await exifr.parse(buf, {
        pick: [
          'DateTimeOriginal', 'Make', 'Model', 'LensModel',
          'FocalLength', 'FocalLengthIn35mmFormat',
          'FNumber', 'ExposureTime', 'ISO', 'ExposureCompensation',
        ],
        // GPS intentionally excluded
        gps: false,
      }).catch(() => null) ?? {};

      // ── Album from EXIF date or folder name ───────────────────────────────
      let album;
      if (raw.DateTimeOriginal) {
        const d = new Date(raw.DateTimeOriginal);
        if (!isNaN(d)) {
          album = d.toISOString().slice(0, 10);
        }
      }
      if (!album) {
        // Derive from relative path: the first sub-directory under public/photos/
        const rel = relative(PHOTOS_DIR, filePath);
        const folderPart = rel.split('/')[0] || rel.split('\\')[0];
        album = parseFolderDate(folderPart);
      }

      const dateTaken = raw.DateTimeOriginal
        ? new Date(raw.DateTimeOriginal).toISOString().replace(/\.\d{3}Z$/, '')
        : `${album}T00:00:00`;

      // ── Image metadata ────────────────────────────────────────────────────
      const meta = await sharp(buf).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;

      // ── Resize ────────────────────────────────────────────────────────────
      const thumbBuf = await sharp(buf)
        .resize({ width: 600, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .withMetadata(false) // strip all metadata
        .toBuffer();

      const previewBuf = await sharp(buf)
        .resize({ width: 1800, withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .withMetadata(false)
        .toBuffer();

      // ── Upload ────────────────────────────────────────────────────────────
      const thumbKey = `photos/${album}/${id}_600.jpg`;
      const previewKey = `photos/${album}/${id}_1800.jpg`;

      await uploadBuffer(thumbKey, thumbBuf);
      await uploadBuffer(previewKey, previewBuf);

      const thumbUrl = `${publicBase}/${thumbKey}`;
      const previewUrl = `${publicBase}/${previewKey}`;

      // ── Build EXIF object ─────────────────────────────────────────────────
      const camera = [raw.Make, raw.Model]
        .filter(Boolean)
        .join(' ')
        .replace(/apple apple/i, 'Apple') // de-duplicate "Apple Apple iPhone"
        || null;

      const exif = {};
      if (camera) exif.camera = camera;
      if (raw.LensModel) exif.lens = raw.LensModel;
      if (raw.FocalLength != null) exif.focal_length = formatFocalLength(raw.FocalLength);
      if (raw.FocalLengthIn35mmFormat != null) exif.focal_length_35mm = formatFocalLength(raw.FocalLengthIn35mmFormat);
      if (raw.FNumber != null) exif.aperture = `f/${raw.FNumber}`;
      if (raw.ExposureTime != null) exif.shutter_speed = formatShutter(raw.ExposureTime);
      if (raw.ISO != null) exif.iso = raw.ISO;
      const ev = formatEV(raw.ExposureCompensation);
      if (ev) exif.exposure_compensation = ev;

      // ── Catalogue entry ───────────────────────────────────────────────────
      const entry = {
        id,
        filename,
        album,
        date_taken: dateTaken,
        date_uploaded: new Date().toISOString(),
        width,
        height,
        thumb_url: thumbUrl,
        preview_url: previewUrl,
        exif,
      };

      catalogue.push(entry);
      knownIds.add(id);
      added++;
      console.log(`  ✓ uploaded → ${thumbKey}`);
    } catch (err) {
      console.error(`  ✗ failed: ${err.message}`);
    }
  }

  // Sort descending by date_taken
  catalogue.sort((a, b) => b.date_taken.localeCompare(a.date_taken));

  writeFileSync(CATALOGUE_PATH, JSON.stringify(catalogue, null, 2) + '\n');
  console.log(`\nDone. Added ${added}, skipped ${skipped}. Catalogue: ${catalogue.length} photo(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

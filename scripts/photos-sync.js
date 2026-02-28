/**
 * photos-sync.js
 *
 * Processes new photos from public/photos/ (flat folder), uploads resized
 * versions to Exoscale SOS (S3-compatible), and updates src/data/photos.json.
 *
 * Usage:
 *   EXOSCALE_FXI_ENDPOINT_STORAGE=https://sos-ch-gva-2.exo.io \
 *   EXOSCALE_FXI_S3_REGION=ch-gva-2 \
 *   EXOSCALE_FXI_S3_BUCKET=fxi-io-media \
 *   EXOSCALE_FXI_API_KEY=... \
 *   EXOSCALE_FXI_API_SECRET=... \
 *   node scripts/photos-sync.js
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import exifr from 'exifr';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PHOTOS_DIR = join(ROOT, 'public', 'photos');
const CATALOGUE_PATH = join(ROOT, 'src', 'data', 'photos.json');

const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic']);

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256File(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/** Convert RGB (0-255) to CIE L*a*b*. Returns [L, a, b]. */
function rgbToLab(r, g, b) {
  let rN = r / 255, gN = g / 255, bN = b / 255;
  rN = rN > 0.04045 ? Math.pow((rN + 0.055) / 1.055, 2.4) : rN / 12.92;
  gN = gN > 0.04045 ? Math.pow((gN + 0.055) / 1.055, 2.4) : gN / 12.92;
  bN = bN > 0.04045 ? Math.pow((bN + 0.055) / 1.055, 2.4) : bN / 12.92;
  const x = (rN * 0.4124 + gN * 0.3576 + bN * 0.1805) * 100;
  const y = (rN * 0.2126 + gN * 0.7152 + bN * 0.0722) * 100;
  const z = (rN * 0.0193 + gN * 0.1192 + bN * 0.9505) * 100;
  let xR = x / 95.047, yR = y / 100.0, zR = z / 108.883;
  xR = xR > 0.008856 ? Math.pow(xR, 1 / 3) : 7.787 * xR + 16 / 116;
  yR = yR > 0.008856 ? Math.pow(yR, 1 / 3) : 7.787 * yR + 16 / 116;
  zR = zR > 0.008856 ? Math.pow(zR, 1 / 3) : 7.787 * zR + 16 / 116;
  return [116 * yR - 16, 500 * (xR - yR), 200 * (yR - zR)];
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

const endpoint = process.env.EXOSCALE_FXI_ENDPOINT_STORAGE;
const region = process.env.EXOSCALE_FXI_S3_REGION;
const bucket = process.env.EXOSCALE_FXI_S3_BUCKET;
const accessKeyId = process.env.EXOSCALE_FXI_API_KEY;
const secretAccessKey = process.env.EXOSCALE_FXI_API_SECRET;

if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
  console.error(
    'Missing env vars. Set EXOSCALE_FXI_ENDPOINT_STORAGE, EXOSCALE_FXI_S3_REGION, EXOSCALE_FXI_S3_BUCKET, EXOSCALE_FXI_API_KEY, EXOSCALE_FXI_API_SECRET.'
  );
  process.exit(1);
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: false,
});

// Virtual-hosted-style public URL: https://{bucket}.sos-ch-gva-2.exo.io
const { protocol, host } = new URL(endpoint);
const publicBase = `${protocol}//${bucket}.${host}`;

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

  const nArg = process.argv.indexOf('--n');
  const limit = nArg !== -1 ? parseInt(process.argv[nArg + 1], 10) : Infinity;

  const images = walkImages(PHOTOS_DIR);
  console.log(`Found ${images.length} image(s) in ${PHOTOS_DIR}${isFinite(limit) ? ` (limiting to ${limit})` : ''}`);

  let added = 0;
  let skipped = 0;
  let attempted = 0;

  for (const filePath of images) {
    const filename = basename(filePath);
    const buf = readFileSync(filePath);
    const id = sha256File(buf);

    if (knownIds.has(id)) {
      skipped++;
      continue;
    }
    if (attempted >= limit) break;
    attempted++;

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

      // ── Album from EXIF date ──────────────────────────────────────────────
      let album = 'unknown';
      if (raw.DateTimeOriginal) {
        const d = new Date(raw.DateTimeOriginal);
        if (!isNaN(d)) album = d.toISOString().slice(0, 10);
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

      // ── Perceptual luminance (CIE L*) ─────────────────────────────────────
      const rawBuf = await sharp(buf)
        .resize(50, 50, { fit: 'inside' })
        .removeAlpha()
        .raw()
        .toBuffer();

      const pixelCount = rawBuf.length / 3;
      let labLSum = 0;
      for (let i = 0; i < rawBuf.length; i += 3) {
        labLSum += rgbToLab(rawBuf[i], rawBuf[i + 1], rawBuf[i + 2])[0];
      }
      const luminance = Math.round((labLSum / pixelCount) * 10) / 10;

      // ── Upload ────────────────────────────────────────────────────────────
      const thumbKey = `photos/${id}_600.jpg`;
      const previewKey = `photos/${id}_1800.jpg`;

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
        luminance,
      };

      catalogue.push(entry);
      knownIds.add(id);
      added++;
      console.log(`  ✓ uploaded → ${thumbKey}`);
    } catch (err) {
      const extra = err.Endpoint ? ` → redirect to: ${err.Endpoint}` : '';
      const code = err.Code ?? err.name ?? '';
      console.error(`  ✗ failed [${code}]: ${err.message}${extra}`);
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

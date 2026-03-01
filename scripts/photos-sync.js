/**
 * photos-sync.js
 *
 * Syncs photos from Photos.app album 'fxi_io_gallery' to Exoscale SOS (S3-compatible)
 * and updates src/data/photos.json. Uses osxphotos to query/export photos directly,
 * eliminating the need for a manual export step.
 *
 * Usage:
 *   EXOSCALE_FXI_ENDPOINT_STORAGE=https://sos-ch-gva-2.exo.io \
 *   EXOSCALE_FXI_S3_REGION=ch-gva-2 \
 *   EXOSCALE_FXI_S3_BUCKET=fxi-io-media \
 *   EXOSCALE_FXI_API_KEY=... \
 *   EXOSCALE_FXI_API_SECRET=... \
 *   node scripts/photos-sync.js [--limit N]
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CATALOGUE_PATH = join(ROOT, 'src', 'data', 'photos.json');
const ALBUM = 'fxi_io_gallery';

// ── helpers ──────────────────────────────────────────────────────────────────

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

/** Build a catalogue exif object from osxphotos exif_info. */
function buildExif(info) {
  if (!info) return {};
  const exif = {};
  const camera = [info.camera_make, info.camera_model]
    .filter(Boolean)
    .join(' ')
    .replace(/apple apple/i, 'Apple')
    || null;
  if (camera) exif.camera = camera;
  if (info.lens_model) exif.lens = info.lens_model;
  if (info.focal_length != null) exif.focal_length = formatFocalLength(info.focal_length);
  if (info.aperture != null) exif.aperture = `f/${info.aperture}`;
  if (info.shutter_speed != null) exif.shutter_speed = formatShutter(info.shutter_speed);
  if (info.iso != null) exif.iso = info.iso;
  const ev = formatEV(info.exposure_bias);
  if (ev) exif.exposure_compensation = ev;
  return exif;
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

const { protocol, host } = new URL(endpoint);
const publicBase = `${protocol}//${bucket}.${host}`;

async function uploadBuffer(key, buffer, contentType = 'image/webp') {
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

async function deleteFromS3(entry) {
  // Legacy sha256 entries used .jpg; UUID entries use .webp
  const ext = entry.id.includes('-') ? 'webp' : 'jpg';
  const keys = [`photos/${entry.id}_600.${ext}`, `photos/${entry.id}_1800.${ext}`];
  await Promise.all(
    keys.map(Key =>
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key })).catch(err => {
        console.warn(`  ⚠ could not delete ${Key}: ${err.message}`);
      })
    )
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Query album ─────────────────────────────────────────────────────────
  console.log(`Querying Photos.app album "${ALBUM}"…`);
  const queryResult = spawnSync('osxphotos', ['query', '--album', ALBUM, '--json'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (queryResult.status !== 0) {
    console.error('osxphotos query failed:', queryResult.stderr);
    process.exit(1);
  }
  const albumPhotos = JSON.parse(queryResult.stdout).filter(p => p.isphoto);
  const albumByUuid = new Map(albumPhotos.map(p => [p.uuid, p]));
  console.log(`  ${albumPhotos.length} photo(s) in album`);

  // ── 2. Load catalogue ──────────────────────────────────────────────────────
  let catalogue = [];
  if (existsSync(CATALOGUE_PATH)) {
    try { catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')); } catch { /* empty */ }
  }

  // Partition into UUID-based (new) and legacy sha256 entries
  const uuidEntries = catalogue.filter(e => e.id.includes('-'));
  const legacyEntries = catalogue.filter(e => !e.id.includes('-'));

  // ── 3. Diff ────────────────────────────────────────────────────────────────
  const keptUuids = new Set(uuidEntries.filter(e => albumByUuid.has(e.id)).map(e => e.id));
  const toDelete = [
    ...legacyEntries,
    ...uuidEntries.filter(e => !albumByUuid.has(e.id)),
  ];
  const toAdd = albumPhotos.filter(p => !keptUuids.has(p.uuid));

  // Apply --limit N
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;
  const toAddLimited = isFinite(limit) ? toAdd.slice(0, limit) : toAdd;

  console.log(`  To remove: ${toDelete.length}, to add: ${toAdd.length}${isFinite(limit) ? ` (limited to ${toAddLimited.length})` : ''}, unchanged: ${keptUuids.size}`);

  // ── 4. Delete removed / legacy photos ─────────────────────────────────────
  if (toDelete.length > 0) {
    console.log(`\nDeleting ${toDelete.length} photo(s) from S3 and catalogue…`);
    await Promise.all(toDelete.map(entry => deleteFromS3(entry)));
    const deleteIds = new Set(toDelete.map(e => e.id));
    catalogue = catalogue.filter(e => !deleteIds.has(e.id));
    console.log(`  ✓ ${toDelete.length} removed`);
  }

  // ── 5. Export new photos via osxphotos ────────────────────────────────────
  if (toAddLimited.length === 0) {
    console.log('\nNothing to add.');
  } else {
    const tmpDir = mkdtempSync(join(tmpdir(), 'photos-sync-'));
    try {
      console.log(`\nExporting ${toAddLimited.length} photo(s) from Photos.app…`);
      const uuidFile = join(tmpDir, 'uuids.txt');
      writeFileSync(uuidFile, toAddLimited.map(p => p.uuid).join('\n'));

      const exportResult = spawnSync(
        'osxphotos',
        [
          'export', tmpDir,
          '--uuid-from-file', uuidFile,
          '--skip-original-if-edited',
          '--convert-to-jpeg',
          '--filename', '{uuid}',
          '--edited-suffix', '',
          '--no-progress',
        ],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      if (exportResult.status !== 0) {
        console.error('osxphotos export failed:', exportResult.stderr);
        process.exit(1);
      }

      // ── 6. Process + upload ────────────────────────────────────────────────
      let added = 0;
      for (const photo of toAddLimited) {
        const exportedPath = ['.jpeg', '.jpg', '.png']
          .map(ext => join(tmpDir, `${photo.uuid}${ext}`))
          .find(p => existsSync(p));
        if (!exportedPath) {
          console.error(`  ✗ exported file missing for ${photo.uuid} (${photo.original_filename})`);
          continue;
        }

        console.log(`  Processing ${photo.original_filename} (${photo.uuid})…`);
        try {
          const buf = readFileSync(exportedPath);

          // Resize → WebP
          const thumbBuf = await sharp(buf)
            .resize({ width: 600, withoutEnlargement: true })
            .webp({ quality: 85 })
            .withMetadata(false)
            .toBuffer();

          const previewBuf = await sharp(buf)
            .resize({ width: 1800, withoutEnlargement: true })
            .webp({ quality: 88 })
            .withMetadata(false)
            .toBuffer();

          // Perceptual luminance (CIE L*)
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

          // Upload
          const thumbKey = `photos/${photo.uuid}_600.webp`;
          const previewKey = `photos/${photo.uuid}_1800.webp`;
          await uploadBuffer(thumbKey, thumbBuf);
          await uploadBuffer(previewKey, previewBuf);

          catalogue.push({
            id: photo.uuid,
            filename: photo.original_filename,
            album: photo.date.slice(0, 10),
            date_taken: photo.date,
            date_uploaded: new Date().toISOString(),
            width: photo.original_width,
            height: photo.original_height,
            thumb_url: `${publicBase}/${thumbKey}`,
            preview_url: `${publicBase}/${previewKey}`,
            exif: buildExif(photo.exif_info),
            luminance,
          });
          added++;
          console.log(`    ✓ uploaded → ${thumbKey}`);
        } catch (err) {
          const extra = err.Endpoint ? ` → redirect to: ${err.Endpoint}` : '';
          const code = err.Code ?? err.name ?? '';
          console.error(`    ✗ failed [${code}]: ${err.message}${extra}`);
        }
      }
      console.log(`\n  ✓ Added ${added}/${toAddLimited.length}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ── 7. Sort + write catalogue ──────────────────────────────────────────────
  catalogue.sort((a, b) => b.date_taken.localeCompare(a.date_taken));
  writeFileSync(CATALOGUE_PATH, JSON.stringify(catalogue, null, 2) + '\n');
  console.log(`\nDone. Catalogue: ${catalogue.length} photo(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

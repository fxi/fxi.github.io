/**
 * tracks-sync.js
 *
 * Syncs Strava activities listed in src/tracks/featured.yaml to Exoscale SOS
 * and updates src/data/tracks.json.
 *
 * Uploads per activity:
 *   tracks/{id}.gpx              — stripped GPX (lat/lon/ele only)
 *   tracks/{id}_photo_600.webp   — activity photo 600 px wide
 *   tracks/{id}_photo_1200.webp  — activity photo 1200 px wide
 *   tracks/{id}_map.webp         — static map thumbnail via MapTiler
 *
 * Usage:
 *   node --env-file=.env scripts/tracks-sync.js
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FEATURED_PATH = join(ROOT, 'src', 'tracks', 'featured.yaml');
const CATALOGUE_PATH = join(ROOT, 'src', 'data', 'tracks.json');

const MAPTILER_MAP_ID = '01984598-44d5-70a4-b028-6ce2d6f3027a';
const MAP_W = 825;
const MAP_H = 350;
const GEOMETRY_MAX_PTS = 300;  // stored in JSON for interactive map
const THUMBNAIL_MAX_PTS = 150; // points for static map URL / encoded polyline

// ── env ───────────────────────────────────────────────────────────────────────

const {
  EXOSCALE_FXI_ENDPOINT_STORAGE: endpoint,
  EXOSCALE_FXI_S3_REGION: region,
  EXOSCALE_FXI_S3_BUCKET: bucket,
  EXOSCALE_FXI_API_KEY: accessKeyId,
  EXOSCALE_FXI_API_SECRET: secretAccessKey,
  STRAVA_ID: stravaClientId,
  STRAVA_SECRET: stravaClientSecret,
  STRAVA_REFRESH_TOKEN: stravaRefreshToken,
  STRAVA_ACCESS_TOKEN: stravaAccessTokenEnv,
  MAPTILER_KEY: maptilerKey,
  MAPTILER_KEY_SERVER: maptilerKeyServer,
} = process.env;

// Server-side thumbnail generation needs an unrestricted key.
// MAPTILER_KEY_SERVER — no origin restrictions (create at cloud.maptiler.com/account/keys/).
// Falls back to MAPTILER_KEY if MAPTILER_KEY_SERVER is not set, but that key
// is likely domain-restricted and will return 403 from a Node.js process.
const thumbnailKey = maptilerKeyServer || maptilerKey;

if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('Missing S3 env vars (EXOSCALE_FXI_*).');
  process.exit(1);
}
if (!thumbnailKey) {
  console.error('Missing MAPTILER_KEY_SERVER (or MAPTILER_KEY) for map thumbnail generation.');
  process.exit(1);
}
if (!stravaClientId || !stravaClientSecret) {
  console.error('Missing STRAVA_ID or STRAVA_SECRET.');
  process.exit(1);
}

// ── S3 ────────────────────────────────────────────────────────────────────────

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: false,
});

const { protocol, host } = new URL(endpoint);
const publicBase = `${protocol}//${bucket}.${host}`;

async function s3Put(key, body, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable', ACL: 'public-read',
  }));
}

async function s3Delete(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    .catch(err => console.warn(`  ⚠ could not delete ${key}: ${err.message}`));
}

// ── Strava ────────────────────────────────────────────────────────────────────

async function getStravaToken() {
  if (stravaRefreshToken) {
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: stravaClientId,
        client_secret: stravaClientSecret,
        grant_type: 'refresh_token',
        refresh_token: stravaRefreshToken,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      console.log('  ✓ Strava token refreshed');
      return data.access_token;
    }
    console.warn('  ⚠ Refresh failed, falling back to STRAVA_ACCESS_TOKEN');
  }
  if (stravaAccessTokenEnv) return stravaAccessTokenEnv;
  throw new Error('Could not obtain Strava access token — set STRAVA_REFRESH_TOKEN or STRAVA_ACCESS_TOKEN');
}

async function stravaGet(path, token) {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strava GET ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── geometry helpers ──────────────────────────────────────────────────────────

/** Uniform downsampling, always keeping first and last points. */
function downsample(arr, maxPts) {
  if (arr.length <= maxPts) return arr;
  const step = (arr.length - 1) / (maxPts - 1);
  return Array.from({ length: maxPts }, (_, i) => arr[Math.round(i * step)]);
}

function calcBbox(points) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lon, lat] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return [minLon, minLat, maxLon, maxLat];
}

function buildGpx(points) {
  const trkpts = points
    .map(([lon, lat, ele]) =>
      `    <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${Math.round(ele)}</ele></trkpt>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="fxi.io" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

// ── Google Encoded Polyline (lat/lng order per spec) ─────────────────────────

function encodePolylineValue(val) {
  val = val < 0 ? ~(val << 1) : (val << 1);
  let out = '';
  while (val >= 0x20) {
    out += String.fromCharCode((0x20 | (val & 0x1f)) + 63);
    val >>= 5;
  }
  return out + String.fromCharCode(val + 63);
}

function encodePolyline(points) {
  // points: [lon, lat, ele] — encode as lat,lon pairs per Google spec
  let out = '', prevLat = 0, prevLon = 0;
  for (const [lon, lat] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLon = Math.round(lon * 1e5);
    out += encodePolylineValue(iLat - prevLat);
    out += encodePolylineValue(iLon - prevLon);
    prevLat = iLat; prevLon = iLon;
  }
  return out;
}

// ── MapTiler static map thumbnail ─────────────────────────────────────────────

async function generateMapThumbnail(points) {
  const pts = downsample(points, THUMBNAIL_MAX_PTS);

  // Explicit lon,lat pairs — user-confirmed MapTiler format.
  // MapTiler parses the path value with literal | separators (not %7C),
  // so we build the URL string manually rather than using searchParams.
  const coords = pts.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join('|');
  const pathValue = `fill:none|width:2|stroke:00cccc|${coords}`;
  const apiUrl = `https://api.maptiler.com/maps/${MAPTILER_MAP_ID}/static/auto/${MAP_W}x${MAP_H}.png?key=${thumbnailKey}&path=${pathValue}`;

  console.log(`    URL: ${apiUrl.replace(maptilerKey, '***')}`);

  const res = await fetch(apiUrl);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`    ⚠ MapTiler static API ${res.status} — falling back to SVG render`);
    if (!text.startsWith('\x89PNG')) console.warn(`    ${text.slice(0, 200)}`);
    return buildSVGThumbnail(points);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return sharp(buf).webp({ quality: 88 }).toBuffer();
}

// ── SVG fallback thumbnail (local, no API) ────────────────────────────────────

function buildSVGThumbnail(points) {
  const pts = downsample(points, THUMBNAIL_MAX_PTS);
  const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);

  const pad = Math.round(MAP_W * 0.08);
  const W = MAP_W - pad * 2, H = MAP_H - pad * 2;
  const lonRange = maxLon - minLon || 0.001;
  const latRange = maxLat - minLat || 0.001;
  const scale = Math.min(W / lonRange, H / latRange);
  const offX = pad + (W - lonRange * scale) / 2;
  const offY = pad + (H - latRange * scale) / 2;

  const toX = lon => offX + (lon - minLon) * scale;
  const toY = lat => (MAP_H - offY) - (lat - minLat) * scale;

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`).join('');
  const sx = toX(pts[0][0]).toFixed(1),      sy = toY(pts[0][1]).toFixed(1);
  const ex = toX(pts.at(-1)[0]).toFixed(1),  ey = toY(pts.at(-1)[1]).toFixed(1);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_W}" height="${MAP_H}">
  <rect width="${MAP_W}" height="${MAP_H}" fill="#1a1a18"/>
  <defs><filter id="g"><feGaussianBlur stdDeviation="5" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
  <path d="${d}" fill="none" stroke="#00cccc" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" opacity="0.18"/>
  <path d="${d}" fill="none" stroke="#00e5e5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" filter="url(#g)" opacity="0.92"/>
  <circle cx="${sx}" cy="${sy}" r="5" fill="#00e5e5" stroke="#1a1a18" stroke-width="2"/>
  <circle cx="${ex}" cy="${ey}" r="5" fill="#00cccc" stroke="#1a1a18" stroke-width="2"/>
</svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 88 }).toBuffer();
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Parse featured list
  const featured = parseYaml(readFileSync(FEATURED_PATH, 'utf8'));
  const featuredById = new Map(featured.map(f => [String(f.id), f]));
  console.log(`Featured: ${featured.length} route(s) in ${FEATURED_PATH}`);

  // 2. Load existing catalogue
  let catalogue = [];
  if (existsSync(CATALOGUE_PATH)) {
    try { catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')); } catch { /* empty */ }
  }
  const catalogueById = new Map(catalogue.map(e => [e.id, e]));

  // 3. Diff
  const toAdd = featured.filter(f => !catalogueById.has(String(f.id)));
  const toDelete = catalogue.filter(e => !featuredById.has(e.id));
  console.log(`  To add: ${toAdd.length}, to remove: ${toDelete.length}, unchanged: ${catalogue.length - toDelete.length}`);

  // 4. Delete removed entries
  if (toDelete.length > 0) {
    console.log(`\nDeleting ${toDelete.length} route(s) from S3…`);
    for (const entry of toDelete) {
      await Promise.all([
        s3Delete(`tracks/${entry.id}.gpx`),
        s3Delete(`tracks/${entry.id}_map.webp`),
        // legacy single-photo format
        s3Delete(`tracks/${entry.id}_photo_600.webp`),
        s3Delete(`tracks/${entry.id}_photo_1200.webp`),
        // multi-photo format (up to 3)
        ...([0, 1, 2].map(i => s3Delete(`tracks/${entry.id}_photo_${i}_600.webp`))),
      ]);
      console.log(`  ✓ removed ${entry.id}`);
    }
    catalogue = catalogue.filter(e => featuredById.has(e.id));
  }

  // 5. Add new entries
  if (toAdd.length > 0) {
    console.log('\nObtaining Strava access token…');
    const token = await getStravaToken();

    // Verify token scope — activity:read is required
    const athlete = await stravaGet('/athlete', token);
    console.log(`  Authenticated as: ${athlete.firstname} ${athlete.lastname} (id ${athlete.id})`);
    // Strava doesn't expose granted scopes via API; log a reminder
    console.log('  (Token must have activity:read or activity:read_all scope)');

    for (const feat of toAdd) {
      const id = String(feat.id);
      console.log(`\nProcessing activity ${id}…`);
      try {
        // Activity metadata
        const activity = await stravaGet(`/activities/${id}?include_all_efforts=false`, token);
        console.log(`  "${activity.name}" — ${(activity.distance / 1000).toFixed(1)} km`);

        // GPS + altitude streams
        const streams = await stravaGet(
          `/activities/${id}/streams?keys=latlng,altitude&key_by_type=true`,
          token,
        );
        const latlng = streams.latlng?.data ?? [];
        const altitude = streams.altitude?.data ?? [];
        if (latlng.length === 0) throw new Error('No GPS stream');

        // [lon, lat, ele] — GeoJSON coordinate order
        const fullPoints = latlng.map(([lat, lng], i) => [lng, lat, altitude[i] ?? 0]);

        // GPX from full track
        const gpxStr = buildGpx(fullPoints);

        // Simplified geometry stored in JSON (for interactive map)
        const geometry = downsample(fullPoints, GEOMETRY_MAX_PTS);

        // Static map thumbnail
        console.log('  Generating map thumbnail…');
        const mapBuf = await generateMapThumbnail(fullPoints);

        // Activity photos — up to 3
        const photoUrls = [];
        if ((activity.total_photo_count ?? 0) > 0) {
          const stravaPhotos = await stravaGet(
            `/activities/${id}/photos?photo_sources=true&size=2000`,
            token,
          );
          const toFetch = stravaPhotos.slice(0, 3);
          console.log(`  Downloading ${toFetch.length} photo(s)…`);
          for (let i = 0; i < toFetch.length; i++) {
            const p = toFetch[i];
            const photoUrl = p?.urls?.['2000'] ?? p?.urls?.[Object.keys(p?.urls ?? {})[0]];
            if (!photoUrl) continue;
            const pRes = await fetch(photoUrl);
            if (!pRes.ok) continue;
            const raw = Buffer.from(await pRes.arrayBuffer());
            const buf600 = await sharp(raw)
              .resize({ width: 600, withoutEnlargement: true })
              .webp({ quality: 85 }).withMetadata(false).toBuffer();
            await s3Put(`tracks/${id}_photo_${i}_600.webp`, buf600, 'image/webp');
            photoUrls.push(`${publicBase}/tracks/${id}_photo_${i}_600.webp`);
          }
        }

        // Upload GPX + map
        console.log('  Uploading to S3…');
        await s3Put(`tracks/${id}.gpx`, gpxStr, 'application/gpx+xml');
        await s3Put(`tracks/${id}_map.webp`, mapBuf, 'image/webp');

        catalogue.push({
          id,
          name: feat.name ?? activity.name,
          date: (activity.start_date_local ?? activity.start_date ?? '').slice(0, 10),
          sport_type: activity.sport_type ?? activity.type,
          distance_km: Math.round((activity.distance / 1000) * 10) / 10,
          elevation_gain_m: Math.round(activity.total_elevation_gain),
          moving_time_s: activity.moving_time ?? 0,
          difficulty: feat.d ?? null,
          scenic: feat.s ?? null,
          endurance: feat.e ?? null,
          map_url: `${publicBase}/tracks/${id}_map.webp`,
          photos: photoUrls,
          gpx_url: `${publicBase}/tracks/${id}.gpx`,
          bbox: calcBbox(fullPoints),
          geometry,
        });

        console.log(`  ✓ done`);
      } catch (err) {
        console.error(`  ✗ ${id}: ${err.message}`);
      }
    }
  }

  // 6. Preserve featured.yaml order
  const order = featured.map(f => String(f.id));
  catalogue.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  writeFileSync(CATALOGUE_PATH, JSON.stringify(catalogue, null, 2) + '\n');
  console.log(`\nDone. Catalogue: ${catalogue.length} route(s).`);
}

main().catch(err => { console.error(err); process.exit(1); });

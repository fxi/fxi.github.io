# fxi.io

Personal portfolio site for Fred Moser. Built with Astro, React, and MapLibre GL.

## Stack

- [Astro](https://astro.build) — static site generator with MDX support
- [React](https://react.dev) — interactive components (photo gallery, route map)
- [MapLibre GL](https://maplibre.org) — vector map on the /routes page
- [Exoscale SOS](https://www.exoscale.com/object-storage/) — S3-compatible object storage for media (photos, GPX files)
- [Strava API](https://developers.strava.com) — activity data for routes
- [MapTiler](https://www.maptiler.com) — map style / tiles

## Pages

| Route | Description |
|---|---|
| `/` | Home |
| `/about` | About |
| `/projects` | Projects |
| `/publications` | Publications |
| `/photos` | Photo gallery (synced from Photos.app) |
| `/routes` | Interactive route map (synced from Strava) |
| `/posts` | Blog posts (MDX) |

## Development

```sh
npm install
npm run dev        # http://localhost:4321
```

Requires a `.env` file — copy `.env.demo` and fill in the values.

## Sync scripts

### Photos — `npm run photos:sync`

Reads from a macOS Photos.app album named `fxi_io_gallery`, resizes and converts to WebP
via `sharp`, uploads to Exoscale SOS, and updates `src/data/photos.json`.

Requires: [`osxphotos`](https://github.com/RhetTbull/osxphotos) (`pip install osxphotos`)
and the Exoscale env vars.

### Routes — `npm run tracks:sync`

Reads `src/tracks/featured.yaml` (list of Strava activity IDs with optional metadata),
fetches GPS streams and activity photos from the Strava API, uploads GPX files and photo
thumbnails (600 px WebP) to Exoscale SOS, and updates `src/data/tracks.json`.

The script is incremental: only new entries are fetched from Strava; removed entries are
deleted from S3.

**featured.yaml fields:**

```yaml
- id: "1234567890"      # Strava activity ID (required)
  name: My Route        # override Strava activity name (optional)
  d: 3                  # difficulty  1-5 (optional)
  s: 4                  # scenic      1-5 (optional)
  e: 3                  # endurance   1-5 (optional)
```

**Strava setup:** create an app at https://www.strava.com/settings/api, complete the OAuth
flow once to get a refresh token with `activity:read_all` scope, then store it in `.env`.
The script refreshes the access token automatically on each run.

## Environment variables

See `.env.demo` for the full list. The file is split into two groups:

- **Exoscale** — object storage credentials (required for both sync scripts and for the
  map to load GPX files in the browser)
- **Strava / MapTiler** — required only for `tracks:sync` and the map style respectively

## Build

```sh
npm run build      # outputs to dist/
npm run preview    # preview the production build locally
```

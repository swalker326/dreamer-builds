# Undertow

Day 8 · Oct 5, 2026 · live public-data visualization

A calm single-page piece that shows the tides of North America breathing. About 35 NOAA CO-OPS tide stations around the Atlantic, Gulf, Pacific, Alaska, Hawaiʻi, and the Caribbean glow as columns whose height tracks predicted water level. A scrubber and play control let you sweep several days at accelerated speed so the tidal wave is visible traveling the coasts. Color encodes rising (teal) vs falling (rose). Hover or tap a station for name, height, and next high/low. Optional soft Web Audio tones (off by default) track water level.

## How it works

- On load the page tries a live fetch from the NOAA CO-OPS datagetter API (`application=dreamer`, CORS open). If that fails, it uses the baked `data.json` snapshot.
- Station positions are a simple lon/lat projection on a dark abstract field — no map tiles.
- Predictions cover hourly heights (MLLW, metric, GMT) for a few days around Oct 5, 2026.

## Data

- Source: [NOAA CO-OPS Tides & Currents](https://tidesandcurrents.noaa.gov/)
- Predictions API: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
- Station list: `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions`

## Run

Serve the folder over HTTP (needed for `fetch` of `data.json` and live NOAA):

```bash
python3 -m http.server 8765
# open http://localhost:8765/
```

No build step, no frameworks.

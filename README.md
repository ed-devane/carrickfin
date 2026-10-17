# Carrickfin

Location-based music for Carrickfin strand, Donegal. Composition and mapping tools by Ed Devane.

Plain HTML/CSS/JS, no build step. Hosted on GitHub Pages.

## Layout

```
index.html              landing page
tools/sensor-test/      milestone 1: GPS / compass / keep-alive test
shared/                 code shared by editor and player
  geo.js                lat/lng ↔ local metres
  smoothing.js          position + heading smoothing
  compass.js            iOS + Android compass heading
  keepalive.js          wake lock + pocket mode
editor/                 (milestone 2)
player/                 (milestone 4)
pieces/<name>/          piece.json + audio
```

## Running locally

```
python -m http.server 8000
```

Then open http://localhost:8000. Desktop browsers can't use the compass, and phones need HTTPS for GPS and compass, so test on phones through the GitHub Pages URL.

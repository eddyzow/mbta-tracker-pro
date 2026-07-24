# MBTA Tracker Pro

A fast, real-time map of the Massachusetts Bay Transportation Authority (MBTA) —
every subway train, commuter-rail set, and ferry — built on the official
[MBTA v3 API](https://api-v3.mbta.com/). An **[eddyzow.net](https://eddyzow.net)** project.

**Live:** https://eddyzow.net/mbta-tracker-pro

## Why use this over Apple/Google Maps?

Maps apps give you a route and a timetable ETA. They don't show you **where the
trains actually are**. MBTA Tracker Pro plans your trip *around the real trains
running right now* — telling you which specific train to catch, how many minutes
you have, and whether it's running late — then shows it moving on the map.

## Features

- **Network-wide trip planner** — pick any two stations across the *whole* system
  (subway ↔ commuter rail ↔ ferry, with transfers) and get a multi-leg journey.
  "Leave now" fuses live vehicle predictions to find the train you can actually
  catch; a later departure falls back to the schedule.
- **Live vehicle tracking** with **route-following interpolation** — trains glide
  *along the tracks* between the ~30s updates (dead-reckoned by speed + report
  time), never cutting across corners. Arrows point in the direction of travel.
- **Trip tracker** — click a train to follow its whole run stop-by-stop; the map
  highlights its previous/next stops with a live pulse.
- **Delay tracker** — per-train delay from predictions vs. schedule.
- **Service alerts & closures** — automatic shuttle / suspension / closure
  detection: global banner, an Alerts tab, and per-line badges.
- **New-train spotting (CRRC)** — flags the new CRRC-built cars
  (Orange 1400–1551, Red 1900–2151).
- **Whole-system map** drawn by default; selecting a line brightens it. Sleek
  dark UI (Geist), tuned trackpad/mouse zoom, mobile-friendly.

## Architecture

- Static front end (`docs/`, GitHub Pages).
- **Route data + live vehicle positions**: Socket.IO data server
  (`eddyzow.herokuapp.com`).
- **Alerts, predictions, schedules, trip data, per-route live vehicles**:
  fetched **directly** from the MBTA v3 API in the browser (CORS-open, no key).
  Note: the keyless API is rate-limited (~20 req/min); calls are kept gentle.

## Local development

```bash
cd docs && python3 -m http.server 8848   # then open http://localhost:8848
```

### Offline / UI testing (`?mock`)

Append `?mock` to replay a captured server payload from `docs/__mock.json`
instead of the live socket (useful when the socket origin isn't allow-listed
locally). Direct MBTA API features still use live data. The mock file is not
committed; regenerate it as `{ "routeData": [...], "vehicles": {...} }` from a
captured `mbta-route-data` + `mbta-vehicle-update` payload.

Open-source, as always.

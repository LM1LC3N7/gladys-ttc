# CLAUDE.md

Guidance for Claude Code (and any other contributor) working in this repository.

## What this project is

An **external Gladys Assistant integration** for Toronto public transit (TTC).
It runs as a Docker container next to a Gladys instance, talks to Gladys
through the official SDK (`@gladysassistant/integration-sdk`), and publishes
**read-only** devices: one per watched stop, one for the line status (subway
Lines 1, 2, 4, LRT Lines 5, 6), one per watched Bike Share Toronto station.

Not affiliated with the TTC, the City of Toronto nor Bike Share Toronto. Data:
the TTC static GTFS (City of Toronto open data, shipped as a stop table in
`gtfs/`), the TTC NextBus API (real time, keyless), the TTC live alerts
(keyless), Transitous (keyless: the subway and LRT timetable, stop
descriptions) and the open Bike Share Toronto GBFS feed. **No key anywhere.**

**Inactive shared code.** The TTC needs neither a key nor the GTFS-Realtime
decoder: `NETWORK.realtime.keyless` hides every key setting, button and
message, and the departures and alerts come through `stopFeed` and
`lineAlerts` (src/network.js). `src/api/gtfsRealtime.js` and the TripUpdates
path of `src/api/realtime.js` stay, unused, to keep the code identical to the
sister repositories (they are tested in gladys-translink); the decoder still
gives src/network.js its effect and severity constants.

**Design goal: usable by somebody who is not technical.** Nothing to type to
start: the house location (`location: true`) gives the suggested stops and
stations, there is no key, and the connection status line (`src/status.js`)
always says what to do next. Keep it that way: every new setting needs a
default that works, and every failure a message that says what to do.

**Sister integrations.** `gladys-translink` (Vancouver), `gladys-octranspo`
(Ottawa), `gladys-rtc-quebec` (Québec) and `gladys-ttc` (Toronto) share this
code base, derived from `gladys-stm` (Montréal). Everything that names the
network lives in `src/network.js`, its data in `gtfs/`, its texts in the
manifest and the docs: the rest of the code is identical in the four
repositories, and a fix to it belongs in the four (and in gladys-stm when it
applies there).

## Commands

```bash
npm ci
npm test               # node --test, no framework, no network access
npm run lint           # eslint
npm run format         # prettier --write .
npm run format:check   # what CI checks
npm run update-stops   # regenerate gtfs/ from the TTC static GTFS (network)
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `npm test`, `npm run lint` and `npm run format:check` before every commit:
CI (`.github/workflows/ci.yml`) runs the three. The CI minutes are counted:
batch the pushes (one push a day at most, unless asked otherwise).

## Layout

```
index.js                      SDK wiring only: handlers, connect, status
src/network.js                the network: operator, feeds, key, lines, bike share
src/config.js                 defaults, type coercion, watch-list mini-syntax, request estimate
src/api/http.js               fetch with timeout and User-Agent
src/api/stops.js              the stop table (gtfs/): code → stop_ids, search, nearby, route labels
src/api/gtfsRealtime.js       minimal GTFS-Realtime decoder (watched stops only; alerts)
src/api/realtime.js           operator feeds (key or open): departures, feed caches, errors
src/api/lines.js              line status from the service alerts (GTFS-RT or translated JSON)
src/api/bikes.js              bike share GBFS client, per-cycle cache, station search
src/api/transitous.js         Transitous: departures of a stop code, descriptions
src/status.js                 the connection status line: what the user must do next
src/devices/index.js          device registry (typed + suggested + created) + manifest actions
src/devices/suggestions.js    the stops and bike stations closest to the house
src/devices/stop.js           one device per watched stop
src/devices/lineStatus.js     the line status device
src/devices/bikeStation.js    one device per watched bike station
src/devices/pollSchedule.js   drops the poll ticks inside the configured interval
src/devices/stateCache.js     drops the states that did not move since the last read
src/devices/publish.js        publishes only to the features the created device has
src/devices/readings.js       last reading per device, shared with the widgets
src/devices/refreshLoop.js    the container's own ticker over the created devices
src/scenes/triggers.js        scene events, computed between two polls of a device
src/scenes/actions.js         scene actions: a fresh read handed to the scene
src/widgets/index.js          dashboard widgets
scripts/update-stops.mjs      generates gtfs/ from the static GTFS (ZIP + CSV, no dependency)
gtfs/                         the stop table, shipped with the image
test/                         node:test suites; helpers: fake SDK, fetch stub, GTFS-RT encoder, fixtures
docs/en.md, docs/fr.md        user documentation (re-hosted by Gladys)
gladys-assistant-integration.json   the store manifest
```

Keep the separation: `index.js` holds no transit logic, `src/api/` only reads
the sources, `src/devices/` only turns a reading into features, `src/scenes/`
and `src/widgets/` only turn a blueprint's `read` into events, outputs and
cards.

## Data sources: what is known and how

- **Stop codes**: the number on the sign (texted to 898882) is the GTFS
  `stop_code`, equal to the `stop_id` for every stop (checked on the static
  GTFS of 2026-09: 9,409 stops, no station rows). A subway or LRT platform is
  a stop of its own, one per direction ("Union Station - Northbound Platform
  Towards Finch"). `gtfs/stops.json` holds `[code, name, lat, lon, ids,
query]`, and a 7th element `1` on the 234 platforms served only by the
  routes of `NETWORK.gtfs.scheduleOnlyRoutes` (1, 2, 4, 5, 6): no real time
  covers them, they read the Transitous timetable (`stopSource` in
  src/devices/stop.js). `npm run update-stops` scans the 200 MB
  stop_times.txt for it.
- **Routes**: `route_id` equals the short name ("504", "1" for Line 1).
- **Real time**: the NextBus API,
  `webservices.umoiq.com/service/publicXMLFeed?command=predictions&a=ttc&stopId=<code>`,
  keyless, one request per stop and refresh interval (`getStopFeed`). Its
  `stopId` is the sign number, `routeTag` the route_id, `tripTag` the GTFS
  trip_id, the direction title the GTFS headsign; no delay. A stop it does
  not know (the subway platforms) answers an `<Error>`. The TTC
  GTFS-Realtime feed (`bustime.ttc.ca/gtfsrt/trips`) is NOT usable: its stop
  and trip ids are numbered apart from the static GTFS (2026-10: 165 of
  13,650 stop times named a stop their route serves).
- **Line status**: `alerts.ttc.ca/api/alerts/live-alerts`, the JSON behind the
  ttc.ca service advisories (undocumented; shape in
  `test/helpers/fixtures.js`). `routes[]` name the line (`route: "2"`), the
  GTFS-RT effect name and a severity. `parseTtcAlerts` translates it: a
  "Minor" alert (standing slow zones) and an alert with `childAlerts` (an
  announcement) are notices; "Critical" is SEVERE. The GTFS-RT alerts feed
  cannot do it: a subway closure there names the shuttle bus routes, and
  every effect is unknown.
- **Bike Share Toronto**: PBSC, GBFS 2.3 at
  `toronto.publicbikesystem.net/customer/gbfs/v2/gbfs.json`, station ids are
  digit strings (`7033` Union Station), true booleans, e-bikes are the
  `vehicle_types_available` whose `propulsion_type` is electric.
- **Transitous**: ids are `ca-on-TTC_<stop_id>`; no TTC real time there
  (`realTime: false`). `/v5/stoptimes` answers for a group of stops (GO
  Transit included at Union): the departures are filtered on the code's own
  stop_ids. Headsigns read "East - 114 Queens Quay East towards Carlaw":
  `tidyHeadsign` keeps what follows "towards". Usage policy: open-source
  non-commercial, User-Agent with a contact, stay light — keep the caches and
  the 120 s floor (`MIN_SCHEDULE_POLL_FREQUENCY`).

## Conventions

- ES modules, Node >= 22, no runtime dependency besides the SDK. Do not add
  one without a strong reason (the 256 MB sandbox is why the GTFS-RT decoder is
  hand-written).
- Prettier decides formatting; ESLint decides the rest.
- Comments explain **why**, in full sentences, in English.
- Every user-visible string in the manifest, actions and widgets is bilingual
  (`{ en, fr }`); text features follow the `language` setting.
- **External ids, feature keys, manifest keys are forever**: Gladys keys the
  devices, their history, the scenes and the dashboards on them. The line ids
  of `src/network.js` (`line1`…`line6`) are feature keys.
- **Created devices** are rebuilt from their params (`stop_code`, `routes`,
  `station_id`): never rename those params.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json` / the manifest, nor the `docker_image` tag, by hand.
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **Never commit a personal stop**: use network landmarks in examples and
  tests (Union Station: stops 247, 10935, subway platform 13816; Bike Share
  7033 Union Station; Union Station as the house).
- Tests never touch the network: `test/helpers/stubFetch.js` routes `fetch`.
  They do read the real `gtfs/` table: a regeneration that drops a landmark
  shows there.

## Roadmap ideas

- Real time for the subway, if the TTC ever publishes it (the platforms would
  leave `scheduleOnlyRoutes`).
- NextBus `predictionsForMultiStops` (one request for every stop) if the
  number of stops watched grows: it needs the NextBus stop tags.
- GO Transit (Metrolinx API, key on request) and the 905 networks (MiWay,
  Brampton Transit, YRT).
- Ask the Transitous team for an explicit OK before the integration gets many
  users (their policy asks to be contacted for heavy use).
- Screenshots in the user documentation.

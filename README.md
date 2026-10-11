# Gladys TTC Toronto

External integration for [Gladys Assistant](https://gladysassistant.com) that
brings Toronto public transit into your smart home:

- **next TTC departures in real time** for every bus and streetcar stop, and
  the timetable of the subway and LRT platforms;
- **status of the subway and LRT lines** (Lines 1, 2, 4, 5 and 6), from the
  TTC service alerts;
- **Bike Share Toronto stations**: bikes, e-bikes and free docks.

**Nothing to configure, no key, no account:** the integration reads the
location of the house from Gladys and offers the closest stops and Bike Share
stations in the Discover tab, named the way people know them ("TTC – Union
Station (509 → Exhibition)").

Unofficial: not affiliated with the TTC, the City of Toronto nor Bike Share
Toronto.

User documentation: [français](docs/fr.md) · [English](docs/en.md).

## What you get in Gladys

| Kind                  | Content                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Devices               | one per stop (minutes to wait, route, summary), one for the lines (status + message per line), one per station |
| Dashboard widgets     | departures board, line status, Bike Share station                                                              |
| Scene triggers        | departure approaching (1–15 min), line disrupted / restored / notice, Bike Share station empty / full          |
| Scene actions         | read the next departures of a stop, read the status of a line                                                  |
| Configuration buttons | find a stop or a Bike Share station by name                                                                    |

Requires Gladys **5.1.0** or later.

## How it works

- **The stop table** (`gtfs/stops.json`, `gtfs/routes.json`) is generated from
  the TTC static GTFS (City of Toronto open data) by `npm run update-stops`
  and ships with the image. It answers the stop search and the "near my home"
  suggestions without any request, and marks the subway and LRT platforms,
  which no real-time source covers.
- **Departures**: the TTC NextBus API (keyless, stop by stop, once a minute)
  for the buses and streetcars; [Transitous](https://transitous.org/sources/)
  (the timetable, every 2 minutes) for the subway and LRT platforms. The TTC
  GTFS-Realtime feed is not used: its stop ids do not match the static GTFS.
- **Line status**: the TTC live alerts (the JSON behind the service
  advisories of ttc.ca), translated to GTFS-Realtime alerts.

## Development

```bash
npm install
npm test               # node --test, no network access
npm run lint           # ESLint
npm run format:check   # Prettier, as the CI runs it
npm run update-stops   # regenerate gtfs/ from the TTC static GTFS
npx github:GladysAssistant/integration-store .   # store admission checks
```

The project follows the official
[integration template](https://github.com/GladysAssistant/integration-template-js):
Node 22+, ES modules, the Gladys SDK as the only runtime dependency, a Docker
image published to GHCR by the Release workflow. It shares its code with
[gladys-stm](https://github.com/LM1LC3N7/gladys-stm),
[gladys-translink](https://github.com/LM1LC3N7/gladys-translink),
[gladys-octranspo](https://github.com/LM1LC3N7/gladys-octranspo) and
[gladys-rtc-quebec](https://github.com/LM1LC3N7/gladys-rtc-quebec): the
network lives in `src/network.js`. See [CLAUDE.md](CLAUDE.md) for the
architecture and the conventions.

### Publishing a version

1. In GitHub: **Actions → Release → Run workflow**. Choose **minor** for the
   first release (0.0.0 → 0.1.0), then patch / minor / major. It bumps the
   version everywhere, rolls the changelog, tags, builds the multi-arch image
   (`linux/amd64`, `linux/arm64`) and creates the GitHub Release.
2. The first time only: make the GHCR package **public**
   (`github.com/LM1LC3N7/gladys-ttc/pkgs/container/gladys-ttc` → Package
   settings → Change visibility). The store refuses an image it cannot pull.
3. Add the topic `gladys-assistant-integration` to the repository: the store
   indexer picks the integration up within the hour.

## Data and licences

- Stop list: TTC Routes and Schedules, City of Toronto open data, under the
  [Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/).
- Real time and alerts: TTC data (NextBus API, ttc.ca service alerts),
  © Toronto Transit Commission.
- Subway and LRT timetable: [Transitous](https://transitous.org/sources/)
  (free community service; the integration sends a User-Agent naming it,
  caches every description and never reads departures more than every two
  minutes).
- Bike Share Toronto data: public GBFS feed of Bike Share Toronto.
- Code: Apache License 2.0. Parts of `src/devices/` are adapted from
  [prohand/gladys-transport-commun-lyonnais](https://github.com/prohand/gladys-transport-commun-lyonnais)
  (Apache-2.0), see [NOTICE](NOTICE).

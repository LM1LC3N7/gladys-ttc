# TTC Toronto

The **next TTC departures** (bus, streetcar, subway, LRT), the **subway and
LRT line status** and the **Bike Share Toronto bikes** near your home, in
Gladys.

This integration is not affiliated with the TTC, the City of Toronto nor Bike
Share Toronto.

## Get started in 3 steps

No technical knowledge is needed, and no account: there is **nothing to
create, no key**.

1. **Check the address of your house in Gladys**: _Settings → Houses_. The
   house must have a position on the map. The integration uses it to find the
   stops near you. The position stays in your Gladys.
2. **Install the integration** from the integration catalog, and accept the
   access to the house location. Open its configuration page and press
   **Save**, without filling anything in.
3. Open the **Discover** tab of the integration. The 3 stops and 2 Bike Share
   stations closest to your home are offered there, with their name and the
   direction of their routes, e.g. "TTC – Union Station (509 → Exhibition)",
   as well as the **TTC – Subway and LRT** device. Press **Add** on each one
   you want.

That's it. You now get the **next departures** at each stop, the status of
the lines, and the bikes and free docks of each Bike Share station.

The message at the top of the configuration page always tells you what to do
next. For example: "Ready: 3 stops, 2 Bike Share Toronto stations and the
lines to add. Open the Discover tab…".

Device names start with **TTC –** or **Bike Share –**, so they are easy to
tell apart in the device list of Gladys. You can rename them freely in Gladys.

### Showing the departures on the dashboard

1. Open the dashboard, then press **Edit**.
2. Add a widget and choose **TTC departures**.
3. Choose the stop, then save.

The **TTC line status** and **Bike Share station** widgets are added the same
way.

Departures tracked in real time are green. Scheduled times carry a **~** and
are grey: "~12 min" means "scheduled in 12 minutes".

## Where the departures come from

- **Buses and streetcars**: the TTC real-time predictions, the same as the
  stop signs and the TTC apps, read every minute.
- **Subway and LRT** (Lines 1, 2, 4, 5 and 6): the TTC publishes no
  prediction for them. Their platforms show the **timetable**, through
  Transitous, a free community service, read every 2 minutes. A subway
  platform is a stop of its own, one per direction: "Union Station -
  Northbound Platform Towards Finch".

## Watching other stops (work, school…)

For a stop far from home:

1. At the bottom of the configuration page, press **Find a stop**. Type a
   street, a station or the stop number, e.g. "Union Station" or "Bay Front".
2. The answer lists the stops with their number and the direction of their
   routes, e.g. `247 — Bay St at Front St West - Union Station (114 → Union
Station, 202 → Union Station via Distillery)`.
3. Copy the number (`247`) in **Stops**, save, then add the stop in the
   **Discover** tab.

The number is the one written on every TTC stop sign (the one texted to
898882).

For Bike Share stations, the **Find a Bike Share station** button works the
same way.

### Going further

The **Stops** field accepts several numbers separated by commas, a route
filter after `@` and a name after `:`.

| Entry                   | Meaning                                |
| ----------------------- | -------------------------------------- |
| `247`                   | every route calling at stop 247        |
| `10935@509`             | route 509 only                         |
| `10935@509\|510`        | routes 509 and 510                     |
| `10935@509:Car to work` | route 509, displayed as "Car to work"  |
| `13816`                 | Line 1 at Union Station, towards Finch |

## What each device holds

**Stop:**

- **Next departure**, **Departure 2**…: the minutes to wait. 999 means no
  departure is coming.
- **Next departure route**…: the route ("504", "96").
- **Next departures**: a summary, e.g. `504 3 min · 504 11 min`.

**Subway and LRT:** for each line, a **status** (`Normal`, `Disrupted`,
`Notice` or `Unknown`) and the **message** of the TTC alert. A closure or a
major delay is a disruption; a standing slow zone ("trains will move slower
than usual") or the announcement of a coming closure is a notice. Elevators
and escalators do not change the status of a line.

**Bike Share station:** the bikes (e-bikes included), the e-bikes, the free
docks and the state of the station.

A station that leaves the network shows 0 bikes, 0 docks and the state
"Removed from the Bike Share Toronto network (seasonal?)", with an orange dot
on the device. It resumes by itself when it comes back.

## Scenes

**Triggers:**

- **Departure approaching**: a departure gets under 1, 2, 3, 5, 10 or 15
  minutes. Example: "when the 504 is 5 minutes away, turn the hall light on".
- **Line status changed**: a line is disrupted, gets back to normal, or
  receives a notice. Example: "if Line 1 is disrupted, send me a message".
- **Bike Share station changed**: the station runs out of bikes or docks, or
  gets some back.

**Actions:**

- **Read the next departures**: e.g. a message every morning "Your 504 comes
  in {{minutes}} minutes".
- **Read a line status**: returns the status, the TTC message and `normal`
  (true or false).

## Troubleshooting

| Message or symptom                                | What to do                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| "set the address of your house"                   | _Settings → Houses_: place the house on the map, then save the configuration of the integration again. |
| "Gladys did not share the location of your house" | Reinstall the integration and accept the location access, or type stop numbers.                        |
| Nothing in the Discover tab                       | Read the message of the configuration page: it says what is missing.                                   |
| "Stop … is not in the TTC stop list"              | Check the number on the sign. A brand new stop comes with the next version of the integration.         |
| Station "Removed from the Bike Share network"     | The station left the network: it will come back by itself.                                             |
| A stop stays at 999                               | No departure coming (at night), or a route filter matching no route of the stop.                       |
| A subway platform shows "~" times                 | Normal: the TTC publishes no real time for the subway, the timetable is shown.                         |

## Privacy, data and licences

- The house location is only used to look the nearby stops up, in the stop
  list shipped with the integration: it is sent nowhere.
- Stop list: TTC Routes and Schedules, City of Toronto open data, under the
  [Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/)
  (updated with every version).
- Real time and alerts: TTC data, © Toronto Transit Commission.
- Subway and LRT timetable: [Transitous](https://transitous.org/sources/), a
  free community service, from the TTC data.
- Bikes: public GBFS feed of Bike Share Toronto.
- Integration code: Apache 2.0 licence.

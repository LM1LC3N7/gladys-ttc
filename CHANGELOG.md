# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Gladys integration SDK 0.15: poll-frequency and batch validation of the discovered devices, state heartbeat, the SDK fake Gladys for the tests.

## [0.1.0] - 2026-10-11

### Added

- First version, derived from gladys-translink (TransLink Vancouver).
- Next departures of every TTC stop, without any key or account: real time
  from the TTC NextBus API for the buses and streetcars, the timetable from
  Transitous for the subway and LRT platforms.
- Status of the subway Lines 1, 2 and 4 and of the LRT Lines 5 and 6, from
  the TTC live alerts (standing slow zones and announcements are notices).
- Bike Share Toronto stations: bikes, e-bikes and free docks.
- The closest stops and Bike Share stations suggested from the house location.
- Stop search by name or number, in the stop list shipped with the image.
- Dashboard widgets, scene triggers and scene actions (Gladys 5.1.0+).

[Unreleased]: https://github.com/LM1LC3N7/gladys-ttc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LM1LC3N7/gladys-ttc/releases/tag/v0.1.0

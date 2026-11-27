# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The next 'L' trains (Train Tracker API) at up to four stations or platform
  stops, the next buses (Bus Tracker API) at up to four bus stops, and the
  alerts in effect there (Customer Alerts API): one device each, with the next
  and following departure, the departures within 30 minutes, a summary, the
  alerts count and the first alert.
- The scene trigger "New CTA alert at a station or stop".
- A daily budget per key, counted per Chicago day and kept in `/data`; the
  read interval stretched to fit it; the pauses the CTA asks for; a refused
  key never sent again until it changes or the button's retry succeeds.

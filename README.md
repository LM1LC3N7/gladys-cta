# Chicago Transit Departures for Gladys Assistant

An unofficial [Gladys Assistant](https://gladysassistant.com) integration: the
next 'L' trains (Train Tracker API) and buses (Bus Tracker API) at up to four
stations and four bus stops of Chicago, and the service alerts in effect there
(Customer Alerts API). Data provided by CTA.

It is not affiliated with, endorsed nor sponsored by the Chicago Transit
Authority, and it is not an official source. It was **never tested with a real
key** nor on a real Gladys installation: Train Tracker and Bus Tracker are
simulated in the tests from their official documentation; the keyless
Customer Alerts API was read live (2026-11-27).

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Keys: free, one for Train Tracker and one for Bus Tracker, from the
  [CTA Developer Center](https://www.transitchicago.com/developers/). Each key
  has a daily quota (100,000 requests by default); the integration counts its
  requests per Chicago day, keeps the count in `/data`, and stays within its
  own daily budget (10,000 by default).
- Terms: [CTA Developer License Agreement and Terms of Use](https://www.transitchicago.com/developers/terms/)
  and the CTA Trademark Guidelines for Developers (no CTA logo, no CTA name as
  the name of the project). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
node scripts/mutants.mjs      # mutation check of the guards (slow; use memcap)
node scripts/cover.mjs        # regenerates cover.png
```

The rules of the project are in [CLAUDE.md](CLAUDE.md), the decisions in
[TODO.md](TODO.md).

## License

Apache-2.0 for the code of this repository. The test fixtures are CTA data,
not covered by the Apache License (see the notices).

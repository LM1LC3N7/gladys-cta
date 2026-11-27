# Third-party notices

## CTA data (Chicago Transit Authority)

Data provided by CTA. The integration reads, at run time, three APIs of the CTA Developer Center
(https://www.transitchicago.com/developers/): Train Tracker (`lapi.transitchicago.com`), Bus Tracker version 3
(`www.ctabustracker.com/bustime/api/v3`) and Customer Alerts (`www.transitchicago.com/api/1.0/alerts.aspx`). The
use of CTA data is governed by the CTA Developer License Agreement and Terms of Use
(https://www.transitchicago.com/developers/terms/, read on 2026-11-27): a limited, non-exclusive, revocable license
to use, reproduce, distribute, display and process CTA data, without warranty; the application must not express or
imply any affiliation with, sponsorship or endorsement by CTA; a credit line is optional ("Data provided by CTA" is
used here). The CTA Trademark Guidelines for Developers (https://www.transitchicago.com/developers/branding/) are
followed as published on that page: no CTA logo, no CTA name as the first or main word of a project name (the name
of the integration, "Chicago Transit Departures", holds none), no CTA service name, nothing "official". Each user reads the APIs with their own keys from their own Gladys.

The file `test/fixtures/alerts-clark-lake-live.json` is an answer of the Customer Alerts API (station 40380)
captured on 2026-11-27. It is CTA data, **not covered by the Apache License** of this repository, and
redistributed under the agreement above (revocable). It serves the tests only and is not shipped in the Docker
image.

No code of the CTA is used: the client is written from the API documentation (Train Tracker API documentation
page, Bus Tracker API Developer Guide v3.0 of 2025-04-21, Customer Alerts API Developer Guide of 2016-09-29) and
from the observed keyless answers.

## gladys-testkit

`test/kit/clock.mjs` is copied from gladys-testkit (Apache-2.0, same author as this repository).

## npm dependencies

The only runtime dependency is `@gladysassistant/integration-sdk` (Apache-2.0); its license ships in
`node_modules/@gladysassistant/integration-sdk/LICENSE` of the image.

# TODO

## Before announcing

- [ ] Rename the repository and the image before the first release? The CTA Trademark Guidelines for Developers
      ask not to combine a CTA name with one's own name nor to make it the main word of a project name
      (`gladys-cta`); the manifest name is "Chicago Transit Departures". Louis to decide (repository, image,
      cover URL).
- [ ] Try it with real keys (Train Tracker and Bus Tracker): the answers with a key were only simulated from the
      official documentation (JSON examples of the Train Tracker page and of the Bus Tracker guide v3.0).
- [ ] Install it on a real Gladys 5.3+ and add a station and a bus stop: device creation, texts, the scene trigger.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Store metadata kept out of the manifest (no `keywords`): Chicago, CTA, 'L', train, bus, transit, departures.

## To confirm with a real key

- [ ] Train Tracker `tmst`, `prdt`, `arrT` in the JSON output: ISO local time without offset (as the docs example
      and the keyless error answers of 2026-11-27); the documented `yyyyMMdd HH:mm:ss` form is read too.
- [ ] Bus Tracker v3: the `error` entries for one stop among several carry `stpid` (assumed from the v2 practice;
      an entry without `stpid` saying "No service scheduled" is read as "no prediction" for every stop asked
      without one); `dly` and `dyn` always present in v3 (absent: false and 0).
- [ ] Bus Tracker: the message for an unknown stop id ("No data found for parameter" or "Invalid parameter
      provided" are read as "unknown id"); until a prediction names the stop, an empty stop is not published.
- [ ] Whether the quotas reset at midnight in Chicago (assumed; a "daily limit" answer pauses the key until
      00:05 Chicago time, one hour at least).

## Decisions

- **Version 0.1.0** set by hand in package.json, package-lock.json, the manifest and its `docker_image`
  (`ghcr.io/lm1lc3n7/gladys-cta:0.1.0`).
- **SDK `^0.16.1`**, the latest published (npm registry, 2026-11-27): no change needed for a read-only device
  integration. `gladys_version >=5.3.0` for `countries: ["US"]`.
- **Name**: "Chicago Transit Departures", not "CTA …": the CTA Trademark Guidelines for Developers forbid a CTA name
  as the first or main word of a project name and a name like "Train Tracker"; "Data provided by CTA" is the credit
  line the CTA terms suggest. No CTA logo on the cover.
- **Quotas**: both keys get 100,000 requests a day by default (Train Tracker docs; Bus Tracker guide v3.0 and FAQ,
  "updated from 50,000 to 100,000 in April 2024"). Own budget per key, 10,000 by default (500 to 100,000), counted per
  Chicago date, written to `/data` before each request (a restart keeps it); a later date in `/data` (clock gone
  back) keeps counting on it, a date after tomorrow is not believed. The interval is stretched so that the planned
  rounds use 90 % of the budget at most. The count is per key print: another key starts at 0.
- **Requests**: Train Tracker one station per request (the docs say "a single code" for `mapid`/`stpid` but also
  "4 at most": one is unambiguous); Bus Tracker one request for every stop (10 at most per request, 4 used);
  `tmres=s`. Alerts every 5 minutes per watch, `activeonly=true`, keyless; train watches by `stationid` (the station
  named by Train Tracker), bus watches by the routes seen at the stop (the Customer Alerts API cannot filter by bus
  stop; `routeid` and `stationid` cannot be combined, error 106, seen live).
- **Errors in a 200**: Train Tracker `errCd` 101 = refused key, 102 = daily limit, 103/104/108/112 = unknown id
  (asked again after 30 min), 900 = server error (pause); Bus Tracker messages ("Invalid API access key supplied",
  "No API access permitted" = refused; "Transaction limit…" = daily limit); Customer Alerts code 50 = no alert
  (seen live), an unknown station answers a `CTARoutes` envelope with code 900 (seen live).
- **Refused key**: a salted 8-bit print in `/data` (never the key; 256 values), cleared by another key, by a
  successful answer of the button's retry (one request, 30 s at least after the previous one of that key), and
  in-process by any key change. HTTP 401/403 are never a refusal (pause "unexpected answer").
- **Times**: local Chicago times without offset, placed with the America/Chicago rules (the skipped spring hour read
  in CST, the repeated fall hour the first one). An answer is used only when its `Date` is within 5 minutes of the
  local clock and its own time stamp within 3 minutes of its `Date`; a prediction generated more than 10 minutes
  before the answer means a frozen feed: nothing published. Minutes counted against the answer's time, rounded
  down; 1 minute in the past = due.
- **Texts, not numbers** for the next and following departure (as gladys-mbta): Gladys cannot clear a number.
  Counter "departures within 30 minutes" (the Bus Tracker horizon is about 30 minutes).
- **Bus stop confirmation**: "no departure" is published for a bus stop only once a prediction named it (salted
  fingerprint in `/data`); a station is confirmed by Train Tracker's error code 0.
- **Scene trigger**: new alert id at a watch, start known and within 24 h; the first read only learns; 10 events per
  read at most; ids kept 7 days (500 at most) in `/data`.
- **Not done in 0.1.0**: the "departure approaching" trigger of gladys-mbta, the train positions, the route status
  API (`routes.aspx`).
- **Mutation** (milestone 1): 59 mutants of the guards in `scripts/mutants.json`, run one at a time with
  `scripts/mutants.mjs` (copy of the repository, node_modules copied, baseline first): all killed. Dropped as
  equivalent: "the button reads without a refusal" (the loop over the refused keys is then empty). Five survivors
  of the first run got a test: the budget not spent during a pause, a pause kept in /data across a restart, the next
  round armed after a failed one, an unknown bus stop asked again after 30 min, the merge of a refusal.
- **/data unreadable**: never overwritten; read again every 10 s on its own timer; once readable, merged on the
  safe side (larger count of the day, later pause, a refusal of memory kept, a refusal of the file lifted only by a
  key the CTA accepted in this process).

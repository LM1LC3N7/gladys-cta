# Chicago Transit Departures

The **next 'L' trains** at up to four stations, the **next buses** at up to
four bus stops, and the **service alerts** in effect there, in Gladys.
Data provided by CTA.

This integration is unofficial: it is not affiliated with, endorsed nor
sponsored by the Chicago Transit Authority, and it is not an official source.
Check transitchicago.com or the station signs before you travel. It was
**never tested with a real key** nor on a real Gladys installation by its
author: Train Tracker and Bus Tracker were simulated from their official
documentation; the Customer Alerts API (no key) was read live.

## Get started

1. **Ask for the free keys** you need on the
   [CTA Developer Center](https://www.transitchicago.com/developers/):
   - trains: the [Train Tracker API key form](https://www.transitchicago.com/developers/traintrackerapply/)
     (answer by e-mail);
   - buses: create an account on [ctabustracker.com](https://www.ctabustracker.com/)
     and request the Bus Tracker API key from it (answer by e-mail).

   The alerts need no key. You need only the key of what you watch.

2. **Find the ids.** A train station is a number from 40000 to 49999 (e.g.
   40380 for Clark/Lake: every platform); a platform stop, from 30000 to 39999,
   keeps one direction only. They are in the "CTA – System Information – List
   of 'L' Stops" of the City of Chicago data portal. A bus stop id is shown on
   the sign of the stop and on ctabustracker.com (e.g. 456).
3. **Install the integration**, type the keys and the ids in its
   configuration, and save. Open the **Discover** tab and press **Add** on each
   station or stop. Its name becomes the CTA name ("Clark/Lake ('L' trains)")
   after the first read, unless you typed one.

**One device per station or stop.** A device belongs to a slot and its id: if
you type another id in a slot, the integration offers a new device; the old
one is no longer updated and keeps its last values (the configuration page
lists it under "Not updated any more": delete it in Gladys). Changing the
lines filter keeps the device.

## What each device shows

| Feature                       | Type    | Content                                                                                                                                           |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next departure                | text    | "Green Line → Harlem/Lake in 4 min (05:18)", "due" when it is approaching, "delayed" and "scheduled time" (no live tracking) when the CTA says so |
| Following departure           | text    | the same for the next one                                                                                                                         |
| Predicted departures (30 min) | counter | for scenes, e.g. "more than 0"                                                                                                                    |
| Departures                    | text    | "05:14 · Green Line → Harlem/Lake 4, 9 min · Brown Line → Kimball 11 min"                                                                         |
| Alerts in effect              | counter | alerts of the station (or of the bus routes seen at the stop)                                                                                     |
| Alert                         | text    | the first alert (major first, then the most severe) and how many more                                                                             |

The times are Chicago times. Every read publishes every value: a departure
that is gone becomes "No following departure (read 05:15)", never a number
left behind. A failed, stale or unreadable read publishes **nothing** (no 0):
the configuration page says why and since when. Canceled, invalidated and
drop-off only bus trips are not departures (Bus Tracker dynamic types 1, 4, 12,
16, 17 and 18; for 12 the CTA does not want the cancellation shown: the bus
is simply left out).

The bus alerts are those of the routes seen at the stop by Bus Tracker (the
Customer Alerts API does not know bus stops). The train alerts are those of
the station and of its lines. The CTA also sends, for a station, the
elevator and accessibility alerts of every other station of its lines: those
are left out (impact "Elevator Status" or severity 1-19, naming another
station, not major). A closure of another station or a major alert on a
watched line is kept. Without a key, the alerts of a station (40000-49999) are
read all the same; those of a platform stop (30000-39999) and of a bus stop
wait for a first read of their departures.

The scene trigger **New CTA alert at a station or stop** fires once for an
alert seen for the first time at a watched station or stop, when it started
within the last 24 hours (the first read only learns the alerts already
there). You can keep major alerts only, or the others.

## Requests and quotas

- One Train Tracker request per station and per read, one Bus Tracker request
  for all the bus stops per read; the alerts every 5 minutes (at each read
  when the read interval is longer), one request per station or stop. One request at a time, 1 s apart at least.
- The CTA grants each key **100,000 requests a day** by default (docs read on
  2026-11-27). The integration keeps its own **daily budget per key** (10,000
  by default, setting "Daily budget per key"): it counts the requests of the
  Chicago day, writes the count to `/data` before each request (a restart
  keeps it), and stretches the read interval when the planned reads would not
  fit 90 % of the budget (the status says "Reads every N s"). When the budget
  is spent, that key waits for the next Chicago day.
- If the CTA says the daily limit is reached, that key pauses until 00:05 in
  Chicago (one hour at least). A 429, a server error or an unexpected answer
  pauses that service from 1 or 2 minutes, doubled up to 6 hours; the other
  services go on.
- If the CTA **refuses a key**, nothing is sent with it any more, even after a
  restart, until you type another key or press **Show the last read / retry the
  key**, which sends one request with it (30 s at least after the previous
  one). A success lifts the refusal. An HTTP 401 or 403 is not taken as a
  refusal: only the CTA's own "invalid key" answer is.
- A restart, a reconnection, a saved configuration that did not change and
  Discovery never read sooner than the interval. The button reads only to
  retry a refused key, as said above.

## Your keys

The keys are kept by Gladys in its database, never shown again, and sent only
to the CTA (in the address of each request, as the CTA requires). The
integration never writes them to its logs, its status nor `/data`: it keeps a
salted 8-bit print of a refused key there (256 possible values, shared by
countless keys), enough to know "another key" after a restart.

## Troubleshooting

The message at the top of the configuration page tells where each station and
stop stands, and how many requests each key used today. Common messages:

- "The CTA does not know this id": check the id; asked again after 30 minutes.
- "No bus has confirmed this stop id yet": the stop has no prediction now and
  no bus was ever seen there; nothing is published until one is.
- "Differs from the clock of this machine": set the clock of the machine that
  runs Gladys.

## Terms of use

The data is used under the
[CTA Developer License Agreement and Terms of Use](https://www.transitchicago.com/developers/terms/)
and the CTA Trademark Guidelines for Developers: revocable, without warranty,
no CTA logo. Data provided by CTA. Each user reads the APIs with their own
keys from their own Gladys.

# ORB wave dashboard (Cloudflare Worker + D1)

Receives wave-analysis (`W`) messages routed out of Notehub, stores them in D1,
and serves a dashboard. Free tier throughout: a buoy transmitting every 10
minutes produces ~144 requests/day, against a 100k/day limit.

```
drifter --LoRa--> base station --Notecard--> Notehub --route--> /api/ingest --> D1
                                                                                 |
                                                        dashboard <-- /api/wave -+
```

| File | What it is |
|---|---|
| `src/worker.js` | ingest + read API, and the wire-format parsers |
| `schema.sql` | D1 tables: `wave`, `wave_bin`, `gps`, `temperature`, `site` |
| `migrations/` | one-off schema changes, applied before the deploy that needs them |
| `public/index.html` | dashboard, no build step; Leaflet from a CDN is the only dependency |
| `wrangler.toml` | Worker config — replace `database_id` with your own when setting up a new database |
| `test/parse.test.mjs` | round-trip tests for the three wire formats (`npm test`) |

## Setup

Requires Node (for `wrangler`) and a free Cloudflare account.

```bash
# 1. database
npx wrangler d1 create orb-wave          # paste database_id into wrangler.toml
npx wrangler d1 execute orb-wave --remote --file=./schema.sql
# an existing database instead: apply the migrations in migrations/ in order

# 2. the shared secret the Notehub route will send
npx wrangler secret put INGEST_SECRET    # paste a long random string

# 3. dashboard login (HTTP basic auth)
npx wrangler secret put DASH_USER
npx wrangler secret put DASH_PASS

# 4. deploy
npx wrangler deploy                      # prints https://orb-wave.<subdomain>.workers.dev
```

Then in Notehub: **Routes → Create Route → HTTP/HTTPS**, URL
`https://<your-worker>/api/ingest`, method POST, add the header
`X-Ingest-Secret: <the same string>`, and restrict the route to the `buoy.qo`
notefile. Leave the transform as the default JSON — the Worker expects Notehub's
own event shape.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/ingest` | Notehub route target. Requires the `X-Ingest-Secret` header. |
| `GET /api/wave?buoy=&site=&hours=&from=&to=&limit=` | wave measurements, oldest first, spectrum expanded |
| `GET /api/gps?buoy=&site=&hours=&from=&to=&limit=` | GPS fixes, oldest first |
| `GET /api/temperature?buoy=&site=&hours=&from=&to=&limit=` | temperature readings, `temps` expanded |
| `GET /api/buoys` | buoy ids with reading counts and last-seen |
| `GET /api/sites` | named places, their boxes, and rows inside each |
| `GET /` | the dashboard |

`from` and `to` are epoch seconds on the `received` column, `to` exclusive;
either may be left out. All routes except `/api/ingest` require the dashboard
login (`DASH_USER` / `DASH_PASS`).

## Running it locally

`wrangler dev` serves the whole thing against a local D1 with no Cloudflare
account involved. It needs a value in `database_id` (any well-formed string does
for local mode) and `INGEST_SECRET`, `DASH_USER` and `DASH_PASS` in a `.dev.vars` file, which is gitignored:

```bash
printf 'INGEST_SECRET=devsecret\nDASH_USER=dev\nDASH_PASS=dev\n' > .dev.vars
npx wrangler d1 execute orb-wave --local --file=./schema.sql
npx wrangler dev
```

## Six things worth knowing

**A wave measurement arrives as two messages.** `W` carries the parameters —
window, Hs/Tc/Tp/Tz, and the position at each end of the analysis window — in 56
bytes. `P` carries the spectrum in 26 + 2·bins. They are paired on
`(buoy_id, ts_start)`, which **both** carry: `reading_id` restarts at zero every
time the drifter reboots, so it would attach one session's spectrum to another
session's parameters. That key is already the primary key of `wave`, so neither
order nor batch matters — whichever arrives first creates the row, the other fills
in its half.

Both writes are UPSERTs, never `INSERT OR REPLACE`: replacing the row deletes it
first and `wave_bin` cascades, so a `W` landing after its `P` would silently take
the spectrum with it. Each message updates only the columns it owns.

Several `P` messages per measurement are supported even though nothing sends them
yet: each chunk clears only its own frequency span, bin indices are derived from
frequency (`round(freq/df)`, the analysis-grid index) so chunks cannot collide on
the primary key, and `f_min`/`f_max`/`num_bins` on the wave row are recomputed from
what is actually stored rather than taken from whichever packet arrived last.

Splitting cost ~16 % more airtime for the pair and bought three things: the
parameters ride in a short packet that survives a marginal link far better, a
position fits so the measurement is self-describing, and `P` holds 114 bins in 255
bytes against 98 before. Timestamps stayed the full 8-byte `time_t` the other
messages use — narrowing them would have saved eight bytes and capped the format
at 2106, and after the split there was nothing to buy with them.

**The wire carries acceleration; `wave_bin` holds both spectra as reals.** The
drifter transmits the acceleration PSD in m²/s⁴/Hz, packed as uint16 fractions of
a peak so a bin fits in two bytes over LoRa. The fraction is **sqrt-companded** —
a bin is `(raw/65535)² · max_value`, not `raw/65535 · max_value` — because
`max_value` is set by chop near 1 Hz while the wave band sits decades below it,
and the linear rule left the weakest wave-band bins on single-digit counts.
`spectrumBins` applies that, divides each bin by (2πf)⁴ at its own centre
frequency, and writes one row per bin: `freq`, `psd` (elevation, m²/Hz) and
`psd_acc` (acceleration, as transmitted). The byte layout did not change when the
firmware did, only the meaning of the numbers — which is also why the companding
rule cannot be detected from a payload, and why the Worker must be deployed in
lockstep with the buoy flash.

Nothing is requantised on the way in, and nothing is cut. At f_min = 0.0049 Hz
the ω⁻⁴ gain is ~1.1·10⁶, so folding the result back into uint16 fractions of its
own new peak would leave the actual wave band with tens of levels out of 65535 —
which is why the peak (`max_value`) and the fraction encoding are gone from
storage entirely. `freq` is stored rather than derived, so a truncated message
cannot be stretched across a band it never covered.

Suppressing the low end is therefore a question about what to look at, and it
lives in the dashboard's taper pair (f1, f2). The weight is 0 below f1, 1 above
f2 and a half-cosine between, applied squared — the same `lowFreqTaper` the
drifter runs, which is why the default 0.03–0.05 Hz mirrors the firmware's
`kTaperF1`/`kTaperF2` and makes the `Hs spectrum` tile comparable with the buoy's
own `Hs`. Setting f1 = f2 gives a hard cutoff, which is what this replaced; both
at 0 really does show the low end. It is worth looking at once: ω⁻⁴ makes
whatever the accelerometer was doing below 0.05 Hz dominate the plot completely.

**Places are boxes, and a measurement's position is stamped at ingest.** Only the
`G` message carries a position — the wave and temperature messages have no
lat/lng field at all — so the Worker copies the nearest GPS fix onto each `wave`
and `temperature` row as it stores it. Nearest in *time*, within ±6 h; outside
that the row keeps a NULL, which is the honest answer and puts it outside every
place filter rather than on the wrong map. `G` notes are batched ahead of the
rows that read them, since a D1 batch runs in order.

The places themselves live in the `site` table as lat/lng boxes and are resolved
at read time, never stored on the measurement — so editing a box or adding a
place reclassifies the whole history at once, with no migration.

Boxes may overlap: a row resolves to the **smallest** box containing it, so it
belongs to exactly one place and the counts in the picker partition rather than
double-count. Nesting is therefore useful — a harbour box inside a fjord box
wins for the rows inside it. Note that a box is not square in metres: at 60°N one
degree of longitude is ~55.7 km against ~111 km for latitude. Rows stored before
this existed need the backfill in `migrations/0003_backfill_positions.sql`, which
is safe to re-run — and is also how to pick up a measurement whose `G` note
arrived in a later batch than the measurement itself.

**`buoy.qo` carries every message type.** G, T, A and W all share the notefile,
so the route cannot filter by type. `/api/ingest` decodes W, G and T by their tag
byte and answers 200 for anything else — a non-2xx would make Notehub retry an
analog note forever.

**The time filter runs on `received`, not `ts_start`.** A bench unit built with
`DEBUG_WAVE_MSG` has no GPS, never syncs its RTC, and stamps its measurements
with a synthetic epoch (2026-01-01 plus uptime). Filtering on the measurement
timestamp would hide that data; the charts still plot against `ts_start`, so an
unsynced RTC is visible rather than silently corrected.

**The drift track is a real map, and it costs nothing.** Leaflet is pinned at
1.9.4 with subresource integrity, and the browser fetches OpenStreetMap tiles
directly, so tiles never touch the Worker and never count against its request
budget. Fixes at exactly 0°, 0° — what a negative coordinate turns into today,
see the note on `parseGpsMessage` — are kept off the map, where one would drag
the view to the Gulf of Guinea, and counted in the card's caption instead. The
`Position` tile falls back to the newest signed fix for the same reason.

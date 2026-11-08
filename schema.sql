-- D1 schema for wave-analysis messages routed out of Notehub.
--
-- One row per wave measurement. (buoy_id, ts_start) is the primary key so a
-- re-delivered Notehub event overwrites its own row instead of duplicating it -
-- routes retry, and the same note can arrive twice.
--
-- The spectrum is its own table, one row per bin, with the PSD values as REAL.
--
-- The wire packs a spectrum as sqrt-companded uint16 fractions of a peak
-- (max_value) to fit two bytes per bin over LoRa, so a bin is
-- (raw/65535)^2 * max_value. That is a transport format, not a storage format:
-- dividing the acceleration PSD by omega^4 amplifies the lowest bin by ~1e6, so
-- requantising the result against its own new peak would leave the actual wave
-- band with tens of levels out of 65535. Storing reals removes the problem
-- instead of managing it, and max_value then has no job left - the peak is just
-- the largest psd in the measurement, which SQL can answer.

CREATE TABLE IF NOT EXISTS wave (
  buoy_id    INTEGER NOT NULL,
  ts_start   INTEGER NOT NULL,   -- epoch s, start of the analysis window
  ts_end     INTEGER NOT NULL,   -- epoch s, end of the analysis window
  reading_id INTEGER,
  hs         REAL,               -- significant wave height, m, as computed onboard
  tc         REAL,               -- crest period, s
  tp         REAL,               -- peak period, s
  tz         REAL,               -- zero-crossing period, s
  f_min      REAL,               -- first bin centre, Hz - see below, not fixed
  f_max      REAL,               -- last bin centre, Hz
  num_bins   INTEGER NOT NULL,   -- bins the message carried, and rows in wave_bin
  rssi       INTEGER,
  device     TEXT,               -- Notehub device UID
  received   INTEGER NOT NULL,   -- epoch s, when Notehub received the note
  -- Position of the measurement, copied from the nearest GPS fix at ingest.
  -- Neither the wave nor the temperature message carries one - the drifter sends
  -- position in its own 'G' message - so this is the Worker joining two streams
  -- that arrive separately. Stored rather than joined at read time because the
  -- join is a correlated subquery per row, and because the answer must not change
  -- retroactively when a late fix lands. NULL is real and expected: a measurement
  -- whose 'G' note was lost has no position and falls outside every site filter.
  -- lat/lng is the position at the END of the window: the more recent of the two,
  -- and the one that answers "where was this measured". It is what the site
  -- filter and the map marker use.
  lat        REAL,
  lng        REAL,
  -- ...and where the window STARTED. A free-drifting buoy moves during a
  -- 30-minute capture, so the pair is a drift vector - surface current - rather
  -- than a repeated field. Both come from the 'W' message; NULL means the buoy
  -- held no fix at that end.
  lat_start  REAL,
  lng_start  REAL,
  PRIMARY KEY (buoy_id, ts_start)
);

-- One row per spectrum bin. freq is stored rather than derived from
-- f_min/f_max/num_bins: a truncated message keeps f_max from the full spectrum
-- it was cut from, so recomputing the grid from the header would stretch the
-- surviving bins across a band they never covered.
--
-- Storing freq is also what lets buoys on different bands share the table. The
-- transmitted band is the sender's choice, not a constant: current firmware
-- drops everything below its kPsdMinFreq (0.03 Hz) and starts at ~0.039 Hz with
-- fewer, finer bins, while measurements taken before that start at 0.0049 Hz.
-- Both are stored as they arrived, with their own freq per bin, so no migration
-- is needed and nothing downstream may assume bin 0 is near DC. Compare rows by
-- freq, never by bin index.
--
-- WITHOUT ROWID because the whole row is its key plus three numbers, and the
-- table is read exactly the way it is clustered: every bin of one measurement,
-- in bin order.
CREATE TABLE IF NOT EXISTS wave_bin (
  buoy_id  INTEGER NOT NULL,
  ts_start INTEGER NOT NULL,
  bin      INTEGER NOT NULL,   -- 0-based index into the spectrum
  freq     REAL NOT NULL,      -- bin centre, Hz
  psd      REAL,               -- elevation PSD, m^2/Hz - what the dashboard plots
  psd_acc  REAL,               -- acceleration PSD as transmitted, m^2/s^4/Hz
  PRIMARY KEY (buoy_id, ts_start, bin),
  FOREIGN KEY (buoy_id, ts_start) REFERENCES wave(buoy_id, ts_start) ON DELETE CASCADE
) WITHOUT ROWID;

-- The dashboard's time filter runs on `received`, not ts_start: a bench unit has
-- no GPS and never syncs its RTC, so ts_start is a synthetic epoch there while
-- received is always real.
CREATE INDEX IF NOT EXISTS idx_wave_received ON wave(received);

-- GPS fixes ('G'). Stored in real units throughout: degrees, m/s, degrees. The
-- wire scales differ per field - coordinates are sign-and-magnitude at 1e-7 deg,
-- speed and heading are uint32 at scale_factor - but that is the worker's
-- problem, so no column changed when the coordinate format did.
--
-- lat/lng are REAL, i.e. a double, which resolves 1e-7 deg with room to spare.
-- Rows written before the format change hold the same degrees at the coarser
-- ~1.1 m quantisation; they stay valid and need no migration.
CREATE TABLE IF NOT EXISTS gps (
  buoy_id    INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL,   -- epoch s, from the GPS fix
  reading_id INTEGER,
  lat        REAL,               -- degrees, negative south of the equator
  lng        REAL,               -- degrees, negative west of Greenwich
  vel        REAL,               -- speed over ground, m/s
  direction  REAL,               -- heading of motion, degrees
  rssi       INTEGER,
  device     TEXT,
  received   INTEGER NOT NULL,
  PRIMARY KEY (buoy_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_gps_received ON gps(received);

-- Temperature strings ('T'). One row per reading; `temps` is a JSON array of
-- degrees Celsius, num_sensors long, in sensor order.
CREATE TABLE IF NOT EXISTS temperature (
  buoy_id     INTEGER NOT NULL,
  timestamp   INTEGER NOT NULL,  -- epoch s
  reading_id  INTEGER,
  num_sensors INTEGER NOT NULL,
  temps       TEXT NOT NULL,     -- JSON array of REAL, degrees Celsius
  rssi        INTEGER,
  device      TEXT,
  received    INTEGER NOT NULL,
  lat         REAL,               -- see wave.lat; same provenance, same NULLs
  lng         REAL,
  PRIMARY KEY (buoy_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_temperature_received ON temperature(received);

-- Named places, as boxes in degrees. The dashboard's site filter is a lookup
-- into this table and nothing more.
--
-- Boxes rather than centre+radius because they index: a box is two BETWEENs on
-- columns that can carry an index, while a radius is a haversine over every row.
-- For a handful of named fjords that trade is obvious. Note that a box is NOT
-- square in metres - at 60 degrees north one degree of longitude is ~55.7 km
-- against ~111 km for latitude - so equal spans in degrees give a box twice as
-- tall as it is wide. Pick the corners off a map rather than by arithmetic.
--
-- Sites are resolved at READ time, against lat/lng stored on the measurement.
-- Deliberately not a site_id column on the measurements: editing a box or adding
-- a place then reclassifies the whole history at once, with no migration and no
-- backfill, which is what you want from something whose boundaries are a
-- judgement call rather than a fact about the measurement.
--
-- Boxes MAY overlap. A row resolves to the smallest box containing it (siteOf in
-- worker.js), so each row belongs to exactly one place and the counts partition
-- rather than double-count. That makes nesting useful - a harbour box inside a
-- fjord box wins for the rows inside it - and means the boxes do not have to be
-- drawn defensively. No constraint enforces disjointness, on purpose.
CREATE TABLE IF NOT EXISTS site (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  lat_min REAL NOT NULL,
  lat_max REAL NOT NULL,
  lng_min REAL NOT NULL,
  lng_max REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wave_pos        ON wave(lat, lng);
CREATE INDEX IF NOT EXISTS idx_temperature_pos ON temperature(lat, lng);
CREATE INDEX IF NOT EXISTS idx_gps_pos         ON gps(lat, lng);

-- Give wave and temperature rows a position, and add the named places the
-- dashboard's site filter selects from.
--
--   before:  position existed only in gps; a wave row could not be filtered by
--            location at all.
--   after:   wave.lat/lng and temperature.lat/lng, written by the Worker at
--            ingest from the nearest GPS fix, plus a `site` table of boxes.
--
-- Run against the remote database BEFORE deploying the Worker that writes the
-- new columns - ingest fails on an unknown column, and D1 has no partial batch.
-- Then 0003, which backfills what is already stored:
--
--   npx wrangler d1 execute orb-wave --remote --file=./migrations/0002_positions_and_sites.sql
--   npx wrangler d1 execute orb-wave --remote --file=./migrations/0003_backfill_positions.sql
--
-- The backfill is a SEPARATE file on purpose, not tidiness. D1 compiles every
-- statement in a file before running any of them, so an UPDATE that assigns to a
-- column an ALTER earlier in the SAME file adds cannot compile - the whole script
-- fails and rolls back, with an error naming some other column in the statement.
--
-- schema.sql declares lat/lng inline in CREATE TABLE, for a database built from
-- scratch. This file is the transition for one that already has rows. Do not put
-- these ALTERs in schema.sql: that file is documented as re-runnable, and
-- ADD COLUMN is not idempotent - a second run fails on "duplicate column name".

ALTER TABLE wave        ADD COLUMN lat REAL;
ALTER TABLE wave        ADD COLUMN lng REAL;
ALTER TABLE temperature ADD COLUMN lat REAL;
ALTER TABLE temperature ADD COLUMN lng REAL;

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

-- Starting boxes. Generous on purpose: a site filter is there to separate
-- Skjaerhalden from Oslo, not to draw a harbour boundary, and a box too tight is
-- the failure that silently hides measurements. Edit them freely - sites are
-- resolved at read time, so changing a box reclassifies the whole history.
--
-- These three do not overlap, but Oslo and Lillestroem are separated by only
-- 0.03 degrees of longitude (~1.7 km at this latitude) while their latitude
-- ranges do overlap - so one careless edit would make them intersect. That is
-- allowed: a row resolves to the SMALLEST box containing it, so an overlap
-- resolves deterministically instead of putting the row under both names.
INSERT OR IGNORE INTO site (name, lat_min, lat_max, lng_min, lng_max) VALUES
  ('Oslo',         59.60, 59.99,  10.40, 10.95),
  ('Lillestrøm',   59.90, 60.02,  10.98, 11.20),
  ('Skjærhalden',  58.98, 59.18,  10.90, 11.20);

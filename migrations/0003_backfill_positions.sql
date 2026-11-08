-- Backfill positions onto the rows stored before wave.lat/lng existed.
--
-- Separate from 0002 because D1 compiles a whole file before executing it, so
-- this cannot reference columns that 0002's ALTER TABLE adds. Run it after:
--
--   npx wrangler d1 execute orb-wave --remote --file=./migrations/0003_backfill_positions.sql
--
-- Safe to re-run at any time: WHERE lat IS NULL means it only touches rows that
-- still have no position. That also makes it the way to pick up a measurement
-- whose 'G' note arrived in a LATER batch than the measurement itself - ingest
-- stamps from the fixes it can already see, and this catches the rest.
--
-- SCOPE, since the wave message changed under it. A 'W' now carries its own
-- position at both ends of the window, so wave rows written after that change
-- never need this. What it is still for:
--   - wave rows written BEFORE the split, which have no position of their own
--   - temperature rows, always: the 'T' message has no position field at all
--
-- WHY THIS IS NOT "nearest fix in time", the way the Worker's ingest stamping is.
-- SQLite rejects a correlated reference to the UPDATE target inside a subquery's
-- ORDER BY - "no such column: wave.ts_end" - so `ORDER BY abs(g.timestamp -
-- wave.ts_end)` cannot be written here at all. It works in the Worker because
-- there the pivot is a BIND PARAMETER, not a column of the row being updated, so
-- nothing is correlated. WHERE and BETWEEN take the correlation fine; only
-- ORDER BY does not.
--
-- So: the LAST fix at or before the window end, and only if there is none, the
-- FIRST fix after it. Both order on g.timestamp alone, which needs no
-- correlation. This is not identical to "nearest" - a fix 5 h before wins over
-- one 10 min after - but it is deterministic, index-friendly, and defensible on
-- its own terms: a fix taken at or before the end of the window was taken while
-- the buoy was there, while one after it was taken on the way to somewhere else.
--
-- The 6 h bound is what keeps a fix from an unrelated deployment out. Beyond it
-- the honest answer is "unknown", which is what leaving NULL says.

UPDATE wave SET
  lat = COALESCE(
    (SELECT g.lat FROM gps g
      WHERE g.buoy_id = wave.buoy_id
        AND g.timestamp BETWEEN wave.ts_end - 21600 AND wave.ts_end
      ORDER BY g.timestamp DESC LIMIT 1),
    (SELECT g.lat FROM gps g
      WHERE g.buoy_id = wave.buoy_id
        AND g.timestamp BETWEEN wave.ts_end AND wave.ts_end + 21600
      ORDER BY g.timestamp ASC LIMIT 1)),
  lng = COALESCE(
    (SELECT g.lng FROM gps g
      WHERE g.buoy_id = wave.buoy_id
        AND g.timestamp BETWEEN wave.ts_end - 21600 AND wave.ts_end
      ORDER BY g.timestamp DESC LIMIT 1),
    (SELECT g.lng FROM gps g
      WHERE g.buoy_id = wave.buoy_id
        AND g.timestamp BETWEEN wave.ts_end AND wave.ts_end + 21600
      ORDER BY g.timestamp ASC LIMIT 1))
WHERE lat IS NULL;

UPDATE temperature SET
  lat = COALESCE(
    (SELECT g.lat FROM gps g
      WHERE g.buoy_id = temperature.buoy_id
        AND g.timestamp BETWEEN temperature.timestamp - 21600 AND temperature.timestamp
      ORDER BY g.timestamp DESC LIMIT 1),
    (SELECT g.lat FROM gps g
      WHERE g.buoy_id = temperature.buoy_id
        AND g.timestamp BETWEEN temperature.timestamp AND temperature.timestamp + 21600
      ORDER BY g.timestamp ASC LIMIT 1)),
  lng = COALESCE(
    (SELECT g.lng FROM gps g
      WHERE g.buoy_id = temperature.buoy_id
        AND g.timestamp BETWEEN temperature.timestamp - 21600 AND temperature.timestamp
      ORDER BY g.timestamp DESC LIMIT 1),
    (SELECT g.lng FROM gps g
      WHERE g.buoy_id = temperature.buoy_id
        AND g.timestamp BETWEEN temperature.timestamp AND temperature.timestamp + 21600
      ORDER BY g.timestamp ASC LIMIT 1))
WHERE lat IS NULL;

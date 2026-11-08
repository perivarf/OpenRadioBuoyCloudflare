-- The position at the START of the analysis window, alongside the end position
-- that wave.lat/lng already holds.
--
--   npx wrangler d1 execute orb-wave --remote --file=./migrations/0004_wave_start_position.sql
--
-- The 'W' message carries both ends - a free-drifting buoy moves during a
-- 30-minute capture, and the pair is the drift vector, which is a measurement
-- rather than metadata. Only the end position was being stored.
--
-- No backfill: rows written before this carry one position and cannot be given a
-- second one after the fact. They keep NULL here and the dashboard draws them as
-- a single point rather than a line, which is the honest picture.
--
-- lat/lng keeps its meaning (END of the window) so the site filter, the map
-- marker and the temperature table all stay as they are.

ALTER TABLE wave ADD COLUMN lat_start REAL;
ALTER TABLE wave ADD COLUMN lng_start REAL;

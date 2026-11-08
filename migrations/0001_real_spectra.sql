-- Move the wave spectrum out of the wave row and into a table of its own, with
-- the PSD values as REAL instead of the wire's uint16 fractions.
--
--   before:  wave.spectrum = JSON [0 .. 65535], absolute PSD = v/65535*max_value
--   after:   wave_bin, one row per bin: freq, psd (elevation, m^2/Hz),
--            psd_acc (acceleration as transmitted, m^2/s^4/Hz).
--            wave.spectrum and wave.max_value are gone.
--
-- The rows in there now are test data, so this drops the table rather than
-- converting it in place. The CREATE lives in schema.sql and only there, so run
-- both, in this order, BEFORE deploying the Worker that writes the new format:
--
--   npx wrangler d1 execute orb-wave --remote --file=./migrations/0001_real_spectra.sql
--   npx wrangler d1 execute orb-wave --remote --file=./schema.sql
--
-- The Worker writes wave_bin and no longer writes wave.spectrum, so ingest fails
-- until the new tables exist. gps and temperature are untouched - schema.sql is
-- CREATE TABLE IF NOT EXISTS throughout, so rerunning it leaves them alone.

DROP TABLE IF EXISTS wave_bin;   -- child first: it references wave
DROP TABLE IF EXISTS wave;

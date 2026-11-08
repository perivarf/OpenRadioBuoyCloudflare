/*
  Round-trip tests for the wire-format parsers.

  Each case is built here byte for byte the way the firmware's serialisers write
  it (wave_manager.cpp / the DEBUG_WAVE_MSG builder, gps_manager.cpp
  updateTransmitMessage, thermo_manager.cpp updateTransmitMessage), so a change on
  either side shows up as a failure rather than as silently wrong numbers on the
  dashboard.

  Run: npm test
*/
import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  parseMessage, parseWaveMessage, parsePsdMessage, parseGpsMessage, parseTempMessage,
  isAuthorizedRequest, spectrumBins,
} from "../src/worker.js";

const SCALE = 100000;
const COORD_SCALE = 10000000;  // gps_coord_scale
const PSD_SCALE = 100000000;   // wave_psd_scale - max_value only, see readings.h

class Writer {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
    this.o = 0;
  }
  u8(v) { this.dv.setUint8(this.o, v); this.o += 1; return this; }
  u16(v) { this.dv.setUint16(this.o, v, false); this.o += 2; return this; }
  i32(v) { this.dv.setInt32(this.o, v, false); this.o += 4; return this; }
  u32(v) { this.dv.setUint32(this.o, v, false); this.o += 4; return this; }
  time(v) { this.dv.setBigUint64(this.o, BigInt(v), false); this.o += 8; return this; }
  tag(c) { return this.u8(c.charCodeAt(0)); }
  // msg_insert_int: 'P'/'N' sign char then the magnitude as uint32.
  sm32(v) { return this.tag(v < 0 ? "N" : "P").u32(Math.abs(v)); }
}

/*
  'G' + u16 reading_ID + lat + lng + u32 vel + u32 direction + u64 time_t + 'E'
  = GPS_message_size (30). lat/lng are msg_insert_int fields at gps_coord_scale;
  speed and heading are plain uint32 at scale_factor.
*/
function buildGps({ reading_id, lat, lng, vel, direction, timestamp }) {
  const w = new Writer(30);
  w.tag("G").u16(reading_id)
    .sm32(Math.round(lat * COORD_SCALE)).sm32(Math.round(lng * COORD_SCALE))
    .u32(Math.round(vel * SCALE)).u32(Math.round(direction * SCALE))
    .time(timestamp).tag("E");
  return w.buf;
}

// 'T' + u16 reading_ID + u8 count + one msg_insert_int field per sensor
// + u64 time_t + 'E'.
function buildTemp({ reading_id, temps, timestamp }) {
  const w = new Writer(13 + 5 * temps.length);
  w.tag("T").u16(reading_id).u8(temps.length);
  for (const c of temps) w.sm32(Math.round(c * SCALE));
  w.time(timestamp).tag("E");
  return w.buf;
}

/*
  A wave measurement is TWO messages, paired on (buoy, ts_start):

    'W' + u16 reading_ID + 2x time_t window + 4x u32 params + 4 signed coords + 'E'
    'P' + u16 reading_ID + time_t ts_start + 3x u32 + u16 num_bins + bins + 'E'

  Both builders write ts_start, and the tests below lean on that being the same
  number - it is the only thing tying the halves together, since reading_id
  restarts at zero on every reboot of the drifter.
*/
function buildWave({ reading_id, ts_start, ts_end, hs, tc, tp, tz,
                     lat_start = 0, lng_start = 0, lat_end = 0, lng_end = 0 }) {
  const w = new Writer(56);
  const fixed = (v) => w.u32(Math.round(v * SCALE));
  w.tag("W").u16(reading_id);
  w.time(ts_start); w.time(ts_end);
  fixed(hs); fixed(tc); fixed(tp); fixed(tz);
  w.sm32(Math.round(lat_start * COORD_SCALE)).sm32(Math.round(lng_start * COORD_SCALE));
  w.sm32(Math.round(lat_end * COORD_SCALE)).sm32(Math.round(lng_end * COORD_SCALE));
  w.tag("E");
  return w.buf;
}

function buildPsd({ reading_id, ts_start, max_value, f_min, f_max, spectrum }) {
  const w = new Writer(26 + 2 * spectrum.length);
  w.tag("P").u16(reading_id).time(ts_start);
  w.u32(Math.round(max_value * PSD_SCALE));   // its own scale, not SCALE
  w.u32(Math.round(f_min * 10000000)).u32(Math.round(f_max * 10000000));
  w.u16(spectrum.length);
  for (const v of spectrum) w.u16(v);
  w.tag("E");
  return w.buf;
}

const BENCH_WAVE = {
  reading_id: 5, ts_start: 1767225781, ts_end: 1767227581,
  hs: 1.37, tc: 2.53, tp: 6.91, tz: 4.29,
  lat_start: 59.9578, lng_start: 11.0686,
  lat_end: 59.9601, lng_end: -11.0701,   // west on purpose: exercises the sign byte
};

const BENCH_PSD = {
  reading_id: 5, ts_start: 1767225781, max_value: 0.0842,
  f_min: 0.0048828, f_max: 0.9814453,
  spectrum: Array.from({ length: 51 }, (_, i) => Math.round(65535 * Math.exp(-0.5 * (((i - 17.85) / 6.12) ** 2)))),
};

test("wave: the parameter message round-trips", () => {
  const bytes = buildWave(BENCH_WAVE);
  assert.equal(bytes.length, 56);
  const w = parseWaveMessage(bytes);
  assert.equal(w.reading_id, 5);
  assert.equal(w.ts_start, 1767225781);
  assert.equal(w.ts_end - w.ts_start, 1800);
  assert.equal(w.hs.toFixed(2), "1.37");
  assert.equal(w.tc.toFixed(2), "2.53");
  assert.equal(w.tp.toFixed(2), "6.91");
  assert.equal(w.tz.toFixed(2), "4.29");
});

test("wave: the position rides in the message, both ends and both signs", () => {
  const w = parseWaveMessage(buildWave(BENCH_WAVE));
  assert.equal(w.lat_start.toFixed(4), "59.9578");
  assert.equal(w.lng_start.toFixed(4), "11.0686");
  assert.equal(w.lat_end.toFixed(4), "59.9601");
  // Negative: the sign character is a byte of its own, and dropping it would put
  // the buoy on the wrong side of Greenwich rather than fail.
  assert.equal(w.lng_end.toFixed(4), "-11.0701");
});

/*
  0,0 is not a coordinate, it is what the drifter sends when it held no fix. It
  has to become NULL before storage: stored as zeros it would place every
  fixless measurement off West Africa and inside any site box drawn there.
*/
test("wave: no fix arrives as 0,0 and is stored as null, not as a position", () => {
  const w = parseWaveMessage(buildWave({
    ...BENCH_WAVE, lat_start: 0, lng_start: 0, lat_end: 0, lng_end: 0,
  }));
  assert.equal(w.lat_start, null);
  assert.equal(w.lng_start, null);
  assert.equal(w.lat_end, null);
  assert.equal(w.lng_end, null);
  assert.equal(w.hs.toFixed(2), "1.37", "the parameters are still good");
});

test("wave: a fix at one end only still yields a position", () => {
  const w = parseWaveMessage(buildWave({
    ...BENCH_WAVE, lat_start: 0, lng_start: 0,
  }));
  assert.equal(w.lat_start, null);
  assert.equal(w.lat_end.toFixed(4), "59.9601");
});

/*
  The window is a full time_t. A four-byte epoch would have saved eight bytes and
  capped the format at 2106; the split left this message at 56 of 255 bytes, so
  there was nothing to buy. Pinned past the wrap so a narrowing cannot creep back
  in unnoticed - it would fail here rather than in 2106.
*/
test("wave: the window is an 8-byte time_t, so 2106 is not a ceiling", () => {
  const w = parseWaveMessage(buildWave({ ...BENCH_WAVE, ts_start: 4300000000, ts_end: 4300001800 }));
  assert.equal(w.ts_start, 4300000000);
  assert.equal(w.ts_end - w.ts_start, 1800);
});

test("wave: a message shorter than the fixed layout is rejected", () => {
  assert.equal(parseWaveMessage(buildWave(BENCH_WAVE).slice(0, 55)), null);
});

test("psd: the spectrum message round-trips", () => {
  const bytes = buildPsd(BENCH_PSD);
  assert.equal(bytes.length, 26 + 2 * 51);
  const p = parsePsdMessage(bytes);
  assert.equal(p.reading_id, 5);
  assert.equal(p.num_bins, 51);
  assert.equal(p.max_value.toFixed(4), "0.0842");
  assert.equal(p.f_min.toFixed(7), "0.0048828");
  assert.equal(p.f_max.toFixed(7), "0.9814453");
  assert.deepEqual(p.spectrum, BENCH_PSD.spectrum);
});

/*
  The two halves are tied together by ts_start and nothing else. reading_id is a
  counter that restarts at zero whenever the drifter reboots, so it cannot be the
  key - this pins that the value the pair shares is the timestamp.
*/
test("psd: the spectrum carries the same ts_start as its parameters", () => {
  const w = parseWaveMessage(buildWave(BENCH_WAVE));
  const p = parsePsdMessage(buildPsd(BENCH_PSD));
  assert.equal(p.ts_start, w.ts_start);
});

test("psd: a sender shipping fewer bins simply sends a shorter message", () => {
  const p = parsePsdMessage(buildPsd({ ...BENCH_PSD, spectrum: [10, 20, 30, 40] }));
  assert.equal(p.num_bins, 4);
  assert.deepEqual(p.spectrum, [10, 20, 30, 40]);
});

/*
  The band the drifter transmits is its choice: firmware drops the PSD bins below
  kPsdMinFreq (0.03 Hz) instead of shipping the spectrum from DC. That makes f_min
  the first bin CLEAR of 0.03 Hz - PSD bin 4 at 0.0390625 Hz, since 0.03/0.0097656
  is 3.07 bins - and leaves 98 of the 102 the wire can hold.
*/
const HIGHPASSED_PSD = {
  ...BENCH_PSD,
  f_min: 0.0390625, f_max: 0.9863281,
  spectrum: Array.from({ length: 98 }, (_, i) => Math.round(65535 * Math.exp(-0.5 * (((i - 25) / 8) ** 2)))),
};

test("psd: a spectrum cut below kPsdMinFreq parses on its own grid", () => {
  const bytes = buildPsd(HIGHPASSED_PSD);
  assert.equal(bytes.length, 222);           // 26-byte header + 98*2
  assert.ok(bytes.length <= 255, "the SX126x payload length field is one byte");

  const p = parsePsdMessage(bytes);
  assert.equal(p.num_bins, 98);
  assert.equal(p.f_min.toFixed(7), "0.0390625");

  // The grid is rebuilt from the header alone, so it lands on the drifter's own
  // 0.009766 Hz bins - and nothing below the firmware's floor reaches storage.
  const bins = spectrumBins(p);
  assert.equal(bins.length, 98);
  assert.equal(bins[0].freq.toFixed(7), "0.0390625");
  assert.equal((bins[1].freq - bins[0].freq).toFixed(6), "0.009766");
  assert.ok(bins.every((b) => b.freq >= 0.03), "no transmitted bin sits below kPsdMinFreq");
  assert.ok(bins.every((b) => Number.isFinite(b.psd)));

  // The bin INDEX is the index on the analysis grid, not the position in the
  // packet: bin 4 is the bin at 4*df. That is what keeps a future split spectrum
  // from having every chunk restart at 0 and collide on the primary key.
  assert.equal(bins[0].bin, 4);
  assert.equal(bins[97].bin, 101);
});

/*
  max_value carries its own scale because scale_factor could not hold it. A buoy
  at rest measures the accelerometer's noise floor, ~6.4e-7 (m/s^2)^2/Hz, which
  at 1e5 rounds to 0 - and a zero peak reconstructs every bin as 0, so a spectrum
  full of perfectly good shape arrived as a flat line of zeros. This is that
  measurement, at the scale that can express it.
*/
test("psd: a noise-floor peak survives the wire instead of quantising to zero", () => {
  const p = parsePsdMessage(buildPsd({ ...HIGHPASSED_PSD, max_value: 6.4e-7 }));

  assert.equal(Math.round(6.4e-7 * SCALE), 0, "this is what the old scale did");
  assert.ok(p.max_value > 0, "max_value must not quantise away");
  assert.equal(p.max_value.toPrecision(2), "6.4e-7");

  const bins = spectrumBins(p);
  assert.equal(Math.max(...bins.map((b) => b.psd_acc)).toPrecision(2), "6.4e-7");
  const sent = bins.filter((_, i) => p.spectrum[i] > 0);
  assert.ok(sent.length > 50 && sent.every((b) => b.psd_acc > 0 && b.psd > 0));
});

test("psd: the peak saturates rather than wraps past the uint32 ceiling", () => {
  // 42.9 (m/s^2)^2/Hz is the ceiling at this scale; the firmware clamps there.
  const p = parsePsdMessage(buildPsd({ ...HIGHPASSED_PSD, max_value: 42.94967295 }));
  assert.equal(p.max_value.toFixed(4), "42.9497");
});

test("psd: a damaged message clamps instead of reading past the end", () => {
  const p = parsePsdMessage(buildPsd(BENCH_PSD).slice(0, 76));
  assert.equal(p.num_bins, 25);
  assert.equal(p.spectrum.length, 25);
});

/*
  Acceleration to elevation. The drifter transmits S_acc in m^2/s^4/Hz as uint16
  fractions of max_value; wave_bin holds absolute reals, S_eta = S_acc/(2*pi*f)^4
  beside the S_acc it came from, at the bin centre f_i = f_min + i*df.

  A flat acceleration spectrum is the sharpest case available: every bin carries
  the same S_acc, so the elevation spectrum is 1/omega^4 alone and the ratio
  between any two bins is a power of four - exact up to the six significant
  figures the stored values are rounded to.
*/
const flatAccel = (bins, f_min, f_max, max_value) => ({
  type: "W", f_min, f_max, num_bins: bins, max_value,
  spectrum: Array.from({ length: bins }, () => 65535),
});

test("wave: elevation PSD is the acceleration PSD over (2*pi*f)^4", () => {
  // 101 bins from 0 to 1 Hz, so df is exactly 0.01 and bin i sits at i/100 Hz.
  const bins = spectrumBins(flatAccel(101, 0, 1, 1));

  assert.equal(bins.length, 101);
  assert.equal(bins[5].freq.toFixed(4), "0.0500");
  assert.equal(bins[5].psd_acc, 1);
  assert.equal(bins[5].psd.toPrecision(6), (1 / (2 * Math.PI * 0.05) ** 4).toPrecision(6));

  // Doubling the frequency divides the elevation PSD by 2^4.
  assert.equal((bins[5].psd / bins[10].psd).toPrecision(5), "16.000");
  assert.equal((bins[5].psd / bins[20].psd).toPrecision(5), "256.00");
});

/*
  The companding rule, pinned on its own.

  Every other spectrum case here uses bins at full scale, where sqrt and linear
  agree (1^2 == 1) - so none of them would notice the rule being wrong. This one
  reads bins BELOW full scale, where the two answers differ by a factor of two or
  more, because getting this wrong is the failure mode that produces a plausible
  spectrum rather than an obvious one: too flat if a sqrt payload is read
  linearly, too peaked the other way.
*/
test("wave: bins are sqrt-companded, so a bin is (raw/65535)^2 * max_value", () => {
  const bins = spectrumBins({
    type: "W", f_min: 0.1, f_max: 1, num_bins: 4, max_value: 2,
    // half scale, quarter scale, full scale, silent
    spectrum: [32768, 16384, 65535, 0],
  });

  // Half the counts is a QUARTER of the peak, not half of it.
  assert.equal(bins[0].psd_acc.toPrecision(4), (0.5 ** 2 * 2).toPrecision(4));
  assert.equal(bins[1].psd_acc.toPrecision(4), (0.25 ** 2 * 2).toPrecision(4));
  assert.equal(bins[2].psd_acc, 2);          // full scale is max_value either way
  assert.equal(bins[3].psd_acc, 0);

  // The same statement as a rule the linear reading cannot also satisfy: halving
  // the counts must quarter the value.
  assert.equal((bins[0].psd_acc / bins[1].psd_acc).toPrecision(3), "4.00");
});

test("wave: nothing is high-passed on the way in - the low bins are kept", () => {
  // A big low-frequency spike is what omega^-4 turns into metres of phantom
  // swell, and it must still be in the row: the cutoff is the dashboard's call.
  const noisy = {
    type: "W", f_min: 0, f_max: 1, num_bins: 101, max_value: 1,
    spectrum: Array.from({ length: 101 }, (_, i) => (i === 2 ? 65535 : 100)),
  };
  const bins = spectrumBins(noisy);

  assert.equal(bins.length, 101);
  assert.ok(bins[2].psd > bins[50].psd, "the 0.02 Hz spike survives storage");
  assert.equal(bins[2].psd_acc, 1);

  // f = 0 is a divide by zero, so that one bin stores its acceleration and a
  // null elevation rather than Infinity.
  assert.equal(bins[0].freq, 0);
  assert.equal(bins[0].psd, null);
  assert.ok(Number.isFinite(bins[0].psd_acc));
});

test("wave: the elevation peak sits below the acceleration peak", () => {
  // Acceleration peaks at 0.30 Hz; weighted by 1/omega^4 the elevation peak has
  // to move down the band.
  const bins = spectrumBins({
    type: "W", f_min: 0, f_max: 1, num_bins: 101, max_value: 0.5,
    spectrum: Array.from({ length: 101 }, (_, i) => Math.round(65535 * Math.exp(-0.5 * (((i - 30) / 6) ** 2)))),
  });

  const peak = (key) => bins.reduce((best, b) => (b[key] > (best[key] ?? -Infinity) ? b : best), {});
  assert.equal(peak("psd_acc").bin, 30);
  assert.ok(peak("psd").bin < 30, "elevation peak at bin " + peak("psd").bin);
});

test("wave: an all-silent spectrum converts to zeros rather than NaN", () => {
  const bins = spectrumBins(flatAccel(51, 0.0048828, 0.9814453, 0));
  assert.equal(bins.length, 51);
  assert.ok(bins.every((b) => b.psd === 0 && b.psd_acc === 0));
});

test("ingest: a 'W' writes the parameter row and touches no bins", async () => {
  const bytes = buildWave(BENCH_WAVE);
  const note = [{ device: "dev:1", received: 1767225800,
    body: { id: 3, rssi: -80, payload: Buffer.from(bytes).toString("base64") } }];

  const calls = [];
  const env = {
    INGEST_SECRET: "s3cret",
    DB: {
      prepare: (sql) => ({ bind: (...args) => { calls.push({ sql, args }); return { sql }; } }),
      batch: async () => [],
    },
  };
  const res = await worker.fetch(postNote({ "x-ingest-secret": "s3cret" }, note), env);
  assert.deepEqual((await res.json()).stored, { W: 1, P: 0, G: 0, T: 0 });

  // One statement. The parameter message carries no spectrum, so it must not
  // delete or rewrite bins that a 'P' may already have stored.
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO wave\b/);
  assert.ok(!/wave_bin/.test(calls[0].sql));

  // UPSERT, not INSERT OR REPLACE: replacing the row would cascade the bins away.
  assert.match(calls[0].sql, /ON CONFLICT\(buoy_id, ts_start\) DO UPDATE/);
  assert.ok(!/INSERT OR REPLACE INTO wave\b/.test(calls[0].sql));

  // Position comes off the message, so there is no nearest-fix subquery left.
  assert.ok(!/FROM gps/.test(calls[0].sql), "no GPS lookup should remain for 'W'");
  // Both ends are stored: lat/lng is the window END - what "where was this
  // measured" means, and what the site filter and the map marker key on - with
  // lat_start/lng_start the position the window opened at. The pair is the drift
  // vector the map draws as a line, so getting the order wrong here would draw
  // every measurement backwards.
  const args = calls[0].args;
  assert.equal(args[0], 3);                       // buoy
  assert.equal(args[1], BENCH_WAVE.ts_start);
  assert.equal(args[args.length - 4].toFixed(4), "59.9601");   // lat,       end
  assert.equal(args[args.length - 3].toFixed(4), "-11.0701");  // lng,       end
  assert.equal(args[args.length - 2].toFixed(4), "59.9578");   // lat_start, begin
  assert.equal(args[args.length - 1].toFixed(4), "11.0686");   // lng_start, begin
});

/*
  A capture that lost its fix partway keeps the end it did get. Without the
  fallback a measurement with only a start position would store no position at
  all and drop out of every site filter, when the buoy's whereabouts are in fact
  known well enough to place it.
*/
test("ingest: a 'W' with no end fix falls back to the start position", async () => {
  const bytes = buildWave({ ...BENCH_WAVE, lat_end: 0, lng_end: 0 });
  const note = [{ device: "dev:1", received: 1767225800,
    body: { id: 3, rssi: -80, payload: Buffer.from(bytes).toString("base64") } }];
  const calls = [];
  const env = {
    INGEST_SECRET: "s3cret",
    DB: { prepare: (sql) => ({ bind: (...args) => { calls.push({ sql, args }); return { sql }; } }), batch: async () => [] },
  };
  await worker.fetch(postNote({ "x-ingest-secret": "s3cret" }, note), env);

  const args = calls[0].args;
  assert.equal(args[args.length - 4].toFixed(4), "59.9578", "lat falls back to the start");
  assert.equal(args[args.length - 2].toFixed(4), "59.9578", "lat_start is still itself");
});

test("ingest: a 'P' writes bins and derives the axis from what is stored", async () => {
  // A real 10-bin chunk: f_max moves with the bin count, or df would not be the
  // drifter's 0.009766 and the derived bin indices would be meaningless.
  const df = 0.009766;
  const bytes = buildPsd({
    ...HIGHPASSED_PSD,
    f_min: 4 * df, f_max: 13 * df,
    spectrum: HIGHPASSED_PSD.spectrum.slice(0, 10),
  });
  const note = [{ device: "dev:1", received: 1767225800,
    body: { id: 3, rssi: -80, payload: Buffer.from(bytes).toString("base64") } }];

  const calls = [];
  const env = {
    INGEST_SECRET: "s3cret",
    DB: {
      prepare: (sql) => ({ bind: (...args) => { calls.push({ sql, args }); return { sql }; } }),
      batch: async () => [],
    },
  };
  const res = await worker.fetch(postNote({ "x-ingest-secret": "s3cret" }, note), env);
  assert.deepEqual((await res.json()).stored, { W: 0, P: 1, G: 0, T: 0 });

  assert.equal(calls.length, 4);
  assert.match(calls[0].sql, /DELETE FROM wave_bin/);
  assert.match(calls[1].sql, /INSERT INTO wave\b/);
  assert.match(calls[2].sql, /INSERT OR REPLACE INTO wave_bin/);
  assert.match(calls[3].sql, /UPDATE wave SET/);

  // The delete is bounded to this chunk's own frequency span, not the whole
  // measurement - otherwise a second chunk would wipe the first.
  const [, , lo, hi] = calls[0].args;
  assert.ok(lo < 4 * df && lo > 3 * df, "lo sits half a bin below the first bin");
  assert.ok(hi > 13 * df && hi < 14 * df, "hi sits half a bin above the last bin");

  // The bins are three bound values whatever the bin count - D1 caps a query at
  // 100 parameters, and 98 bins would need 588 as a VALUES list.
  assert.equal(calls[2].args.length, 3);
  const rows = JSON.parse(calls[2].args[2]);
  assert.equal(rows.length, 10);
  assert.equal(rows[0][0], 4, "bin index is the analysis-grid index, not the packet position");

  // The axis is recomputed from wave_bin rather than taken from the packet, which
  // is what makes several 'P' messages add up instead of overwriting each other.
  assert.match(calls[3].sql, /MIN\(freq\)/);
  assert.match(calls[3].sql, /COUNT\(\*\)/);
});

/*
  A measurement split across TWO 'P' messages. Nothing sends this yet - the
  spectrum fits one packet today - but the format allows it and the storage path
  has to survive it, because the failure would be silent: the second chunk
  overwriting the first leaves a plausible-looking half spectrum.
*/
test("ingest: two spectrum chunks add up instead of overwriting each other", async () => {
  const df = 0.009766;
  const chunk = (startBin, n) => buildPsd({
    ...BENCH_PSD,
    f_min: startBin * df, f_max: (startBin + n - 1) * df,
    spectrum: Array.from({ length: n }, (_, i) => 1000 + startBin + i),
  });
  const notes = [chunk(4, 10), chunk(14, 10)].map((bytes) => ({
    device: "dev:1", received: 1767225800,
    body: { id: 3, rssi: -80, payload: Buffer.from(bytes).toString("base64") },
  }));

  const calls = [];
  const env = {
    INGEST_SECRET: "s3cret",
    DB: {
      prepare: (sql) => ({ bind: (...args) => { calls.push({ sql, args }); return { sql }; } }),
      batch: async () => [],
    },
  };
  const res = await worker.fetch(postNote({ "x-ingest-secret": "s3cret" }, notes), env);
  assert.deepEqual((await res.json()).stored, { W: 0, P: 2, G: 0, T: 0 });

  const deletes = calls.filter((c) => /DELETE FROM wave_bin/.test(c.sql));
  assert.equal(deletes.length, 2);

  // The two delete ranges must not overlap: each chunk clears its own span only.
  const [, , lo1, hi1] = deletes[0].args;
  const [, , lo2, hi2] = deletes[1].args;
  assert.ok(hi1 <= lo2, `chunk 1 clears up to ${hi1}, chunk 2 from ${lo2} - they must not overlap`);
  assert.ok(hi2 > hi1);

  // And the bin indices are disjoint, so the two chunks coexist under the
  // (buoy, ts_start, bin) primary key instead of colliding at 0..9 twice.
  const inserts = calls.filter((c) => /INSERT OR REPLACE INTO wave_bin/.test(c.sql));
  const idx = inserts.map((c) => JSON.parse(c.args[2]).map((r) => r[0]));
  assert.deepEqual(idx[0], [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(idx[1], [14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  assert.equal(new Set([...idx[0], ...idx[1]]).size, 20, "no index is claimed twice");
});

/*
  Batch ordering. Temperature rows still take their position from a subquery over
  gps - the 'T' message has no position field - and a D1 batch runs in order inside
  one transaction, so a 'G' note delivered alongside only helps if it is inserted
  first. Notehub hands over a burst in arrival order, which is not that order.

  Wave rows no longer need this: the 'W' message carries its own position.
*/
test("ingest: GPS statements are batched before the rows that read them", async () => {
  const temp = buildTemp({ reading_id: 9, temps: [7.2], timestamp: 1767225781 });
  const gps = buildGps({ reading_id: 9, lat: 59.05, lng: 11.05, vel: 0.4,
                         direction: 12, timestamp: 1767225781 });
  // Temperature FIRST in the note array, which is the order that would break it.
  const notes = [temp, gps].map((bytes) => ({
    device: "dev:1", received: 1767225800,
    body: { id: 3, rssi: -80, payload: Buffer.from(bytes).toString("base64") },
  }));

  let batched = [];
  const env = {
    INGEST_SECRET: "s3cret",
    DB: {
      prepare: (sql) => ({ bind: () => ({ sql }) }),
      batch: async (stmts) => { batched = stmts; return []; },
    },
  };
  const res = await worker.fetch(postNote({ "x-ingest-secret": "s3cret" }, notes), env);
  assert.deepEqual((await res.json()).stored, { W: 0, P: 0, G: 1, T: 1 });

  const sqls = batched.map((s) => s.sql);
  const gpsAt = sqls.findIndex((s) => /INSERT OR REPLACE INTO gps/.test(s));
  const tempAt = sqls.findIndex((s) => /INSERT OR REPLACE INTO temperature/.test(s));
  assert.ok(gpsAt >= 0 && tempAt >= 0);
  assert.ok(gpsAt < tempAt, `gps must be batched first, got gps@${gpsAt} temp@${tempAt}`);
});

test("gps: round-trips position, speed and heading", () => {
  const src = { reading_id: 41, lat: 59.9139, lng: 10.7522, vel: 1.234, direction: 275.5, timestamp: 1767225781 };
  const bytes = buildGps(src);
  assert.equal(bytes.length, 30);  // 28 before lat/lng gained their sign bytes
  const g = parseGpsMessage(bytes);
  assert.equal(g.type, "G");
  assert.equal(g.reading_id, 41);
  assert.equal(g.lat.toFixed(5), "59.91390");
  assert.equal(g.lng.toFixed(5), "10.75220");
  assert.equal(g.vel.toFixed(3), "1.234");
  assert.equal(g.direction.toFixed(1), "275.5");
  assert.equal(g.timestamp, 1767225781);
});

test("gps: all four sign combinations survive", () => {
  const at = (lat, lng) =>
    parseGpsMessage(buildGps({ reading_id: 1, lat, lng, vel: 0, direction: 0, timestamp: 1 }));

  const oslo = at(59.9139, 10.7522);          // N, E
  assert.equal(oslo.lat.toFixed(4), "59.9139");
  assert.equal(oslo.lng.toFixed(4), "10.7522");

  const capeTown = at(-33.918, 18.4233);      // S, E
  assert.equal(capeTown.lat.toFixed(4), "-33.9180");
  assert.equal(capeTown.lng.toFixed(4), "18.4233");

  const reykjavik = at(64.1466, -21.9426);    // N, W - the case scale_factor's
  assert.equal(reykjavik.lat.toFixed(4), "64.1466");   // unsigned cast zeroed
  assert.equal(reykjavik.lng.toFixed(4), "-21.9426");

  const puntaArenas = at(-53.1638, -70.9171); // S, W
  assert.equal(puntaArenas.lat.toFixed(4), "-53.1638");
  assert.equal(puntaArenas.lng.toFixed(4), "-70.9171");
});

test("gps: the extra two decimals of gps_coord_scale actually arrive", () => {
  // 1e-7 deg is ~1.1 cm. Under the old scale_factor these last two digits were
  // truncated away before the message was ever built.
  const g = parseGpsMessage(buildGps({
    reading_id: 1, lat: 59.9139123, lng: -10.7522456, vel: 0, direction: 0, timestamp: 1,
  }));
  assert.equal(g.lat.toFixed(7), "59.9139123");
  assert.equal(g.lng.toFixed(7), "-10.7522456");
});

test("gps: the poles and the antimeridian stay inside the field", () => {
  const g = parseGpsMessage(buildGps({
    reading_id: 1, lat: -90, lng: 180, vel: 0, direction: 0, timestamp: 1,
  }));
  assert.equal(g.lat, -90);
  assert.equal(g.lng, 180);
});

test("gps: a message shorter than GPS_message_size is rejected", () => {
  assert.equal(parseGpsMessage(buildGps({ reading_id: 1, lat: 1, lng: 1, vel: 1, direction: 1, timestamp: 1 }).slice(0, 29)), null);
});

test("temperature: sign-and-magnitude decodes both polarities", () => {
  const temps = [7.25, -1.5, 0, 21.375];
  const t = parseTempMessage(buildTemp({ reading_id: 9, temps, timestamp: 1767225781 }));
  assert.equal(t.type, "T");
  assert.equal(t.num_sensors, 4);
  assert.deepEqual(t.temps.map((v) => Number(v.toFixed(3))), temps);
  assert.equal(t.timestamp, 1767225781);
});

test("temperature: declared sensor count is clamped to what arrived", () => {
  const full = buildTemp({ reading_id: 9, temps: [1, 2, 3, 4, 5, 6, 7, 8], timestamp: 5 });
  // Drop three sensors' worth of bytes from the middle of the sensor block.
  const short = full.slice(0, full.length - 15);
  const t = parseTempMessage(short);
  assert.equal(t.num_sensors, 5);
  assert.equal(t.temps.length, 5);
});

test("dispatch: known tags route, unknown tags are dropped", () => {
  assert.equal(parseMessage(buildWave(BENCH_WAVE)).type, "W");
  assert.equal(parseMessage(buildGps({ reading_id: 1, lat: 1, lng: 1, vel: 1, direction: 1, timestamp: 1 })).type, "G");
  assert.equal(parseMessage(buildTemp({ reading_id: 1, temps: [1], timestamp: 1 })).type, "T");
  assert.equal(parseMessage(new Uint8Array([0x41, 0, 0, 0])), null);  // 'A', analog
  assert.equal(parseMessage(new Uint8Array([])), null);
});

/*
  Notehub is a machine caller: it sends x-ingest-secret and cannot answer a
  www-authenticate challenge. The basic-auth gate used to run before routing, so
  every note came back 401 "Authentication required" and was dropped. These pin
  the ingest path open while keeping the dashboard closed.
*/
const ingestEnv = (secret) => ({
  INGEST_SECRET: secret,
  DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => [] },
});

const postNote = (headers, body = []) =>
  new Request("https://example.com/api/ingest", {
    method: "POST", headers, body: JSON.stringify(body),
  });

test("ingest: Notehub gets through with the secret and no basic auth", async () => {
  const res = await worker.fetch(postNote({ "x-ingest-secret": "s3cret" }), ingestEnv("s3cret"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("ingest: a wrong secret is 403, never a basic-auth challenge", async () => {
  const res = await worker.fetch(postNote({ "x-ingest-secret": "wrong" }), ingestEnv("s3cret"));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("www-authenticate"), null);
});

test("ingest: a stored GPS note round-trips through the handler", async () => {
  const bytes = buildGps({
    reading_id: 7, lat: -33.918, lng: -18.4233, vel: 0.5, direction: 90, timestamp: 1767225781,
  });
  const note = [{ device: "dev:1", received: 1767225800, body: { id: 3, rssi: -92, payload: Buffer.from(bytes).toString("base64") } }];
  const res = await worker.fetch(postNote({ "x-ingest-secret": "s3cret" }, note), ingestEnv("s3cret"));
  assert.deepEqual((await res.json()).stored, { W: 0, P: 0, G: 1, T: 0 });
});

test("dashboard routes stay behind basic auth", async () => {
  const res = await worker.fetch(new Request("https://example.com/api/gps"), ingestEnv("s3cret"));
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /^Basic/);
});

test("basic auth accepts the configured credentials and rejects the rest", () => {
  const missing = new Request("https://example.com/");
  assert.equal(isAuthorizedRequest(missing, {}), false);

  const wrong = new Request("https://example.com/", {
    headers: { Authorization: "Basic " + Buffer.from("user:wrong").toString("base64") },
  });
  assert.equal(isAuthorizedRequest(wrong, {}), false);

  const creds = { DASH_USER: "user", DASH_PASS: "pass" };
  assert.equal(isAuthorizedRequest(missing, creds), false);
  assert.equal(isAuthorizedRequest(wrong, creds), false);

  const ok = new Request("https://example.com/", {
    headers: { Authorization: "Basic " + Buffer.from("user:pass").toString("base64") },
  });
  assert.equal(isAuthorizedRequest(ok, creds), true);
  // No secrets configured: locked, even for a request that would otherwise match.
  assert.equal(isAuthorizedRequest(ok, {}), false);
});

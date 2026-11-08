/*
  Ingest and read API for the messages the base station forwards to Notehub.

  Three message types are decoded, all framed <tag> ... 'E' with big-endian
  integers and fixed-point floats:

    'W'  wave analysis     parse_wave_analysis_message
    'G'  GPS fix           parse_gps_message
    'T'  temperature       parse_temperature_message

  The wire formats are the firmware's own - see
  common_libraries/message_tools/src/message_parser.cpp. Timestamps are 8 bytes in
  all three: time_t is 64-bit in the ARM toolchain this firmware is built with,
  and every serialiser writes it at that natural width.

  buoy.qo carries every type at once, so the Notehub route cannot filter by
  message type. The tag byte is the filter, and an unrecognised message is
  acknowledged and dropped.
*/

const SCALE_FACTOR = 100000;       // scale_factor, firmware common_config.h
const GPS_COORD_SCALE = 10000000;  // gps_coord_scale, firmware common_config.h
const WAVE_FREQ_SCALE = 10000000;  // wave_freq_scale, readings.h
/*
  wave_psd_scale, readings.h. max_value is the acceleration-PSD peak the spectrum
  is normalised against, and it does NOT share SCALE_FACTOR with hs/tc/tp/tz: a
  PSD in (m/s^2)^2/Hz runs from ~6e-7 on a bench at rest to ~15 in a storm, and
  1e5 quantised the calm end to 0 - which made every bin reconstruct as zero.
  Reading this field at the wrong scale is silent, so it is the one number here
  that must be changed in lockstep with the firmware.
*/
const WAVE_PSD_SCALE = 100000000;
// 'W' + u16 + 2x u64 window + 4x u32 params + 4 signed coords + 'E'
const WAVE_MESSAGE_BYTES = 56;
// 'P' + u16 + u64 ts_start + 3x u32 + u16 num_bins + 'E', before any bins
const PSD_HEADER_BYTES = 26;

// A value written by msg_insert_int: a 'P'/'N' sign char then the magnitude as
// uint32. Sign-and-magnitude, not two's complement. Coordinates and temperatures
// both use it; speed and heading are magnitudes and stay on the plain uint32.
const SIGNED_FIELD_BYTES = 5;

const GPS_MESSAGE_BYTES = 30;      // 'G' + u16 + 2 signed + 2x u32 + u64 + 'E'
const TEMP_HEADER_BYTES = 4;       // 'T' + u16 + num_sensors
const TEMP_TAIL_BYTES = 9;         // u64 timestamp + 'E'

const TAG_WAVE = 0x57;  // 'W'
const TAG_GPS = 0x47;   // 'G'
const TAG_TEMP = 0x54;  // 'T'
const TAG_PSD = 0x50;   // 'P', the spectrum half of a wave measurement
const SIGN_NEGATIVE = 0x4e;  // 'N'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function basicAuthResponse() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="ORB telemetry"',
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export function isAuthorizedRequest(request, env) {
  // Credentials are Worker secrets (wrangler secret put DASH_USER / DASH_PASS).
  // Unset means locked: no configured pair, no way in.
  const expectedUser = env?.DASH_USER;
  const expectedPass = env?.DASH_PASS;
  if (!expectedUser || !expectedPass) return false;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;

  const decoded = atob(header.slice(6));
  const separator = decoded.indexOf(":");
  if (separator < 1) return false;

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return user === expectedUser && pass === expectedPass;
}

function decodeBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Cursor over a message, big-endian throughout.
function reader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 1;  // every parse starts past the tag byte
  return {
    u8: () => dv.getUint8(o++),
    u16: () => { const v = dv.getUint16(o, false); o += 2; return v; },
    u32: () => { const v = dv.getUint32(o, false); o += 4; return v; },
    i32: () => { const v = dv.getInt32(o, false); o += 4; return v; },
    // msg_extract_int's counterpart: sign char, then the magnitude. Anything
    // other than 'N' reads as positive, matching msg_insert_int which only ever
    // writes 'P' or 'N'.
    sm32: () => {
      const sign = dv.getUint8(o) === SIGN_NEGATIVE ? -1 : 1;
      o += 1;
      const v = dv.getUint32(o, false); o += 4;
      return sign * v;
    },
    // time_t is 8 bytes on the sender. Epochs are far inside Number's exact
    // integer range, so the BigInt only exists for the width of the read.
    time: () => { const v = dv.getBigUint64(o, false); o += 8; return Number(v); },
    at: () => o,
  };
}

/*
  A WAVE MEASUREMENT ARRIVES AS TWO MESSAGES.

    'W'  the parameters: window, position, Hs/Tc/Tp/Tz
    'P'  the spectrum:   max_value, the frequency axis, the bins

  They are paired on (buoy_id, ts_start), which BOTH carry - not on reading_id,
  which restarts from zero every time the drifter reboots and would therefore
  attach one session's spectrum to another session's parameters. That is also the
  primary key of the `wave` table, so the pair needs no staging: whichever message
  arrives first creates the row and the other fills in its half. Order does not
  matter and neither does which batch they land in.

  Consequence for the writes: they must UPSERT, never INSERT OR REPLACE. Replacing
  the row deletes it first, and wave_bin cascades on that delete - so a 'W'
  arriving after its 'P' would silently take the spectrum with it. Each message
  updates only the columns it owns; see INSERT_WAVE and INSERT_WAVE_SPECTRUM.
*/
export function parseWaveMessage(bytes) {
  if (bytes.length < WAVE_MESSAGE_BYTES || bytes[0] !== TAG_WAVE) return null;
  const r = reader(bytes);

  const reading_id = r.u16();
  // Full 8-byte time_t, as every other message here carries it. Narrowing to a
  // uint32 would save eight bytes and cap the format at 2106; splitting the
  // measurement in two is what made those bytes not worth having.
  const ts_start = r.time();
  const ts_end = r.time();
  const hs = r.u32() / SCALE_FACTOR;
  const tc = r.u32() / SCALE_FACTOR;
  const tp = r.u32() / SCALE_FACTOR;
  const tz = r.u32() / SCALE_FACTOR;

  /*
    Position at each end of the analysis window, sign-and-magnitude at 1e-7 deg,
    the same encoding the 'G' message uses.

    0,0 is not a coordinate, it is "the buoy held no fix" - the drifter sends it
    when UBX_PVT was invalid. Turned into null here so it reaches D1 as a NULL and
    falls outside every site filter, rather than placing the measurement in the
    Gulf of Guinea. Both ends are tested together: a capture that got a fix at one
    end and not the other still has a usable position.
  */
  const lat_start = r.sm32() / GPS_COORD_SCALE;
  const lng_start = r.sm32() / GPS_COORD_SCALE;
  const lat_end = r.sm32() / GPS_COORD_SCALE;
  const lng_end = r.sm32() / GPS_COORD_SCALE;
  const fix = (a, b) => (a === 0 && b === 0 ? null : a);

  return {
    type: "W", reading_id, ts_start, ts_end, hs, tc, tp, tz,
    lat_start: fix(lat_start, lng_start), lng_start: fix(lng_start, lat_start),
    lat_end: fix(lat_end, lng_end), lng_end: fix(lng_end, lat_end),
  };
}

/*
  The spectrum message. num_bins is taken from the wire and clamped to what
  actually arrived, so a short packet yields a short spectrum rather than a parse
  past the end of the buffer - which is also how a sender that legitimately ships
  fewer bins is handled, since the spectrum is the last field.

  The spectrum on the wire is the ACCELERATION PSD, in m^2/s^4/Hz, sqrt-companded
  against max_value. The parser returns the raw counts as transmitted; spectrumBins
  applies the companding and the omega^-4 conversion on the way into D1. The byte
  layout does not say which companding rule produced it, which is why the decode
  rule cannot be detected from the payload. See SPECTRUM_FULL_SCALE.
*/
export function parsePsdMessage(bytes) {
  if (bytes.length < PSD_HEADER_BYTES || bytes[0] !== TAG_PSD) return null;
  const r = reader(bytes);

  const reading_id = r.u16();
  const ts_start = r.time();           // the join key back to the 'W' message
  const max_value = r.u32() / WAVE_PSD_SCALE;
  const f_min = r.u32() / WAVE_FREQ_SCALE;
  const f_max = r.u32() / WAVE_FREQ_SCALE;
  const declared_bins = r.u16();

  // One trailing byte is the 'E' terminator, so it is not spectrum data.
  const available_bins = Math.max(0, Math.floor((bytes.length - r.at() - 1) / 2));
  const num_bins = Math.min(declared_bins, available_bins);

  const spectrum = new Array(num_bins);
  for (let i = 0; i < num_bins; i++) spectrum[i] = r.u16();

  return { type: "P", reading_id, ts_start, max_value, f_min, f_max, num_bins, spectrum };
}

/*
  GPS fix.

  Coordinates and the other two fields are on different encodings and different
  scales, which is deliberate:

    lat, lng   sign-and-magnitude, 1e-7 deg (gps_coord_scale)
    vel        uint32, m/s * scale_factor
    direction  uint32, deg * scale_factor

  Coordinates need the sign for anything south of the equator or west of
  Greenwich, and they carry the receiver's native 1e-7 deg rather than
  scale_factor's 5 decimals - that scale quantised position to about 1.1 m and
  the conversion into it destroyed the sign on the way. Speed and course over
  ground are magnitudes that cannot go negative, so they cost no sign byte.
*/
export function parseGpsMessage(bytes) {
  if (bytes.length < GPS_MESSAGE_BYTES || bytes[0] !== TAG_GPS) return null;
  const r = reader(bytes);

  const reading_id = r.u16();
  const lat = r.sm32() / GPS_COORD_SCALE;
  const lng = r.sm32() / GPS_COORD_SCALE;
  const vel = r.u32() / SCALE_FACTOR;
  const direction = r.u32() / SCALE_FACTOR;
  const timestamp = r.time();

  return { type: "G", reading_id, lat, lng, vel, direction, timestamp };
}

/*
  Temperature string. Each sensor is one msg_insert_int field, the same encoding
  the coordinates use. num_sensors is clamped to what arrived, same reasoning as
  the spectrum.
*/
export function parseTempMessage(bytes) {
  if (bytes.length < TEMP_HEADER_BYTES + TEMP_TAIL_BYTES || bytes[0] !== TAG_TEMP) return null;
  const r = reader(bytes);

  const reading_id = r.u16();
  const declared_sensors = r.u8();

  const room = bytes.length - r.at() - TEMP_TAIL_BYTES;
  const num_sensors = Math.min(declared_sensors, Math.max(0, Math.floor(room / SIGNED_FIELD_BYTES)));

  const temps = new Array(num_sensors);
  for (let i = 0; i < num_sensors; i++) temps[i] = r.sm32() / SCALE_FACTOR;

  const timestamp = r.time();
  return { type: "T", reading_id, num_sensors, temps, timestamp };
}

/*
  Acceleration PSD to elevation PSD.

    S_eta(f) = S_acc(f) / (2*pi*f)^4          [m^2/Hz] = [m^2/s^4/Hz] / [1/s^4]

  evaluated at the centre of each bin, f_i = f_min + i*df, df = (f_max-f_min)/
  (num_bins-1) - the same bin grid the dashboard plots against. f_min is the
  first bin CENTRE and is not zero on real messages; the guard below exists for
  a malformed one, not for the physics.

  The band is whatever the sender chose: current firmware drops the bins below
  its kPsdMinFreq before quantising, so f_min arrives at ~0.039 Hz and num_bins
  is correspondingly smaller, where older buoys started at 0.0049 Hz. Nothing
  here is pinned to either - the grid is rebuilt per message from the three
  header fields, which is also why measurements on the two bands coexist in
  wave_bin without a migration.

  Returns one object per bin, which is what wave_bin holds. Nothing is cut and
  nothing is requantised: at f_min = 0.0049 Hz the omega^-4 gain is ~1.1e6, so
  folding the result back into uint16 fractions of its own new peak would leave
  the actual wave band with tens of levels out of 65535. Further high-passing is
  a question about what to look at, and it belongs in the dashboard, where it can
  be changed after the fact.

  Elevation is derived here rather than sent: the buoy transmits acceleration, so
  this side stays free to choose the taper and the low-frequency cut. Sending
  elevation was measured and rejected upstream - untapered it peaks in the bottom
  bin of every field capture, which would have made max_value omega^-4-amplified
  drift instead of a wave measurement.
*/
/*
  The uint16 the wire normalises bins to, and the companding rule that goes with
  it. The sender stores sqrt(bin/peak) * 65535, so a bin is
  (raw/65535)^2 * max_value - squared, not a plain multiply.

  Why the square root is there: max_value is the largest bin in the transmitted
  band, and the vertical acceleration PSD of a buoy keeps climbing past 0.5 Hz on
  chop, so with the band running to 1 Hz the peak is set by something that is not
  a wave and sits three to four decades above the wave band. Replaying the field
  captures through the linear rule left the weakest wave-band bin on 3 counts out
  of 65535; the square root puts them on 457-3642, which is 10-72x less
  quantisation error for one multiply here.

  THIS IS A FLAG DAY. The message carries no format version - the byte layout is
  identical either way - so this Worker cannot tell an old payload from a new one,
  and applying the wrong rule fails silently: a linear payload read as sqrt comes
  out too peaked, a sqrt payload read as linear too flat, both plausible. It must
  be deployed together with the buoy and base-station flash, and any note already
  queued in Notehub from a pre-flip buoy will be decoded wrong. Rows already in
  wave_bin are unaffected: they hold decoded reals, not raw counts.
*/
const SPECTRUM_FULL_SCALE = 65535;

// The wire carries ~4.8 significant digits, so six is lossless against the
// source and keeps the stored numbers from being noise past the decimal point.
const round6 = (v) => Number(v.toPrecision(6));

/*
  The bin INDEX is derived from the frequency, not from the position in this
  message: bin = round(freq / df), the index on the analysis grid the drifter ran.

  That is what lets a measurement arrive as SEVERAL 'P' messages. A future sender
  splitting the spectrum - to widen the band past what one 255-byte packet holds,
  say - ships each chunk with its own f_min/f_max, and each chunk's bins land on
  their own global indices instead of every chunk restarting at 0 and colliding on
  the (buoy, ts_start, bin) primary key. Nothing about the single-message case
  changes except the numbering: a spectrum starting at 0.0391 Hz with df 0.009766
  now numbers its first bin 4 rather than 0, which is the PSD bin it actually is.

  Storage was already built for this - wave_bin stores freq per row and the schema
  says to compare rows by freq, never by bin index - so the index is a stable sort
  key and nothing more.
*/
export function spectrumBins(msg) {
  const bins = msg.spectrum.length;
  if (!bins) return [];

  const df = bins > 1 ? (msg.f_max - msg.f_min) / (bins - 1) : 0;
  return msg.spectrum.map((raw, i) => {
    const freq = msg.f_min + i * df;
    // df = 0 means a single-bin message, which has no grid to index against; fall
    // back to the position, since there is exactly one and it cannot collide.
    const bin = df > 0 ? Math.round(freq / df) : i;
    const n = raw / SPECTRUM_FULL_SCALE;
    const psd_acc = round6(n * n * msg.max_value);
    const w = 2 * Math.PI * freq;
    return { bin, freq, psd_acc, psd: freq > 0 ? round6(psd_acc / (w * w * w * w)) : null };
  });
}

export function parseMessage(bytes) {
  if (!bytes.length) return null;
  switch (bytes[0]) {
    case TAG_WAVE: return parseWaveMessage(bytes);
    case TAG_PSD: return parsePsdMessage(bytes);
    case TAG_GPS: return parseGpsMessage(bytes);
    case TAG_TEMP: return parseTempMessage(bytes);
    default: return null;
  }
}

/*
  Position for a measurement that does not carry one.

  The wave message now carries its own lat/lng - the drifter samples the fix at
  each end of the analysis window - so this is only for TEMPERATURE, which still
  has no position field of its own. It takes the nearest GPS fix for that buoy and
  stores it on the row.

  As a subquery in the INSERT rather than a lookup before it: it keeps
  statementsFor synchronous and free of round trips, and a 'G' note earlier in the
  SAME batch is already visible, since D1 runs a batch in order inside one
  transaction.

  Nearest in TIME, not the latest fix at or before. A reading can have its only fix
  afterwards - the buoy surfaces, gets a fix, then transmits - and "latest at or
  before" would leave that one NULL forever.

  The window is what stops a fix from an unrelated deployment being used. Six hours
  is loose enough for a buoy that reports position sparsely over LoRa and tight
  enough that it cannot reach the previous outing. Outside it the honest answer is
  "position unknown", which is what a NULL says; such a row falls outside every
  site filter rather than being placed somewhere plausible.
*/
const POS_WINDOW_S = 21600;

const nearestFix = (col) => `(
  SELECT g.${col} FROM gps g
   WHERE g.buoy_id = ?
     AND g.timestamp BETWEEN ? - ${POS_WINDOW_S} AND ? + ${POS_WINDOW_S}
   ORDER BY abs(g.timestamp - ?) LIMIT 1)`;

/*
  The two halves of a wave measurement, each writing only the columns it owns.

  UPSERT, not INSERT OR REPLACE. Replacing deletes the row before re-inserting it,
  and wave_bin has ON DELETE CASCADE - so a 'W' that arrived after its 'P' would
  take the spectrum with it, silently, leaving a measurement with num_bins set and
  no bins. DO UPDATE touches the named columns and leaves the rest of the row
  alone, which is what makes the pair order-independent.

  A redelivered note is still idempotent: Notehub retries, and writing the same
  values over themselves changes nothing.
*/
const INSERT_WAVE = `
  INSERT INTO wave
    (buoy_id, ts_start, ts_end, reading_id, hs, tc, tp, tz,
     num_bins, rssi, device, received, lat, lng, lat_start, lng_start)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(buoy_id, ts_start) DO UPDATE SET
     ts_end = excluded.ts_end, reading_id = excluded.reading_id,
     hs = excluded.hs, tc = excluded.tc, tp = excluded.tp, tz = excluded.tz,
     rssi = excluded.rssi, device = excluded.device, received = excluded.received,
     lat = excluded.lat, lng = excluded.lng,
     lat_start = excluded.lat_start, lng_start = excluded.lng_start`;

/*
  The spectrum half. It owns the frequency axis and the bin count, and it must be
  able to create the row on its own: wave_bin references wave, so a 'P' whose 'W'
  is still in flight has nowhere to put its bins otherwise.

  The placeholder it inserts carries ts_end = ts_start, which reads as a zero-length
  window - visibly incomplete rather than plausibly wrong - and leaves the
  parameters NULL until the 'W' lands.
*/
const INSERT_WAVE_SPECTRUM = `
  INSERT INTO wave
    (buoy_id, ts_start, ts_end, reading_id, num_bins, rssi, device, received)
  VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  ON CONFLICT(buoy_id, ts_start) DO UPDATE SET received = excluded.received`;

/*
  Clear only the frequency range THIS message covers, not every bin of the
  measurement.

  A measurement may arrive as several 'P' messages - the format lets a sender split
  the spectrum across packets, each chunk carrying its own f_min/f_max - so
  deleting the lot would mean every chunk wiped the ones before it and only the
  last survived. Bounded by half a bin either side, which is exactly the span this
  chunk's own bins occupy.

  Still needed for the single-chunk case: a redelivered message carrying fewer bins
  than the first attempt would otherwise leave the tail of the old spectrum behind,
  silently lengthening the measurement.
*/
const DELETE_WAVE_BINS = `
  DELETE FROM wave_bin
   WHERE buoy_id = ? AND ts_start = ? AND freq BETWEEN ? AND ?`;

/*
  The whole chunk in one statement and three bound values: D1 allows at most
  100 parameters per query, so a VALUES list with six per bin runs out at 16 of
  them. The bins travel as a single JSON array of [bin, freq, psd, psd_acc] and
  json_each unpacks it inside SQLite, which puts no limit on the bin count.
*/
const INSERT_WAVE_BINS = `
  INSERT OR REPLACE INTO wave_bin (buoy_id, ts_start, bin, freq, psd, psd_acc)
  SELECT ?, ?,
         json_extract(value, '$[0]'), json_extract(value, '$[1]'),
         json_extract(value, '$[2]'), json_extract(value, '$[3]')
    FROM json_each(?)`;

/*
  The wave row's frequency axis and bin count, taken from what is actually stored
  rather than from whichever packet arrived last.

  With one chunk this says the same thing the chunk did. With several it is the
  only correct answer: no single 'P' knows the full band, and f_min/f_max/num_bins
  describe the measurement, not the packet.
*/
const REFRESH_WAVE_AXIS = `
  UPDATE wave SET
    f_min    = (SELECT MIN(freq) FROM wave_bin b WHERE b.buoy_id = ? AND b.ts_start = ?),
    f_max    = (SELECT MAX(freq) FROM wave_bin b WHERE b.buoy_id = ? AND b.ts_start = ?),
    num_bins = (SELECT COUNT(*)  FROM wave_bin b WHERE b.buoy_id = ? AND b.ts_start = ?)
  WHERE buoy_id = ? AND ts_start = ?`;

const INSERT_GPS = `
  INSERT OR REPLACE INTO gps
    (buoy_id, timestamp, reading_id, lat, lng, vel, direction, rssi, device, received)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_TEMP = `
  INSERT OR REPLACE INTO temperature
    (buoy_id, timestamp, reading_id, num_sensors, temps, rssi, device, received, lat, lng)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?,
          ${nearestFix("lat")}, ${nearestFix("lng")})`;

// The four binds nearestFix() takes, in order: buoy, the two window bounds, and
// the value abs() sorts against. All the same two numbers - kept as four binds
// rather than reusing ?N so the placeholder order stays positional throughout.
const fixBinds = (buoyId, t) => [buoyId, t, t, t];

/*
  One message becomes one or more statements.

  A 'W' is one: the parameter columns of the wave row, upserted. It no longer
  touches wave_bin at all - it does not carry a spectrum - so a redelivered 'W'
  cannot disturb bins that are already stored.

  A 'P' is three: clear whatever bins that (buoy, ts_start) already had, upsert the
  axis columns of the wave row, then write the bins in a single multi-row INSERT.

  The DELETE is not redundant with the upsert. The row is no longer replaced, so
  nothing cascades any more - and a redelivered 'P' carrying fewer bins than the
  first attempt would otherwise leave the tail of the old spectrum behind, silently
  lengthening the measurement.

  The bins go in one statement rather than one per bin, which keeps a single note
  from turning into a hundred-statement batch. See INSERT_WAVE_BINS for why they
  travel as JSON rather than as a VALUES list.
*/
function statementsFor(env, msg, meta) {
  const { buoyId, rssi, device, received } = meta;

  if (msg.type === "W") {
    /*
      Position comes straight off the message - the drifter samples a fix at each
      end of the window - so there is no nearest-fix subquery here and no
      dependency on a 'G' note having arrived first.

      Both ends are stored. lat/lng is the end position, which is what "where was
      this measured" means and what the site filter uses; lat_start/lng_start is
      where the window began, and the two together are the drift vector the
      dashboard draws as a line.
    */
    return [env.DB.prepare(INSERT_WAVE).bind(
      buoyId, msg.ts_start, msg.ts_end, msg.reading_id,
      msg.hs, msg.tc, msg.tp, msg.tz,
      rssi, device, received,
      // lat/lng is the END of the window - the more recent of the two, and what
      // the site filter and the map marker key on. Falling back to the start
      // position keeps a capture that lost its fix mid-window on the map.
      msg.lat_end ?? msg.lat_start ?? null,
      msg.lng_end ?? msg.lng_start ?? null,
      msg.lat_start ?? null,
      msg.lng_start ?? null,
    )];
  }

  if (msg.type === "P") {
    const bins = spectrumBins(msg);
    // Half a bin either side of what this chunk covers, so the delete reaches its
    // own bins and no further. A one-bin message has no spacing to halve; a hair of
    // tolerance keeps float equality out of it.
    const df = bins.length > 1 ? bins[1].freq - bins[0].freq : 0;
    const pad = df > 0 ? df / 2 : 1e-9;
    const lo = bins.length ? bins[0].freq - pad : 0;
    const hi = bins.length ? bins[bins.length - 1].freq + pad : 0;

    const out = [
      env.DB.prepare(DELETE_WAVE_BINS).bind(buoyId, msg.ts_start, lo, hi),
      // ts_end = ts_start on the placeholder path: a zero-length window is visibly
      // incomplete, where copying ts_start into it as a guess would not be.
      // num_bins goes in as 0 and REFRESH_WAVE_AXIS corrects it below by counting
      // rows, rather than trusting one packet's idea of the total.
      env.DB.prepare(INSERT_WAVE_SPECTRUM).bind(
        buoyId, msg.ts_start, msg.ts_start, msg.reading_id, rssi, device, received,
      ),
    ];
    if (bins.length) {
      out.push(env.DB.prepare(INSERT_WAVE_BINS).bind(
        buoyId, msg.ts_start,
        JSON.stringify(bins.map((b) => [b.bin, b.freq, b.psd, b.psd_acc])),
      ));
    }
    // Last, so it sees this chunk's rows as well as any earlier chunk's.
    out.push(env.DB.prepare(REFRESH_WAVE_AXIS).bind(
      buoyId, msg.ts_start, buoyId, msg.ts_start, buoyId, msg.ts_start,
      buoyId, msg.ts_start,
    ));
    return out;
  }

  if (msg.type === "G") {
    return [env.DB.prepare(INSERT_GPS).bind(
      buoyId, msg.timestamp, msg.reading_id,
      msg.lat, msg.lng, msg.vel, msg.direction, rssi, device, received,
    )];
  }
  return [env.DB.prepare(INSERT_TEMP).bind(
    buoyId, msg.timestamp, msg.reading_id, msg.num_sensors,
    JSON.stringify(msg.temps), rssi, device, received,
    ...fixBinds(buoyId, msg.timestamp), ...fixBinds(buoyId, msg.timestamp),
  )];
}

async function handleIngest(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.INGEST_SECRET) return json({ error: "INGEST_SECRET is not configured" }, 500);
  if (request.headers.get("x-ingest-secret") !== env.INGEST_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }

  const events = Array.isArray(payload) ? payload : [payload];
  /*
    GPS statements are collected separately and run FIRST, for TEMPERATURE rows.
    The 'T' message has no position field, so its row takes one from a subquery
    over gps - and a D1 batch runs in order inside one transaction, so a 'G' note
    delivered in the same batch only helps if it is inserted before the row that
    reads it. Notehub routes a burst as one array in arrival order, which is not
    that order.

    Wave rows no longer need any of this: the 'W' message carries its own
    position at both ends of the window, so it is independent of whether a 'G'
    note arrived at all.

    This is a best effort, not a guarantee: a 'G' note in a LATER batch still
    leaves a temperature row NULL. migrations/0003 is what closes that, and it
    can be re-run.
  */
  const gpsStatements = [];
  const statements = [];
  const stored = { W: 0, P: 0, G: 0, T: 0 };
  let skipped = 0;

  for (const ev of events) {
    const body = ev && ev.body;
    if (!body || typeof body.payload !== "string") { skipped++; continue; }

    let msg = null;
    try {
      msg = parseMessage(decodeBase64(body.payload));
    } catch {
      msg = null;
    }
    if (!msg) { skipped++; continue; }

    (msg.type === "G" ? gpsStatements : statements).push(...statementsFor(env, msg, {
      buoyId: Number.isFinite(body.id) ? body.id : 0,
      rssi: Number.isFinite(body.rssi) ? Math.round(body.rssi) : null,
      device: typeof ev.device === "string" ? ev.device : null,
      received: Math.round(Number(ev.received) || Date.now() / 1000),
    }));
    stored[msg.type]++;
  }

  const batch = [...gpsStatements, ...statements];
  if (batch.length) await env.DB.batch(batch);

  // 200 even when nothing was stored: an unrecognised note is a normal thing to
  // see, and a non-2xx would only make Notehub retry it forever.
  return json({ ok: true, stored, skipped });
}

/*
  The wave read path stitches wave_bin back into three parallel arrays per
  measurement, so the API keeps the shape the dashboard already consumes and the
  normalised table stays an implementation detail of storage. Each array is
  ordered by bin, which is why the ORDER BY sits in a subquery: json_group_array
  aggregates in the order its rows arrive.
*/
const binArray = (col) =>
  `(SELECT json_group_array(${col}) FROM
      (SELECT ${col} FROM wave_bin b
        WHERE b.buoy_id = w.buoy_id AND b.ts_start = w.ts_start ORDER BY b.bin))`;

const SELECT_WAVE =
  `SELECT w.*, ${binArray("freq")} AS freqs, ${binArray("psd")} AS spectrum, ` +
  `${binArray("psd_acc")} AS spectrum_acc FROM wave w`;

/*
  Shared read path for the three tables. `hours` filters on `received` - the
  Notehub receipt time, which is real even when the buoy's own RTC is not.
*/
async function handleSeries(url, env, { table, timeColumn, jsonColumns = [], select, alias = null }) {
  // The wave read path aliases its table (FROM wave w), and once aliased the
  // bare table name is not a valid qualifier - so the site filter has to use
  // whatever name the FROM clause actually bound.
  const t = alias || table;
  const buoy = url.searchParams.get("buoy");
  const site = url.searchParams.get("site");
  const hours = Number(url.searchParams.get("hours"));
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 1000, 1), 5000);

  const where = [];
  const binds = [];
  if (buoy !== null && buoy !== "" && buoy !== "all") {
    where.push("buoy_id = ?");
    binds.push(Number(buoy));
  }
  /*
    Site filter, against the row's RESOLVED place - the smallest containing box,
    see siteOf - rather than "is inside this named box". With overlapping boxes
    the two differ: the resolved form puts each row under exactly one place, so
    what the filter shows and what the picker counts are the same set.

    A row with no position drops out on its own - BETWEEN against NULL is NULL,
    so siteOf yields NULL and NULL = ? is never true - which is the behaviour
    wanted. A measurement whose GPS note was lost genuinely cannot be claimed for
    a place, and showing it under every site would be worse than showing it under
    none. It is still reachable with the filter on "All".

    An unknown site name matches nothing, rather than falling back to unfiltered:
    a typo that silently widens the selection is the failure mode to avoid here.
  */
  if (site !== null && site !== "" && site !== "all") {
    where.push(`${siteOf(t)} = ?`);
    binds.push(site);
  }
  if (Number.isFinite(hours) && hours > 0) {
    where.push("received >= ?");
    binds.push(Math.round(Date.now() / 1000 - hours * 3600));
  }
  // Explicit window, epoch seconds on `received`; `to` is exclusive. Absent or
  // non-numeric means open-ended on that side.
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from !== null && from !== "" && Number.isFinite(Number(from))) {
    where.push("received >= ?");
    binds.push(Number(from));
  }
  if (to !== null && to !== "" && Number.isFinite(Number(to))) {
    where.push("received < ?");
    binds.push(Number(to));
  }

  const sql = `${select || `SELECT * FROM ${table}`}
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY ${timeColumn} DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds, limit).all();

  // Newest-first in SQL so LIMIT keeps the most recent rows; oldest-first out,
  // which is the order the charts plot in.
  const rows = results.reverse().map((r) => {
    const out = { ...r };
    // A measurement whose bins never arrived yields NULL, not '[]'.
    for (const c of jsonColumns) out[c] = r[c] == null ? [] : JSON.parse(r[c]);
    return out;
  });

  return json({ rows });
}

/*
  Which place a row belongs to: the SMALLEST box that contains it.

  Boxes are allowed to overlap, and resolving to exactly one place is what keeps
  that from being a problem. Two consequences, both wanted:

    - Nesting becomes a feature. A "Skjaerhalden harbour" box drawn inside a
      "Hvaler" box wins for the rows inside it, so places can be as coarse or as
      fine as the question needs.
    - Counts partition. Every row lands in at most one site, so the numbers in
      the picker sum to the total instead of double-counting the overlaps.

  Without this a row in an overlap would appear under both names - not corrupt,
  but the sort of ambiguity that only shows up once the boxes have been edited a
  few times. The starting boxes for Oslo and Lillestroem are separated by 0.03
  degrees of longitude, about 1.7 km, so this is one careless edit away.

  Ranked by area in SQUARE DEGREES, which is not area on the ground - a degree of
  longitude is about half a degree of latitude at 60 N. For genuinely nested
  boxes that does not matter: the inner box is smaller on both axes, so it wins
  under any metric. For boxes that merely clip each other the ranking is an
  arbitrary but stable tiebreak, which is all it needs to be.
*/
const siteOf = (t) => `(
  SELECT s2.name FROM site s2
   WHERE ${t}.lat BETWEEN s2.lat_min AND s2.lat_max
     AND ${t}.lng BETWEEN s2.lng_min AND s2.lng_max
   ORDER BY (s2.lat_max - s2.lat_min) * (s2.lng_max - s2.lng_min)
   LIMIT 1)`;

/*
  The named places, with a count of how much resolves to each.

  The counts are what makes the picker honest: a site with 0 measurements is
  either a box drawn in the wrong place or a deployment that has not happened
  yet, and both are worth seeing before concluding the filter is broken. They are
  three correlated counts over a table of a handful of rows, so the cost is
  nothing at this size and bounded by the number of sites, not measurements.
*/
async function handleSites(env) {
  const inSite = (t) => `(SELECT COUNT(*) FROM ${t} x WHERE ${siteOf("x")} = s.name)`;
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.name, s.lat_min, s.lat_max, s.lng_min, s.lng_max,
            ${inSite("wave")} AS wave_rows,
            ${inSite("gps")} AS gps_rows,
            ${inSite("temperature")} AS temp_rows
       FROM site s ORDER BY s.name`,
  ).all();
  return json({ sites: results });
}

async function handleBuoys(env) {
  // A buoy that has only ever sent GPS still belongs in the picker, so the list
  // is the union across the three tables.
  const { results } = await env.DB.prepare(
    `SELECT buoy_id, SUM(n) AS readings, MAX(last_seen) AS last_seen FROM (
       SELECT buoy_id, COUNT(*) AS n, MAX(received) AS last_seen FROM wave GROUP BY buoy_id
       UNION ALL
       SELECT buoy_id, COUNT(*), MAX(received) FROM gps GROUP BY buoy_id
       UNION ALL
       SELECT buoy_id, COUNT(*), MAX(received) FROM temperature GROUP BY buoy_id
     ) GROUP BY buoy_id ORDER BY buoy_id`,
  ).all();
  return json({ buoys: results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      /*
        Ingest is exempt from the basic-auth gate, and has to be: Notehub is a
        machine caller that authenticates with the x-ingest-secret header and has
        no way to answer a www-authenticate challenge. Routing it before the gate
        rather than weakening the gate keeps the dashboard behind a password
        while handleIngest enforces its own shared secret - which is the stronger
        check of the two, since basic auth sends its credentials with every request.
      */
      if (url.pathname === "/api/ingest") return await handleIngest(request, env);

      if (!isAuthorizedRequest(request, env)) {
        return basicAuthResponse();
      }
      if (url.pathname === "/api/wave") {
        return await handleSeries(url, env, {
          table: "wave", alias: "w", timeColumn: "ts_start", select: SELECT_WAVE,
          jsonColumns: ["freqs", "spectrum", "spectrum_acc"],
        });
      }
      if (url.pathname === "/api/gps") {
        return await handleSeries(url, env, { table: "gps", timeColumn: "timestamp" });
      }
      if (url.pathname === "/api/temperature") {
        return await handleSeries(url, env, { table: "temperature", timeColumn: "timestamp", jsonColumns: ["temps"] });
      }
      if (url.pathname === "/api/buoys") return await handleBuoys(env);
      if (url.pathname === "/api/sites") return await handleSites(env);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
    return json({ error: "not found" }, 404);
  },
};

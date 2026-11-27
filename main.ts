// png-squeeze: squeeze screenshots into the smallest lossless PNG.
//
// My own re-encoder, written from scratch for the make.fun
// png-squeeze-01-run-20261127 bounty. One run answers a whole set of 8
// screenshots (1280x720 RGBA): it reads /input/<id>/image.png and writes
// /output/<id>/image.png, losslessly, as small as it can.
//
// How it works, per image:
//   1. Decode the stored PNG (own minimal decoder: chunk walk, zlib inflate,
//      row unfiltering) to raw RGBA.
//   2. Pick the cheapest colour representation from the pixels themselves:
//      grey (type 0) when R == G == B everywhere and opaque, grey+alpha
//      (type 4) when grey with varying alpha, palette (type 3 + tRNS) when
//      there are at most 256 distinct RGBA colours, plain RGB (type 2) when
//      opaque, RGBA (type 6) otherwise. A fully transparent pixel keeps its
//      exact RGB through the palette / alpha channel.
//   3. Filter every row under each of seven schemes — one fixed PNG filter
//      (None/Sub/Up/Average/Paeth) for the whole image, plus two per-row
//      minimum-sum choices (all five filters, or None/Paeth only) — and deflate each at zlib level 9, keeping the
//      smallest stream (then the filtered-data strategy on the winner).
//      The minimum-sum heuristic is only a proxy for compressed size and
//      often loses to one fixed filter, so the choice is made on real
//      deflated bytes, bounded by scheme count and never by the clock.
//   5. Write a minimal PNG: IHDR, PLTE (palette only), tRNS (only when some
//      alpha is below 255), one IDAT, IEND. Bit depth stays 8, no interlace.
//
// Deterministic: no clock, no randomness, no environment reads beyond the
// input/output directory env vars the harness documents. Node 22 built-ins
// only (node:fs, node:path, node:zlib).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC-32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------ PNG decode
// Minimal reader for the stored input PNGs (colour type 6, unfiltered rows),
// written generally: any filter type unfiltered, any chunk order tolerated.
function decodePng(buf) {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8; // skip the 8-byte signature
  let width = 0;
  let height = 0;
  let colourType = 6;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colourType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (colourType !== 6) throw new Error(`input colour type ${colourType}, expected 6`);
  const channels = 4;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const rgba = new Uint8Array(width * height * 4);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    if (ft === 0) {
      rgba.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) {
        rgba[o + i] = raw[src + i] + (i >= channels ? rgba[o + i - channels] : 0);
      }
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) {
        rgba[o + i] = raw[src + i] + (prev !== null ? rgba[o - stride + i] : 0);
      }
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? rgba[o + i - channels] : 0;
        const b = prev !== null ? rgba[o - stride + i] : 0;
        rgba[o + i] = raw[src + i] + ((a + b) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? rgba[o + i - channels] : 0;
        const b = prev !== null ? rgba[o - stride + i] : 0;
        const c = prev !== null && i >= channels ? rgba[o - stride + i - channels] : 0;
        const p = a + b - c;
        const pa = p > a ? p - a : a - p;
        const pb = p > b ? p - b : b - p;
        const pc = p > c ? p - c : c - p;
        rgba[o + i] = raw[src + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
    } else {
      throw new Error(`row ${y} has filter type ${ft}`);
    }
    prev = y;
  }
  return { width, height, rgba };
}

// ------------------------------------------------------- representation pick
// Analyse the pixels once: grey? opaque? how many distinct colours?
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let grey = true;
  let opaque = true;
  const colours = new Map();
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) opaque = false;
    if (colours.size <= 256) {
      // Keep the map bounded: once it passes 256 we only need to know it did.
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!colours.has(key)) colours.set(key, colours.size);
    }
  }
  return { grey, opaque, paletteSize: colours.size, paletteIndex: colours };
}

// Build the sample bytes for the chosen representation, plus PLTE / tRNS.
function repack(rgba, width, height, info) {
  const n = width * height;
  if (info.grey) {
    if (info.opaque) {
      const samples = new Uint8Array(n);
      for (let i = 0; i < n; i++) samples[i] = rgba[i * 4];
      return { colourType: 0, bpp: 1, samples, plte: null, trns: null };
    }
    const samples = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      samples[i * 2] = rgba[i * 4];
      samples[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return { colourType: 4, bpp: 2, samples, plte: null, trns: null };
  }
  if (info.paletteSize <= 256) {
    const samples = new Uint8Array(n);
    const plte = new Uint8Array(info.paletteSize * 3);
    const alphas = new Uint8Array(info.paletteSize);
    for (const [key, idx] of info.paletteIndex) {
      plte[idx * 3] = (key >>> 24) & 0xff;
      plte[idx * 3 + 1] = (key >>> 16) & 0xff;
      plte[idx * 3 + 2] = (key >>> 8) & 0xff;
      alphas[idx] = key & 0xff;
    }
    for (let i = 0; i < n; i++) {
      const key =
        ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0;
      samples[i] = info.paletteIndex.get(key);
    }
    // tRNS: one alpha byte per palette entry, trailing opaque entries dropped
    // (entries past it are opaque by the format).
    let trnsLen = info.paletteSize;
    while (trnsLen > 0 && alphas[trnsLen - 1] === 255) trnsLen--;
    const trns = trnsLen === 0 ? null : alphas.subarray(0, trnsLen);
    return { colourType: 3, bpp: 1, samples, plte, trns };
  }
  if (info.opaque) {
    const samples = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      samples[i * 3] = rgba[i * 4];
      samples[i * 3 + 1] = rgba[i * 4 + 1];
      samples[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { colourType: 2, bpp: 3, samples, plte: null, trns: null };
  }
  return { colourType: 6, bpp: 4, samples: rgba, plte: null, trns: null };
}

// ------------------------------------------------------------- row filtering
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter one row with `type` into `out`. `cur`/`prev` are sample rows.
function filterOne(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) {
      out.set(cur);
    } else {
      for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
    }
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredictor(a, b, c);
    }
  }
}

// Sum of |signed byte| over a filtered row: the per-row filter cost.
function rowCost(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Filter the whole image under one scheme and return the filtered bytes.
// `mode` is a fixed filter type (0 to 4) for every row, 'minsum': each row
// takes the filter whose filtered bytes have the least sum of absolute
// signed values, or 'ms04': the same per-row choice restricted to None and
// Paeth (the pair that wins on smooth alpha captures). Lowest filter number
// wins a tie, for determinism.
function filterImage(samples, width, height, bpp, mode) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  if (mode === 'minsum' || mode === 'ms04') {
    const allowed = mode === 'minsum' ? [0, 1, 2, 3, 4] : [0, 4];
    const trials = [];
    for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      let bestType = allowed[0];
      let bestCost = Infinity;
      for (const t of allowed) {
        filterOne(t, cur, prev, bpp, trials[t]);
        const s = rowCost(trials[t]);
        if (s < bestCost) {
          bestCost = s;
          bestType = t;
        }
      }
      raw[y * (stride + 1)] = bestType;
      raw.set(trials[bestType], y * (stride + 1) + 1);
    }
    return raw;
  }
  const buf = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    filterOne(mode, cur, prev, bpp, buf);
    raw[y * (stride + 1)] = mode;
    raw.set(buf, y * (stride + 1) + 1);
  }
  return raw;
}

// --------------------------------------------------------------- PNG writing
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function writePng(width, height, rep, idat) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = rep.colourType;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (rep.plte !== null) parts.push(chunk('PLTE', rep.plte));
  if (rep.trns !== null) parts.push(chunk('tRNS', rep.trns));
  parts.push(chunk('IDAT', new Uint8Array(idat.buffer, idat.byteOffset, idat.byteLength)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// -------------------------------------------------------------------- driver
function compressOne(rgba, width, height) {
  const info = analyse(rgba);
  const rep = repack(rgba, width, height, info);
  // The minimum-sum heuristic is only a proxy for compressed size, and on
  // these screenshots it often loses to one fixed filter for the whole
  // image (flat runs compress best unfiltered, smooth areas best under Up
  // or Paeth). So try every scheme, deflate each at level 9, and keep the
  // smallest stream; then try the filtered-data strategy on the winner.
  // The work is bounded by scheme count, never by the clock, so two runs
  // of the program write identical bytes.
  let best = null;
  let bestFiltered = null;
  for (const mode of [0, 1, 2, 3, 4, 'minsum', 'ms04']) {
    const filtered = filterImage(rep.samples, width, height, rep.bpp, mode);
    const z = deflateSync(filtered, { level: 9 });
    if (best === null || z.length < best.length) {
      best = z;
      bestFiltered = filtered;
    }
  }
  const alt = deflateSync(bestFiltered, { level: 9, strategy: 1 });
  if (alt.length < best.length) best = alt;
  return writePng(width, height, rep, best);
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const { width, height, rgba } = decodePng(readFileSync(join(INPUT_DIR, id, 'image.png')));
  const png = compressOne(rgba, width, height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}

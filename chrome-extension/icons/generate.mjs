/**
 * Zero-dependency PNG icon generator for the Chrome extension.
 *
 * Run:  node chrome-extension/icons/generate.mjs
 *
 * Produces icon-16.png, icon-48.png, icon-128.png in this directory.
 *
 * The design (v0.9.9+): dark rounded-square tile (#0a0e1a) with a
 * 4-point sparkle ✨ in the centre — the universal "AI" symbol used by
 * Anthropic, Notion AI, Microsoft Copilot, etc. The sparkle is filled
 * with a cyan→blue→violet→pink gradient (same palette as the previous
 * V mark, so the brand colours carry over). Two smaller satellite
 * sparkles sit in opposite corners for visual rhythm.
 *
 * Drawn purely by manipulating raw RGBA bytes + the built-in
 * `node:zlib` for PNG IDAT compression. No npm packages required.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 48, 128];

// --- PNG byte construction -------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size, pixels /* Uint8Array length = size*size*4 RGBA */) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  // IDAT — filter byte 0 per scanline + pixel data
  const rowLen = size * 4;
  const raw = Buffer.alloc((rowLen + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowLen + 1)] = 0;
    pixels.subarray(y * rowLen, (y + 1) * rowLen).forEach((b, x) => {
      raw[y * (rowLen + 1) + 1 + x] = b;
    });
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Drawing helpers -------------------------------------------------------

function rgba(r, g, b, a = 255) {
  return [r & 0xff, g & 0xff, b & 0xff, a & 0xff];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Gradient sample: 4 stops mimicking the V mark colour ramp.
 *   cyan #06b6d4  →  blue #3b82f6  →  violet #8b5cf6  →  pink #ec4899
 */
function gradientStop(t) {
  const stops = [
    { at: 0.0, c: [0x06, 0xb6, 0xd4] },
    { at: 0.4, c: [0x3b, 0x82, 0xf6] },
    { at: 0.7, c: [0x8b, 0x5c, 0xf6] },
    { at: 1.0, c: [0xec, 0x48, 0x99] },
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t <= b.at) {
      const u = (t - a.at) / (b.at - a.at);
      return [
        Math.round(lerp(a.c[0], b.c[0], u)),
        Math.round(lerp(a.c[1], b.c[1], u)),
        Math.round(lerp(a.c[2], b.c[2], u)),
      ];
    }
  }
  return stops[stops.length - 1].c;
}

/**
 * Render the icon at the given pixel size.
 *
 *   1. Rounded-square dark tile background
 *   2. Big 4-point sparkle in the centre with diagonal gradient fill
 *   3. Two small satellite sparkles in opposite corners
 */
function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const radius = Math.round(size * 0.22);
  const tileColor = rgba(0x0a, 0x0e, 0x1a, 255); // #0a0e1a

  function set(x, y, c) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    // Alpha-over blend so the sparkle can sit on top of the tile cleanly.
    const dstA = pixels[i + 3] / 255;
    const srcA = c[3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) {
      pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 0;
      return;
    }
    pixels[i] = Math.round((c[0] * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
    pixels[i + 1] = Math.round((c[1] * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
    pixels[i + 2] = Math.round((c[2] * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
    pixels[i + 3] = Math.round(outA * 255);
  }

  // 1. Rounded-square tile background.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const corner = Math.sqrt(dx * dx + dy * dy);
      if (corner <= radius) {
        const aa = Math.max(0, Math.min(1, radius - corner));
        const a = aa >= 1 ? 255 : Math.round(aa * 255);
        set(x, y, [tileColor[0], tileColor[1], tileColor[2], a]);
      }
    }
  }

  /**
   * Draw a 4-point sparkle (✨) centred at (cx, cy).
   *   R     — outer tip distance (length of each ray)
   *   waist — half-thickness at the centre joint (where the rays cross)
   *
   * The shape is 4 elongated isosceles triangles meeting at the centre.
   * Each tip narrows to a point; the central waist gives the classic
   * 4-point-star silhouette rather than a plain +.
   */
  function drawSparkle(cx, cy, R, waist, colorAt) {
    // For each pixel in the bounding box, decide if it's inside the
    // 4-point-star shape. The shape is:
    //   inside iff there exists a ray (N/E/S/W) such that the pixel
    //   lies within the triangle from that tip to the two adjacent
    //   centre-waist vertices.
    //
    // Equivalently — in polar coordinates from centre:
    //   distance d, angle θ
    //   reduce θ to its acute distance from nearest cardinal axis (0..π/4)
    //   max permitted d at that angle interpolates linearly from R
    //   (axis) down to 0 (45° between axes)
    //
    // The "interpolating to 0" makes the points actually sharp, vs.
    // a rounded blob. waist controls how fat the centre is — when
    // waist=0 the shape collapses to a 4-arm asterisk; small waist
    // (~R*0.1) gives the recognisable ✨ silhouette.
    const minX = Math.floor(cx - R);
    const maxX = Math.ceil(cx + R);
    const minY = Math.floor(cy - R);
    const maxY = Math.ceil(cy + R);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px - cx;
        const dy = py - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > R) continue;
        // Acute angle to nearest cardinal axis (0..π/4)
        let theta = Math.atan2(Math.abs(dy), Math.abs(dx));
        if (theta > Math.PI / 4) theta = Math.PI / 2 - theta;
        // Linear interpolate the max radius — sharp at axis, narrow near 45°
        const t = theta / (Math.PI / 4); // 0 on axis, 1 at 45°
        // Concave taper: the max-radius drops to `waist` at 45°
        const maxR = R * (1 - t) + waist * t;
        if (d > maxR) continue;
        // Edge AA — fade the alpha as we approach maxR
        const edge = maxR - d;
        const alpha = Math.min(1, Math.max(0, edge / 1.2));
        const c = colorAt(px, py);
        set(px, py, [c[0], c[1], c[2], Math.round(alpha * 255)]);
      }
    }
  }

  // 2. Big centre sparkle. Gradient based on the pixel's diagonal
  // position WITHIN the sparkle, so the top-left tip reads cyan and
  // the bottom-right tip reads pink — full gradient range visible
  // on the centrepiece.
  //
  // Tuning notes:
  //   centreR    big to dominate the tile
  //   centreWaist deliberately thin — keeps tips spiky, not petal-like
  const centreCx = size * 0.5;
  const centreCy = size * 0.5;
  const centreR = size * 0.42;
  const centreWaist = Math.max(1, size * 0.028);

  drawSparkle(centreCx, centreCy, centreR, centreWaist, (px, py) => {
    // Diagonal local-T: 0 at top-left tip, 1 at bottom-right tip.
    const localT =
      ((px - centreCx) + (py - centreCy)) / (2 * centreR) + 0.5;
    return gradientStop(Math.max(0, Math.min(1, localT)));
  });

  // 3. Two satellite sparkles in opposite corners for visual rhythm.
  // Top-left (cyan end of the gradient) and bottom-right (pink end).
  // Only drawn at ≥ 32 px — at 16 px they collide with the main sparkle
  // and turn the icon into a muddy glob in the Chrome toolbar.
  if (size >= 32) {
    const satR = Math.max(2, size * 0.1);
    const satWaist = Math.max(1, size * 0.014);
    drawSparkle(size * 0.84, size * 0.83, satR, satWaist, () =>
      gradientStop(0.88), // pink/magenta tip
    );
    drawSparkle(size * 0.18, size * 0.2, satR * 0.65, satWaist * 0.7, () =>
      gradientStop(0.12), // cyan tip
    );
  }

  return pixels;
}

// --- Main ------------------------------------------------------------------

for (const size of SIZES) {
  const pixels = renderIcon(size);
  const png = makePng(size, pixels);
  const path = join(HERE, `icon-${size}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path}  (${png.length} bytes)`);
}
console.log("done — reload the extension in chrome://extensions/");

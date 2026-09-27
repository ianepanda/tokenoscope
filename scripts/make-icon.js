// Рисует иконку приложения без внешних библиотек: растеризация простых фигур со сглаживанием
// (суперсэмплинг 4×4), кодирование PNG через zlib и сборка ICO и ICNS с PNG-кадрами.
// node scripts/make-icon.js  ->  build/icon.png (512), build/icon.ico (16…256), build/icon.icns (16…1024)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BLUE_TOP = hex('#3987e5');
const BLUE_BOTTOM = hex('#184f95');
const WHITE = hex('#ffffff');
const ORANGE = hex('#eb6834');

// Фигуры в координатах 256×256; inside(x, y) -> bool.
const roundRect = (x, y, w, h, r) => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};
const ring = (cx, cy, r, width) => (px, py) => {
  const d = Math.hypot(px - cx, py - cy);
  return d >= r - width / 2 && d <= r + width / 2;
};
const capsule = (x1, y1, x2, y2, width) => (px, py) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) <= width / 2;
};

const LAYERS = [
  { shape: roundRect(8, 8, 240, 240, 56), color: (x, y) => {
    const t = Math.min(1, Math.max(0, (x + y) / 512));
    return BLUE_TOP.map((c, i) => c + (BLUE_BOTTOM[i] - c) * t);
  } },
  { shape: roundRect(46, 140, 34, 70, 9), color: () => WHITE, alpha: 0.9 },
  { shape: roundRect(94, 108, 34, 102, 9), color: () => WHITE, alpha: 0.95 },
  { shape: roundRect(142, 150, 34, 60, 9), color: () => WHITE, alpha: 0.9 },
  // Лупа над столбцами.
  { shape: ring(150, 86, 38, 15), color: () => ORANGE },
  { shape: capsule(178, 114, 206, 142, 17), color: () => ORANGE },
];

// inset — поле по краям в долях размера: иконки macOS не заполняют холст целиком.
function render(size, inset = 0) {
  const px = new Float64Array(size * size * 4);
  const S = 4;
  const k = 256 / (size * (1 - 2 * inset));
  const off = size * inset;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const ux = (x + (sx + 0.5) / S - off) * k;
          const uy = (y + (sy + 0.5) / S - off) * k;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const L of LAYERS) {
            if (!L.shape(ux, uy)) continue;
            const [lr, lg, lb] = L.color(ux, uy);
            const la = L.alpha ?? 1;
            // «поверх» с премультипликацией
            cr = lr * la + cr * (1 - la);
            cg = lg * la + cg * (1 - la);
            cb = lb * la + cb * (1 - la);
            ca = la + ca * (1 - la);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      const alpha = a / n;
      px[o] = alpha > 0 ? r / n / alpha : 0;
      px[o + 1] = alpha > 0 ? g / n / alpha : 0;
      px[o + 2] = alpha > 0 ? b / n / alpha : 0;
      px[o + 3] = alpha * 255;
    }
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, inset = 0) {
  const px = render(size, inset);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = Math.round(Math.min(255, Math.max(0, px[y * size * 4 + x])));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // глубина
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map((s) => ({ s, data: png(s) }));
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ s, data }, i) => {
    const o = 6 + 16 * i;
    head[o] = s >= 256 ? 0 : s;
    head[o + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, o + 4); // плоскости
    head.writeUInt16LE(32, o + 6); // бит на пиксель
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.data)]);
}

// Тело иконки macOS — 824 из 1024 px (сетка Apple); квадрат 240/256 в LAYERS занимает столько при поле 7%.
const MAC_INSET = 0.07;
// ICNS из PNG-кадров: тип кадра задаёт его размер (ic11 — 16@2x, то есть 32 px, и т. д.).
function icns(frames) {
  const cache = new Map();
  const blocks = frames.map(([type, s]) => {
    if (!cache.has(s)) cache.set(s, png(s, MAC_INSET));
    const data = cache.get(s);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + blocks.reduce((n, b) => n + b.length, 0), 4);
  return Buffer.concat([head, ...blocks]);
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png(512));
fs.writeFileSync(path.join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(out, 'icon.icns'), icns([
  ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
]));
console.log('icon: build/icon.png, build/icon.ico, build/icon.icns');

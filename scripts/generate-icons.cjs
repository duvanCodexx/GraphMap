const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const svgIcon = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#070a14"/>
      <stop offset="50%" stop-color="#0b1120"/>
      <stop offset="100%" stop-color="#03050a"/>
    </linearGradient>
    <linearGradient id="cyanGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#06b6d4"/>
    </linearGradient>
    <linearGradient id="purpleGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#c084fc"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Background Hexagon Shield -->
  <rect width="512" height="512" rx="110" fill="url(#bgGrad)" />
  <rect width="496" height="496" x="8" y="8" rx="102" fill="none" stroke="#1e293b" stroke-width="4" />
  <rect width="480" height="480" x="16" y="16" rx="94" fill="none" stroke="#06b6d4" stroke-width="3" stroke-opacity="0.4" />

  <!-- Constellation Graph Edges -->
  <g stroke="#38bdf8" stroke-width="5" stroke-opacity="0.45" filter="url(#glow)">
    <line x1="256" y1="135" x2="135" y2="245" />
    <line x1="256" y1="135" x2="377" y2="245" />
    <line x1="135" y1="245" x2="185" y2="380" />
    <line x1="377" y1="245" x2="327" y2="380" />
    <line x1="185" y1="380" x2="327" y2="380" />
    <line x1="256" y1="135" x2="256" y2="275" stroke="#a855f7" stroke-width="6" stroke-opacity="0.75" />
    <line x1="256" y1="275" x2="135" y2="245" stroke="#a855f7" stroke-width="5" stroke-opacity="0.65" />
    <line x1="256" y1="275" x2="377" y2="245" stroke="#a855f7" stroke-width="5" stroke-opacity="0.65" />
    <line x1="256" y1="275" x2="185" y2="380" stroke="#a855f7" stroke-width="5" stroke-opacity="0.65" />
    <line x1="256" y1="275" x2="327" y2="380" stroke="#a855f7" stroke-width="5" stroke-opacity="0.65" />
  </g>

  <!-- Constellation Orbit Rings -->
  <circle cx="256" cy="275" r="165" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-dasharray="6 8" stroke-opacity="0.35" />
  <circle cx="256" cy="275" r="85" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-dasharray="4 6" stroke-opacity="0.45" />

  <!-- Center Core Node -->
  <circle cx="256" cy="275" r="34" fill="url(#purpleGlow)" filter="url(#glow)" />
  <circle cx="256" cy="275" r="18" fill="#ffffff" />

  <!-- Peripheral Nodes -->
  <circle cx="256" cy="135" r="24" fill="url(#cyanGlow)" filter="url(#glow)" />
  <circle cx="256" cy="135" r="11" fill="#ffffff" />

  <circle cx="135" cy="245" r="22" fill="url(#cyanGlow)" filter="url(#glow)" />
  <circle cx="135" cy="245" r="9" fill="#ffffff" />

  <circle cx="377" cy="245" r="22" fill="url(#cyanGlow)" filter="url(#glow)" />
  <circle cx="377" cy="245" r="9" fill="#ffffff" />

  <circle cx="185" cy="380" r="20" fill="url(#purpleGlow)" filter="url(#glow)" />
  <circle cx="185" cy="380" r="8" fill="#ffffff" />

  <circle cx="327" cy="380" r="20" fill="url(#purpleGlow)" filter="url(#glow)" />
  <circle cx="327" cy="380" r="8" fill="#ffffff" />
</svg>
`;

// Helper to create a Windows ICO binary containing multiple PNG frames
function createIcoFromPngBuffers(pngBuffers) {
  // ICO header: 6 bytes
  // 2 bytes reserved (0), 2 bytes type (1 = icon), 2 bytes count
  const numImages = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(numImages, 4);

  // Each directory entry is 16 bytes
  const dirSize = numImages * 16;
  let offset = 6 + dirSize;

  const entries = [];
  for (const img of pngBuffers) {
    const entry = Buffer.alloc(16);
    const w = img.width >= 256 ? 0 : img.width;
    const h = img.height >= 256 ? 0 : img.height;
    entry.writeUInt8(w, 0);
    entry.writeUInt8(h, 1);
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(img.buffer.length, 8); // size
    entry.writeUInt32LE(offset, 12); // offset
    entries.push(entry);
    offset += img.buffer.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffers.map(img => img.buffer)]);
}

async function run() {
  const rootDir = path.resolve(__dirname, '..');
  const buildDir = path.join(rootDir, 'build');
  const publicDir = path.join(rootDir, 'public');

  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  const svgBuf = Buffer.from(svgIcon);

  // Write base SVG
  fs.writeFileSync(path.join(publicDir, 'logo.svg'), svgIcon);
  fs.writeFileSync(path.join(buildDir, 'icon.svg'), svgIcon);

  // Render various PNG sizes
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = [];

  for (const s of sizes) {
    const buf = await sharp(svgBuf).resize(s, s).png().toBuffer();
    pngBuffers.push({ width: s, height: s, buffer: buf });
  }

  // 512x512 Master PNG
  const p512 = await sharp(svgBuf).resize(512, 512).png().toBuffer();
  fs.writeFileSync(path.join(buildDir, 'icon.png'), p512);
  fs.writeFileSync(path.join(publicDir, 'icon.png'), p512);

  // Tray icons
  const tray32 = await sharp(svgBuf).resize(32, 32).png().toBuffer();
  const tray16 = await sharp(svgBuf).resize(16, 16).png().toBuffer();
  fs.writeFileSync(path.join(publicDir, 'tray-icon.png'), tray32);
  fs.writeFileSync(path.join(publicDir, 'tray-icon-16.png'), tray16);
  fs.writeFileSync(path.join(buildDir, 'tray-icon.png'), tray32);

  // Windows Multi-size ICO
  const icoBuf = createIcoFromPngBuffers(pngBuffers);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuf);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoBuf);

  console.log('✅ Generated all icons: build/icon.ico, build/icon.png, public/tray-icon.png, public/favicon.ico');
}

run().catch(err => {
  console.error('Failed to generate icons:', err);
  process.exit(1);
});

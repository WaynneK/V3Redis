/*
 * make-installer-art.js — Images de l'installeur (design « Hyperespace ») : npm run installer:art
 *
 * Rend build/art/installerSidebar.svg (164 × 314) et build/art/installerHeader.svg (150 × 57) dans une fenêtre
 * cachée d'Electron, puis écrit les BMP 24 bits attendus par l'installeur NSIS :
 *   build/installerSidebar.bmp  volet gauche des pages d'accueil et de fin (installation et désinstallation)
 *   build/installerHeader.bmp   bandeau à droite du titre des autres pages
 * Un aperçu PNG est aussi écrit à côté des sources (build/art/*.png).
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BUILD = path.resolve(__dirname, '..', 'build');
const ART = [
  { svg: 'installerSidebar.svg', bmp: 'installerSidebar.bmp', width: 164, height: 314 },
  { svg: 'installerHeader.svg', bmp: 'installerHeader.bmp', width: 150, height: 57 },
];

/** BMP 24 bits non compressé (lignes de bas en haut, alignées sur 4 octets) à partir de pixels BGRA. */
function toBmp24(bgra, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + dataSize, 2);
  buf.writeUInt32LE(54, 10); // début des pixels
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positif : de bas en haut
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(2835, 38); // 72 ppp
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      buf[dst + x * 3] = bgra[src + x * 4]; // B
      buf[dst + x * 3 + 1] = bgra[src + x * 4 + 1]; // G
      buf[dst + x * 3 + 2] = bgra[src + x * 4 + 2]; // R
    }
  }
  return buf;
}

/** Fenêtre cachée commune, plus grande que les images (une fenêtre de 57 px de haut ne se charge pas). */
let win = null;

async function render(item) {
  const svg = fs.readFileSync(path.join(BUILD, 'art', item.svg), 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}img{display:block}</style></head>
<body><img width="${item.width}" height="${item.height}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  if (!win) win = new BrowserWindow({ show: false, width: 400, height: 400, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => document.querySelector("img").decode()).then(() => true)');
  await new Promise((r) => setTimeout(r, 300));
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: item.width, height: item.height });
  const size = image.getSize();
  if (size.width !== item.width || size.height !== item.height) image = image.resize({ width: item.width, height: item.height, quality: 'best' });
  fs.writeFileSync(path.join(BUILD, item.bmp), toBmp24(image.toBitmap(), item.width, item.height));
  fs.writeFileSync(path.join(BUILD, 'art', item.svg.replace(/\.svg$/, '.png')), image.toPNG());
  console.log(`  ✓ ${item.bmp} (${item.width} × ${item.height} px) → ${path.join(BUILD, item.bmp)}`);
}

app.whenReady().then(async () => {
  try {
    console.log('Images de l\'installeur (design « Hyperespace »), sans fenêtre :');
    for (const item of ART) await render(item);
    console.log(`\nTerminé. Aperçus PNG : ${path.join(BUILD, 'art')}`);
    console.log('Elles apparaîtront dans l\'installeur au prochain « npm run build ».');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});

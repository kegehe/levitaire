/**
 * 从悬浮球 SVG 生成透明背景的托盘图标（PNG 各尺寸 + ICO）
 * 用法: node scripts/generate-tray-icons.mjs
 */
import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, "..", "src-tauri", "icons");

// 悬浮球 SVG — 与 FloatingOrb.tsx 中的图标一致
// 托盘图标需要带圆形背景，原因：
// 1. Windows Shell 对透明 PNG 会填充黑色/系统色，纯透明背景会显示为方块
// 2. 与悬浮球的毛玻璃圆形背景视觉统一
// 背景色使用深色半透明圆（模拟悬浮球在桌面上的毛玻璃效果）
// viewBox 0 0 18 18，中心圆点 + 3 条椭圆轨道
const svgContent = `<svg width="512" height="512" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="0" cy="0" r="1" gradientTransform="translate(88 72) rotate(48) scale(190)">
      <stop offset="0" stop-color="#35456f" />
      <stop offset="1" stop-color="#11162c" />
    </radialGradient>
    <linearGradient id="orbit" x1="50" y1="40" x2="211" y2="216" gradientUnits="userSpaceOnUse">
      <stop stop-color="#6CE8FF" />
      <stop offset="0.52" stop-color="#5D9DFF" />
      <stop offset="1" stop-color="#B18CFF" />
    </linearGradient>
    <linearGradient id="core" x1="105" y1="94" x2="153" y2="156" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFFFFF" />
      <stop offset="1" stop-color="#B8F3FF" />
    </linearGradient>
  </defs>
  <circle cx="128" cy="128" r="119" fill="url(#bg)" />
  <circle cx="128" cy="128" r="119" stroke="#7182B5" stroke-opacity="0.6" stroke-width="5" />
  <g stroke="url(#orbit)" stroke-width="17" stroke-linecap="round">
    <ellipse cx="128" cy="128" rx="93" ry="39" />
    <ellipse cx="128" cy="128" rx="93" ry="39" transform="rotate(60 128 128)" />
    <ellipse cx="128" cy="128" rx="93" ry="39" transform="rotate(120 128 128)" />
  </g>
  <circle cx="128" cy="128" r="25" fill="url(#core)" />
  <circle cx="128" cy="128" r="25" stroke="#D7FAFF" stroke-width="5" />
</svg>`;

// 需要生成的 PNG 尺寸
const PNG_SIZES = [
  { name: "32x32.png", size: 32 },
  { name: "64x64.png", size: 64 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
  // Windows Store logos
  { name: "Square30x30Logo.png", size: 30 },
  { name: "Square44x44Logo.png", size: 44 },
  { name: "Square71x71Logo.png", size: 71 },
  { name: "Square89x89Logo.png", size: 89 },
  { name: "Square107x107Logo.png", size: 107 },
  { name: "Square142x142Logo.png", size: 142 },
  { name: "Square150x150Logo.png", size: 150 },
  { name: "Square284x284Logo.png", size: 284 },
  { name: "Square310x310Logo.png", size: 310 },
  { name: "StoreLogo.png", size: 50 },
];

async function generatePngs() {
  mkdirSync(ICONS_DIR, { recursive: true });

  for (const { name, size } of PNG_SIZES) {
    const outputPath = join(ICONS_DIR, name);
    await sharp(Buffer.from(svgContent))
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outputPath);
    console.log(`✅ ${name} (${size}x${size})`);
  }
}

async function generateIco() {
  // ICO 文件：包含 16, 32, 48, 256 尺寸
  const icoSizes = [16, 32, 48, 256];
  const pngBuffers = [];

  for (const size of icoSizes) {
    const buf = await sharp(Buffer.from(svgContent))
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push({ size, buf });
  }

  // 构建 ICO 文件格式
  // Header: 6 bytes, Directory: 16 bytes per entry, then PNG data
  const headerSize = 6;
  const dirEntrySize = 16;
  const numImages = pngBuffers.length;
  const dirSize = dirEntrySize * numImages;
  const dataOffset = headerSize + dirSize;

  // Calculate total size
  let totalDataSize = 0;
  for (const { buf } of pngBuffers) {
    totalDataSize += buf.length;
  }

  const totalSize = dataOffset + totalDataSize;
  const ico = Buffer.alloc(totalSize);

  // ICO Header
  ico.writeUInt16LE(0, 0);       // Reserved
  ico.writeUInt16LE(1, 2);       // Type: 1 = ICO
  ico.writeUInt16LE(numImages, 4); // Number of images

  // Directory entries
  let currentOffset = dataOffset;
  for (let i = 0; i < pngBuffers.length; i++) {
    const { size, buf } = pngBuffers[i];
    const entryOffset = headerSize + i * dirEntrySize;

    // Width (0 = 256)
    ico.writeUInt8(size >= 256 ? 0 : size, entryOffset + 0);
    // Height (0 = 256)
    ico.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1);
    // Color palette count
    ico.writeUInt8(0, entryOffset + 2);
    // Reserved
    ico.writeUInt8(0, entryOffset + 3);
    // Color planes
    ico.writeUInt16LE(1, entryOffset + 4);
    // Bits per pixel
    ico.writeUInt16LE(32, entryOffset + 6);
    // Image data size
    ico.writeUInt32LE(buf.length, entryOffset + 8);
    // Image data offset
    ico.writeUInt32LE(currentOffset, entryOffset + 12);

    // Copy PNG data
    buf.copy(ico, currentOffset);
    currentOffset += buf.length;
  }

  const icoPath = join(ICONS_DIR, "icon.ico");
  const { writeFileSync } = await import("fs");
  writeFileSync(icoPath, ico);
  console.log(`✅ icon.ico (with ${numImages} sizes)`);
}

async function main() {
  console.log("🎨 生成透明背景托盘图标...\n");
  await generatePngs();
  console.log("");
  await generateIco();
  console.log("\n🎉 全部完成！托盘图标已替换为与悬浮球一致的原子轨道图标。");
}

main().catch(console.error);

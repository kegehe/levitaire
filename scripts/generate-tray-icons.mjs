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
const svgContent = `<svg width="256" height="256" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- 圆形背景：模拟悬浮球毛玻璃效果 -->
  <circle cx="9" cy="9" r="8.5" fill="rgba(30, 30, 50, 0.85)" />
  <circle cx="9" cy="9" r="8.5" stroke="rgba(255,255,255,0.15)" stroke-width="0.3" fill="none" />
  <!-- 中心实心圆点 -->
  <circle cx="9" cy="9" r="1.5" fill="white" stroke="none" />
  <!-- 3 条椭圆轨道，分别旋转 0° / 60° / 120° -->
  <ellipse cx="9" cy="9" rx="7.5" ry="3" transform="rotate(0 9 9)" stroke="white" stroke-width="1.2" fill="none" />
  <ellipse cx="9" cy="9" rx="7.5" ry="3" transform="rotate(60 9 9)" stroke="white" stroke-width="1.2" fill="none" />
  <ellipse cx="9" cy="9" rx="7.5" ry="3" transform="rotate(120 9 9)" stroke="white" stroke-width="1.2" fill="none" />
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

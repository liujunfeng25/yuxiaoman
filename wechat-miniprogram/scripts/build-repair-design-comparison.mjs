import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const artifactsDir = path.join(projectDir, "artifacts", "repair-marketplace");
const referencePath = process.env.REPAIR_DESIGN_REFERENCE
  ?? "C:\\Users\\Administrator\\.codex\\generated_images\\01a03039-47b3-7aa2-8535-baf7e8badf3c\\exec-d3c20e16-6096-4d6c-bd3a-d58fe251a289.png";
const implementationPath = path.join(artifactsDir, "owner-quotes-native.png");
const outputPath = path.join(artifactsDir, "owner-quotes-design-comparison.png");
const previewPath = path.join(artifactsDir, "owner-quotes-native-preview.png");
const receiptPreviewPath = path.join(artifactsDir, "owner-receipt-native-preview.png");
const dealPreviewPath = path.join(artifactsDir, "shop-deal-native-preview.png");

const viewport = { width: 149, height: 321 };
const scale = 4;
const panel = { width: viewport.width * scale, height: viewport.height * scale };
const headerHeight = 72;
const gutter = 28;
const outer = 28;
const canvasWidth = outer * 2 + panel.width * 2 + gutter;
const canvasHeight = outer * 2 + headerHeight + panel.height;

const reference = await sharp(referencePath)
  .resize(panel.width, panel.height, { fit: "fill", kernel: "lanczos3" })
  .png()
  .toBuffer();
const implementation = await sharp(implementationPath)
  .resize(panel.width, panel.height, { fit: "fill", kernel: "nearest" })
  .png()
  .toBuffer();

const label = (x, title, subtitle) => ({
  input: Buffer.from(`
    <svg width="${panel.width}" height="${headerHeight}" xmlns="http://www.w3.org/2000/svg">
      <text x="0" y="27" fill="#F8FAFC" font-family="Microsoft YaHei, sans-serif" font-size="22" font-weight="700">${title}</text>
      <text x="0" y="53" fill="#94A3B8" font-family="Microsoft YaHei, sans-serif" font-size="15">${subtitle}</text>
    </svg>
  `),
  left: x,
  top: outer,
});

await sharp({
  create: {
    width: canvasWidth,
    height: canvasHeight,
    channels: 3,
    background: "#0F172A",
  },
})
  .composite([
    label(outer, "选中方案 1", "归一化到 149 × 321 原生视口"),
    label(outer + panel.width + gutter, "原生小程序实现", "3 家有效报价 · 最低价默认选中"),
    { input: reference, left: outer, top: outer + headerHeight },
    { input: implementation, left: outer + panel.width + gutter, top: outer + headerHeight },
  ])
  .png()
  .toFile(outputPath);

await sharp(implementationPath)
  .resize(panel.width, panel.height, { fit: "fill", kernel: "nearest" })
  .png()
  .toFile(previewPath);

await sharp(path.join(artifactsDir, "owner-receipt-native.png"))
  .resize(panel.width, panel.height, { fit: "fill", kernel: "nearest" })
  .png()
  .toFile(receiptPreviewPath);

await sharp(path.join(artifactsDir, "shop-deal-native.png"))
  .resize(panel.width, panel.height, { fit: "fill", kernel: "nearest" })
  .png()
  .toFile(dealPreviewPath);

console.log(JSON.stringify({ outputPath, previewPath, receiptPreviewPath, dealPreviewPath, viewport, scale }, null, 2));

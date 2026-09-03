import sharp from "sharp";

const [sourcePath, implementationPath, outputPath] = process.argv.slice(2);
if (!sourcePath || !implementationPath || !outputPath) {
  throw new Error("Usage: node scripts/build-image-comparison.mjs <source> <implementation> <output>");
}

const targetHeight = 786;
const [source, implementation] = await Promise.all([
  sharp(sourcePath).resize({ height: targetHeight }).png().toBuffer(),
  sharp(implementationPath).resize({ height: targetHeight }).png().toBuffer(),
]);
const [sourceMeta, implementationMeta] = await Promise.all([
  sharp(source).metadata(),
  sharp(implementation).metadata(),
]);
const sourceWidth = sourceMeta.width ?? 0;
const implementationWidth = implementationMeta.width ?? 0;
const canvasWidth = sourceWidth + implementationWidth + 48;
const label = Buffer.from(`
  <svg width="${canvasWidth}" height="40" xmlns="http://www.w3.org/2000/svg">
    <style>text { font: 700 18px sans-serif; fill: #12213a; }</style>
    <text x="16" y="26">SOURCE</text>
    <text x="${sourceWidth + 32}" y="26">IMPLEMENTATION</text>
  </svg>`);

await sharp({
  create: { width: canvasWidth, height: targetHeight + 56, channels: 3, background: "#eef3f8" },
})
  .composite([
    { input: label, left: 0, top: 0 },
    { input: source, left: 16, top: 40 },
    { input: implementation, left: sourceWidth + 32, top: 40 },
  ])
  .png()
  .toFile(outputPath);

console.log(`Comparison written to ${outputPath}`);

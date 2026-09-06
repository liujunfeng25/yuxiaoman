import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const sourceRoot = new URL("../source-assets/owner-vehicle-presentation-v2/", import.meta.url);
const outputRoot = new URL("../public/assets/used-cars/owner-presentation-v2/", import.meta.url);
const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const optionValues = (name) => args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);

function removeChromaMagenta(data, channels) {
  for (let offset = 0; offset < data.length; offset += channels) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    const magentaDominance = Math.min(red, blue) - green;
    const magentaBalance = Math.abs(red - blue);
    const isMagentaFamily = red > green * 1.16 && blue > green * 1.16 && magentaBalance < 100;
    if (!isMagentaFamily) continue;

    // The generator uses a flat #ff00ff key, but antialiasing and contact shadows
    // create darker purple edge pixels. Remove the strong key and neutralize the
    // remaining purple spill so cards keep a clean gray studio shadow.
    const opacity = magentaDominance >= 30
      ? Math.max(0, Math.min(1, (92 - magentaDominance) / 50))
      : 1;
    data[offset + 3] = Math.round(alpha * opacity);
    const neutral = Math.max(green, Math.round((red + green + blue) / 3));
    data[offset] = neutral;
    data[offset + 1] = neutral;
    data[offset + 2] = neutral;
  }
}

async function build(inputName) {
  const id = basename(inputName, ".png");
  const input = join(sourceRoot.pathname.slice(1), inputName);
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  removeChromaMagenta(data, info.channels);
  const cutout = await sharp(data, { raw: info })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 })
    .resize(1040, 570, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  await sharp({
    create: { width: 1120, height: 630, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: cutout, gravity: "center" }])
    .webp({ quality: 86, alphaQuality: 94, effort: 6 })
    .toFile(join(outputRoot.pathname.slice(1), `${id}.webp`));
  return id;
}

await mkdir(outputRoot, { recursive: true });
const availableInputs = (await readdir(sourceRoot)).filter((name) => name.endsWith(".png")).sort();
const requestedModelIds = new Set(optionValues("--model-id"));
const selectionPath = optionValues("--selection")[0];
if (selectionPath) {
  const selections = JSON.parse(await readFile(resolve(workspaceRoot, selectionPath), "utf8"));
  for (const selection of selections) requestedModelIds.add(selection.modelId);
}
const inputs = requestedModelIds.size
  ? [...requestedModelIds].map((id) => `${id}.png`).sort()
  : availableInputs;
for (const input of inputs) {
  if (!availableInputs.includes(input)) throw new Error(`Missing presentation source: ${input}`);
}
for (const input of inputs) await build(input);
console.log(`Built ${inputs.length} fixed-angle owner vehicle presentation assets${requestedModelIds.size ? " for the requested batch" : ""}.`);

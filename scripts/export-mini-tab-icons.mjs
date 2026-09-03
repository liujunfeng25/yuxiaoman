import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { ClipboardText, House, UserCircle } from "@phosphor-icons/react";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "wechat-miniprogram", "miniprogram", "assets", "tabbar");
const icons = [
  ["home", House],
  ["orders", ClipboardText],
  ["profile", UserCircle],
];

await mkdir(output, { recursive: true });

for (const [name, Icon] of icons) {
  for (const selected of [false, true]) {
    const color = selected ? "#1768CF" : "#7A8799";
    const svg = renderToStaticMarkup(
      React.createElement(Icon, {
        xmlns: "http://www.w3.org/2000/svg",
        size: 54,
        color,
        weight: selected ? "fill" : "regular",
      }),
    );
    const icon = await sharp(Buffer.from(svg)).png().toBuffer();
    await sharp({
      create: { width: 81, height: 81, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: icon, left: 13, top: 13 }])
      .png()
      .toFile(path.join(output, `${name}${selected ? "-active" : ""}.png`));
  }
}

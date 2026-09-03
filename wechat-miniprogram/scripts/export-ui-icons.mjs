import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import {
  ArrowLeft,
  Backspace,
  CalendarCheck,
  CalendarDots,
  Camera,
  Car,
  CarProfile,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  Drop,
  FileArrowUp,
  FileMagnifyingGlass,
  FunnelSimple,
  Headset,
  MapPin,
  MagnifyingGlass,
  Moon,
  PaperPlaneTilt,
  Phone,
  Plus,
  Receipt,
  Recycle,
  ShieldCheck,
  Storefront,
  Sun,
  Trash,
  Umbrella,
  UserCircle,
  WarningCircle,
  Wrench,
  X,
} from "@phosphor-icons/react";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(project, "miniprogram", "assets", "icons");
const icons = [
  ["shield-check", ShieldCheck],
  ["map-pin", MapPin],
  ["calendar-check", CalendarCheck],
  ["file-search", FileMagnifyingGlass],
  ["car", Car],
  ["file-arrow-up", FileArrowUp],
  ["drop", Drop],
  ["calendar-search", CalendarDots],
  ["umbrella", Umbrella],
  ["wrench", Wrench],
  ["car-profile", CarProfile],
  ["recycle", Recycle],
  ["user-circle", UserCircle],
  ["receipt", Receipt],
  ["headset", Headset],
  ["phone", Phone],
  ["arrow-left", ArrowLeft],
  ["backspace", Backspace],
  ["camera", Camera],
  ["caret-down", CaretDown],
  ["caret-right", CaretRight],
  ["check-circle", CheckCircle],
  ["clock", Clock],
  ["filter", FunnelSimple],
  ["plus", Plus],
  ["search", MagnifyingGlass],
  ["send", PaperPlaneTilt],
  ["storefront", Storefront],
  ["sun", Sun],
  ["moon", Moon],
  ["trash", Trash],
  ["warning-circle", WarningCircle],
  ["x", X],
];

await mkdir(output, { recursive: true });

async function exportIcon(name, Icon, color = "#1768CF") {
  const svg = renderToStaticMarkup(
    React.createElement(Icon, {
      xmlns: "http://www.w3.org/2000/svg",
      size: 72,
      color,
      weight: "duotone",
    }),
  );
  const icon = await sharp(Buffer.from(svg)).png().toBuffer();
  await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: icon, left: 12, top: 12 }])
    .png()
    .toFile(path.join(output, `${name}.png`));
}

for (const [name, Icon] of icons) await exportIcon(name, Icon);
await exportIcon("calendar-check-white", CalendarCheck, "#FFFFFF");
await exportIcon("check-white", Check, "#FFFFFF");
await exportIcon("user-circle-white", UserCircle, "#FFFFFF");

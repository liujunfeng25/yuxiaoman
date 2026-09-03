import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = path.resolve(process.env.YUXIAOMAN_ROOT || path.join(import.meta.dirname, "..", ".."));
const DEFAULT_ANNUAL = path.join(
  ROOT,
  ".runtime",
  "annual-demo-media",
  "artifacts",
  "native-annual-final-verified9-20260830",
);
const ANNUAL_DIR = path.resolve(process.env.ANNUAL_ARTIFACT_DIR || DEFAULT_ANNUAL);
const REPAIR_DIR = process.env.REPAIR_ARTIFACT_DIR
  ? path.resolve(process.env.REPAIR_ARTIFACT_DIR)
  : path.join(ROOT, ".runtime", "annual-demo-media", "artifacts", "native-repair-final-verified9-20260830");
const DRIVER_ENTRY_DIR = path.resolve(
  process.env.DRIVER_ENTRY_ARTIFACT_DIR
    || path.join(ROOT, "deliverables", "deck-work", "driver-entry-evidence-20260830"),
);
const PREPARED_DIR = path.resolve(
  process.env.PREPARED_MEDIA_DIR ||
    path.join(
      ROOT,
      ".runtime",
      "annual-demo-media",
      "runs",
      "2026-08-29T17-52-45-661Z-6064",
      "prepared",
    ),
);
const OUT_DIR = path.resolve(process.env.DECK_OUTPUT_DIR || path.join(ROOT, "deliverables", "deck-work", "output"));
const FINAL_PPTX = path.resolve(
  process.env.DECK_OUTPUT_PPTX || path.join(ROOT, "deliverables", "驭小满年检与维修报价业务闭环操作手册.pptx"),
);
const REQUIRE_FINAL = process.env.REQUIRE_FINAL_EVIDENCE === "1";

const REQUIRED_ANNUAL_SCREENSHOTS = [
  "self-drive-01-home-entry.png",
  "self-drive-02-station-picker.png",
  "self-drive-05-all-uploads-retained.png",
  "self-drive-06-order-pending-payment.png",
  "self-drive-08-station-inspecting.png",
  "self-drive-13-checkup-ready-to-publish.png",
  "self-drive-17-owner-report-modal.png",
  "valet-02-station-picker.png",
  "valet-05-all-uploads-retained.png",
  "valet-06-order-pending-payment.png",
  "valet-09-driver-pickup-five-photos-ready.png",
  "valet-09-driver-pickup-submitted.png",
  "valet-12-station-arrival-and-inspecting.png",
  "valet-13a-fault-recorded-with-photo.png",
  "valet-14-report-published.png",
  "valet-15-driver-return-submitted.png",
  "valet-16-owner-evidence-modal.png",
  "valet-17-owner-report-modal.png",
  "valet-18-admin-final-detail.png",
];

const REQUIRED_REPAIR_SCREENSHOTS = [
  "01-owner-report-repair-entry.png",
  "02-owner-confirm-imported-faults.png",
  "03-owner-consent-ready.png",
  "04-owner-request-waiting-quotes.png",
  "09-shop-1-quote-submitted.png",
  "13-shop-2-quote-submitted.png",
  "17-shop-3-quote-submitted.png",
  "17-owner-request-three-quotes.png",
  "19-owner-explicit-quote-selection.png",
  "20-owner-paid-receipt.png",
  "24-winning-shop-deal.png",
  "26-losing-shop-1-contact-locked.png",
  "28-losing-shop-2-contact-locked.png",
];

const REQUIRED_DRIVER_ENTRY_SCREENSHOTS = [
  "driver-entry-01-switch-to-driver.png",
  "driver-entry-02-code-login.png",
];

const REQUIRED_PREPARED_MEDIA = [
  ["self-drive", "frontLeft.jpg"],
  ["valet", "frontLeft.jpg"],
];

const W = 1280;
const H = 720;
const COLORS = {
  navy: "#103B5D",
  navy2: "#174F77",
  blue: "#1976D2",
  blue2: "#42A5F5",
  pale: "#EAF4FE",
  ice: "#F4F8FC",
  white: "#FFFFFF",
  text: "#17324A",
  muted: "#6B8194",
  line: "#D7E4EF",
  green: "#1D9B68",
  greenPale: "#E9F7F1",
  orange: "#F07B35",
  orangePale: "#FFF2E8",
  red: "#D94B4B",
  redPale: "#FDEEEE",
  gray: "#8DA1B2",
};
const FONT = "Microsoft YaHei";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function scenarioByName(summary, scenarioName) {
  return Array.isArray(summary?.scenarios)
    ? summary.scenarios.find((scenario) => scenario?.scenario === scenarioName)
    : null;
}

function annualEvidenceIssues(summary) {
  const issues = [];
  if (summary?.status !== "passed") issues.push("status must be passed");
  if (summary?.scope !== "full-native-closure") issues.push("scope must be full-native-closure");
  if (!Array.isArray(summary?.scenarios) || summary.scenarios.length !== 2) issues.push("exactly 2 scenarios are required");
  if (summary?.consoleIssueCount !== 0) issues.push("consoleIssueCount must be 0");

  const selfDrive = scenarioByName(summary, "self-drive");
  const valet = scenarioByName(summary, "valet");
  for (const [label, scenario] of [
    ["self-drive", selfDrive],
    ["valet", valet],
  ]) {
    if (!scenario) {
      issues.push(`${label} scenario is missing`);
      continue;
    }
    if (scenario?.closure?.owner?.finalStatus !== "completed") issues.push(`${label} owner finalStatus must be completed`);
    if (scenario?.closure?.owner?.reportStatus !== "published") issues.push(`${label} owner reportStatus must be published`);
  }

  const expectedEvidenceStages = ["owner_pickup", "station_arrival", "inspection_complete", "owner_return"];
  const valetEvidence = valet?.closure?.owner?.evidence;
  if (!Array.isArray(valetEvidence) || valetEvidence.length !== expectedEvidenceStages.length) {
    issues.push("valet must contain exactly 4 evidence stages");
  } else {
    for (const stage of expectedEvidenceStages) {
      const evidence = valetEvidence.find((entry) => entry?.stage === stage);
      if (!evidence) {
        issues.push(`valet evidence stage ${stage} is missing`);
      } else if (evidence.status !== "completed" || evidence.photoCount !== 5) {
        issues.push(`valet evidence stage ${stage} must be completed with 5 photos`);
      }
    }
  }

  return issues;
}

function repairEvidenceIssues(repairSummary, annualSummary) {
  const issues = [];
  if (repairSummary?.status !== "passed") issues.push("status must be passed");
  if (repairSummary?.scope !== "ui-only-repair-marketplace-transaction") {
    issues.push("scope must be ui-only-repair-marketplace-transaction");
  }
  if (!Array.isArray(repairSummary?.quotes) || repairSummary.quotes.length !== 3) issues.push("exactly 3 submitted quotes are required");
  const quoteAmounts = Array.isArray(repairSummary?.quotes)
    ? repairSummary.quotes.map((quote) => quote?.totalFen).sort((a, b) => a - b)
    : [];
  if (JSON.stringify(quoteAmounts) !== JSON.stringify([168000, 198000, 235000])) {
    issues.push("quote totals must be 168000, 198000 and 235000 fen");
  }
  if (repairSummary?.selectedPriceFen !== 198000) issues.push("selectedPriceFen must be 198000");
  if (repairSummary?.screenshotCount !== 32) issues.push("screenshotCount must be 32");
  if (repairSummary?.consoleIssueCount !== 0) issues.push("consoleIssueCount must be 0");
  if (!Array.isArray(repairSummary?.losingShopPrivacyChecks) || repairSummary.losingShopPrivacyChecks.length !== 2) {
    issues.push("exactly 2 losing-shop privacy checks are required");
  } else if (repairSummary.losingShopPrivacyChecks.some((check) => check?.locked !== true || check?.contactVisible !== false)) {
    issues.push("both losing shops must remain locked with contactVisible=false");
  }

  const valetBookingId = scenarioByName(annualSummary, "valet")?.bookingId;
  if (!valetBookingId) {
    issues.push("verified valet bookingId is missing from annual summary");
  } else if (repairSummary?.annualBookingId !== valetBookingId) {
    issues.push("annualBookingId must match the verified valet scenario bookingId");
  }
  return issues;
}

async function missingFiles(baseDir, names) {
  const missing = [];
  for (const name of names) {
    if (!(await exists(path.join(baseDir, name)))) missing.push(name);
  }
  return missing;
}

async function validateFinalEvidence(annualSummary, repairSummary) {
  const annualIssues = annualEvidenceIssues(annualSummary);
  const repairIssues = repairEvidenceIssues(repairSummary, annualSummary);
  const missingAnnual = await missingFiles(ANNUAL_DIR, REQUIRED_ANNUAL_SCREENSHOTS);
  const missingRepair = await missingFiles(REPAIR_DIR, REQUIRED_REPAIR_SCREENSHOTS);
  const missingDriverEntry = await missingFiles(DRIVER_ENTRY_DIR, REQUIRED_DRIVER_ENTRY_SCREENSHOTS);
  const missingPrepared = [];
  for (const [mode, name] of REQUIRED_PREPARED_MEDIA) {
    if (!(await exists(path.join(PREPARED_DIR, mode, name)))) missingPrepared.push(`${mode}/${name}`);
  }

  const problems = [];
  if (annualIssues.length) problems.push(`annual summary: ${annualIssues.join("; ")}`);
  if (repairIssues.length) problems.push(`repair summary: ${repairIssues.join("; ")}`);
  if (missingAnnual.length) problems.push(`annual screenshots missing: ${missingAnnual.join(", ")}`);
  if (missingRepair.length) problems.push(`repair screenshots missing: ${missingRepair.join(", ")}`);
  if (missingDriverEntry.length) problems.push(`driver entry screenshots missing: ${missingDriverEntry.join(", ")}`);
  if (missingPrepared.length) problems.push(`prepared media missing: ${missingPrepared.join(", ")}`);
  if (problems.length) throw new Error(`Final evidence validation failed:\n- ${problems.join("\n- ")}`);
}

async function cleanKnownOutputArtifacts() {
  let entries = [];
  try {
    entries = await fs.readdir(OUT_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const exactNames = new Set(["deck-montage.webp", "build-manifest.json"]);
  const generatedSlidePattern = /^slide-\d+\.(?:png|layout\.json)$/;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (exactNames.has(entry.name) || generatedSlidePattern.test(entry.name)) {
      await fs.unlink(path.join(OUT_DIR, entry.name));
    }
  }
}

function addRect(slide, x, y, width, height, fill, options = {}) {
  return slide.shapes.add({
    geometry: options.geometry || "roundRect",
    position: { left: x, top: y, width, height },
    fill,
    line: {
      style: "solid",
      fill: options.lineFill || fill,
      width: options.lineWidth ?? 0,
    },
    ...(options.shadow ? { shadow: options.shadow } : {}),
    ...(options.borderRadius ? { borderRadius: options.borderRadius } : {}),
  });
}

function addText(slide, value, x, y, width, height, options = {}) {
  const box = slide.shapes.add({
    geometry: "textbox",
    position: { left: x, top: y, width, height },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  box.text = value;
  box.text.style = {
    fontSize: options.fontSize ?? 22,
    typeface: FONT,
    color: options.color || COLORS.text,
    bold: options.bold ?? false,
    alignment: options.align || "left",
    verticalAlignment: options.vAlign || "top",
    autoFit: options.autoFit || "shrinkText",
    insets: options.insets || { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return box;
}

function addTitle(slide, section, title, subtitle, pageNo) {
  slide.background.fill = COLORS.ice;
  addRect(slide, 0, 0, W, 14, COLORS.blue, { geometry: "rect" });
  addText(slide, section.toUpperCase(), 54, 28, 280, 24, {
    fontSize: 12,
    bold: true,
    color: COLORS.blue,
  });
  addText(slide, title, 54, 55, 1040, 62, { fontSize: 36, bold: true, color: COLORS.navy });
  if (subtitle) addText(slide, subtitle, 54, 120, 1080, 40, { fontSize: 16, color: COLORS.muted });
  addText(slide, String(pageNo).padStart(2, "0"), 1180, 32, 50, 28, {
    fontSize: 14,
    bold: true,
    color: COLORS.gray,
    align: "right",
  });
}

function addPill(slide, label, x, y, width, color = COLORS.blue, fill = COLORS.pale) {
  addRect(slide, x, y, width, 30, fill, { lineFill: fill, borderRadius: "rounded-xl" });
  addText(slide, label, x + 10, y + 6, width - 20, 18, {
    fontSize: 12,
    bold: true,
    color,
    align: "center",
  });
}

function addBulletList(slide, bullets, x, y, width, options = {}) {
  const gap = options.gap ?? 54;
  bullets.forEach((bullet, index) => {
    const yy = y + index * gap;
    addRect(slide, x, yy + 5, 24, 24, options.dotFill || COLORS.blue, { geometry: "ellipse" });
    addText(slide, String(index + 1), x, yy + 7, 24, 18, {
      fontSize: 11,
      bold: true,
      color: COLORS.white,
      align: "center",
    });
    addText(slide, bullet, x + 38, yy, width - 38, options.itemHeight || 40, {
      fontSize: options.fontSize || 18,
      color: options.color || COLORS.text,
    });
  });
}

function addStatCard(slide, x, y, width, stat, label, tone = "blue") {
  const toneMap = {
    blue: [COLORS.pale, COLORS.blue],
    green: [COLORS.greenPale, COLORS.green],
    orange: [COLORS.orangePale, COLORS.orange],
    red: [COLORS.redPale, COLORS.red],
  };
  const [fill, color] = toneMap[tone] || toneMap.blue;
  addRect(slide, x, y, width, 145, COLORS.white, {
    lineFill: COLORS.line,
    lineWidth: 1,
    shadow: "shadow-sm",
    borderRadius: "rounded-2xl",
  });
  addRect(slide, x + 18, y + 18, 42, 42, fill, { geometry: "ellipse" });
  addText(slide, "✓", x + 18, y + 26, 42, 20, { fontSize: 18, bold: true, color, align: "center" });
  addText(slide, stat, x + 20, y + 66, width - 40, 42, { fontSize: 30, bold: true, color: COLORS.navy });
  addText(slide, label, x + 20, y + 112, width - 40, 24, { fontSize: 13, color: COLORS.muted });
}

async function addImage(slide, filePath, x, y, width, height, options = {}) {
  const hasLabel = Boolean(options.label);
  const imageTopInset = 8;
  const imageBottomInset = 8;
  let labelTop = y + imageTopInset;
  addRect(slide, x, y, width, height, COLORS.white, {
    lineFill: options.lineFill || COLORS.line,
    lineWidth: 1,
    shadow: options.shadow === false ? undefined : "shadow-sm",
    borderRadius: "rounded-2xl",
  });
  const imageExists = filePath && (await exists(filePath));
  if (imageExists) {
    const bytes = new Uint8Array(await fs.readFile(filePath));
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    const imagePosition = {
      left: x + 8,
      top: y + imageTopInset,
      width: width - 16,
      height: height - imageTopInset - imageBottomInset,
    };
    if (contentType === "image/png" && bytes.byteLength >= 24) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const sourceWidth = view.getUint32(16, false);
      const sourceHeight = view.getUint32(20, false);
      const isPortraitCapture = sourceWidth > 0 && sourceHeight / sourceWidth > 1.5;
      if (isPortraitCapture && (options.fit || "contain") === "contain") {
        const sourceRatio = sourceWidth / sourceHeight;
        const frameRatio = imagePosition.width / imagePosition.height;
        if (frameRatio < sourceRatio) {
          const renderedHeight = imagePosition.width / sourceRatio;
          labelTop = imagePosition.top + (imagePosition.height - renderedHeight) / 2;
        } else {
          labelTop = imagePosition.top;
        }
      }
    }
    slide.images.add({
      blob: bytes,
      contentType,
      alt: options.alt || path.basename(filePath),
      fit: options.fit || "contain",
      geometry: "roundRect",
      borderRadius: "rounded-xl",
      position: imagePosition,
      ...(options.crop ? { crop: options.crop } : {}),
    });
  } else {
    if (REQUIRE_FINAL) {
      throw new Error(`Final evidence image is missing: ${filePath || "<empty path>"}`);
    }
    addRect(slide, x + 12, y + imageTopInset, width - 24, height - imageTopInset - 12, COLORS.pale, {
      lineFill: COLORS.line,
      lineWidth: 1,
    });
    addText(slide, options.missingText || "待最终点击回归截图", x + 30, y + imageTopInset + (height - imageTopInset) / 2 - 18, width - 60, 36, {
      fontSize: 16,
      bold: true,
      color: COLORS.gray,
      align: "center",
      vAlign: "middle",
    });
  }
  if (hasLabel) {
    // Put the operation prompt over the phone status-bar area only. The short
    // dark strip masks the device notch without reaching the page title below.
    addRect(slide, x + 12, labelTop, width - 24, 24, COLORS.navy, {
      lineFill: COLORS.navy,
      lineWidth: 0,
      borderRadius: "rounded-xl",
    });
    addText(slide, options.label, x + 22, labelTop + 3, width - 44, 18, {
      fontSize: 11,
      bold: true,
      color: COLORS.white,
      align: "center",
      vAlign: "middle",
    });
  }
}

function addFlow(slide, items, x, y, width, options = {}) {
  const gap = 12;
  const itemWidth = (width - gap * (items.length - 1)) / items.length;
  items.forEach((item, index) => {
    const xx = x + index * (itemWidth + gap);
    addRect(slide, xx, y, itemWidth, options.height || 94, index === items.length - 1 ? COLORS.navy : COLORS.white, {
      lineFill: index === items.length - 1 ? COLORS.navy : COLORS.line,
      lineWidth: 1,
      shadow: "shadow-sm",
    });
    addText(slide, String(index + 1).padStart(2, "0"), xx + 14, y + 14, 40, 22, {
      fontSize: 12,
      bold: true,
      color: index === items.length - 1 ? COLORS.blue2 : COLORS.blue,
    });
    addText(slide, item, xx + 14, y + 42, itemWidth - 28, 38, {
      fontSize: 16,
      bold: true,
      color: index === items.length - 1 ? COLORS.white : COLORS.text,
    });
  });
}

function setNotes(slide, sources, presenter = "") {
  const safeSources = sources.filter(Boolean);
  const notes = [
    presenter,
    "[Sources]",
    ...safeSources.map((source) => `- ${source}`),
    "[/Sources]",
  ]
    .filter(Boolean)
    .join("\n");
  slide.speakerNotes.textFrame.setText(notes);
  slide.speakerNotes.setVisible(true);
}

function annual(name) {
  return path.join(ANNUAL_DIR, name);
}

function repair(name) {
  return path.join(REPAIR_DIR, name);
}

function driverEntry(name) {
  return path.join(DRIVER_ENTRY_DIR, name);
}

function prepared(mode, name) {
  return path.join(PREPARED_DIR, mode, name);
}

async function buildDeck() {
  const annualSummary = await readJson(path.join(ANNUAL_DIR, "run-summary.json"));
  const repairSummary = await readJson(path.join(REPAIR_DIR, "run-summary.json"));
  const missingAnnualScreenshots = await missingFiles(ANNUAL_DIR, REQUIRED_ANNUAL_SCREENSHOTS);
  const missingRepairScreenshots = await missingFiles(REPAIR_DIR, REQUIRED_REPAIR_SCREENSHOTS);
  const missingDriverEntryScreenshots = await missingFiles(DRIVER_ENTRY_DIR, REQUIRED_DRIVER_ENTRY_SCREENSHOTS);
  const missingPreparedMedia = [];
  for (const [mode, name] of REQUIRED_PREPARED_MEDIA) {
    if (!(await exists(path.join(PREPARED_DIR, mode, name)))) missingPreparedMedia.push(`${mode}/${name}`);
  }
  const annualPassed = annualEvidenceIssues(annualSummary).length === 0
    && missingAnnualScreenshots.length === 0
    && missingDriverEntryScreenshots.length === 0
    && missingPreparedMedia.length === 0;
  const repairPassed = repairEvidenceIssues(repairSummary, annualSummary).length === 0
    && missingRepairScreenshots.length === 0;

  if (REQUIRE_FINAL) await validateFinalEvidence(annualSummary, repairSummary);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });
  await cleanKnownOutputArtifacts();

  const presentation = Presentation.create({ slideSize: { width: W, height: H } });

  // 01 Cover — Codex Grid cover-image-field inspired.
  {
    const slide = presentation.slides.add();
    slide.background.fill = COLORS.navy;
    addRect(slide, 0, 0, 22, H, COLORS.blue, { geometry: "rect" });
    addText(slide, "YUXIAOMAN · BUSINESS CLOSURE", 64, 52, 470, 26, {
      fontSize: 12,
      bold: true,
      color: "#83C6FF",
    });
    addText(slide, "驭小满年检与\n维修报价业务闭环", 64, 118, 540, 164, {
      fontSize: 52,
      bold: true,
      color: COLORS.white,
    });
    addText(slide, "原生点击回归 · 操作手册 · 项目价值说明", 66, 306, 520, 42, {
      fontSize: 20,
      color: "#C7E4F8",
    });
    addPill(slide, "自驾验车", 66, 380, 112, COLORS.white, "#246A94");
    addPill(slide, "代驾留证", 190, 380, 112, COLORS.white, "#246A94");
    addPill(slide, "车辆报告", 314, 380, 112, COLORS.white, "#246A94");
    addPill(slide, "多维修店报价", 438, 380, 112, COLORS.white, "#246A94");
    addText(
      slide,
      `年检点击回归：${annualPassed ? "已通过" : "待最终复跑"}   ·   维修报价点击回归：${repairPassed ? "已通过" : "待最终复跑"}`,
      66,
      458,
      520,
      56,
      { fontSize: 16, bold: true, color: annualPassed && repairPassed ? "#A9E8CD" : "#FFD6A8" },
    );
    await addImage(slide, annual("self-drive-01-home-entry.png"), 662, 50, 258, 610, {
      label: "车主端",
      alt: "驭小满小程序首页年检入口",
    });
    await addImage(slide, annual("valet-13a-fault-recorded-with-photo.png"), 944, 50, 272, 610, {
      label: "检测站端",
      alt: "检测站车辆体检报告和故障近照",
      missingText: "新版本故障报告截图\n待最终点击复跑",
    });
    addText(slide, "本地演示环境 · 2026.08", 66, 648, 300, 24, { fontSize: 12, color: "#82A9C2" });
    setNotes(slide, [annual("self-drive-01-home-entry.png"), annual("valet-13a-fault-recorded-with-photo.png")], "开场先讲闭环范围，再讲功能。维修闭环止于报价选择与模拟支付。");
  }

  // 02 Metrics summary — Codex Grid metric-led inspired.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "01 / PROOF", "闭环不是“有页面”，而是每个角色都能把订单推到终态", "年检到报告与服务完成；维修报价到车主选店与模拟支付。", 2);
    addStatCard(slide, 54, 198, 270, "2 条", "自驾 + 代驾原生点击路径", annualPassed ? "green" : "orange");
    addStatCard(slide, 342, 198, 270, "4 × 5", "代驾四阶段留证包", "blue");
    addStatCard(slide, 630, 198, 270, "3 家", "维修门店独立报价", repairPassed ? "green" : "orange");
    addStatCard(slide, 918, 198, 270, "0 元 ≠", "报价统计使用真实非零测试金额", "red");
    addFlow(slide, ["车主预约", "支付确认", "检测履约", "结果发布", "报告可查", "维修询价", "选店支付"], 54, 392, 1134, { height: 106 });
    addRect(slide, 54, 532, 1134, 92, annualPassed && repairPassed ? COLORS.greenPale : COLORS.orangePale, {
      lineFill: annualPassed && repairPassed ? "#BDE7D5" : "#FFD8B5",
      lineWidth: 1,
    });
    addText(
      slide,
      annualPassed && repairPassed
        ? "最终证据：两条年检路径与维修报价路径均由界面点击完成，摘要状态 passed。"
        : "当前稿件为证据版式预览；只有新年检与维修 run-summary 同时为 passed 后，最终稿才标记“全流程已验证”。",
      82,
      557,
      1078,
      46,
      { fontSize: 17, bold: true, color: annualPassed && repairPassed ? COLORS.green : COLORS.orange },
    );
    setNotes(slide, [path.join(ANNUAL_DIR, "run-summary.json"), path.join(REPAIR_DIR, "run-summary.json")], "这一页用于回答老板最关心的问题：流程到底闭在哪里、哪些已被点击证据证明。");
  }

  // 03 Provenance.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "02 / DATA", "测试素材边界：真实车辆照片进入流程，测试文件不伪装成正式凭证", "两套真实车辆用于验证上传保留、留证、报告和故障照片；缺失法定材料明确标注 TEST ONLY。", 3);
    await addImage(slide, prepared("self-drive", "frontLeft.jpg"), 54, 190, 330, 250, {
      label: "自驾车辆 · 真实素材",
      alt: "自驾测试车辆左前照片",
      fit: "cover",
    });
    await addImage(slide, prepared("valet", "frontLeft.jpg"), 400, 190, 330, 250, {
      label: "代驾车辆 · 真实素材",
      alt: "代驾测试车辆左前照片",
      fit: "cover",
    });
    addRect(slide, 754, 190, 434, 250, COLORS.white, { lineFill: COLORS.line, lineWidth: 1, shadow: "shadow-sm" });
    addPill(slide, "真实素材", 782, 218, 110, COLORS.green, COLORS.greenPale);
    addText(slide, "两辆车的四角、启动后仪表盘，以及可用行驶证页面来自用户提供图片。", 782, 260, 370, 72, { fontSize: 18 });
    addPill(slide, "TEST ONLY", 782, 345, 110, COLORS.orange, COLORS.orangePale);
    addText(slide, "缺失的证件副页与安全技术检验报告仅用于本地流程验证，画面带醒目标识。", 782, 386, 370, 44, { fontSize: 16, color: COLORS.muted });
    addRect(slide, 54, 470, 1134, 142, COLORS.navy, { lineFill: COLORS.navy });
    addText(slide, "对外演示原则", 80, 496, 180, 28, { fontSize: 18, bold: true, color: "#82C8FF" });
    addText(slide, "内测演示可展示任务验证码与测试账号；实车素材含用户授权车牌；模拟支付不拉起真实 SDK。", 80, 536, 1060, 58, { fontSize: 20, bold: true, color: COLORS.white });
    setNotes(slide, [prepared("self-drive", "frontLeft.jpg"), prepared("valet", "frontLeft.jpg"), path.join(ROOT, ".runtime", "annual-demo-media", "result.local.json")], "强调素材真实性与合规边界。result.local.json 仅作配置依据，不在页面中展示其内容。");
  }

  // 04 Roles.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "03 / ROLES", "五类角色共同推进一笔订单，后台看全局但不替一线履约", "正常业务节点由车主、司机、检测站和维修门店分别完成；后台负责任务安排与全程查看。", 4);
    const roles = [
      ["车主端", "预约、上传、模拟支付、看进度和报告", COLORS.blue],
      ["代驾端", "验证码领单、取车和送回留证", COLORS.green],
      ["检测站端", "接车、检测、故障记录、发布结论", COLORS.orange],
      ["运营后台", "安排司机、看状态机、证据与交易", COLORS.navy2],
      ["维修门店", "看授权故障、提交报价、按中标开放权限", COLORS.red],
    ];
    roles.forEach(([name, desc, color], i) => {
      const x = 54 + i * 226;
      addRect(slide, x, 210, 206, 280, COLORS.white, { lineFill: COLORS.line, lineWidth: 1, shadow: "shadow-sm" });
      addRect(slide, x + 66, 238, 74, 74, color, { geometry: "ellipse" });
      addText(slide, String(i + 1), x + 66, 255, 74, 32, { fontSize: 24, bold: true, color: COLORS.white, align: "center" });
      addText(slide, name, x + 18, 338, 170, 34, { fontSize: 21, bold: true, color: COLORS.navy, align: "center" });
      addText(slide, desc, x + 20, 390, 166, 72, { fontSize: 15, color: COLORS.muted, align: "center" });
    });
    addRect(slide, 54, 525, 1134, 86, COLORS.pale, { lineFill: "#C6DEF2", lineWidth: 1 });
    addText(slide, "设计原则：留证完整即可推进，不增加客户确认和异议环节阻塞业务；所有已完成节点对客户和后台只读可见。", 82, 550, 1078, 44, { fontSize: 18, bold: true, color: COLORS.navy });
    setNotes(slide, [path.join(ROOT, "server", "app.ts"), path.join(ROOT, "wechat-miniprogram", "miniprogram", "app.json")], "用角色而不是技术模块讲解系统，便于非技术听众理解职责分工。");
  }

  // 05 Home entries.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "04 / OWNER", "首页三入口：自驾验车、代驾验车、检测报告", "预约入口直达对应检测站选择；报告入口始终进入报告中心。", 5);
    await addImage(slide, annual("self-drive-01-home-entry.png"), 54, 180, 318, 472, { label: "操作 1 · 选择验车方式", alt: "小程序首页年检服务三入口" });
    addRect(slide, 404, 180, 784, 472, COLORS.white, { lineFill: COLORS.line, lineWidth: 1, shadow: "shadow-sm" });
    const entries = [
      ["自驾验车", "自己开车到检测站 · 选择网点和时段", "直接建立自驾预约草稿"],
      ["代驾验车", "上门取车，检后送回 · 按真实路线计价", "直接建立代驾预约草稿"],
      ["检测报告", "年检结论 · 车辆体检记录", "进入全部车辆报告中心"],
    ];
    entries.forEach(([name, desc, behavior], i) => {
      const y = 212 + i * 118;
      addRect(slide, 438, y, 716, 96, i === 2 ? COLORS.navy : COLORS.pale, { lineFill: i === 2 ? COLORS.navy : "#C5DDF1", lineWidth: 1 });
      addText(slide, name, 462, y + 18, 160, 28, { fontSize: 20, bold: true, color: i === 2 ? COLORS.white : COLORS.navy });
      addText(slide, desc, 462, y + 52, 380, 24, { fontSize: 14, color: i === 2 ? "#CEE8FA" : COLORS.muted });
      addPill(slide, behavior, 860, y + 31, 268, i === 2 ? COLORS.navy : COLORS.blue, i === 2 ? COLORS.white : "#DCEEFF");
    });
    addText(slide, "智能分流：无车辆先添加；已有进行中订单直接打开；资格异常先核验，完成后续接原验车方式。", 438, 588, 716, 34, { fontSize: 15, bold: true, color: COLORS.blue });
    setNotes(slide, [annual("self-drive-01-home-entry.png"), path.join(ROOT, "wechat-miniprogram", "miniprogram", "pages", "home", "home.ts")], "演示时先从首页进入自驾，再返回首页进入代驾；报告入口留到结果发布后展示。");
  }

  // 06 Self-drive booking.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "05 / SELF-DRIVE", "自驾预约：7 张资料不会互相覆盖，支付后自动确认", "四角 + 启动后仪表盘 + 行驶证主页/副页；服务端报价快照锁定 ¥260.00。", 6);
    await addImage(slide, annual("self-drive-02-station-picker.png"), 54, 180, 250, 456, { label: "① 选站与时段", alt: "自驾检测站选择页面" });
    await addImage(slide, annual("self-drive-05-all-uploads-retained.png"), 322, 180, 250, 456, { label: "② 7/7 上传保留", alt: "自驾七张预约资料全部保留", missingText: "7 张资料上传完成" });
    await addImage(slide, annual("self-drive-06-order-pending-payment.png"), 590, 180, 250, 456, { label: "③ ¥260 待支付", alt: "自驾订单非零金额模拟支付页面" });
    addRect(slide, 862, 180, 326, 456, COLORS.white, { lineFill: COLORS.line, lineWidth: 1, shadow: "shadow-sm" });
    addBulletList(slide, ["选择检测站与预约时段", "依次上传 7 张，每次检查此前照片仍在", "使用服务端 quoteSnapshotId 创建订单", "本地模拟支付，不拉起真实 SDK", "支付成功后自动进入已确认"], 888, 218, 274, { gap: 70, fontSize: 16, itemHeight: 50 });
    setNotes(slide, [annual("self-drive-02-station-picker.png"), annual("self-drive-05-all-uploads-retained.png"), annual("self-drive-06-order-pending-payment.png")], "演示操作：先选择检测站与时段，再逐张上传 7 份资料并核对缩略图均保留；提交预约后展示 ¥260 待支付和支付后自动确认。");
  }

  // 07 Self-drive inspection and failed.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "06 / INSPECTION", "自驾检测：车身无明显故障，年检仍可依据检测结果判定未通过", "结论只有“通过 / 未通过”；未通过必须填写原因与复检建议。", 7);
    await addImage(slide, annual("self-drive-08-station-inspecting.png"), 54, 182, 292, 450, { label: "检测站 · 检测中", alt: "检测站推进自驾订单至检测中" });
    await addImage(slide, annual("self-drive-13-checkup-ready-to-publish.png"), 364, 182, 292, 450, { label: "5/5 现场照片 + 未通过", alt: "检测报告待发布并选择未通过" });
    await addImage(slide, annual("self-drive-17-owner-report-modal.png"), 674, 182, 292, 450, { label: "客户收到未通过报告", alt: "车主端查看自驾未通过报告弹窗" });
    addRect(slide, 986, 182, 202, 450, COLORS.navy, { lineFill: COLORS.navy });
    addText(slide, "未通过示例", 1008, 212, 160, 30, { fontSize: 18, bold: true, color: "#8DD0FF" });
    addText(slide, "制动力检测未达到检测线阈值", 1008, 260, 160, 72, { fontSize: 22, bold: true, color: COLORS.white });
    addText(slide, "复检建议", 1008, 370, 160, 24, { fontSize: 14, bold: true, color: "#8DD0FF" });
    addText(slide, "检修制动系统，携检测报告完成复检。", 1008, 408, 160, 80, { fontSize: 17, color: "#D6ECF9" });
    addText(slide, "未通过时\n不发布合格标志。", 1008, 542, 160, 58, { fontSize: 14, bold: true, color: "#FFCCAE" });
    setNotes(slide, [annual("self-drive-08-station-inspecting.png"), annual("self-drive-13-checkup-ready-to-publish.png"), annual("self-drive-17-owner-report-modal.png")], "重点解释：车身状态确认与年检结论不是同一个判断维度。");
  }

  // 08 Valet booking.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "07 / VALET", "代驾预约：预约只收 2 张证件，现场车况由司机取车时采集", "真实地址 + 路线凭证 + 服务端计价；¥260 检测费 + ¥109 取送费 = ¥369。", 8);
    await addImage(slide, annual("valet-02-station-picker.png"), 54, 182, 272, 450, { label: "① 地址与路线", alt: "代驾地址与检测站选择", missingText: "选择取车地址与检测站" });
    await addImage(slide, annual("valet-05-all-uploads-retained.png"), 344, 182, 272, 450, { label: "② 2/2 行驶证", alt: "代驾预约两张证件全部保留", missingText: "2 张行驶证资料上传完成" });
    await addImage(slide, annual("valet-06-order-pending-payment.png"), 634, 182, 272, 450, { label: "③ ¥369 模拟支付", alt: "代驾非零报价和模拟支付" });
    addRect(slide, 928, 182, 260, 450, COLORS.white, { lineFill: COLORS.line, lineWidth: 1, shadow: "shadow-sm" });
    addText(slide, "报价快照", 954, 216, 208, 28, { fontSize: 19, bold: true, color: COLORS.navy });
    addText(slide, "年检服务费", 954, 278, 120, 24, { fontSize: 15, color: COLORS.muted });
    addText(slide, "¥260", 1078, 273, 84, 30, { fontSize: 21, bold: true, color: COLORS.text, align: "right" });
    addText(slide, "路线取送费", 954, 334, 120, 24, { fontSize: 15, color: COLORS.muted });
    addText(slide, "¥109", 1078, 329, 84, 30, { fontSize: 21, bold: true, color: COLORS.text, align: "right" });
    addRect(slide, 954, 388, 208, 1, COLORS.line, { geometry: "rect" });
    addText(slide, "合计", 954, 410, 90, 28, { fontSize: 16, bold: true, color: COLORS.navy });
    addText(slide, "¥369", 1050, 404, 112, 38, { fontSize: 28, bold: true, color: COLORS.orange, align: "right" });
    addText(slide, "预约只传 2 张行驶证；现场车况由司机取车时拍摄。", 954, 500, 208, 88, { fontSize: 16, bold: true, color: COLORS.blue });
    addText(slide, "车主点击：代驾验车 → 取车地址 / 检测站 / 时段 → 上传 2 张行驶证 →「提交预约」→「本地模拟支付」。", 54, 646, 1134, 30, { fontSize: 16, bold: true, color: COLORS.navy, align: "center" });
    setNotes(slide, [annual("valet-02-station-picker.png"), annual("valet-05-all-uploads-retained.png"), annual("valet-06-order-pending-payment.png")], "演示操作：从首页点击“代驾验车”，完成取车地址、检测站与时段选择；上传行驶证主页和副页后点击“提交预约”，最后在订单页点击“本地模拟支付”。");
  }

  // 09 Driver entry, code login and pickup.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "08 / DRIVER", "从工作人员入口切换代驾端，验证码登录后进入单笔任务", "四张实机截图依次展示入口、登录、取车留证和状态推进。", 9);
    await addImage(slide, driverEntry("driver-entry-01-switch-to-driver.png"), 54, 184, 230, 448, { label: "① 切换 · 代驾端", alt: "工作人员入口切换到代驾端" });
    await addImage(slide, driverEntry("driver-entry-02-code-login.png"), 304, 184, 230, 448, { label: "② 登录 · 任务码", alt: "代驾端六位任务验证码登录页面" });
    await addImage(slide, annual("valet-09-driver-pickup-five-photos-ready.png"), 570, 184, 294, 448, { label: "③ 登录后 · 取车 5/5", alt: "代驾司机登录后进入取车任务并拍满五张照片" });
    await addImage(slide, annual("valet-09-driver-pickup-submitted.png"), 894, 184, 294, 448, { label: "④ 提交后 · 已取车", alt: "代驾司机提交取车留证后状态推进" });
    setNotes(slide, [driverEntry("driver-entry-01-switch-to-driver.png"), driverEntry("driver-entry-02-code-login.png"), annual("valet-09-driver-pickup-five-photos-ready.png"), annual("valet-09-driver-pickup-submitted.png"), path.join(ROOT, "wechat-miniprogram", "miniprogram", "packages", "operator", "pages", "staff-entry", "staff-entry.ts"), path.join(ROOT, "wechat-miniprogram", "miniprogram", "packages", "driver", "pages", "login", "login.ts"), path.join(ROOT, "wechat-miniprogram", "miniprogram", "packages", "driver", "pages", "task", "task.ts")], "演示操作：进入“工作人员入口”，点击“代驾端”；在代驾端输入后台生成的 6 位任务验证码并点击“验证并进入任务”；登录后核对只显示当前订单，再拍满 5 张并点击“提交取车留证并推进”。");
  }

  // 10 Station handover and evidence.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "09 / EVIDENCE", "代驾四阶段留证：照片完整就是推进条件，不增加确认阻塞", "取车、到站、检测完成、送回；每阶段固定四角 + 启动后仪表盘 5 张。", 10);
    const stages = [
      ["01 司机取车", annual("valet-09-driver-pickup-submitted.png")],
      ["02 检测站接车", annual("valet-12-station-arrival-and-inspecting.png")],
      ["03 检测完成", annual("valet-14-report-published.png")],
      ["04 司机送回", annual("valet-15-driver-return-submitted.png")],
    ];
    for (let i = 0; i < stages.length; i += 1) {
      await addImage(slide, stages[i][1], 54 + i * 284, 190, 266, 388, { label: stages[i][0], alt: stages[i][0] });
      addPill(slide, "5 / 5", 124 + i * 284, 596, 126, COLORS.green, COLORS.greenPale);
    }
    addText(slide, "司机取车：点“提交取车留证并推进” ｜ 检测站接车：点“提交留证并完成到站核验” ｜ 检测完成：点“填写体检报告并回传”", 54, 630, 1134, 24, { fontSize: 16, bold: true, color: COLORS.navy, align: "center" });
    addText(slide, "司机返程：点“开始送回车辆” → 拍满 5 张 → 点“提交送回留证并完成服务”", 54, 658, 1134, 24, { fontSize: 16, bold: true, color: COLORS.blue, align: "center" });
    setNotes(slide, stages.map(([, source]) => source), "演示操作：四个责任节点都先拍满 5 张再推进；检测完成阶段复用体检报告中的 5 张现场照片。每次提交会同步记录照片包、操作角色、服务端时间和订单状态。");
  }

  // 11 Report: fault independent.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "10 / REPORT", "车况故障与年检结论相互独立：有轻微剐蹭仍可年检通过", "检测站在车辆示意图定位右后翼子板，填写类型/程度/说明，并上传故障近照。", 11);
    await addImage(slide, annual("valet-13a-fault-recorded-with-photo.png"), 54, 182, 480, 450, { label: "检测站 · 故障定位 + 近照", alt: "检测站记录右后翼子板剐蹭和故障照片", missingText: "检测站故障定位与近照" });
    await addImage(slide, annual("valet-17-owner-report-modal.png"), 560, 182, 300, 450, { label: "车主 · 报告弹窗", alt: "车主查看通过报告和车辆故障" });
    addRect(slide, 886, 182, 302, 450, COLORS.white, { lineFill: COLORS.line, lineWidth: 1, shadow: "shadow-sm" });
    addPill(slide, "年检结论", 912, 218, 114, COLORS.green, COLORS.greenPale);
    addText(slide, "通过", 1040, 216, 120, 34, { fontSize: 24, bold: true, color: COLORS.green, align: "right" });
    addPill(slide, "车况故障", 912, 286, 114, COLORS.red, COLORS.redPale);
    addText(slide, "1 项", 1040, 284, 120, 34, { fontSize: 24, bold: true, color: COLORS.red, align: "right" });
    addText(slide, "右后翼子板 · 轻微剐蹭", 912, 354, 248, 52, { fontSize: 19, bold: true, color: COLORS.navy });
    addText(slide, "约 8 cm；附现场特写照片。", 912, 420, 248, 44, { fontSize: 16, color: COLORS.muted });
    addRect(slide, 912, 500, 248, 94, COLORS.pale, { lineFill: "#C7DFF2", lineWidth: 1 });
    addText(slide, "普通车身问题不自动决定年检是否合格。", 934, 524, 204, 52, { fontSize: 16, bold: true, color: COLORS.blue, align: "center" });
    setNotes(slide, [annual("valet-13a-fault-recorded-with-photo.png"), annual("valet-17-owner-report-modal.png")], "演示操作：检测站点击车辆示意图中的右后翼子板，选择“剐蹭”和“轻微”，填写说明并上传近照；报告发布后，车主在报告弹窗核对年检结论与故障记录。");
  }

  // 12 Results and visibility.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "11 / VISIBILITY", "结果发布后报告立即可查；代驾送回中仍保留车辆进度", "客户和后台看到同一状态机、同一组留证和同一份报告，但只有只读权限。", 12);
    await addImage(slide, annual("valet-16-owner-evidence-modal.png"), 54, 182, 300, 450, { label: "客户 · 履约留证弹窗", alt: "客户查看代驾四阶段履约留证" });
    await addImage(slide, annual("valet-17-owner-report-modal.png"), 380, 182, 300, 450, { label: "客户 · 检测报告弹窗", alt: "客户查看代驾检测报告" });
    await addImage(slide, annual("valet-18-admin-final-detail.png"), 706, 182, 482, 450, { label: "后台 · 全局订单详情", alt: "后台查看代驾订单完整状态和报告", fit: "contain" });
    addText(slide, "图片用页面内弹窗查看，不挤占整张业务详情；历史订单缺少留证时明确显示“该节点未采集”，不补造数据。", 54, 646, 1134, 32, { fontSize: 16, bold: true, color: COLORS.navy, align: "center" });
    setNotes(slide, [annual("valet-16-owner-evidence-modal.png"), annual("valet-17-owner-report-modal.png"), annual("valet-18-admin-final-detail.png")], "演示操作：客户在订单详情滚动到“履约留证”，点击任一照片查看弹窗；再点击“查看检测报告与留证”打开报告。后台打开同一订单详情，依次核对状态时间轴、4/4 留证阶段和每阶段 5/5 照片。");
  }

  // 13 Repair request.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "12 / REPAIR", "从已发布体检报告一键生成维修询价，不重复手工录入故障", "车主明确授权后，故障位置、描述和近照以报告快照形式提供给维修门店。", 13);
    await addImage(slide, repair("01-owner-report-repair-entry.png"), 54, 182, 260, 448, { label: "① 点“一键咨询维修报价”", alt: "车主从检测报告进入维修报价", missingText: "报告中的维修报价入口" });
    await addImage(slide, repair("02-owner-confirm-imported-faults.png"), 334, 182, 260, 448, { label: "② 核对导入的故障与近照", alt: "车主确认从报告导入的故障和照片", missingText: "核对导入的故障资料" });
    await addImage(slide, repair("03-owner-consent-ready.png"), 614, 182, 260, 448, { label: "③ 勾选资料共享授权", alt: "车主勾选维修询价授权", missingText: "勾选资料共享授权" });
    await addImage(slide, repair("04-owner-request-waiting-quotes.png"), 894, 182, 294, 448, { label: "④ 点“发布维修询价”", alt: "维修请求发布后等待门店报价", missingText: "维修询价等待报价" });
    addText(slide, "操作顺序：报告点“一键咨询维修报价” → 核对故障与近照 → 勾选“同意共享上述维修询价资料” → 点“发布维修询价”。", 54, 638, 1134, 44, { fontSize: 16, bold: true, color: COLORS.blue, align: "center" });
    setNotes(slide, [repair("01-owner-report-repair-entry.png"), repair("02-owner-confirm-imported-faults.png"), repair("03-owner-consent-ready.png"), repair("04-owner-request-waiting-quotes.png")], "演示操作：从已发布报告点击“一键咨询维修报价”，核对自动导入的故障位置、说明和近照；勾选“同意共享上述维修询价资料”，再点击“发布维修询价”。报价前门店只能看到授权的脱敏资料。");
  }

  // 14 Three shops.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "13 / QUOTES", "三家门店独立看故障、看近照、提交全款报价", "报价互相隔离；车主收到三份可比较方案，但系统不替车主自动选最低价。", 14);
    const shops = [
      ["门店 A", "¥1,680", repair("09-shop-1-quote-submitted.png")],
      ["门店 B", "¥1,980", repair("13-shop-2-quote-submitted.png")],
      ["门店 C", "¥2,350", repair("17-shop-3-quote-submitted.png")],
    ];
    for (let i = 0; i < shops.length; i += 1) {
      const x = 54 + i * 292;
      await addImage(slide, shops[i][2], x, 188, 270, 356, { label: `${shops[i][0]} · 独立报价`, alt: `${shops[i][0]}报价表单`, missingText: `${shops[i][0]}报价提交结果` });
      addText(slide, shops[i][1], x, 560, 270, 42, { fontSize: 28, bold: true, color: COLORS.navy, align: "center" });
    }
    await addImage(slide, repair("18-owner-quotes-price-sorted.png"), 930, 188, 258, 414, { label: "车主 · 3 份报价，未默认选择", alt: "车主收到三家报价且系统未默认选中最低价", missingText: "车主收到三份报价且未默认选择" });
    addText(slide, "每家门店：打开需求 → 点“立即报价” → 填写项目、金额和说明 → 点“提交报价 ¥金额”；车主点击“刷新报价”查看 3 份方案。", 54, 636, 1134, 42, { fontSize: 16, bold: true, color: COLORS.navy, align: "center" });
    setNotes(slide, shops.map(([, , source]) => source).concat(repair("17-owner-request-three-quotes.png"), repair("18-owner-quotes-price-sorted.png")), "演示操作：三家门店分别打开同一条授权需求，点击“立即报价”，填写项目、金额和说明后点击“提交报价 ¥金额”；回到车主端点击“刷新报价”，确认出现三份互相隔离的报价。进入比较页时三份报价均未勾选，系统不替车主自动选择最低价。现场内测演示可展示测试门店账号，以便切换角色完成报价流程。");
  }

  // 15 Explicit selection and permissions.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "14 / TRANSACTION", "车主明确选择第二份报价并模拟支付，权限随成交结果收口", "排序第一不等于自动中选；成交回执冻结门店、金额和方案。", 15);
    await addImage(slide, repair("19-owner-explicit-quote-selection.png"), 54, 182, 264, 440, { label: "① 选择门店 B · ¥1,980", alt: "车主明确选择第二份维修报价", missingText: "车主选择门店 B 报价" });
    await addImage(slide, repair("20-owner-paid-receipt.png"), 338, 182, 264, 440, { label: "② 点“确认模拟支付”", alt: "维修报价模拟支付成交回执", missingText: "模拟支付成交回执" });
    await addImage(slide, repair("24-winning-shop-deal.png"), 622, 182, 264, 440, { label: "③ 点“查看成交回执”", alt: "中选维修门店查看成交和联系人", missingText: "中选门店成交详情" });
    await addImage(slide, repair("26-losing-shop-1-contact-locked.png"), 906, 182, 282, 440, { label: "④ 两家落选店 · 联系人锁定", alt: "两家未中选维修门店联系人权限均锁定", missingText: "两家未中选门店联系人锁定" });
    addText(slide, "车主：选择门店 B → 点“确认模拟支付 ¥1,980” → 点“查看成交回执”；仅中选门店解锁联系人，模拟支付不真实扣款。", 54, 636, 1134, 42, { fontSize: 16, bold: true, color: COLORS.orange, align: "center" });
    setNotes(slide, [repair("19-owner-explicit-quote-selection.png"), repair("20-owner-paid-receipt.png"), repair("24-winning-shop-deal.png"), repair("26-losing-shop-1-contact-locked.png"), repair("28-losing-shop-2-contact-locked.png")], "演示操作：车主在三份报价中主动选择门店 B，点击“确认模拟支付 ¥1,980”，随后点击“查看成交回执”；切换到三家门店端核对只有中选门店可见联系人，两家未中选门店都保持锁定。");
  }

  // 16 Acceptance and boundary.
  {
    const slide = presentation.slides.add();
    addTitle(slide, "15 / HANDOFF", "可演示、可复测、边界透明：这才是可信的业务闭环", "操作手册既告诉演示者点什么，也明确哪些能力仍属于正式上线前工作。", 16);
    addRect(slide, 54, 188, 544, 414, COLORS.white, { lineFill: COLORS.line, lineWidth: 1, shadow: "shadow-sm" });
    addPill(slide, "已纳入本地闭环", 82, 216, 150, COLORS.green, COLORS.greenPale);
    addBulletList(slide, ["自驾与代驾两条年检状态机", "非零服务端报价快照与模拟支付", "司机/检测站四阶段留证", "通过/未通过报告、故障与照片", "多维修店报价、车主选择、成交权限"], 82, 272, 486, { gap: 58, fontSize: 17 });
    addRect(slide, 626, 188, 562, 414, COLORS.navy, { lineFill: COLORS.navy, shadow: "shadow-sm" });
    addPill(slide, "正式上线前边界", 654, 216, 150, COLORS.orange, COLORS.orangePale);
    const boundaries = ["微信小程序审核与公网部署", "真实支付 SDK 与资金清结算", "检测站正式系统与法定材料", "司机实名认证、风控与运营调度", "线下维修拆检、施工、质保、交车验收"];
    boundaries.forEach((item, i) => {
      addText(slide, `• ${item}`, 660, 274 + i * 58, 496, 38, { fontSize: 17, color: COLORS.white });
    });
    addRect(slide, 54, 626, 1134, 48, annualPassed && repairPassed ? COLORS.greenPale : COLORS.orangePale, {
      lineFill: annualPassed && repairPassed ? "#BDE7D5" : "#FFD8B5",
      lineWidth: 1,
    });
    addText(
      slide,
      annualPassed && repairPassed
        ? "验收结论：当前版本已使用真实车辆图片完成全链路界面点击回归，业务与权限闭环通过。"
        : "当前状态：版式和说明已完成；等待微信开发者工具扫码后执行最终年检与维修点击回归，再生成终版。",
      74,
      638,
      1094,
      24,
      { fontSize: 16, bold: true, color: annualPassed && repairPassed ? COLORS.green : COLORS.orange, align: "center" },
    );
    setNotes(slide, [path.join(ANNUAL_DIR, "run-summary.json"), path.join(REPAIR_DIR, "run-summary.json"), path.join(ROOT, "README.md")], "结束时主动说明真实生产边界，避免把本地演示能力包装成已正式上线能力。");
  }

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    const png = await presentation.export({ slide, format: "png", scale: 1 });
    await fs.writeFile(path.join(OUT_DIR, `${stem}.png`), new Uint8Array(await png.arrayBuffer()));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(OUT_DIR, `${stem}.layout.json`), await layout.text());
  }

  const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
  await fs.writeFile(path.join(OUT_DIR, "deck-montage.webp"), new Uint8Array(await montage.arrayBuffer()));
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(FINAL_PPTX);

  const manifest = {
    generatedAt: new Date().toISOString(),
    annualArtifactDir: ANNUAL_DIR,
    repairArtifactDir: REPAIR_DIR,
    annualPassed,
    repairPassed,
    finalEvidenceRequired: REQUIRE_FINAL,
    slideCount: presentation.slides.items.length,
    outputPptx: FINAL_PPTX,
    montage: path.join(OUT_DIR, "deck-montage.webp"),
  };
  await fs.writeFile(path.join(OUT_DIR, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

buildDeck().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

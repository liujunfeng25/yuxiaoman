const fs = require("node:fs");
const path = require("node:path");
const ts = require("../../node_modules/typescript");

const projectRoot = path.resolve(__dirname, "..");
const miniprogramRoot = path.join(projectRoot, "miniprogram");
const appConfig = JSON.parse(fs.readFileSync(path.join(miniprogramRoot, "app.json"), "utf8"));
const projectConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "project.config.json"), "utf8"));
const subpackages = appConfig.subPackages || appConfig.subpackages || [];
const subpackageRoots = subpackages
  .map((item) => String(item.root || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
  .filter(Boolean);
const targetBytes = Math.floor(1.5 * 1024 * 1024);
const hardLimitBytes = 2 * 1024 * 1024;
const totalLimitBytes = 20 * 1024 * 1024;
const expectedMainPages = ["pages/home/home", "pages/orders/orders", "pages/profile/profile"];
const entries = [];
const uploadIgnores = projectConfig.packOptions?.ignore || [];
const errors = [];

function belongsToSubpackage(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  return subpackageRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isIgnoredForUpload(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  return uploadIgnores.some((rule) => {
    const value = String(rule.value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!value) return false;
    if (rule.type === "file") return normalized === value;
    if (rule.type === "folder") return normalized === value || normalized.startsWith(`${value}/`);
    if (rule.type === "suffix") return normalized.endsWith(value);
    if (rule.type === "prefix") return normalized.startsWith(value);
    return false;
  });
}

function visit(directory, target = entries, excludeSubpackages = true) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(miniprogramRoot, absolutePath).replace(/\\/g, "/");
    if (excludeSubpackages && belongsToSubpackage(relativePath)) continue;
    if (isIgnoredForUpload(relativePath)) continue;
    if (entry.isDirectory()) {
      visit(absolutePath, target, excludeSubpackages);
      continue;
    }
    if (relativePath.endsWith(".d.ts") || relativePath.endsWith(".map")) continue;
    const source = fs.readFileSync(absolutePath);
    const bytes = relativePath.endsWith(".ts")
      ? Buffer.byteLength(ts.transpileModule(source.toString("utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2017,
          module: ts.ModuleKind.CommonJS,
          removeComments: true,
        },
        fileName: relativePath,
      }).outputText)
      : source.length;
    target.push({ relativePath, bytes });
  }
}

function collectJson(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJson(absolutePath, files);
    else if (entry.name.endsWith(".json")) files.push(absolutePath);
  }
  return files;
}

function collectFiles(directory, predicate, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(absolutePath, predicate, files);
    else if (predicate(absolutePath)) files.push(absolutePath);
  }
  return files;
}

function normalize(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

const mainPages = (appConfig.pages || []).map(normalize);
const tabPages = (appConfig.tabBar?.list || []).map((item) => normalize(item.pagePath));
if (!sameList(mainPages, expectedMainPages)) {
  errors.push(`主包 pages 必须且只能按顺序保留：${expectedMainPages.join("、")}`);
}
if (!sameList(tabPages, expectedMainPages)) errors.push("tabBar 必须与主包三个根页面完全一致");
if (appConfig.pages?.[0] !== "pages/home/home") errors.push("小程序首屏必须保持 pages/home/home");

for (const page of mainPages) {
  const base = path.join(miniprogramRoot, page);
  for (const extension of [".ts", ".json", ".wxml", ".wxss"]) {
    if (!fs.existsSync(`${base}${extension}`)) errors.push(`主包页面缺少 ${normalize(`${page}${extension}`)}`);
  }
}
for (const tab of appConfig.tabBar?.list || []) {
  for (const iconPath of [tab.iconPath, tab.selectedIconPath]) {
    const normalizedIcon = normalize(iconPath);
    if (!normalizedIcon || !fs.existsSync(path.join(miniprogramRoot, normalizedIcon))) {
      errors.push(`tabBar 图标不存在：${normalizedIcon || "未配置"}`);
    }
  }
}

for (const subpackage of subpackages) {
  if (subpackage.independent === true) errors.push(`${subpackage.root} 不得设为独立分包`);
  const root = normalize(subpackage.root);
  for (const page of subpackage.pages || []) {
    const base = path.join(miniprogramRoot, root, normalize(page));
    for (const extension of [".ts", ".json", ".wxml", ".wxss"]) {
      if (!fs.existsSync(`${base}${extension}`)) {
        errors.push(`分包页面缺少 ${normalize(path.relative(miniprogramRoot, `${base}${extension}`))}`);
      }
    }
  }
}

const registeredRoutes = new Set([
  ...mainPages,
  ...subpackages.flatMap((subpackage) => {
    const root = normalize(subpackage.root);
    return (subpackage.pages || []).map((page) => `${root}/${normalize(page)}`);
  }),
]);
const runtimeSources = collectFiles(
  miniprogramRoot,
  (file) => file.endsWith(".ts") || file.endsWith(".wxml") || file.endsWith(".wxss"),
);

function packageRootFor(absolutePath) {
  const relativePath = normalize(path.relative(miniprogramRoot, absolutePath));
  return subpackageRoots.find((root) => relativePath === root || relativePath.startsWith(`${root}/`)) || null;
}

function resolveLocalReference(sourceFile, reference) {
  return reference.startsWith("/")
    ? path.join(miniprogramRoot, reference.slice(1))
    : path.resolve(path.dirname(sourceFile), reference);
}

function validatePackageBoundary(sourceFile, targetFile, label) {
  const sourcePackage = packageRootFor(sourceFile);
  const targetPackage = packageRootFor(targetFile);
  const relativeFile = normalize(path.relative(miniprogramRoot, sourceFile));
  if (!sourcePackage && targetPackage) errors.push(`${relativeFile} 的主包文件通过${label}引用了分包 ${targetPackage}`);
  else if (sourcePackage && targetPackage && sourcePackage !== targetPackage) {
    errors.push(`${relativeFile} 从 ${sourcePackage} 通过${label}跨分包引用了 ${targetPackage}`);
  }
}

function validateExistingReference(sourceFile, reference, label) {
  const target = resolveLocalReference(sourceFile, reference);
  const relativeFile = normalize(path.relative(miniprogramRoot, sourceFile));
  if (!fs.existsSync(target)) errors.push(`${relativeFile} 引用了不存在的${label} ${reference}`);
  validatePackageBoundary(sourceFile, target, label);
}

for (const file of runtimeSources) {
  const source = fs.readFileSync(file, "utf8");
  const relativeFile = normalize(path.relative(miniprogramRoot, file));
  for (const match of source.matchAll(/\/(?:pages\/[a-z0-9-]+\/[a-z0-9-]+|packages\/[a-z0-9-]+\/pages\/[a-z0-9-]+\/[a-z0-9-]+)/giu)) {
    const route = normalize(match[0]);
    if (!registeredRoutes.has(route)) errors.push(`${relativeFile} 引用了未注册页面 /${route}`);
  }

  if (file.endsWith(".ts")) {
    for (const match of source.matchAll(/(?:from\s+|require\s*\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      validatePackageBoundary(file, target, " TypeScript import ");
    }
  }

  const resourceMatches = [
    ...source.matchAll(/["'](\/(?:assets\/|packages\/[a-z0-9-]+\/assets\/)[^"'{}\s]+)["']/giu),
    ...source.matchAll(/(?:src\s*=\s*|url\(\s*)["']((?:\.\.\/)+assets\/[^"'{}\s)]+)["']/giu),
  ];
  for (const match of resourceMatches) {
    const resource = match[1];
    if (/\.webp(?:[?#].*)?$/iu.test(resource)) {
      errors.push(`${relativeFile} 引用了真机兼容性不稳定的本地 WebP 静态资源 ${resource}；请转换为 PNG/JPG`);
    }
    validateExistingReference(file, resource, "静态资源");
  }

  if (file.endsWith(".wxml")) {
    for (const match of source.matchAll(/<wxs\b[^>]*\bsrc=["']([^"'{}]+)["'][^>]*>/giu)) {
      const wxsPath = match[1];
      validateExistingReference(file, wxsPath, " WXS ");
    }
    for (const match of source.matchAll(/<(?:include|import)\b[^>]*\bsrc=["']([^"'{}]+)["'][^>]*>/giu)) {
      validateExistingReference(file, match[1], " WXML include/import ");
    }
  }
  if (file.endsWith(".wxss")) {
    for (const match of source.matchAll(/@import\s+["']([^"'{}]+)["']\s*;/giu)) {
      validateExistingReference(file, match[1], " WXSS @import ");
    }
    for (const match of source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/giu)) {
      const stylesheetUrl = match[1];
      if (!/^(?:https?:|data:)/iu.test(stylesheetUrl)) {
        errors.push(`${relativeFile} 使用了微信开发者工具不支持的 WXSS 本地 url(${stylesheetUrl})；请改为 WXML <image> 层`);
      }
    }
  }
}

const jsonFiles = [
  ...collectJson(miniprogramRoot),
  path.join(projectRoot, "project.config.json"),
  path.join(projectRoot, "tsconfig.json"),
];
for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${normalize(path.relative(miniprogramRoot, file))} 不是合法 JSON：${error.message}`);
  }
}

visit(miniprogramRoot);

const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
const largest = [...entries].sort((left, right) => right.bytes - left.bytes).slice(0, 8);
const format = (bytes) => `${(bytes / 1024 / 1024).toFixed(3)} MiB`;

console.log(`主包保守编译估算：${format(totalBytes)} / ${format(targetBytes)} 预算（微信硬上限 ${format(hardLimitBytes)}，${entries.length} 个运行时文件）`);
console.log(`主包页面：${mainPages.join("、")}`);
console.log(`已排除普通分包：${subpackageRoots.join("、") || "无"}`);
console.log(`JSON 校验：${jsonFiles.length} 个文件通过解析`);
console.log("包边界校验：页面注册、相对 import、静态资源、WXS、WXML include/import 与 WXSS @import 通过");
console.log("主包最大文件：");
for (const entry of largest) console.log(`- ${(entry.bytes / 1024).toFixed(1)} KiB  ${entry.relativePath}`);

let allPackagesBytes = totalBytes;
for (const subpackage of subpackages) {
  const root = normalize(subpackage.root);
  const packageEntries = [];
  visit(path.join(miniprogramRoot, root), packageEntries, false);
  const packageBytes = packageEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  allPackagesBytes += packageBytes;
  console.log(`分包 ${root}：${format(packageBytes)} / ${format(hardLimitBytes)}（${packageEntries.length} 个运行时文件）`);
  if (packageBytes > hardLimitBytes) errors.push(`分包 ${root} 超出微信 2 MiB 硬上限 ${format(packageBytes - hardLimitBytes)}`);
}
console.log(`全部包合计：${format(allPackagesBytes)} / ${format(totalLimitBytes)} 微信上限`);
if (allPackagesBytes > totalLimitBytes) errors.push(`全部包合计超出微信 20 MiB 上限 ${format(allPackagesBytes - totalLimitBytes)}`);

if (totalBytes > hardLimitBytes) errors.push(`主包超出微信 2 MiB 硬上限 ${format(totalBytes - hardLimitBytes)}`);
else if (totalBytes > targetBytes) errors.push(`主包超出项目 1.5 MiB 预算 ${format(totalBytes - targetBytes)}，请将非 Tab 功能和专用资产移入普通分包`);

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
}

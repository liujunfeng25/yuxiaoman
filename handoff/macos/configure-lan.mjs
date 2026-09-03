import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const targetPath = path.join(repositoryRoot, "wechat-miniprogram", "miniprogram", "config", "env.ts");

function isPrivateIpv4(value) {
  return /^10\./u.test(value)
    || /^192\.168\./u.test(value)
    || /^172\.(1[6-9]|2\d|3[01])\./u.test(value);
}

function fromDefaultRoute() {
  if (process.platform !== "darwin") return undefined;
  try {
    const route = execFileSync("route", ["-n", "get", "default"], { encoding: "utf8" });
    const interfaceName = route.match(/^\s*interface:\s*(\S+)/mu)?.[1];
    if (!interfaceName) return undefined;
    return execFileSync("ipconfig", ["getifaddr", interfaceName], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function fromInterfaces() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      candidates.push({ name, address: address.address });
    }
  }
  candidates.sort((left, right) => {
    const leftScore = (left.name === "en0" ? 4 : 0) + (isPrivateIpv4(left.address) ? 2 : 0);
    const rightScore = (right.name === "en0" ? 4 : 0) + (isPrivateIpv4(right.address) ? 2 : 0);
    return rightScore - leftScore;
  });
  return candidates[0]?.address;
}

const requested = process.argv[2]?.trim();
const address = requested || fromDefaultRoute() || fromInterfaces();
if (!address || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address)) {
  throw new Error("未能识别局域网 IPv4；请运行：node handoff/macos/configure-lan.mjs 192.168.x.x");
}

const octets = address.split(".").map(Number);
if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
  throw new Error(`无效 IPv4：${address}`);
}

const source = readFileSync(targetPath, "utf8");
const updated = source.replace(
  /const DEVICE_LAN_HOST = "[^"]*";/u,
  `const DEVICE_LAN_HOST = "${address}";`,
);
if (updated === source && !source.includes(`const DEVICE_LAN_HOST = "${address}";`)) {
  throw new Error("未找到 DEVICE_LAN_HOST 配置项");
}
writeFileSync(targetPath, updated, "utf8");
console.log(`小程序真机 API 地址已切换到 ${address}:8792`);

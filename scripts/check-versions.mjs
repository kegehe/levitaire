#!/usr/bin/env node
// 校验发版三处版本号一致。CI 与本地发版前都可直接运行：
//   npm run check:versions
//
// 为什么需要它：版本号分散在 package.json / tauri.conf.json / Cargo.toml，
// 只改其中一处时构建不会报错，但安装包文件名、升级清单与程序自身版本会各说各话。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), "utf8"));

// 只从 [package] 段取版本：Cargo.toml 后面还有 [dependencies.windows] 的 version 行。
function cargoPackageVersion() {
  const text = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  const start = text.indexOf("[package]");
  if (start < 0) throw new Error("Cargo.toml 缺少 [package] 段");
  const next = text.indexOf("\n[", start + "[package]".length);
  const section = text.slice(start, next < 0 ? text.length : next + 1);
  return section.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

const pkg = readJson("package.json").version;
const tauri = readJson("src-tauri/tauri.conf.json").version;
const cargo = cargoPackageVersion();

if (!pkg || !tauri || !cargo || pkg !== tauri || pkg !== cargo) {
  console.error(
    `版本号不一致：package.json=${pkg ?? "?"} tauri.conf.json=${tauri ?? "?"} Cargo.toml=${cargo ?? "?"}`,
  );
  process.exit(1);
}

console.log(`版本号一致：${pkg}`);

#!/usr/bin/env node
// Levitaire 桌面端发版脚本 —— 把"升版本号 + 打包 + 签名 + 生成 latest.json"封装成一条命令。
//
// 只在你【明确要发版】时手动跑；日常 commit 完全不碰它，不影响正常开发。
//
// 用法（在仓库根目录）：
//   npm run release 0.1.1 "修复了…\n新增了…"
//   npm run release:bump 0.1.1      # 只同步三处版本号，不打包不签名
//   node scripts/release.mjs 0.1.1 --no-build   # 不重新出包，签现有安装包（需已 build）
//
// 环境变量：
//   LEVITAIRE_PRIVKEY     私钥文件路径（默认 ~/.tauri/levitaire.key）
//   LEVITAIRE_PASSFILE    私钥口令文件（默认 ~/.tauri/levitaire-key-password.txt）
//   两者都会自动回落到默认位，通常无需设置。
//
// 流程与 Milevia 一致：本地出包 + 签名 + 生成 latest.json，不自动 push / upload。
// 之后手动确认：
//   git tag v<ver> && git push origin v<ver>
//   gh release create v<ver> "<setup.exe>" "release/latest.json" --notes "<说明>"
//   把 root latest.json 同步到 GitHub Pages 根目录（endpoints 指向处）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();

const args = process.argv.slice(2);
const bumpOnly = args.includes("--bump-only");
const noBuild = args.includes("--no-build");
const positional = args.filter((a) => !a.startsWith("--"));

if (positional.length < 1) {
  const msg =
    "缺少版本号参数。\n示例:\n  npm run release 0.1.1 \"修复了XX\"\n  npm run release:bump 0.2.0";
  throw new Error(msg);
}

const nextVersion = positional[0];
const notes = positional.slice(1).join(" ") || "Levitaire 新版本";

if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  throw new Error(`版本号必须形如 0.1.1（MAJOR.MINOR.PATCH），收到：${nextVersion}`);
}

/* ── 三处需要同步的版本文件 ─────────────────────────────── */
const tauriConf = join(repoRoot, "src-tauri/tauri.conf.json");
const cargoToml = join(repoRoot, "src-tauri/Cargo.toml");
const rootPkg = join(repoRoot, "package.json");

function safeTauriCli() {
  // 定位仓库顶层已安装的 @tauri-apps/cli JS 入口（npm 单仓）
  const top = join(repoRoot, "node_modules/@tauri-apps/cli/tauri.js");
  if (existsSync(top)) return top;
  throw new Error("找不到 tauri CLI 入口，请确认已 npm install @tauri-apps/cli。");
}

function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function writeJson(file, obj) { writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8"); }

function readCargoVersion(file) {
  const match = readFileSync(file, "utf8").match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

/* ── 1. 校验当前三处版本一致，然后一起升到新版本 ─────────── */
const current = {
  tauriConf: readJson(tauriConf).version,
  cargo: readCargoVersion(cargoToml),
  rootPkg: readJson(rootPkg).version,
};

const uniq = new Set(Object.values(current));
if (uniq.size > 1) {
  const listing = Object.entries(current).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  throw new Error(`三处版本号当前不一致，先手动统一再发版：\n${listing}`);
}

console.log(`当前版本 ${current.tauriConf} → 新版本 ${nextVersion}`);

const tauri = readJson(tauriConf);
tauri.version = nextVersion;
writeJson(tauriConf, tauri);

const cargo = readFileSync(cargoToml, "utf8")
  .replace(/^(version\s*=\s*")[^"]+(")/m, `$1${nextVersion}$2`);
writeFileSync(cargoToml, cargo, "utf8");

const pkg = readJson(rootPkg);
pkg.version = nextVersion;
writeJson(rootPkg, pkg);

console.log(`已同步三处版本号：tauri.conf.json / Cargo.toml / package.json → ${nextVersion}`);

if (bumpOnly) {
  console.log("bump-only：仅升级版本号，未打包、未签名。");
  process.exit(0);
}

/* ── 2. 打包（复用现有 build：frontend + resources + tauri build --bundles nsis）── */
if (!noBuild) {
  console.log("开始打包（npm run tauri build -- --bundles nsis）…");
  execFileSync("npm", ["run", "tauri", "build", "--", "--bundles", "nsis"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

/* ── 3. 定位 NSIS 安装包并签名 ─────────────────────────── */
const productName = readJson(tauriConf).productName ?? "Levitaire";
const installerName = `${productName}_${nextVersion}_x64-setup.exe`;
const installer = join(
  repoRoot,
  "src-tauri/target/release/bundle/nsis",
  installerName,
);
if (!existsSync(installer)) {
  throw new Error(`未找到安装包：${installer}\n请确认已执行 build（或去掉 --no-build）。`);
}
console.log(`安装包：${installer}`);

const privkey = process.env.LEVITAIRE_PRIVKEY || join(HOME, ".tauri", "levitaire.key");
const passfile =
  process.env.LEVITAIRE_PASSFILE || join(HOME, ".tauri", "levitaire-key-password.txt");
if (!existsSync(privkey)) throw new Error(`找不到私钥：${privkey}`);
if (!existsSync(passfile)) throw new Error(`找不到口令文件：${passfile}`);

const releaseDir = join(repoRoot, "release");
mkdirSync(releaseDir, { recursive: true });

// 签名：位置参数 <FILE>；私钥路径与口令走环境变量（不进命令行，避免出现在进程/日志里）。
execFileSync("node", [safeTauriCli(), "signer", "sign", installer], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY_PATH: privkey,
    // 口令文件若带 UTF-8 BOM（PowerShell Set-Content 默认会加），剥离后再用，
    // 否则 BOM 字符会混进口令导致 "wrong password"。显式用 ﻿ 匹配 BOM。
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: readFileSync(passfile, "utf8")
      .replace(/﻿/, "")
      .trim(),
  },
});
const signature = readFileSync(`${installer}.sig`, "utf8").trim();

/* ── 4. 生成 latest.json ───────────────────────────────── */
// latest.json 的 url 指向 GitHub Releases 下载地址。仓库信息已在 git remote 中，
// 也可用 LEVITAIRE_DOWNLOAD_BASE 覆盖（例如日后换 Cloudflare R2）。
const gh = readRemote();
const downloadBase =
  process.env.LEVITAIRE_DOWNLOAD_BASE ||
  `https://github.com/${gh.owner}/${gh.repo}/releases/download/v${nextVersion}`;

const manifest = {
  version: nextVersion,
  notes,
  pub_date: new Date().toISOString(), // ISO 8601 UTC
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${downloadBase}/${installerName}`,
    },
  },
};

const manifestText = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(join(repoRoot, "release", "latest.json"), manifestText, "utf8");
writeFileSync(join(repoRoot, "latest.json"), manifestText, "utf8");
console.log(`已生成升级清单：${join(repoRoot, "release", "latest.json")}`);
console.log(`\n清单内容：\n${JSON.stringify(manifest, null, 2)}`);

/* ── 5. 打印后续动作（不自动 push / upload）────────────── */
console.log("\n发布动作已完成（未上传）。下一步（在确认后手动执行）:");
console.log(`  git tag v${nextVersion}`);
console.log(`  git push origin v${nextVersion}`);
console.log(
  `  gh release create v${nextVersion} "${installer}" "release/latest.json" --notes "${notes.replace(/\\n/g, "\n")}"`,
);
console.log("\n然后把仓库根的 latest.json 提交并推到 main，GitHub Pages 会自动更新（当前 endpoints 指向 kegehe.github.io/levitaire/latest.json）。");

/** 解析 git remote origin 得到 owner/repo，用于拼 release 下载地址。 */
function readRemote() {
  if (process.env.LEVITAIRE_DOWNLOAD_BASE) return { owner: "<owner>", repo: "<repo>" };
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const m = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/);
    if (!m) throw new Error("无法从 git remote 解析 owner/repo");
    return { owner: m[1], repo: m[2] };
  } catch {
    console.warn("〔警告〕无法解析 GitHub remote，latest.json 的 url 用了占位 <owner>/<repo>。用 LEVITAIRE_DOWNLOAD_BASE 指定下载基地址。");
    return { owner: "<owner>", repo: "<repo>" };
  }
}

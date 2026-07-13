import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import manifest from "../manifest.json" with { type: "json" };

const root = process.cwd();
const distDir = path.join(root, "dist");
const packageName = `etsy-growth-agent-${manifest.version}.zip`;
const outputPath = path.join(distDir, packageName);

const include = [
  "_locales",
  "icons",
  "libs",
  "modules",
  "skills",
  "background.js",
  "content.js",
  "dashboard.css",
  "dashboard.html",
  "dashboard.js",
  "manifest.json",
  "print.html",
  "print.js",
  "sidepanel.css",
  "sidepanel.html",
  "sidepanel.js",
  "PrivacyPolicy.md",
  "README.md",
  "LICENSE",
];

await mkdir(distDir, { recursive: true });
if (existsSync(outputPath)) await rm(outputPath);

const result = spawnSync("zip", ["-r", outputPath, ...include], {
  cwd: root,
  stdio: "inherit",
});

if (result.status !== 0) {
  throw new Error("Failed to package Chrome extension. Please ensure the zip command is available.");
}

console.log(`Packaged ${outputPath}`);

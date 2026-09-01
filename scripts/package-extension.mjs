import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import manifest from "../manifest.json" with { type: "json" };

const root = process.cwd();
const distDir = path.join(root, "dist");
const packageName = `etsy-growth-agent-${manifest.version}.zip`;
const outputPath = path.join(distDir, packageName);
const releaseManifestPath = path.join(distDir, "release-manifest.json");
const excludedLegacyFiles = ["skills/etsy_sourcing_finder.skill.md"];

const include = [
  "_locales", "icons", "libs", "modules", "skills", "background.js", "content.js",
  "dashboard.css", "dashboard.html", "dashboard.js", "dashboardAds.js", "manifest.json", "print.html", "print.js",
  "sidepanel.css", "sidepanel.html", "sidepanel.js", "PrivacyPolicy.md", "DATA_GOVERNANCE.md", "README.md", "LICENSE",
];

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sourceRevision = git("rev-parse", "HEAD");
const sourceDirty = Boolean(git("status", "--porcelain"));
if (!process.argv.includes("--allow-dirty") && sourceDirty) {
  throw new Error("Refusing to package a dirty checkout. Commit the release source or pass --allow-dirty for a development-only artifact.");
}

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

await mkdir(distDir, { recursive: true });
if (existsSync(outputPath)) await rm(outputPath);
if (existsSync(releaseManifestPath)) await rm(releaseManifestPath);

const stageRoot = await mkdtemp(path.join(os.tmpdir(), "etsy-growth-agent-package-"));
try {
  for (const entry of include) await cp(path.join(root, entry), path.join(stageRoot, entry), { recursive: true });
  for (const excluded of excludedLegacyFiles) await rm(path.join(stageRoot, excluded), { force: true });

  const files = await collectFiles(stageRoot);
  const fixedTime = new Date("2000-01-01T00:00:00.000Z");
  for (const file of files) await utimes(path.join(stageRoot, file), fixedTime, fixedTime);

  const result = spawnSync("zip", ["-X", "-q", outputPath, ...files], { cwd: stageRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Failed to package Chrome extension. Please ensure the zip command is available.");
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}

const artifactSha256 = await sha256(outputPath);
const manifestSha256 = await sha256(path.join(root, "manifest.json"));
const repository = process.env.GITHUB_REPOSITORY || "ninemouth/etsy-growth-agent";
const releaseManifest = {
  schema_version: "etsy-growth-agent-release.v2",
  latest_version: manifest.version,
  source_revision: sourceRevision,
  source_dirty: sourceDirty,
  artifact: packageName,
  artifact_sha256: artifactSha256,
  extension_manifest_sha256: manifestSha256,
  release_url: `https://github.com/${repository}/releases/tag/v${manifest.version}`,
  download_url: `https://github.com/${repository}/releases/download/v${manifest.version}/${packageName}`,
  minimum_chrome_version: manifest.minimum_chrome_version,
  changelog: "See GitHub release notes.",
};
await writeFile(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ok: true, outputPath, releaseManifestPath, sourceRevision, sourceDirty, artifactSha256 }, null, 2));

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import manifest from "../manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { extensionIdFromManifestKey, isReleaseRuntimePath, validateAcceptanceRecord } from "./lib/release-readiness.mjs";

const root = new URL("..", import.meta.url);
const errors = [];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

if (process.versions.node.split(".")[0] !== "22") errors.push(`release requires Node 22; found ${process.versions.node}`);
if (pkg.version !== manifest.version) errors.push("package.json and manifest.json versions differ");
if (manifest.permissions.includes("debugger")) errors.push("manifest must not request debugger permission");
if (manifest.host_permissions.includes("<all_urls>")) errors.push("manifest must not request blanket install-time host access");
if (Number.parseInt(manifest.minimum_chrome_version || "0", 10) < 114) errors.push("manifest minimum_chrome_version must be at least 114 for the Side Panel API");
if ((manifest.web_accessible_resources || []).length) errors.push("release must not expose internal files as web-accessible resources");

let stableExtensionId = "";
try {
  stableExtensionId = extensionIdFromManifestKey(manifest.key);
} catch (error) {
  errors.push(`production readiness requires a valid organization-owned manifest public key: ${error.message}`);
}

let head = "";
try {
  head = git("rev-parse", "HEAD");
  if (git("status", "--porcelain")) errors.push("release checkout must be clean");
} catch (error) {
  errors.push(`unable to read Git release state: ${error.message}`);
}

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "";
if (tag && tag !== `v${manifest.version}`) errors.push(`release tag ${tag} must equal v${manifest.version}`);

let acceptance = {};
try {
  acceptance = JSON.parse(fs.readFileSync(new URL("../operations/acceptance/real_browser_acceptance_matrix.json", import.meta.url), "utf8"));
  errors.push(...validateAcceptanceRecord(acceptance, { manifestVersion: manifest.version, expectedRuntimeExtensionId: stableExtensionId }));
} catch (error) {
  errors.push(`unable to read acceptance record: ${error.message}`);
}

const testedCommit = String(acceptance?.tested?.sourceCommit || "");
if (/^[0-9a-f]{40}$/i.test(testedCommit) && head) {
  try {
    git("merge-base", "--is-ancestor", testedCommit, head);
    const postTestFiles = git("diff", "--name-only", `${testedCommit}..${head}`).split("\n").filter(Boolean);
    const runtimeChanges = postTestFiles.filter(isReleaseRuntimePath);
    if (runtimeChanges.length) errors.push(`runtime changed after tested commit: ${runtimeChanges.join(", ")}`);
  } catch (_) {
    errors.push("acceptance tested.sourceCommit must be an ancestor of the release commit");
  }
}

const result = { ok: errors.length === 0, version: manifest.version, stableExtensionId, head, testedCommit, acceptanceStatus: acceptance?.status || "missing", errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;

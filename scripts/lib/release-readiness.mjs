import crypto from "node:crypto";

const REQUIRED_ACCEPTANCE_IDS = ["RB-01", "RB-02", "RB-03", "RB-04", "RB-05", "RB-06", "RB-07"];

export function extensionIdFromManifestKey(manifestKey = "") {
  const normalized = String(manifestKey || "").replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error("manifest key must be non-empty base64 SPKI data");
  const publicKey = Buffer.from(normalized, "base64");
  crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });
  const digest = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32);
  return [...digest].map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
}

export function validateAcceptanceRecord(record = {}, { manifestVersion = "", expectedRuntimeExtensionId = "" } = {}) {
  const errors = [];
  if (record.schemaVersion !== "real-browser-acceptance.v2") {
    errors.push("acceptance schemaVersion must be real-browser-acceptance.v2");
  }
  if (record.status !== "passed") errors.push("real-browser acceptance status must be passed");

  const tested = record.tested || {};
  if (tested.extensionVersion !== manifestVersion) errors.push(`acceptance extensionVersion must equal ${manifestVersion}`);
  if (!/^[0-9a-f]{40}$/i.test(String(tested.sourceCommit || ""))) errors.push("acceptance tested.sourceCommit must be a full Git commit SHA");
  if (!String(tested.chromeVersion || "").trim()) errors.push("acceptance tested.chromeVersion is required");
  if (tested.platform !== "adspower_etsy") errors.push("acceptance tested.platform must be adspower_etsy");
  if (!String(tested.osPlatform || "").trim()) errors.push("acceptance tested.osPlatform is required");
  if (!String(tested.browserProfileId || "").trim()) errors.push("acceptance tested.browserProfileId is required");
  if (!/^[a-p]{32}$/.test(String(tested.runtimeExtensionId || ""))) errors.push("acceptance tested.runtimeExtensionId must be a valid Chrome Extension ID");
  if (expectedRuntimeExtensionId && tested.runtimeExtensionId !== expectedRuntimeExtensionId) errors.push(`acceptance tested.runtimeExtensionId must equal stable manifest ID ${expectedRuntimeExtensionId}`);
  if (tested.installMode !== "unpacked") errors.push("acceptance tested.installMode must be unpacked for the internal distribution policy");
  if (tested.deviceClientType !== "etsy_adspower") errors.push("acceptance tested.deviceClientType must be etsy_adspower");
  if (tested.deviceClientId !== "etsy-growth-agent") errors.push("acceptance tested.deviceClientId must be etsy-growth-agent");
  if (tested.controlCenterInstallationState !== "current") errors.push("acceptance tested.controlCenterInstallationState must be current");
  if (!String(tested.operator || "").trim()) errors.push("acceptance tested.operator is required");
  if (!Number.isFinite(Date.parse(String(tested.executedAt || "")))) errors.push("acceptance tested.executedAt must be an ISO timestamp");

  const matrix = Array.isArray(record.matrix) ? record.matrix : [];
  const ids = matrix.map((item) => item?.id);
  if (JSON.stringify(ids) !== JSON.stringify(REQUIRED_ACCEPTANCE_IDS)) {
    errors.push(`acceptance matrix must contain exactly ${REQUIRED_ACCEPTANCE_IDS.join(", ")} in order`);
  }
  for (const item of matrix) {
    if (item?.result !== "passed") errors.push(`${item?.id || "unknown"} result must be passed`);
    if (String(item?.blocker || "").trim()) errors.push(`${item?.id || "unknown"} blocker must be empty when passed`);
    const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
    if (!evidence.length) errors.push(`${item?.id || "unknown"} must include at least one evidence reference`);
    for (const [index, entry] of evidence.entries()) {
      if (!String(entry?.kind || "").trim() || !String(entry?.ref || "").trim()) {
        errors.push(`${item?.id || "unknown"} evidence[${index}] requires kind and ref`);
      }
    }
  }
  return errors;
}

export const RELEASE_RUNTIME_PATHS = [
  "_locales/", "icons/", "libs/", "modules/", "skills/",
  "background.js", "content.js", "dashboard.css", "dashboard.html", "dashboard.js", "dashboardAds.js",
  "manifest.json", "print.html", "print.js", "sidepanel.css", "sidepanel.html", "sidepanel.js",
  "package.json", "package-lock.json", "scripts/", ".github/workflows/",
];

export function isReleaseRuntimePath(file = "") {
  return RELEASE_RUNTIME_PATHS.some((prefix) => prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix);
}

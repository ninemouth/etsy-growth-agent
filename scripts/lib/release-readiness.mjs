const REQUIRED_ACCEPTANCE_IDS = ["RB-01", "RB-02", "RB-03", "RB-04", "RB-05", "RB-06", "RB-07"];

export function validateAcceptanceRecord(record = {}, { manifestVersion = "" } = {}) {
  const errors = [];
  if (record.schemaVersion !== "real-browser-acceptance.v2") {
    errors.push("acceptance schemaVersion must be real-browser-acceptance.v2");
  }
  if (record.status !== "passed") errors.push("real-browser acceptance status must be passed");

  const tested = record.tested || {};
  if (tested.extensionVersion !== manifestVersion) errors.push(`acceptance extensionVersion must equal ${manifestVersion}`);
  if (!/^[0-9a-f]{40}$/i.test(String(tested.sourceCommit || ""))) errors.push("acceptance tested.sourceCommit must be a full Git commit SHA");
  if (!String(tested.chromeVersion || "").trim()) errors.push("acceptance tested.chromeVersion is required");
  if (!String(tested.platform || "").trim()) errors.push("acceptance tested.platform is required");
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
  "background.js", "content.js", "dashboard.css", "dashboard.html", "dashboard.js",
  "manifest.json", "print.html", "print.js", "sidepanel.css", "sidepanel.html", "sidepanel.js",
  "package.json", "package-lock.json", "scripts/", ".github/workflows/",
];

export function isReleaseRuntimePath(file = "") {
  return RELEASE_RUNTIME_PATHS.some((prefix) => prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix);
}

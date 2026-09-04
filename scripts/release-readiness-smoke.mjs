import assert from "node:assert/strict";
import manifest from "../manifest.json" with { type: "json" };
import { extensionIdFromManifestKey, isReleaseRuntimePath, validateAcceptanceRecord } from "./lib/release-readiness.mjs";

const stableExtensionId = extensionIdFromManifestKey(manifest.key);
assert.equal(stableExtensionId, "mbejkffcjhcaonfhoniagegpmgemcadj");

const valid = {
  schemaVersion: "real-browser-acceptance.v2",
  status: "passed",
  tested: {
    extensionVersion: "1.2.0",
    sourceCommit: "a".repeat(40),
    chromeVersion: "140.0.0.0",
    platform: "adspower_etsy",
    osPlatform: "macOS",
    browserProfileId: "etsy-profile-test",
    runtimeExtensionId: stableExtensionId,
    installMode: "unpacked",
    deviceClientType: "etsy_adspower",
    deviceClientId: "etsy-growth-agent",
    controlCenterInstallationState: "current",
    operator: "release-tester",
    executedAt: "2026-08-22T00:00:00.000Z",
  },
  matrix: ["RB-01", "RB-02", "RB-03", "RB-04", "RB-05", "RB-06", "RB-07"].map((id) => ({
    id, result: "passed", blocker: "", evidence: [{ kind: "evidence_bundle", ref: `artifact://${id}` }],
  })),
};

assert.deepEqual(validateAcceptanceRecord(valid, { manifestVersion: "1.2.0", expectedRuntimeExtensionId: stableExtensionId }), []);
assert.ok(validateAcceptanceRecord({ ...valid, status: "not_run" }, { manifestVersion: "1.2.0" }).length > 0);
assert.ok(validateAcceptanceRecord({ ...valid, tested: { ...valid.tested, sourceCommit: "short" } }, { manifestVersion: "1.2.0" }).length > 0);
assert.ok(validateAcceptanceRecord({ ...valid, tested: { ...valid.tested, installMode: "web_store" } }, { manifestVersion: "1.2.0" }).length > 0);
assert.ok(validateAcceptanceRecord({ ...valid, tested: { ...valid.tested, browserProfileId: "" } }, { manifestVersion: "1.2.0" }).length > 0);
assert.ok(validateAcceptanceRecord({ ...valid, tested: { ...valid.tested, controlCenterInstallationState: "not_reported" } }, { manifestVersion: "1.2.0" }).length > 0);
assert.ok(validateAcceptanceRecord({ ...valid, tested: { ...valid.tested, runtimeExtensionId: "abcdefghijklmnopabcdefghijklmnop" } }, { manifestVersion: "1.2.0", expectedRuntimeExtensionId: stableExtensionId }).length > 0);
assert.ok(validateAcceptanceRecord({ ...valid, matrix: valid.matrix.map((item, index) => index === 0 ? { ...item, evidence: [] } : item) }, { manifestVersion: "1.2.0" }).length > 0);
assert.equal(isReleaseRuntimePath("modules/toolRegistry.js"), false);
assert.equal(isReleaseRuntimePath("modules/controlCenterAuth.js"), true);
assert.equal(isReleaseRuntimePath("edge-background.js"), true);
assert.equal(isReleaseRuntimePath("operations/acceptance/evidence.json"), false);

console.log("release-readiness-smoke: ok");

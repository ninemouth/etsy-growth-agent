import assert from "node:assert/strict";
import { isReleaseRuntimePath, validateAcceptanceRecord } from "./lib/release-readiness.mjs";

const valid = {
  schemaVersion: "real-browser-acceptance.v2",
  status: "passed",
  tested: {
    extensionVersion: "1.2.0",
    sourceCommit: "a".repeat(40),
    chromeVersion: "140.0.0.0",
    platform: "macOS",
    operator: "release-tester",
    executedAt: "2026-08-22T00:00:00.000Z",
  },
  matrix: ["RB-01", "RB-02", "RB-03", "RB-04", "RB-05", "RB-06"].map((id) => ({
    id, result: "passed", blocker: "", evidence: [{ kind: "evidence_bundle", ref: `artifact://${id}` }],
  })),
};

assert.deepEqual(validateAcceptanceRecord(valid, { manifestVersion: "1.2.0" }), []);
assert.ok(validateAcceptanceRecord({ ...valid, status: "not_run" }, { manifestVersion: "1.2.0" }).length > 0);
assert.ok(validateAcceptanceRecord({ ...valid, tested: { ...valid.tested, sourceCommit: "short" } }, { manifestVersion: "1.2.0" }).length > 0);
assert.ok(validateAcceptanceRecord({ ...valid, matrix: valid.matrix.map((item, index) => index === 0 ? { ...item, evidence: [] } : item) }, { manifestVersion: "1.2.0" }).length > 0);
assert.equal(isReleaseRuntimePath("modules/toolRegistry.js"), true);
assert.equal(isReleaseRuntimePath("operations/acceptance/evidence.json"), false);

console.log("release-readiness-smoke: ok");

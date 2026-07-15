import assert from "node:assert/strict";
import {
  __testInternals,
  appendTaskLog,
  clearTaskLogs,
  listTaskLogs,
  pruneTaskLogs,
  sanitizeTaskLogValue,
} from "../modules/taskLogStore.js";

__testInternals.memoryFallback.clear();

const workflowId = `task-log-smoke-${Date.now()}`;
const otherWorkflowId = `${workflowId}-other`;

await appendTaskLog({
  workflowId,
  sessionId: "session-a",
  skillId: "skills/etsy_platform_trends.skill.md",
  severity: "info",
  category: "tool",
  event: "google_trends_evidence_ready",
  message: "Google Trends evidence captured.",
  context: {
    token: "secret-token",
    authorization: "Bearer sk-test1234567890",
    screenshotRef: "artifact://search-evidence-screenshot/123",
    visibleText: "interest over time related queries",
  },
});

await appendTaskLog({
  workflowId: otherWorkflowId,
  sessionId: "session-b",
  skillId: "scheduled_monitor",
  severity: "warn",
  category: "monitor",
  event: "monitor_page_read_failed",
  message: "Monitor read failed.",
  context: { targetUrl: "https://www.etsy.com/shop/example" },
});

const workflowLogs = await listTaskLogs({ workflowId, limit: 10 });
assert.equal(workflowLogs.length, 1, "workflow filter should isolate task logs");
assert.equal(workflowLogs[0].context.token, "[redacted]", "token fields must be redacted");
assert.equal(workflowLogs[0].context.authorization, "[redacted]", "authorization fields must be redacted");
assert.equal(workflowLogs[0].context.screenshotRef, "[redacted]", "screenshot references must be redacted from durable logs");
assert.equal(workflowLogs[0].context.visibleText, "interest over time related queries");

const directSanitized = sanitizeTaskLogValue({
  nested: {
    apiKey: "abc123",
    text: "ok",
  },
  dataUrl: "data:image/png;base64,AAAA",
});
assert.equal(directSanitized.nested.apiKey, "[redacted]");
assert.equal(directSanitized.dataUrl, "[redacted]");
assert.equal(directSanitized.nested.text, "ok");

for (let i = 0; i < 5; i++) {
  await appendTaskLog({
    workflowId,
    event: `extra_${i}`,
    message: `extra log ${i}`,
  });
}

const pruneResult = await pruneTaskLogs({
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 100,
  maxEntriesPerWorkflow: 3,
});
assert.equal(pruneResult.ok, true, "prune should succeed in memory fallback mode");
assert.ok(pruneResult.deleted >= 3, "per-workflow retention should prune old entries");

const retainedWorkflowLogs = await listTaskLogs({ workflowId, limit: 20 });
assert.ok(retainedWorkflowLogs.length <= 3, "per-workflow retention must be enforced");
assert.ok((await listTaskLogs({ workflowId: otherWorkflowId, limit: 20 })).length <= 1, "unrelated workflow should be retained independently");

const clearResult = await clearTaskLogs();
assert.equal(clearResult.cleared, true, "task log clear should report cleared state");
assert.equal((await listTaskLogs({ limit: 20 })).length, 0, "task log clear should remove all logs");

__testInternals.memoryFallback.clear();
console.log("task log store smoke passed");

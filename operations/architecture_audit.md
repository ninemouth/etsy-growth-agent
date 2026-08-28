# Etsy Growth Agent Architecture Audit

Updated: 2026-08-25

This audit is the current engineering baseline for the Etsy extension runtime. The goal is not only to keep the plugin usable, but to make each growth workflow observable, evidence-backed, and commercially useful for Etsy sellers.

## Executive Findings

- Task execution needed durable observability. Workflow progress appeared in the side panel, but historical debugging depended on transient UI logs. The runtime now writes privacy-safe task logs to IndexedDB with memory fallback, query/export message endpoints, and periodic retention cleanup.
- Unimplemented paid market-data surfaces were removed instead of being presented as integrations. The old Helium 10/SellerSprite key fields and `query_market_data` tool are absent; the hard-coded FastMoss responses and key field were also removed, so runtime reports cannot mistake fabricated metrics for provider acceptance.
- Scheduled monitor alarms were not captured in the same task trail as conversation workflows. Monitor start, read failure, completion, and errors are now written to task logs.
- Foreground workflows now use a global scheduler slot. Side panel and page-overlay entrypoints can no longer independently start competing browser-automation runs without the background runtime accepting the workflow first.
- Tool execution now writes a structured workflow ledger. Each tool run records planned, started, timeout, finished, and validation events with a stable `toolRunId` and compact evidence quality metadata.
- Chrome extension browser automation is intentionally built on Chrome APIs instead of Playwright/Puppeteer. For an installed MV3 extension this is the correct runtime boundary; external browser-control libraries do not have access to the user's logged-in Chrome extension context.
- Evidence collection remains the highest-risk area. Google Trends, Etsy Search, and competitor tabs depend on live page state, login/consent prompts, anti-bot behavior, and content-script readiness. The existing `wait/read/stable evidence` strategy is directionally correct and should keep moving toward reusable page readiness primitives.
- Etsy viewport capture now uses a default privacy mask: sensitive routes fail closed, detected PII/private elements are hidden, two animation frames are awaited, and the mask is restored after capture. Provider contractual governance and real-page selector coverage remain external acceptance items.
- The governed Etsy draft path now uses a deterministic DOM writer over exact approved `etsy-listing-draft.v1` data. It preflights required fields before mutation, verifies each value, rolls back touched fields on mismatch, treats tokenized tags/images as manual, and has no Save/Publish/Submit/file-upload action surface.
- The legacy `etsy_sourcing_finder` Skill file and supplier execution surface have been physically removed. Runtime intent is handed to `cross-border-sourcing-orchestrator`; direct legacy file loads are denied; 1688/Taobao search engines and direct navigation fail closed; content-script upload/image-search handlers and the historical “save supplier” write control are absent. Historical reports remain read-only.
- Draft-write selector and screenshot-mask policy versions are now emitted into a bounded `etsy_dom_telemetry` task-log category. Telemetry records route classes, status counts, mask counts, and error codes only; it does not persist page URLs, listing/operation identifiers, selectors, approved text, screenshots, or credentials.
- The global “disable negative filters” switch was removed. Risk filtering is always injected by the background/runtime, while a user may still request a narrowly explained exception that remains visibly risk-qualified.

## Durable Task Logs

Task logs are stored in `indexedDB` under `etsyGrowthAgentTaskLogs`. This keeps high-volume execution telemetry away from `chrome.storage.local`, which is already used for settings, checkpoints, update state, and local saved outputs.

Log record contract:

- `workflowId`: checkpoint/runtime identifier or monitor identifier.
- `sessionId`: conversation/growth case when available.
- `skillId`: skill or system task owner.
- `severity`: `debug`, `info`, `warn`, or `error`.
- `category`: `workflow`, `tool`, `llm`, `checkpoint`, `monitor`, `maintenance`, or the bounded `etsy_dom_telemetry` category.
- `event`: stable event name.
- `message`: short human-readable summary.
- `context`: sanitized structured metadata.

Privacy guardrails:

- API keys, OAuth tokens, passwords, authorization headers, cookies, credentials, screenshots, and data URLs are redacted before persistence.
- Long strings, arrays, and nested objects are bounded.
- Screenshots remain in the artifact store; logs should contain only references or quality metadata, and sensitive reference-like keys are redacted.

Retention policy:

- Maximum age: 14 days.
- Maximum total entries: 15,000.
- Maximum entries per workflow: 1,200.
- Cleanup runs on startup/install and every 6 hours through `chrome.alarms`.

## Workflow Execution Architecture

The extension uses a global foreground workflow scheduler in `modules/workflowScheduler.js`. Every side panel or page-overlay workflow must acquire the scheduler slot before it can enter the AI/tool loop. This prevents different UI entrypoints from silently starting parallel browser-automation runs that compete for tabs, LLM calls, and checkpoints.

Scheduler contract:

- One active foreground workflow slot per browser profile.
- Active slots carry owner, workflow id, skill id, growth action, source tab, page URL, status, and expiry.
- The background harness renews the scheduler slot while a workflow is running and releases it on completion, failure, interruption, port disconnect, or cleanup.
- UI surfaces can query `GET_WORKFLOW_RUNTIME_STATUS` to display the real background runtime state instead of relying only on local button state.

Tool execution writes a structured workflow execution ledger through `appendWorkflowEvent`. Every tool run records planned, started, timeout, finished, and platform-trend validation events with `toolRunId`, action kind, action label, tab lifecycle, evidence quality, page health, screenshot status, and closed-tab ids where applicable.

Tool execution context:

- `agentLoop` injects `__workflowContext` into every tool call.
- The context includes workflow id, generation, source tab id, tool run id, step, action kind, action label, and start time.
- `toolRegistry` can read this context through a shared helper and use it for cancellation-aware polling.
- Runtime-only context is stripped before tool arguments are stored in tool history.

## Third-Party Library Review

Current external dependencies:

- `dompurify`: correct dependency for report HTML sanitization. Keep.
- `jsdom`: used in Node smoke tests for sanitizer verification. Keep as dev dependency.
- `prettier` and `eslint`: correct development tooling. Keep.

Vendored browser libraries:

- `libs/dompurify.min.js`: acceptable for MV3 browser runtime packaging because extension pages cannot import npm packages directly without bundling.
- `libs/marked.min.js`: acceptable for now, but the npm dependency is not declared. Future packaging should either vendor-lock the file with provenance/version notes or switch to a bundling step that imports `marked` from npm.

Intentional custom code:

- Chrome tab/session ownership, `captureVisibleTab` evidence capture, content-script DOM reads, and MV3 service-worker persistence must remain custom because they are extension-runtime specific. Full-page `chrome.debugger` access was removed: viewport screenshots are labeled as such and combined with DOM evidence instead of requesting debugger-backend access.
- Workflow checkpoints, leases, cancellation, and quality gates are product-specific. A generic job queue would not understand Chrome tab ownership, content-script evidence, or resumable LLM/tool context.
- Evidence validators are business-specific. Replacing them with a generic schema validator would lose the current hard gates around Etsy/Google/Google Trends evidence.

Custom code to keep under review:

- Search result parsing in `agentic_web_search` still uses lightweight HTML matching for Bing fallback. For browser-tab evidence paths this is less important, but if server-side search parsing becomes a core feature, use an official API or a maintained parser.
- PDF/report rendering should continue using the existing sanitized renderer and regression tests. Do not add a separate report renderer without proving it fixes a real layout or encoding issue.
- Page readiness logic should keep moving toward one shared primitive across all newly opened evidence tabs.

## Current Risk Register

1. Google Trends evidence may still fail when the page opens to consent, verification, empty modules, region mismatch, or slow SPA hydration. The correct response is to surface a blocked/insufficient-evidence state and retain the checkpoint, not to generate trend claims.
2. Etsy competitor shop/listing research is limited to public DOM, screenshots, and seller-visible pages. The personal Etsy API boundary does not allow private data from other shops.
3. Long-running workflows can still become expensive if a quality gate repeatedly asks for missing evidence that is structurally impossible in the current browser state. Task logs should now make these loops visible by workflow, tool, and event.
4. The product uses organization-internal unpacked distribution only. Updates require an immutable ZIP/release-manifest SHA verification, replacement at the canonical AdsPower Etsy Profile extension path, manual extension reload, and Etsy page refresh. Runtime update awareness can guide the user, but cannot silently replace unpacked source; path drift or a second loaded copy invalidates runtime-ID acceptance.
5. Chrome extension APIs do not provide true hard-abort semantics for every in-flight tab or content-script operation. The runtime now propagates cancellation into polling tools, marks stale generation results, and reclaims tabs, but some low-level Chrome calls may still finish at a boundary before their result is discarded.
6. The side-panel progress log is not a full observability console. The background message endpoints expose task logs, scheduler state, and execution events for debugging/export, but a richer UI can be added later.
7. Etsy editor selectors and privacy heuristics are tested against local DOM fixtures, not all live Etsy locale/AB variants. RB-07 must prove the exact release in the designated AdsPower Profile and record any selector drift without broadening to generic click/input tools.
8. Selector/policy-version telemetry is locally queryable and exportable through the task-log endpoints, but no SLO threshold or operator alert is yet bound to selector failure rates. This remains a production-observability acceptance item.

## Engineering Rules Going Forward

- Do not introduce mock business metrics in runtime tools. Test fixtures can use mock data, but runtime outputs must clearly distinguish real evidence, unavailable integrations, and assumptions.
- Do not weaken validators to pass reports. Repair evidence ledgers only when real evidence already exists.
- Do not let source tabs be overwritten by research tabs. Evidence tabs should be owned, temporary, readiness-checked, and closed only after text/screenshot evidence is saved.
- Prefer Chrome extension APIs for in-extension browser work. Use third-party libraries for generic concerns such as sanitization, parsing, packaging, and test harnesses when they reduce risk.
- Every new long-running tool should emit stable progress events with action kind, tab lifecycle, evidence quality, and timeout/blocked reason.

## Verification Baseline

Run these before release:

```bash
npm run test:release
npm run release:readiness
npm run package:extension
```

`release:readiness` intentionally remains blocked until the seven-item real-browser matrix, including the governed Etsy draft task/readback path, is recorded as `real-browser-acceptance.v2` with evidence references. A green local test suite proves code contracts; it does not substitute for Etsy/AdsPower/Chrome/Google Trends acceptance. Supplier-platform acceptance belongs to the separate Supplier Runner.

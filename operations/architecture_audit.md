# Etsy Growth Agent Architecture Audit

Updated: 2026-07-15

This audit is the current engineering baseline for the Etsy extension runtime. The goal is not only to keep the plugin usable, but to make each growth workflow observable, evidence-backed, and commercially useful for Etsy sellers.

## Executive Findings

- Task execution needed durable observability. Workflow progress appeared in the side panel, but historical debugging depended on transient UI logs. The runtime now writes privacy-safe task logs to IndexedDB with memory fallback, query/export message endpoints, and periodic retention cleanup.
- The extension had one remaining market-data mock path in `query_market_data`. When a SellerSprite or Helium 10 key existed, the tool returned random metrics. This has been replaced with an explicit `not_implemented` result so fake volume, sales, and competition data cannot enter reports.
- Scheduled monitor alarms were not captured in the same task trail as conversation workflows. Monitor start, read failure, completion, and errors are now written to task logs.
- Chrome extension browser automation is intentionally built on Chrome APIs instead of Playwright/Puppeteer. For an installed MV3 extension this is the correct runtime boundary; external browser-control libraries do not have access to the user's logged-in Chrome extension context.
- Evidence collection remains the highest-risk area. Google Trends, Etsy Search, and competitor tabs depend on live page state, login/consent prompts, anti-bot behavior, and content-script readiness. The existing `wait/read/stable evidence` strategy is directionally correct and should keep moving toward reusable page readiness primitives.

## Durable Task Logs

Task logs are stored in `indexedDB` under `etsyGrowthAgentTaskLogs`. This keeps high-volume execution telemetry away from `chrome.storage.local`, which is already used for settings, checkpoints, update state, and local saved outputs.

Log record contract:

- `workflowId`: checkpoint/runtime identifier or monitor identifier.
- `sessionId`: conversation/growth case when available.
- `skillId`: skill or system task owner.
- `severity`: `debug`, `info`, `warn`, or `error`.
- `category`: `workflow`, `tool`, `llm`, `checkpoint`, `monitor`, or `maintenance`.
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

## Third-Party Library Review

Current external dependencies:

- `dompurify`: correct dependency for report HTML sanitization. Keep.
- `jsdom`: used in Node smoke tests for sanitizer verification. Keep as dev dependency.
- `prettier` and `eslint`: correct development tooling. Keep.

Vendored browser libraries:

- `libs/dompurify.min.js`: acceptable for MV3 browser runtime packaging because extension pages cannot import npm packages directly without bundling.
- `libs/marked.min.js`: acceptable for now, but the npm dependency is not declared. Future packaging should either vendor-lock the file with provenance/version notes or switch to a bundling step that imports `marked` from npm.

Intentional custom code:

- Chrome tab/session ownership, `chrome.debugger` screenshot capture, content-script DOM reads, and MV3 service-worker persistence must remain custom because they are extension-runtime specific.
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
4. Developer Mode updates require manual extension reload and page refresh. Runtime update awareness can guide the user, but cannot silently replace unpacked source.
5. The side-panel progress log is not a full observability console. The background message endpoints expose task logs for debugging/export, but a richer UI can be added later.

## Engineering Rules Going Forward

- Do not introduce mock business metrics in runtime tools. Test fixtures can use mock data, but runtime outputs must clearly distinguish real evidence, unavailable integrations, and assumptions.
- Do not weaken validators to pass reports. Repair evidence ledgers only when real evidence already exists.
- Do not let source tabs be overwritten by research tabs. Evidence tabs should be owned, temporary, readiness-checked, and closed only after text/screenshot evidence is saved.
- Prefer Chrome extension APIs for in-extension browser work. Use third-party libraries for generic concerns such as sanitization, parsing, packaging, and test harnesses when they reduce risk.
- Every new long-running tool should emit stable progress events with action kind, tab lifecycle, evidence quality, and timeout/blocked reason.

## Verification Baseline

Run these before release:

```bash
npm run test:task-logs
npm run test:runtime
npm run test:browser-capabilities
npm run test:evidence-bundle
npm run test:business
npm run test:security
npm run lint
```

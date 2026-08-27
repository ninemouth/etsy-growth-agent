# Etsy Growth Agent

Etsy Growth Agent is a Manifest V3 Chrome extension adapted from a marketplace growth workflow shell and specialized for Etsy seller operations.

It provides an AI-driven browser side panel, page-reading tools, Etsy-focused operations skills, report rendering, local result storage, and a growth dashboard for shop optimization work. Cross-platform 1688/Taobao supplier sourcing is handled by the Marqel Etsy Codex workflow and is not an active skill in this extension.

Repository: https://github.com/ninemouth/etsy-growth-agent

## Core Capabilities

- Etsy shop and listing diagnosis from the current browser page.
- Etsy SEO title, tag, description, and occasion keyword planning.
- Etsy trend and product opportunity exploration for lightweight gifts, personalized products, craft supplies, and cross-border supply-chain advantages.
- Cross-platform supplier sourcing handoff to the Marqel Etsy Codex Orchestrator (the legacy sourcing report reader remains read-only).
- Competitor/review analysis focused on buyer expectations, packaging, delivery promise, personalization quality, and IP/compliance risk.
- Optional Etsy personal-access Open API adapter for active listings and authorized receipts when a Shop ID, API key, OAuth access token, and optional refresh token are configured locally.
- Etsy Campaign Adapter: imports user-triggered visible Etsy Ads / Offsite Ads evidence as non-canonical input for the Control Center and `etsy-campaign-operator`; it does not approve campaigns, change budgets, or publish Outreach handoffs locally.
- Governed Etsy draft executor: fills only deterministic fields from an exact approved `etsy-listing-draft.v1` on an allowlisted Etsy editor route, verifies the DOM write, and leaves tokenized tags, images, Save, and Publish visibly manual.
- Privacy-safe DOM observability: records selector/policy versions, route classes, field-status counts, mask counts, and bounded error codes in local task logs without storing page URLs, business identifiers, approved content, screenshots, or credentials.
- Marqel Control Center V2 session: Agent execution requires an active Marqel session; first use starts an `etsy-growth-agent` device request that a Web member must approve. The extension can use approved organization defaults or local overrides from its extension-origin side panel, and never collects a Marqel password.

## Project Structure

```text
etsy-growth-agent/
├── manifest.json
├── background.js
├── content.js
├── sidepanel.html / sidepanel.css / sidepanel.js
├── dashboard.html / dashboard.css / dashboard.js
├── modules/
│   ├── agentLoop.js
│   ├── etsyApi.js
│   ├── llmClient.js
│   └── toolRegistry.js
├── skills/
│   ├── etsy_crossborder_explorer.skill.md
│   ├── etsy_keyword_analysis.skill.md
│   ├── etsy_product_opportunity_explorer.skill.md
│   ├── etsy_platform_trends.skill.md
│   ├── etsy_event_driven_trend_radar.skill.md
│   ├── etsy_global_shop_optimizer.skill.md
│   ├── etsy_operations_tracker.skill.md
│   ├── etsy_listing_generator.skill.md
│   ├── etsy_review_analyzer.skill.md
│   ├── etsy_compliance_auditor.skill.md
│   └── base_report_auditor.skill.md
└── scripts/
```

## Etsy Adaptation Notes

This project keeps the browser automation, dashboard, workflow canvas, report library, monitoring baseline, and Etsy operations guardrails from the source workflow shell, but changes the platform contract:

- Platform URLs target `etsy.com`.
- Runtime routing uses `etsy_*` skills and tool names.
- The dashboard currency and listing logic are centered on USD-style Etsy economics.
- Compliance guidance focuses on Etsy IP policy, personalization claims, CE/CPC/FDA/category-specific obligations, and gift-market delivery promises.
- Supplier sourcing is a runtime handoff boundary. The old `etsy_sourcing_finder` Skill file has been physically removed; direct legacy loads fail closed and sourcing intent is handed to the cross-border Orchestrator. Historical sourcing report rendering remains read-only for evidence migration.
- Etsy API integration is modeled as a personal-access/local-browser setup, not a multi-tenant SaaS authorization flow. Public listing reads use the configured API key. Private shop data such as receipts/orders requires an OAuth access token; when a refresh token is also saved, the adapter can refresh an expired access token before retrying the request.

## Etsy Personal Access Credentials

The extension stores Etsy credentials only in `chrome.storage.local` for the current browser profile:

- `Shop ID`
- `API Key` in Etsy's `keystring:shared_secret` form
- `OAuth Access Token` for private shop data such as receipts/orders
- Optional `Refresh Token` for renewing an expired access token

This project does not currently implement the full OAuth consent screen or hosted multi-user callback flow. Generate or provide the personal access credentials outside the extension, then save them in the extension side panel. The page overlay never renders or repopulates credential fields. Marqel Control Center LLM/multimodal/image defaults are a separate configuration lane; Etsy credentials remain local and are never returned by the Control Center config endpoint.

## Before You Run

Etsy Growth Agent works by reading the currently open browser page and, for some skills, opening temporary read-only evidence tabs for Etsy Search, Google Search, Google Trends, and public competitor/shop research. It does not execute supplier-platform actions. For reliable runs, prepare the browser session first:

- Initial store positioning and assortment planning do not require an Etsy login. With a category, customer, use-case, store-concept, opportunity-pool, or supplier-capability seed, the Dashboard hands the request to Codex `$cross-border-store-assortment-architect`; only user input and public market evidence may be used, while private-shop metrics remain explicit missing evidence or assumptions. This stage must not dispatch sourcing, create Listings, or write to Etsy.
- Sign in to Etsy in the same Chrome profile before running shop diagnosis, listing work, review analysis, or any workflow that depends on seller-visible pages.
- Open Google Search and Google Trends once in the same Chrome profile, complete any consent, region, language, or verification prompts, then keep the session available for trend and market-research workflows.
- For 1688/Taobao supplier tasks, use Codex `$cross-border-sourcing-orchestrator` and the ordinary Chrome `supplier-sourcing-chrome-runner`; do not use this extension as the supplier-platform runner. Platform login and CAPTCHA prompts remain human-handled.
- The model tool surface is read-only for page evidence. Generic clicks, form input/submission, image upload/search, purchase, publish, account, Ads, and other high-consequence actions are denied centrally and remain human-controlled.
- Supplier URLs, 1688/Taobao search engines, legacy image-search/input handlers, and unimplemented paid market-data credentials/tools are absent from the active runtime. Risk filtering is always enabled; exceptions must be requested and explained one risk at a time.
- For any Agent run, sign in through the Dashboard's `Marqel Access` control first. The internal unpacked extension can be configured locally without an account, but it will fail closed before execution when its dedicated `etsy_adspower` Marqel session is missing or inactive.
- Keep the original Etsy shop or listing page open while the workflow runs. The extension protects and restores the source tab, but external login or verification pages may still require manual attention.
- If a run reports a blocked, login, consent, or verification page, resolve it in Chrome, reload the extension/page if needed, then resume the saved workflow instead of starting from scratch.

Developer Mode users should reload the unpacked extension from `chrome://extensions/` after pulling updates, then refresh the Etsy page so the latest `content.js` is injected.

## Install

1. Run `npm install`.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer Mode.
4. Click "Load unpacked" and select this project directory.
5. Open an Etsy listing, shop, or search page, then launch the extension side panel.

## Distribution Policy

Etsy Growth Agent is an organization-internal unpacked extension. It is not published to the Chrome Web Store and has no Web Store or self-hosted CRX auto-update path. The governed release unit is an immutable ZIP plus release manifest and SHA-256 digest. Operators extract each approved version to the canonical AdsPower Etsy Profile extension path, verify the digest, use Developer Mode `Load unpacked` only for the first install, and use `Reload` plus an Etsy page refresh for later versions. Moving the extracted directory or loading a second copy is prohibited because an unpacked runtime ID may otherwise drift.

Production acceptance still requires an organization-owned manifest public key and protected private release key so the Extension ID remains stable across canonical reinstalls. The private key is never included in the unpacked directory, ZIP, browser profile, repository, logs, or Control Center report.

## Updates

Developer Mode `Load unpacked` installs cannot silently replace their own source files. Etsy Growth Agent can detect a newer governed catalog version and show update guidance, but an operator must obtain the exact approved ZIP, verify its SHA-256/release manifest, replace the canonical extracted directory, click `Reload`, and refresh Etsy tabs. No background process may mutate the unpacked extension directory.

The extension includes update awareness in the side panel settings:

- `Check for updates` may call Chrome's runtime update check, but for unpacked installs the Marqel catalog comparison is authoritative.
- `onUpdateAvailable` remains a compatibility signal only; it is not treated as proof that an unpacked source directory was updated.
- The default version source is the Marqel browser-extension catalog at `/api/browser-extensions/catalog`; it distinguishes current source, minimum supported version, controlled-test artifacts, and production-ready releases.
- Existing installations that still point at the obsolete GitHub `releases/latest` manifest are migrated to the governed catalog. A historical GitHub Release is not treated as the current supported version.

The governed catalog publishes a record with this shape:

```json
{
  "id": "etsy-growth-agent",
  "currentVersion": "1.2.4",
  "minimumSupportedVersion": "1.2.4",
  "minimumChromeVersion": "114",
  "releaseState": "blocked_until_rb_01_to_rb_07_pass"
}
```

The GitHub Action packages an internal ZIP only after the real-browser release gate passes. It does not publish to Chrome Web Store. Until then, the reviewed source remains available to the team while the catalog explicitly blocks production installation.

## Development

```bash
npm run lint
npm run test:scheduler
npm run test:task-logs
npm run test:security
npm run test:business
npm run test:sourcing
npm run test:updates
npm run package:extension
```

## Task Observability

Long-running workflows and scheduled monitor jobs write privacy-safe task logs to the extension's local IndexedDB. Logs are retained for 14 days, capped by total entries and per-workflow entries, and pruned automatically on startup/install and by a 6-hour maintenance alarm.

The background service worker accepts:

- `GET_TASK_LOGS` with optional `workflowId`, `sessionId`, `limit`, and `before` filters.
- `EXPORT_TASK_LOGS` with the same filters and a larger export limit.

Task logs intentionally redact API keys, OAuth tokens, authorization headers, cookies, credentials, screenshots, and data URLs. Screenshot evidence remains in the artifact store; logs should be used to audit execution stages, tab lifecycle, evidence quality, retries, blocked states, and quality-gate loops.

See `operations/architecture_audit.md` for the current runtime risk register and library/custom-code review.

## Internal Unpacked Release Checklist

1. Keep `manifest.json` and `package.json` versions aligned and use the Node version pinned in `.nvmrc`.
2. Run `npm run test:release`; this executes lint and every `test:*` smoke suite.
3. Complete all seven real-browser acceptance items (including the governed Etsy draft task/readback path) and record `real-browser-acceptance.v2` evidence in `operations/acceptance/real_browser_acceptance_matrix.json`.
4. Run `npm run release:readiness`. It fails closed on a dirty tree, version/tag mismatch, excessive permissions, missing acceptance evidence, or runtime changes after the tested commit.
5. Run `npm run package:extension` to create a reproducible ZIP plus `dist/release-manifest.json` with source and SHA-256 provenance.
6. Push the reviewed commit and create the exact tag `v<manifest.version>`; GitHub Actions repeats the full release gate before publishing internal ZIP/release-manifest assets. Do not submit the extension to Chrome Web Store.

## Privacy

The extension is designed for local browser execution. LLM provider credentials are stored in `chrome.storage.local`; Etsy login credentials and cookies are not collected by the extension. Viewport screenshots require a fresh user disclosure confirmation, block sensitive Etsy routes, and hide detected email, phone, address, order, credential, and payment fields before capture. This local mask reduces accidental disclosure but does not replace the organization/provider DPA and real-browser privacy acceptance. See `DATA_GOVERNANCE.md` for the enforced boundary.

## Promotion handoff

This repository is the canonical Etsy Growth OS implementation. The earlier
lightweight Ads-capture prototype is absorbed as the local, read-only Etsy
Campaign Adapter in `modules/etsyCampaignAdapter.js`. Its visible-page Ads
normalization, Etsy Ads/Offsite Ads guardrails, evidence-gated trend queue and
creative-hypothesis safeguards now live here; all new Etsy development belongs
in this repository.

Growth Agent no longer creates a campaign or Outreach handoff from a local
prompt-based approval. Its dashboard routes the operator to the canonical
`etsy-campaign-operator` and Control Center reviewer. A
`promotion-object-handoff.v1` may be built only from a persisted Control Center
Campaign approval readback carrying the exact operation, campaign, approval,
target and version identifiers.

It deliberately excludes passwords, cookies, OAuth/API tokens, AdsPower API
keys, browser-control endpoints, screenshots/data URLs and every Etsy budget
mutation instruction. The recipient must still verify the tenant session and
entitlement with the cloud authorization center before it opens a live run.
An Etsy campaign approval never authorizes a social post by itself: every
target, account, final copy and media item remains subject to the downstream
service's human approval gate.

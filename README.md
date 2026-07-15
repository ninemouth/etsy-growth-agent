# Etsy Growth Agent

Etsy Growth Agent is a Manifest V3 Chrome extension adapted from a marketplace growth workflow shell and specialized for Etsy sellers.

It provides an AI-driven browser side panel, page-reading tools, Etsy-focused skills, report rendering, local result storage, sourcing workflows, and a growth dashboard for shop optimization work.

Repository: https://github.com/ninemouth/etsy-growth-agent

## Core Capabilities

- Etsy shop and listing diagnosis from the current browser page.
- Etsy SEO title, tag, description, and occasion keyword planning.
- Etsy trend and product opportunity exploration for lightweight gifts, personalized products, craft supplies, and cross-border supply-chain advantages.
- 1688 and Taobao sourcing support for visual matching and conservative landed-cost estimation.
- Competitor/review analysis focused on buyer expectations, packaging, delivery promise, personalization quality, and IP/compliance risk.
- Optional Etsy personal-access Open API adapter for active listings and authorized receipts when a Shop ID, API key, OAuth access token, and optional refresh token are configured locally.

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
│   ├── etsy_sourcing_finder.skill.md
│   ├── etsy_global_shop_optimizer.skill.md
│   ├── etsy_operations_tracker.skill.md
│   ├── etsy_listing_generator.skill.md
│   ├── etsy_review_analyzer.skill.md
│   └── base_report_auditor.skill.md
└── scripts/
```

## Etsy Adaptation Notes

This project keeps the browser automation, dashboard, workflow canvas, report library, monitoring baseline, and sourcing guardrails from the source workflow shell, but changes the platform contract:

- Platform URLs target `etsy.com`.
- Runtime routing uses `etsy_*` skills and tool names.
- The dashboard currency and listing logic are centered on USD-style Etsy economics.
- Compliance guidance focuses on Etsy IP policy, personalization claims, CE/CPC/FDA/category-specific obligations, and gift-market delivery promises.
- Etsy API integration is modeled as a personal-access/local-browser setup, not a multi-tenant SaaS authorization flow. Public listing reads use the configured API key. Private shop data such as receipts/orders requires an OAuth access token; when a refresh token is also saved, the adapter can refresh an expired access token before retrying the request.

## Etsy Personal Access Credentials

The extension stores Etsy credentials only in `chrome.storage.local` for the current browser profile:

- `Shop ID`
- `API Key` in Etsy's `keystring:shared_secret` form
- `OAuth Access Token` for private shop data such as receipts/orders
- Optional `Refresh Token` for renewing an expired access token

This project does not currently implement the full OAuth consent screen or hosted multi-user callback flow. Generate or provide the personal access credentials outside the extension, then save them in the extension settings drawer.

## Before You Run

Etsy Growth Agent works by reading the currently open browser page and, for some skills, opening temporary evidence tabs for Etsy Search, Google Search, Google Trends, competitor shops/listings, and sourcing sites. For reliable runs, prepare the browser session first:

- Sign in to Etsy in the same Chrome profile before running shop diagnosis, listing work, review analysis, or any workflow that depends on seller-visible pages.
- Open Google Search and Google Trends once in the same Chrome profile, complete any consent, region, language, or verification prompts, then keep the session available for trend and market-research workflows.
- If sourcing workflows will be used, sign in to 1688, Taobao, or other supplier sites first and resolve any captcha/login prompts manually.
- Keep the original Etsy shop or listing page open while the workflow runs. The extension protects and restores the source tab, but external login or verification pages may still require manual attention.
- If a run reports a blocked, login, consent, or verification page, resolve it in Chrome, reload the extension/page if needed, then resume the saved workflow instead of starting from scratch.

Developer Mode users should reload the unpacked extension from `chrome://extensions/` after pulling updates, then refresh the Etsy page so the latest `content.js` is injected.

## Install

1. Run `npm install`.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer Mode.
4. Click "Load unpacked" and select this project directory.
5. Open an Etsy listing, shop, or search page, then launch the extension side panel.

## Updates

Chrome extension code updates are controlled by Chrome's extension update system:

- Chrome Web Store releases update automatically through Chrome.
- Self-hosted or enterprise CRX releases can update automatically when `update_url` is configured in the packaged extension manifest.
- Developer Mode "Load unpacked" installs cannot silently replace their own source files. In this mode, Etsy Growth Agent can detect a newer open-source release and show update guidance, but the user must pull the latest code or reload the unpacked extension manually.

The extension includes update awareness in the side panel settings:

- `Check for updates` calls Chrome's runtime update check.
- `onUpdateAvailable` is recorded and applied automatically when no workflow is running.
- An optional open-source release manifest URL can be configured for GitHub release awareness.

For GitHub releases, publish a `release-manifest.json` with this shape:

```json
{
  "latest_version": "1.1.0",
  "release_url": "https://github.com/ninemouth/etsy-growth-agent/releases/latest",
  "download_url": "https://github.com/ninemouth/etsy-growth-agent/releases/latest",
  "published_at": "2026-07-13T00:00:00Z",
  "minimum_chrome_version": "120",
  "changelog": "Release notes"
}
```

The included GitHub Action packages the extension zip and uploads both the zip and release manifest when a tag like `v1.1.0` is pushed.

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

## Open-Source Release Checklist

1. Keep `manifest.json` and `package.json` versions aligned.
2. Run `npm run lint` and the smoke tests.
3. Run `npm run package:extension` to create `dist/etsy-growth-agent-<version>.zip`.
4. Push to `github.com/ninemouth/etsy-growth-agent`.
5. Create a tag such as `v1.1.0`; GitHub Actions will build the release assets.

## Privacy

The extension is designed for local browser execution. LLM provider credentials and Etsy credentials are stored in `chrome.storage.local`. No third-party middleware server is required by this repository.

# Etsy Growth Agent

Etsy Growth Agent is a Manifest V3 Chrome extension adapted from a marketplace growth workflow shell and specialized for Etsy sellers.

It provides an AI-driven browser side panel, page-reading tools, Etsy-focused skills, report rendering, local result storage, sourcing workflows, and a growth dashboard for shop optimization work.

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

## Install

1. Run `npm install`.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer Mode.
4. Click "Load unpacked" and select this project directory.
5. Open an Etsy listing, shop, or search page, then launch the extension side panel.

## Development

```bash
npm run lint
npm run test:security
npm run test:business
npm run test:sourcing
```

## Privacy

The extension is designed for local browser execution. LLM provider credentials and Etsy credentials are stored in `chrome.storage.local`. No third-party middleware server is required by this repository.

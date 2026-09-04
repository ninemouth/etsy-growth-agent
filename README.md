# Marqel Etsy Edge 2.0

Marqel Etsy Edge is a narrow browser execution node for Codex and Marqel Control Center. It is not a chatbot, competitor-analysis product, prompt runner, local report library, business dashboard, or model client.

## Repository editions

This repository intentionally keeps two independent product lines:

| Edition | Branch | Intended user | Runtime |
| --- | --- | --- | --- |
| Etsy Growth Agent standalone | [`main`](https://github.com/ninemouth/etsy-growth-agent/tree/main) | Users without Codex who need the browser-side AI, competitor/trend research, reports and local workflows | v1.2.9 |
| Marqel Etsy Edge | [`edge2.0`](https://github.com/ninemouth/etsy-growth-agent/tree/edge2.0) | Teams using Codex for planning and Marqel Web for approval, dispatch and outcomes | v2.0.0 |

The standalone `main` branch is retained and is not replaced by this branch. The editions are not an in-place compatibility upgrade: use only one in a Chrome/AdsPower Profile, and choose it according to the operating model. Edge 2.0 deliberately removes the standalone AI runtime and retired local data.

## Ownership

| Layer | Owns |
| --- | --- |
| Codex + `etsy-growth-strategist` | Competitor/shop/Listing/review/trend research, diagnosis, measurable growth cycles and downstream handoff |
| Marqel Web | Identity, store memory, approvals, versions, experiments, business settings, outcomes |
| Etsy Edge | Current Etsy surface detection, exact approved draft fill, task-bound privacy-safe evidence, terminal readback and reconciliation |

An operation is complete only when the same `operationId` connects an approved Web artifact, an executable task, the visible Etsy action, and terminal readback. A successful click or model response is not completion.

The migrated analytical entrypoint is the Marqel-managed `$etsy-growth-strategist` Skill. It stores `etsy-growth-cycle.v1` records in Web; approved Listing changes route to Listing Ops, Ads decisions to Campaign Operator, portfolio changes to Store Assortment Architect, and public execution remains outside the Skill.

## Deliberate removals in 2.0

- No embedded Skill runner or free-form prompt input.
- No competitor scan, trend research, Listing strategy, store diagnosis, report library, monitoring scheduler, or profit calculator.
- No local LLM/image provider settings and no provider API keys.
- No Google, Amazon, eBay, Pinterest, Bing, model-provider, or exchange-rate host permissions.
- No legacy workflow canvas or settings drawer.
- No compatibility route for previous Growth Agent workflows.
- No fallback to another background Etsy tab; every action targets only the currently active tab.

On install/update, the runtime removes retired model credentials, reports, monitor tasks, workflow checkpoints, growth cases and local finance settings.

## Active runtime

- `edge-background.js`: device identity, approved Etsy task lease, deterministic draft fill, task evidence, readback and reconciliation.
- `edge-content.js`: a three-action Etsy dock (`任务 / Web / 设置`) plus isolated page bridges for the approved draft writer and privacy mask.
- `sidepanel.*`: the only execution and settings surface.
- `dashboard.*`: read-only node status and execution ledger; it contains no business settings.
- `modules/etsyAdsPowerTaskAdapter.js`: validates `etsy-listing-draft.v1`, exact approval, `etsyAutomationPermissionRef`, lease and terminal readback.
- `modules/etsyDraftDomWriter.js`: fills only allowlisted fields, verifies values, rolls back partial writes, and never saves or publishes.
- `modules/screenshotPrivacyMask.js`: blocks sensitive routes and masks likely personal data before a user-triggered, task-bound screenshot.

## Hard boundaries

- Official Etsy APIs are preferred whenever they cover the operation.
- Browser evidence and writes require an archived authorization reference in the Web task.
- No task means no business evidence capture and no page mutation.
- Public publish, Ads spend, purchasing, payment, upload and ordering are never autonomous Edge actions.
- An uncertain readback disables repeat execution and allows only reconciliation.
- Model credentials and browser credentials never enter the extension runtime.

Etsy's API Terms restrict automated systems and browser extensions that access, analyze, or scrape Etsy without the required written authorization. Keep real DOM activity blocked until the planned activity and distribution model are covered by archived authorization. See [Etsy API Terms](https://www.etsy.com/legal/api/).

Etsy is a trademark of Etsy, Inc. Marqel Etsy Edge is an independent tool and is not endorsed or certified by Etsy.

## Install for controlled testing

Choose one source method:

```bash
git clone --branch edge2.0 --single-branch https://github.com/ninemouth/etsy-growth-agent.git etsy-edge-2.0
cd etsy-edge-2.0
```

Alternatively, download the [Edge 2.0 source snapshot ZIP](https://github.com/ninemouth/etsy-growth-agent/archive/refs/heads/edge2.0.zip), extract it, and open a terminal in the extracted directory. This archive is a source snapshot, not a signed or production-accepted release package.

Run the controlled-test checks and build:

```bash
npm install
npm run test:release
npm run package:extension -- --allow-dirty
```

Then open `chrome://extensions`, enable Developer Mode, choose **Load unpacked**, select the extracted repository directory that contains `manifest.json`, and refresh every already-open Etsy tab. Reloading the extension does not replace content scripts that are already running in a tab.

## Release evidence

Local tests are not production acceptance. A releasable candidate still requires:

- clean reviewed commit and immutable ZIP digest;
- Node version from `.nvmrc`;
- exact Chrome/AdsPower Profile and runtime Extension ID;
- Control Center installation readback;
- archived Etsy authorization reference;
- real Etsy editor tests for allowed fields, selector drift, sensitive routes, context invalidation, lease loss, uncertain readback and no-publication proof.

Repository reviews should use the current industrial audit and product strategy under `operations/`; those documents are intentionally not part of the runtime ZIP.

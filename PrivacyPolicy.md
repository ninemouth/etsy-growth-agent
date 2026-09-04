# Privacy Policy for Marqel Etsy Edge

**Last updated:** September 4, 2026

Marqel Etsy Edge is an organization-controlled Chrome extension that performs narrowly approved actions on Etsy pages and returns evidence and terminal state to Marqel Control Center.

## Information processed

The extension processes the current Etsy page URL and supported form fields only when needed to classify the page or execute an active Web-approved task. It stores a Marqel device session, the active task lease and bounded execution logs. It does not read browser cookies, saved passwords, general browsing history or unrelated sites.

When an operator explicitly captures task evidence, the extension blocks sensitive Etsy routes, masks likely personal or confidential elements, captures the visible viewport, hashes the image and uploads it to the matching Marqel task artifact endpoint. The image is not sent to an LLM or image provider. Heuristic masking cannot guarantee detection of every Etsy page variant, so target-browser privacy acceptance remains mandatory.

## Information not collected by the extension

- Model-provider or image-provider API keys.
- Etsy API secrets or OAuth tokens from Marqel Web.
- Cookies, password-manager entries or hidden browser-profile credentials.
- Competitor-monitoring history, research reports, prompts or model conversations.
- Payment, checkout, order, receipt, private-message or account-security page evidence.

## Permissions

- `storage`: stores device authorization, task lease and bounded runtime logs.
- `alarms`: renews task leases, checks pending device authorization and prunes logs.
- `sidePanel`: provides the single execution and settings surface.
- Etsy host access: identifies matching tabs, loads the deterministic page bridge and privacy mask, and permits operator-triggered visible-page capture only on Etsy HTTPS pages.
- `https://www.marqel.shop/*`: performs device authorization, task acquisition, artifact upload and terminal readback.

The extension requests no blanket `<all_urls>` access and no model-provider, search-engine, marketplace, social-network or exchange-rate host access.

## Changes and contact

Policy changes are reflected in this file with a new revision date. Questions should be raised through the organization's approved Marqel support or repository channel.

Etsy is a trademark of Etsy, Inc. This independent tool is not endorsed or certified by Etsy.

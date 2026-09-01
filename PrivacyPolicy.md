# Privacy Policy for E-commerce Growth Agent

**Last Updated:** August 25, 2026

Welcome to **E-commerce Growth Agent** (formerly Skill Runner). We are committed to protecting your privacy and ensuring the security of your data. This Privacy Policy explains how our Chrome Extension handles your information.

## 1. Local and Marqel Processing
The extension reads supported Etsy and public research pages and captures visible-page evidence locally in Chrome. It also connects to the Marqel Control Center for device authorization, session maintenance, entitlement checks, organization-managed model configuration, and a sanitized Etsy Seller App connection status. Etsy API keystrings, shared secrets, OAuth access tokens, and refresh tokens configured in Control Center are not delivered to the extension. It does not read browser cookies, saved passwords, or unrelated browsing history.

Etsy credentials are stored only in the current browser profile. Credential entry and provider configuration are available only on extension-origin pages such as the side panel; secret fields are not injected into Etsy page DOM.

## 2. Third-Party API Usage
To perform AI analysis, the extension sends the evidence required for the selected task (for example, bounded text and visible screenshots) to the approved third-party Large Language Model (LLM) provider selected in the extension or supplied through an authorized Marqel organization configuration.
* Each viewport capture requires a fresh user disclosure. Sensitive Etsy account/order/message/payment/security routes are blocked, and detected email, phone, address, order, credential, and payment elements are hidden before capture and restored afterward. This heuristic mask reduces accidental disclosure but cannot replace review of the selected provider's retention, training, deletion, and DPA terms.
* Provider endpoints are restricted to HTTPS origins explicitly declared in the reviewed extension manifest; arbitrary runtime host access is not supported.
* Local overrides are stored in `chrome.storage.local`. Organization-managed credentials are delivered through the authenticated Marqel configuration channel and are not inserted into Etsy page DOM.
* Local DOM telemetry is limited to selector/policy versions, coarse route classes, outcome counts, and bounded error codes. It excludes page URLs, listing/operation identifiers, approved content, screenshots, selector strings, and credentials.
* Please review the privacy policy of your chosen API provider to understand how they handle the data sent to them.

## 3. Data We Do Not Collect
* We **do not** scan or export general browsing history.
* We **do not** read or export browser cookies, password-manager entries, or hidden account-page data.
* We **do not** expose Etsy or provider credentials to the page overlay.
* We **do not** use analytics trackers to monitor your behavior.

## 4. Permissions Justification
To function correctly, the extension requires the following permissions:
* `activeTab`: Required to capture the active visible page after a user invokes the extension.
* `storage`: Required to save your settings (e.g., API keys, preferred models) and analysis history locally on your device.
* `scripting`: Required to extract bounded structured evidence from the explicitly supported Etsy and public research origins.
* Exact `host_permissions`: Required for Etsy, Marqel, reviewed model providers, GitHub release awareness, exchange rates, and the named public research sources. The extension does not request `<all_urls>`, arbitrary HTTPS origins, or supplier-marketplace origins.

## 5. Changes to This Policy
We may update our Privacy Policy from time to time. Any changes will be reflected on this page with an updated revision date.

## 6. Contact Us
If you have any questions about this Privacy Policy or the open-source project, please open an issue in our GitHub repository.

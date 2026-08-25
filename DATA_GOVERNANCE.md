# Data governance

This extension is an Etsy operating assistant. It must not use account, login, payment, order, security, cookie, or private-message pages as model evidence. Etsy credentials, MFA, browser cookies, and Marqel device tokens are never included in prompts or injected into page scripts.

Every workflow that captures the current viewport requires a fresh, visible user confirmation before the run starts. The confirmation states that the screenshot is sent to the organization-configured model provider. The screenshot is used as transient model context and is not part of the exported evidence bundle unless a separate, explicit artifact action is added and approved. Provider retention and training terms remain the responsibility of the organization that configured that provider.

Structured outputs, task logs, and resumable checkpoints are stored locally under the documented retention controls. Business artifacts synchronized to Marqel follow Control Center access, audit, and retention policy. Public publishing, Etsy writes, Ads changes, supplier actions, and spend remain separate approval-gated operations.

Production distribution requires RB-01 through RB-06 real-browser acceptance, the organization-owned stable extension ID, supported Chrome floor, rollback artifact, and provider data-processing review. Source availability, local tests, and package checksums alone do not satisfy this gate.

# Data governance — Marqel Etsy Edge 2.0

Marqel Etsy Edge is a task-bound browser execution node. It does not run models, accept provider credentials, perform competitor research, maintain business reports, or store a duplicate business configuration.

## Data allowed in the extension

- A short-lived Marqel device session and rotating refresh token.
- The exact Web-approved Etsy task, operation reference, approval reference, permission reference and lease state.
- Bounded local runtime logs containing event type, timestamp, severity, coarse outcome counts and task/operation references.
- The current approved Listing draft while it is being filled.

## Page access and evidence

The content script runs only on Etsy HTTPS origins declared in the manifest. Account, login, checkout, cart, payment, billing, security, message, conversation, order and receipt pages are blocked from evidence capture. Other `/your` routes are blocked unless they match an allowlisted Listing editor route.

A viewport capture is permitted only after an operator invokes the evidence action for an active, preflighted task. Before capture, the page bridge masks detected email, phone, address, postal, credential, order, payment and explicitly private elements; it then restores the page in a `finally` path. The resulting JPEG is hashed and uploaded only to the matching Marqel task artifact endpoint. It is not sent to a model provider and is not used for autonomous analysis.

Masking is heuristic. Real Etsy locale and A/B variants must pass the controlled browser acceptance matrix before release.

## Page mutation

The DOM writer accepts only an exact approved `etsy-listing-draft.v1` with a valid operation, approval, permission reference and lease. It fills allowlisted fields, verifies their values, rolls back partial changes, and never clicks Save, Submit or Publish. Unsupported tags, images, categories or dynamic components remain manual.

## Terminal state

An Etsy action is not complete until the human-confirmed draft ID/URL or bounded failure is written back to the same Web operation. An uncertain response disables repeated mutation and permits only read-only reconciliation.

## Retention and removal

Task log retention is enforced locally by the runtime. Web artifacts follow Control Center access and retention policy. On 2.0 installation or update, retired model credentials, report libraries, monitoring state, growth cases, workflow checkpoints and finance settings are deleted; there is no compatibility UI or migration back to the prior local-agent model.

## Release gate

Local tests and a valid ZIP are not production acceptance. Release requires a clean reviewed commit, immutable package digest, the exact AdsPower/Chrome profile and Extension ID, Control Center readback, archived Etsy authorization for the planned browser behavior, and a passed real-browser task from Web approval through Etsy draft readback.

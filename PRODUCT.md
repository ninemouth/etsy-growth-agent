# Marqel Etsy Edge — Product Contract

## Product thesis

Codex will continue to improve at research, reasoning and browser use. Etsy Edge survives only where a dedicated extension can be safer and more deterministic than a general agent: the logged-in Etsy last mile, precise field-level execution, task-bound evidence, and terminal reconciliation.

This contract applies only to the `codex/etsy-edge-v2-20260904` branch. The GitHub `main` branch remains the standalone Etsy Growth Agent for users without Codex. The two editions share a repository but not a feature-compatibility promise or automatic migration path.

## Primary user

An Etsy operator who already has a reviewed plan or Listing draft in Marqel Web and needs to move that exact version into the correct Etsy browser profile without copy errors, accidental publication, duplicate execution, or unverifiable success.

## Core job

> Take one exactly approved Web task, verify that the current Etsy page and execution lease match it, perform only the allowed deterministic action, then return evidence and terminal state to the same operation.

## Not the job

- Generating business ideas or copy.
- Competitor analysis, trend research or monitoring.
- Choosing what to sell, price, advertise or publish.
- Storing reports, model settings or business configuration.
- Acting as a general browser agent.

## Product surfaces

1. Etsy Dock: only `任务 / Web / 设置`; no analysis shortcuts and no chat overlay.
2. Side Panel: capability passport, Web-approved task, controlled execution, evidence and readback; it is the single settings surface.
3. Node Console: read-only runtime identity, task lease, boundary and log inspection; no duplicated business controls.
4. Marqel Web: the sole business control plane.

## Supported capability in 2.0

The only write capability is a governed `etsy_publish` task whose action is `upload_draft`, with `publicPublishAllowed=false`. It requires:

- `etsy-listing-draft.v1`;
- exact `approvalId` and `expectedUpdatedAt`;
- `etsyAutomationPermissionRef`;
- valid browser-task lease;
- an allowlisted Etsy listing-editor route;
- human save-as-draft confirmation;
- terminal readback and reconciliation.

## Success metrics

- 100% of page writes have operation, approval, permission and lease references.
- 100% of uncertain outcomes disable repeat execution.
- Zero autonomous public publish, spend, purchase, payment, upload or order actions.
- At least 80% reduction in manual Listing-field copy steps for supported tasks.
- At least 95% terminal readback completion in a controlled real-browser sample.
- Operators can identify page, authority, task and next safe action within five seconds.

## Kill criteria

Stop the extension as a product and retain only an internal adapter if any of the following remains true after controlled validation:

- official Etsy API or Codex Browser covers the same task with equal safety and lower maintenance;
- written authorization for the required browser behavior cannot be obtained;
- selector maintenance costs exceed saved operator time;
- users return mainly for research/chat rather than governed execution;
- terminal readback cannot reach the target reliability without manual duplicate work.

# Marqel Etsy Edge 2.0 strategy

Date: 2026-09-04

## Decision

Marqel's Etsy product is a Web-first Revenue OS. Codex is the research and reasoning engine; Marqel Web is the system of record and approval control plane; Etsy Edge is an optional, replaceable browser adapter.

The extension must not compete with Codex on intelligence. It must beat a general agent on deterministic Etsy execution, least privilege, in-profile identity, privacy controls, and terminal evidence.

## Competitor analysis

Competitor analysis does not belong in the extension.

- Codex performs research, source synthesis, comparison and recommendations.
- Web stores the research brief, evidence references, decision, experiment and outcome.
- Edge may capture only the visible allowlisted Listing editor for an active approved task. It does not decide which competitors to inspect, open research tabs, call a model, maintain a competitor monitor, or generate conclusions.

The migrated analytical owner is the Marqel-managed `etsy-growth-strategist` Codex Skill. It covers competitor benchmarks, shop audits, Listing experiments, review voice, trend watches and portfolio optimization through versioned `etsy-growth-cycle.v1` records. It routes approved work to Listing Ops, Campaign Operator, Store Assortment Architect, Positioning Analyst, Intelligent Outreach or a named human operator; it does not execute Etsy actions itself.

This avoids the false product moat of “AI inside a browser.” The defensible capability is a governed link between an exact approved artifact and an exact observed Etsy result.

## Product narrow waist

```text
Codex research and reasoning
        ↓ typed recommendation
Marqel Web approval and version
        ↓ exact task + permission ref + lease
Etsy Edge deterministic page action
        ↓ artifact + terminal readback
Marqel Web experiment and outcome
```

All adapters—official Etsy API, human-only action, or Edge—must consume the same operation envelope. Edge must remain replaceable when API coverage improves.

## 2.0 capability set

Retain:

1. Current Etsy surface classification and sensitive-route blocking.
2. Device-bound Marqel session and exact task acquisition.
3. Task contract, approval, version, permission-reference and lease validation.
4. Allowlisted Listing draft field fill with atomic rollback and no Save/Publish click.
5. User-triggered, task-bound viewport evidence with privacy masking.
6. Human-confirmed draft readback, artifact upload and reconciliation.
7. Privacy-safe runtime logs and stale-extension recovery.

Remove:

1. Free-form chat and prompt entry.
2. Embedded Skills and local agent loop.
3. Competitor scan, trend research, review analysis and store diagnosis.
4. Cross-site search/navigation and scheduled competitor monitoring.
5. Local report library, workflow canvas, growth cases and experiments.
6. Direct model/image provider settings and credentials.
7. Local FX, shipping, margin and business configuration.
8. Duplicate settings surfaces.

## Surface contract

- Etsy page Dock: `任务 / Web / 设置` only.
- Side Panel: the single operational and settings surface.
- Node Console: read-only identity, lease, boundary and evidence ledger.
- Web: the only business backend.

## Why this can survive Codex

The extension remains useful only if it can prove advantages that a general agent should not assume:

- correct AdsPower/Chrome profile and current Etsy session without exporting cookies;
- field-level allowlists rather than unconstrained clicks;
- approval-version and lease checks at the moment of mutation;
- local sensitive-route and privacy-mask enforcement before capture;
- atomic rollback when a required field cannot be verified;
- one-shot terminal readback and no-repeat reconciliation after uncertain results;
- runtime evidence tied to a stable extension build and policy version.

These are execution-control advantages, not reasoning advantages.

## Industrial acceptance gates

The extension is retained only if a controlled design-partner run demonstrates:

- archived Etsy authorization covers the exact browser behavior and distribution model;
- 100% of writes carry operation, approval, permission and lease references;
- zero autonomous publish/spend/purchase/payment/upload/order actions;
- at least 80% fewer manual field-copy steps for the supported Listing task;
- at least 95% terminal readback completion;
- context invalidation, selector drift, lease loss and uncertain readback all fail closed;
- maintenance cost is below the operator time and error cost saved.

If Etsy API or Codex Browser reaches equal safety and lower cost, the corresponding Edge capability is deleted. Edge is not protected from replacement; replaceability is an architectural requirement.

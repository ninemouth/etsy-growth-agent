---
name: "Marqel Etsy Edge Instrument"
description: "A narrow, evidence-bound browser execution instrument for one approved Etsy task."
colors:
  paper-canvas: "#f4f0e9"
  paper-surface: "#fffdf9"
  graphite: "#2b2723"
  graphite-muted: "#6c645c"
  etsy-orange: "#b7471c"
  etsy-orange-dark: "#963715"
  proof-success: "#2f7a4d"
  proof-warning: "#95601a"
  proof-danger: "#a93429"
  hairline: "#d6cec4"
---

# Design System: Marqel Etsy Edge Instrument

## North star

The product should look like a browser instrument, not an AI chat application or a second ecommerce backend. Every surface must help the operator answer four questions in seconds: which Etsy page is active, whether the device is authorized, which exact task is leased, and whether the final state was read back.

## Surface hierarchy

1. Etsy Dock: a small bottom-right strip with `任务 / Web / 设置`. It never expands into a chat window.
2. Side Panel: the only operational and settings surface. It owns the capability passport, approved task controls, task evidence and readback.
3. Node Console: a read-only inspection surface for identity, lease, boundary and logs.
4. Marqel Web: the business control plane. The extension never duplicates its settings or analytics.

## Visual language

- Warm paper background, warm-white surfaces and graphite text.
- One deep Etsy orange for the primary action and current execution stage.
- Green, amber and red only for proven success, attention and blockage; labels are mandatory.
- Small practical corners, fine rules and restrained elevation.
- System sans-serif stack for predictable extension rendering; no remote or bundled font dependency.
- Controls are at least 44px high with visible focus rings.
- Reduced-motion preferences are respected.

## Component rules

### Dock

The Dock stays under 52px high and uses text actions rather than ambiguous icons. It exposes no business capability shortcuts. Errors such as a stale extension context appear in a small temporary status bubble and direct the operator to refresh the Etsy page.

### Capability passport

Use a four-cell grid for page, authorization, runtime and next action. The reason below the grid explains why an action is allowed or blocked. A public Etsy page is not automatically evidence-ready: a task is required.

### Execution card

Show the four-stage rail before controls: Web approval, lease preflight, field fill and terminal readback. Only actions valid for the current task state are enabled. An uncertain result disables every mutation and leaves only read-only reconciliation.

### Settings

There is one route: `sidepanel.html#settings`. It contains device authorization, extension version, runtime ID, site scope and the hard boundary. It contains no model provider, key, temperature, business parameter, report or research setting.

### Node Console

The console uses a large product thesis, one current-node verdict, a four-stage status line, current lease facts, the capability boundary and a privacy-safe log table. It never contains settings, research actions or fake revenue metrics.

## Do

- Keep one exact task and next safe action visually dominant.
- Tie actions to operation, approval, permission and lease identity.
- Make failure and recovery explicit.
- Keep the Etsy page visible.
- Use task-bound evidence language.

## Do not

- Add chat, prompt, Skill, competitor, trend or report controls.
- Add a second settings drawer or business dashboard.
- Add decorative KPI cards or unverified revenue claims.
- Hide a risky action behind generic wording such as “Run.”
- Use a successful click as proof of business completion.

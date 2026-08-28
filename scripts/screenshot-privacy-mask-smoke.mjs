import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

delete globalThis.EtsyScreenshotPrivacyMask;
await import(`../modules/screenshotPrivacyMask.js?test=${Date.now()}`);
const mask = globalThis.EtsyScreenshotPrivacyMask;
assert.ok(mask, "privacy mask must register its isolated content-script API");

const dom = new JSDOM(`
  <main>
    <h1>Shop dashboard</h1>
    <input id="email" type="email" value="seller@example.com">
    <input id="phone" name="phone" value="+1 212 555 0100">
    <span id="order">Order 123-4567890-1234567</span>
    <p id="public">Public listing performance</p>
  </main>
`, { url:"https://www.etsy.com/your/shops/me/dashboard" });
const prepared = mask.prepare({ documentImpl:dom.window.document, locationHref:dom.window.location.href });
assert.equal(prepared.contractVersion, "etsy-screenshot-privacy-mask.v1");
assert.equal(prepared.policyVersion, "etsy-screenshot-sensitive-selectors.2026-08-25");
assert.equal(prepared.blocked, false);
assert.ok(prepared.maskedCount >= 3);
for (const id of ["email", "phone", "order"]) {
  assert.equal(dom.window.document.querySelector(`#${id}`).style.getPropertyValue("visibility"), "hidden");
  assert.equal(dom.window.document.querySelector(`#${id}`).style.getPropertyPriority("visibility"), "important");
}
assert.equal(dom.window.document.querySelector("#public").style.getPropertyValue("visibility"), "");
const restored = mask.restore(prepared.token);
assert.equal(restored.restored, true);
assert.equal(restored.policyVersion, prepared.policyVersion);
assert.equal(dom.window.document.querySelector("#email").style.getPropertyValue("visibility"), "");
assert.equal(mask.restore(prepared.token).restored, false, "mask token must be one-shot");

const blocked = mask.prepare({ documentImpl:dom.window.document, locationHref:"https://www.etsy.com/your/orders/123" });
assert.equal(blocked.blocked, true);
assert.equal(blocked.reason, "sensitive_route");
assert.equal(blocked.token, "");

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.content_scripts[0].js[0], "modules/screenshotPrivacyMask.js");
const background = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const content = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
assert.match(background, /capturePrivacySafeEtsyViewport/);
assert.match(background, /SCREENSHOT_SENSITIVE_ROUTE_FORBIDDEN/);
assert.match(background, /RESTORE_PRIVACY_SAFE_SCREENSHOT/);
assert.match(content, /PREPARE_PRIVACY_SAFE_SCREENSHOT[\s\S]*requestAnimationFrame\(\(\) => requestAnimationFrame/, "capture must wait for the privacy mask to paint");

console.log("screenshot-privacy-mask-smoke: ok");

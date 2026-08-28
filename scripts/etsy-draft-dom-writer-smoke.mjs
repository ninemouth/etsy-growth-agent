import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

delete globalThis.EtsyDraftDomWriter;
await import(`../modules/etsyDraftDomWriter.js?test=${Date.now()}`);
const writer = globalThis.EtsyDraftDomWriter;
assert.ok(writer, "draft writer must register its isolated content-script API");

const draft = {
  id:"listing-draft-1", operationId:"operation-1", contractVersion:"etsy-listing-draft.v1",
  title:"Minimal Desk Organizer", description:"A calm and tidy home office organizer.",
  price:"24.00", currency:"USD", tags:["desk organizer", "home office"],
  category:"Office", personalization:"No personalization.", imageManifest:{ imageCount:3 },
  publishAllowed:false, publicPublishAllowed:false, writeAdapter:"adspower_etsy",
  approval:{ id:"approval-1", status:"approved" },
};

function editorDom(markup = "") {
  return new JSDOM(`<form id="editor">${markup}<button id="save" type="submit">Save draft</button><button id="publish" type="button">Publish</button></form>`, { url:"https://www.etsy.com/your/shops/me/listing/draft-123" });
}

const dom = editorDom(`
  <input name="title" value="Old title">
  <textarea name="description">Old description</textarea>
  <input name="price" value="1.00">
  <input name="tags" value="old tag">
  <select name="category"><option value="office">Office</option><option value="home">Home</option></select>
  <textarea name="personalization">Old personalization</textarea>
`);
let submits = 0;
let clicks = 0;
dom.window.document.querySelector("#editor").addEventListener("submit", (event) => { submits += 1; event.preventDefault(); });
dom.window.document.querySelector("#save").addEventListener("click", () => { clicks += 1; });
dom.window.document.querySelector("#publish").addEventListener("click", () => { clicks += 1; });
const result = writer.applyApprovedDraft(draft, { documentImpl:dom.window.document, locationHref:dom.window.location.href, EventImpl:dom.window.Event });
assert.equal(dom.window.document.querySelector('[name="title"]').value, draft.title);
assert.equal(dom.window.document.querySelector('[name="description"]').value, draft.description);
assert.equal(dom.window.document.querySelector('[name="price"]').value, draft.price);
assert.equal(dom.window.document.querySelector('[name="tags"]').value, "old tag", "tokenized Etsy tags must remain a visible manual action");
assert.equal(dom.window.document.querySelector('[name="category"]').value, "office");
assert.equal(dom.window.document.querySelector('[name="personalization"]').value, draft.personalization);
assert.equal(result.contractVersion, "etsy-approved-draft-dom-write.v1");
assert.equal(result.selectorSetVersion, "etsy-listing-editor-selectors.2026-08-25");
assert.equal(result.fieldsApplied, 5);
assert.equal(result.fieldResults.tags.status, "manual_required");
assert.equal(result.imageStatus, "manual_required");
assert.equal(result.saveTriggered, false);
assert.equal(result.publicPublishPerformed, false);
assert.equal(submits, 0);
assert.equal(clicks, 0);
assert.equal(JSON.stringify(result).includes(draft.description), false, "write result must not echo approved business content");

const wrongPage = editorDom('<input name="title" value="unchanged"><textarea name="description">unchanged</textarea><input name="price" value="1">');
assert.throws(() => writer.applyApprovedDraft(draft, { documentImpl:wrongPage.window.document, locationHref:"https://www.etsy.com/account/security", EventImpl:wrongPage.window.Event }), /not an allowed listing editor route/);
assert.equal(wrongPage.window.document.querySelector('[name="title"]').value, "unchanged");

const missingPrice = editorDom('<input name="title" value="unchanged"><textarea name="description">unchanged</textarea>');
assert.throws(() => writer.applyApprovedDraft(draft, { documentImpl:missingPrice.window.document, locationHref:missingPrice.window.location.href, EventImpl:missingPrice.window.Event }), /price.*No fields were changed/);
assert.equal(missingPrice.window.document.querySelector('[name="title"]').value, "unchanged", "atomic preflight must prevent partial writes");

const readOnly = editorDom('<input name="title" readonly value="unchanged"><textarea name="description">unchanged</textarea><input name="price" value="1">');
assert.throws(() => writer.applyApprovedDraft(draft, { documentImpl:readOnly.window.document, locationHref:readOnly.window.location.href, EventImpl:readOnly.window.Event }), /title.*No fields were changed/);

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.content_scripts[0].js.slice(0, 3), ["modules/screenshotPrivacyMask.js", "modules/etsyDraftDomWriter.js", "content.js"]);
const background = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const content = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
assert.match(background, /ETSY_TASK_APPLY_APPROVED_DRAFT/);
assert.match(background, /approved_fields_applied_pending_human_save/);
assert.match(content, /APPLY_APPROVED_ETSY_DRAFT/);
assert.doesNotMatch(fs.readFileSync(new URL("../modules/etsyDraftDomWriter.js", import.meta.url), "utf8"), /\.click\(|requestSubmit|\.submit\(/, "draft writer must never save or publish");

console.log("etsy-draft-dom-writer-smoke: ok");

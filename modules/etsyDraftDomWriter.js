(() => {
  const CONTRACT_VERSION = "etsy-approved-draft-dom-write.v1";
  const SELECTOR_SET_VERSION = "etsy-listing-editor-selectors.2026-09-04.v2";
  const EDITOR_PATHS = [
    /^\/your\/shops\/[^/]+\/(?:listing|listings)(?:\/|$)/i,
    /^\/your\/shops\/[^/]+\/tools\/listings(?:\/|$)/i,
  ];
  const BLOCKED_PATH = /\/(?:account|signin|login|checkout|cart|payment|billing|security|messages?|conversations?|orders?)(?:\/|$)/i;
  const SELECTORS = Object.freeze({
    title: ['input[name="title"]', 'textarea[name="title"]', '#listing-title-input', '[data-field="title"] input', '[data-test-id="listing-title"] input', '[data-test-id="listing-title"] textarea'],
    description: ['textarea[name="description"]', '#listing-description-textarea', '[data-field="description"] textarea', '[data-test-id="listing-description"] textarea'],
    price: ['input[name="price"]', '#listing-price-input', '[data-field="price"] input', '[data-test-id="listing-price"] input'],
    tags: ['input[name="tags"]', 'textarea[name="tags"]', '#listing-tags-input', '[data-field="tags"] input', '[data-test-id="listing-tags"] input'],
    category: ['select[name="category"]', '#listing-category-select', '[data-field="category"] select', '[data-test-id="listing-category"] select'],
    personalization: ['textarea[name="personalization"]', '#listing-personalization-textarea', '[data-field="personalization"] textarea', '[data-test-id="listing-personalization"] textarea'],
  });

  function requiredText(value, field, max) {
    const text = String(value || "").trim();
    if (!text || text.length > max) throw new Error(`${field} is required and must not exceed ${max} characters.`);
    return text;
  }

  function optionalText(value, max) {
    return String(value || "").trim().slice(0, max);
  }

  function normalizeDraft(draft) {
    if (!draft || draft.contractVersion !== "etsy-listing-draft.v1") throw new Error("Only etsy-listing-draft.v1 is accepted.");
    if (draft.approval?.status !== "approved" || !draft.approval?.id) throw new Error("The exact Listing draft must have a persisted approval.");
    if (draft.publishAllowed !== false || draft.publicPublishAllowed !== false || draft.writeAdapter !== "adspower_etsy") throw new Error("The Listing draft must preserve the AdsPower draft-only boundary.");
    const tags = Array.isArray(draft.tags)
      ? [...new Set(draft.tags.map((tag) => String(tag || "").trim()).filter(Boolean))].slice(0, 13)
      : [];
    if (tags.some((tag) => tag.length > 20)) throw new Error("Listing tags must not exceed 20 characters each.");
    return {
      id: requiredText(draft.id, "listingDraft.id", 180),
      operationId: requiredText(draft.operationId, "listingDraft.operationId", 180),
      title: requiredText(draft.title, "listingDraft.title", 140),
      description: requiredText(draft.description, "listingDraft.description", 10_000),
      price: optionalText(draft.price, 80),
      currency: optionalText(draft.currency, 12),
      tags,
      category: optionalText(draft.category, 180),
      personalization: optionalText(draft.personalization, 1_000),
      imageCount: Number(draft.imageManifest?.imageCount || draft.imageManifest?.images?.length || 0),
    };
  }

  function assertEditorUrl(value) {
    let url;
    try { url = new URL(String(value || "")); } catch { throw new Error("The active tab URL is invalid."); }
    if (url.protocol !== "https:" || !/(^|\.)etsy\.com$/i.test(url.hostname) || url.username || url.password) throw new Error("The active tab must be an Etsy HTTPS listing editor.");
    if (BLOCKED_PATH.test(url.pathname) || !EDITOR_PATHS.some((pattern) => pattern.test(url.pathname))) throw new Error("The active Etsy page is not an allowed listing editor route.");
    return url;
  }

  function normalizeShopRef(value, field = "etsyShopRef") {
    const normalized = String(value || "").trim().normalize("NFKC");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/.test(normalized) || normalized.toLowerCase() === "me") {
      throw new Error(`${field} must identify the exact Etsy shop.`);
    }
    return normalized.toLowerCase();
  }

  function shopRefFromEditorUrl(url) {
    const match = url.pathname.match(/^\/your\/shops\/([^/]+)\/(?:listing|listings|tools\/listings)(?:\/|$)/i);
    if (!match) throw new Error("The Etsy editor URL does not expose an exact shop identity.");
    let decoded = "";
    try { decoded = decodeURIComponent(match[1]); } catch { throw new Error("The Etsy editor shop identity is invalid."); }
    return normalizeShopRef(decoded, "page.etsyShopRef");
  }

  function findEditable(documentImpl, field) {
    for (const selector of SELECTORS[field] || []) {
      const element = documentImpl.querySelector(selector);
      if (!element) continue;
      if (element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true") {
        return { field, selector, element, blocked: true };
      }
      return { field, selector, element, blocked: false };
    }
    return { field, selector: "", element: null, blocked: false };
  }

  function setNativeValue(element, value, EventImpl) {
    const view = element.ownerDocument?.defaultView;
    const prototype = element.tagName === "TEXTAREA" ? view?.HTMLTextAreaElement?.prototype
      : element.tagName === "SELECT" ? view?.HTMLSelectElement?.prototype
        : view?.HTMLInputElement?.prototype;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new EventImpl("input", { bubbles: true }));
    element.dispatchEvent(new EventImpl("change", { bubbles: true }));
  }

  function exactCategoryValue(select, category) {
    const normalized = category.toLocaleLowerCase();
    const option = Array.from(select.options || []).find((candidate) => String(candidate.value || "").trim().toLocaleLowerCase() === normalized
      || String(candidate.textContent || "").trim().toLocaleLowerCase() === normalized);
    return option ? option.value : "";
  }

  function inspectEditor(draft, {
    documentImpl = document,
    locationHref = location.href,
    executionBinding = {},
  } = {}) {
    const normalized = normalizeDraft(draft);
    const url = assertEditorUrl(locationHref);
    const etsyShopRef = shopRefFromEditorUrl(url);
    if (etsyShopRef !== normalizeShopRef(executionBinding.etsyShopRef, "executionBinding.etsyShopRef")) {
      throw new Error("The visible Etsy editor belongs to another shop.");
    }
    const requiredFields = ["title", "description", ...(normalized.price ? ["price"] : [])];
    const optionalFields = ["tags", "category", "personalization"];
    const resolved = new Map([...requiredFields, ...optionalFields].map((field) => [field, findEditable(documentImpl, field)]));
    const fieldResults = Object.fromEntries([...resolved.entries()].map(([field, entry]) => [field, {
      required: requiredFields.includes(field),
      available: Boolean(entry.element),
      writable: Boolean(entry.element && !entry.blocked),
      approvedValueMatch: Boolean(entry.element) && (!requiredFields.includes(field) || String(entry.element.value || "") === String(normalized[field] || "")),
      selector: entry.selector,
    }]));
    const unavailable = requiredFields.filter((field) => !resolved.get(field)?.element || resolved.get(field)?.blocked);
    return {
      contractVersion: "etsy-listing-editor-inspection.v1",
      selectorSetVersion: SELECTOR_SET_VERSION,
      listingDraftId: normalized.id,
      operationId: normalized.operationId,
      sourceUrl: url.toString(),
      etsyShopRef,
      observedAt: new Date().toISOString(),
      ready: unavailable.length === 0,
      approvedRequiredValuesMatch: requiredFields.every((field) => fieldResults[field]?.approvedValueMatch === true),
      unavailableRequiredFields: unavailable,
      fieldResults,
    };
  }

  function applyApprovedDraft(draft, {
    documentImpl = document,
    locationHref = location.href,
    EventImpl = Event,
    executionBinding = {},
  } = {}) {
    const normalized = normalizeDraft(draft);
    const inspection = inspectEditor(draft, { documentImpl, locationHref, executionBinding });
    const url = new URL(inspection.sourceUrl);
    const requiredFields = ["title", "description", ...(normalized.price ? ["price"] : [])];
    const optionalFields = ["tags", "category", "personalization"];
    const resolved = new Map([...requiredFields, ...optionalFields].map((field) => [field, findEditable(documentImpl, field)]));
    const unavailable = requiredFields.filter((field) => !resolved.get(field)?.element || resolved.get(field)?.blocked);
    if (unavailable.length) throw new Error(`Required Etsy draft fields are unavailable or read-only: ${unavailable.join(", ")}. No fields were changed.`);

    const desired = new Map([
      ["title", normalized.title],
      ["description", normalized.description],
      ["price", normalized.price],
      ["tags", normalized.tags.join(", ")],
      ["personalization", normalized.personalization],
    ]);
    const categoryEntry = resolved.get("category");
    const categoryValue = normalized.category && categoryEntry?.element
      ? exactCategoryValue(categoryEntry.element, normalized.category)
      : "";
    desired.set("category", categoryValue);

    const writable = [...resolved.entries()].filter(([field, entry]) => field !== "tags" && entry.element && !entry.blocked && desired.get(field));
    const originals = new Map(writable.map(([field, entry]) => [field, String(entry.element.value || "")]));
    const applied = [];
    try {
      for (const [field, entry] of writable) {
        setNativeValue(entry.element, desired.get(field), EventImpl);
        if (String(entry.element.value || "") !== desired.get(field)) throw new Error(`${field} did not retain the approved value.`);
        applied.push(field);
      }
    } catch (error) {
      for (const [field, entry] of writable) {
        try { setNativeValue(entry.element, originals.get(field), EventImpl); } catch (_) {}
      }
      throw new Error(`Etsy draft field verification failed and all touched fields were rolled back: ${error.message}`);
    }

    const fieldResults = Object.fromEntries([...resolved.entries()].map(([field, entry]) => [field, {
      status: applied.includes(field) ? "applied_verified" : normalized[field]?.length || (field === "tags" && normalized.tags.length) ? "manual_required" : "not_requested",
      selector: entry.selector,
    }]));
    return {
      contractVersion: CONTRACT_VERSION,
      selectorSetVersion: SELECTOR_SET_VERSION,
      listingDraftId: normalized.id,
      operationId: normalized.operationId,
      sourceUrl: url.toString(),
      etsyShopRef: inspection.etsyShopRef,
      observedAt: new Date().toISOString(),
      fieldsApplied: applied.length,
      fieldResults,
      imageStatus: normalized.imageCount > 0 ? "manual_required" : "not_requested",
      saveTriggered: false,
      publicPublishPerformed: false,
      credentialsIncluded: false,
    };
  }

  globalThis.EtsyDraftDomWriter = Object.freeze({ CONTRACT_VERSION, SELECTOR_SET_VERSION, normalizeDraft, assertEditorUrl, inspectEditor, applyApprovedDraft });
})();

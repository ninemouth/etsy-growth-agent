(() => {
  const CONTRACT_VERSION = "etsy-screenshot-privacy-mask.v1";
  const POLICY_VERSION = "etsy-screenshot-sensitive-selectors.2026-08-25";
  const BLOCKED_PATH = /\/(?:account|signin|login|checkout|cart|payment|billing|security|messages?|conversations?|orders?)(?:\/|$)/i;
  const SENSITIVE_SELECTORS = [
    'input[type="password"]', 'input[type="email"]', 'input[type="tel"]',
    '[autocomplete="email"]', '[autocomplete="tel"]', '[autocomplete="street-address"]',
    '[autocomplete="postal-code"]', '[autocomplete^="cc-"]',
    '[name*="email" i]', '[name*="phone" i]', '[name*="address" i]', '[name*="postal" i]',
    '[id*="email" i]', '[id*="phone" i]', '[id*="address" i]', '[id*="postal" i]',
    '[data-order-id]', '[data-private]', '[data-sensitive]', '[data-marqel-sensitive]',
  ];
  const active = new Map();

  function pageUrl(value) {
    let url;
    try { url = new URL(String(value || "")); } catch { throw new Error("The screenshot page URL is invalid."); }
    if (url.protocol !== "https:" || !/(^|\.)etsy\.com$/i.test(url.hostname)) throw new Error("Privacy masking is limited to Etsy HTTPS pages.");
    return url;
  }

  function likelySensitiveText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 240) return false;
    return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
      || /(?:\+?\d[\s().-]*){7,}/.test(text)
      || /\b(?:order|订单|address|地址|postal|postcode|zip code|收货人)\b/i.test(text);
  }

  function sensitiveElements(documentImpl) {
    const elements = new Set();
    for (const element of documentImpl.querySelectorAll(SENSITIVE_SELECTORS.join(","))) elements.add(element);
    for (const element of documentImpl.querySelectorAll("address, p, span, li, dd, dt, [role='row'], [role='cell']")) {
      if (element.children.length <= 6 && likelySensitiveText(element.textContent)) elements.add(element);
    }
    return [...elements];
  }

  function prepare({ documentImpl = document, locationHref = location.href } = {}) {
    const url = pageUrl(locationHref);
    if (BLOCKED_PATH.test(url.pathname)) {
      return { contractVersion:CONTRACT_VERSION, policyVersion:POLICY_VERSION, blocked:true, reason:"sensitive_route", sourceUrl:url.toString(), maskedCount:0, token:"" };
    }
    const token = `mask-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    const snapshots = sensitiveElements(documentImpl).map((element) => ({
      element,
      visibilityValue:element.style.getPropertyValue("visibility"),
      visibilityPriority:element.style.getPropertyPriority("visibility"),
      ariaHidden:element.getAttribute("aria-hidden"),
    }));
    for (const snapshot of snapshots) {
      snapshot.element.style.setProperty("visibility", "hidden", "important");
      snapshot.element.setAttribute("aria-hidden", "true");
      snapshot.element.setAttribute("data-marqel-screenshot-masked", token);
    }
    active.set(token, snapshots);
    return { contractVersion:CONTRACT_VERSION, policyVersion:POLICY_VERSION, blocked:false, reason:"", sourceUrl:url.toString(), maskedCount:snapshots.length, token };
  }

  function restore(token) {
    const normalized = String(token || "");
    const snapshots = active.get(normalized);
    if (!snapshots) return { contractVersion:CONTRACT_VERSION, policyVersion:POLICY_VERSION, restored:false, restoredCount:0 };
    for (const snapshot of snapshots) {
      if (snapshot.visibilityValue) snapshot.element.style.setProperty("visibility", snapshot.visibilityValue, snapshot.visibilityPriority);
      else snapshot.element.style.removeProperty("visibility");
      if (snapshot.ariaHidden === null) snapshot.element.removeAttribute("aria-hidden");
      else snapshot.element.setAttribute("aria-hidden", snapshot.ariaHidden);
      snapshot.element.removeAttribute("data-marqel-screenshot-masked");
    }
    active.delete(normalized);
    return { contractVersion:CONTRACT_VERSION, policyVersion:POLICY_VERSION, restored:true, restoredCount:snapshots.length };
  }

  globalThis.EtsyScreenshotPrivacyMask = Object.freeze({ CONTRACT_VERSION, POLICY_VERSION, likelySensitiveText, prepare, restore });
})();

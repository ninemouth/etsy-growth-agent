import assert from "node:assert/strict";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const SANITIZE_ALLOWED_TAGS = ["H1", "H2", "H3", "H4", "H5", "H6", "P", "SPAN", "DIV", "UL", "OL", "LI", "STRONG", "EM", "CODE", "PRE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "BR", "A", "HR"];
const SANITIZE_ALLOWED_ATTR = ["href", "class", "target", "rel", "title", "style"];
const SANITIZE_FORBID_TAGS = ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "SVG", "MATH", "TEMPLATE"];

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
const DOMPurify = createDOMPurify(window);

function sanitizeStyleAttr(styleValue) {
  if (!styleValue || /url\s*\(|expression\s*\(|javascript:|data:|@import|-moz-binding/i.test(styleValue)) return "";
  const allowedProps = new Set([
    "align-items", "background", "background-color", "border", "border-bottom", "border-collapse", "border-color",
    "border-left", "border-radius", "border-right", "border-top", "box-shadow", "box-sizing", "break-inside",
    "color", "display", "flex", "font-family", "font-size", "font-style", "font-weight", "gap", "height",
    "justify-content", "letter-spacing", "line-height", "list-style-type", "margin", "margin-bottom",
    "margin-left", "margin-right", "margin-top", "max-width", "min-width", "overflow", "overflow-wrap",
    "padding", "padding-bottom", "padding-left", "padding-right", "padding-top", "page-break-inside",
    "text-align", "text-decoration", "text-transform", "vertical-align", "white-space", "width",
    "word-break", "word-wrap",
  ]);

  return styleValue
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf(":");
      if (separatorIndex <= 0) return "";
      const prop = part.slice(0, separatorIndex).trim().toLowerCase();
      const value = part.slice(separatorIndex + 1).trim();
      if (!allowedProps.has(prop) || !value || /[<>]/.test(value)) return "";
      return `${prop}: ${value}`;
    })
    .filter(Boolean)
    .join("; ");
}

function sanitizeHtmlFallback(htmlString) {
  const parser = new window.DOMParser();
  const doc = parser.parseFromString(String(htmlString || ""), "text/html");
  const dropContentTags = new Set(SANITIZE_FORBID_TAGS);

  function sanitizeNode(node) {
    if (node.nodeType === window.Node.TEXT_NODE) return;
    if (node.nodeType === window.Node.ELEMENT_NODE) {
      const tagName = node.tagName.toUpperCase();
      if (!SANITIZE_ALLOWED_TAGS.includes(tagName)) {
        const parent = node.parentNode;
        if (parent && dropContentTags.has(tagName)) {
          parent.removeChild(node);
        } else if (parent) {
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          parent.removeChild(node);
        }
        return;
      }

      const attrs = Array.from(node.attributes);
      for (const attr of attrs) {
        const attrName = attr.name.toLowerCase();
        if (!SANITIZE_ALLOWED_ATTR.includes(attrName)) {
          node.removeAttribute(attr.name);
        } else if (attrName === "href") {
          const val = attr.value.trim().toLowerCase();
          if (!val.startsWith("http://") && !val.startsWith("https://") && !val.startsWith("#") && !val.startsWith("/")) {
            node.removeAttribute("href");
          }
        } else if (attrName === "target" && attr.value !== "_blank") {
          node.removeAttribute("target");
        } else if (attrName === "style") {
          const safeStyle = sanitizeStyleAttr(attr.value);
          if (safeStyle) node.setAttribute("style", safeStyle);
          else node.removeAttribute("style");
        }
      }

      if (tagName === "A" && node.getAttribute("target") === "_blank") {
        node.setAttribute("rel", "noopener noreferrer");
      }

      Array.from(node.childNodes).forEach(sanitizeNode);
    }
  }

  Array.from(doc.body.childNodes).forEach(sanitizeNode);
  return doc.body.innerHTML;
}

function sanitizeHtml(htmlString) {
  const purifiedHtml = DOMPurify.sanitize(htmlString, {
    ALLOWED_TAGS: SANITIZE_ALLOWED_TAGS.map((tag) => tag.toLowerCase()),
    ALLOWED_ATTR: SANITIZE_ALLOWED_ATTR,
    FORBID_TAGS: SANITIZE_FORBID_TAGS.map((tag) => tag.toLowerCase()),
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    RETURN_TRUSTED_TYPE: false,
    SANITIZE_DOM: true,
  });
  return sanitizeHtmlFallback(purifiedHtml);
}

function maskApiKeys(str) {
  if (!str || typeof str !== "string") return str;
  return str
    .replace(/(Bearer\s+)[a-zA-Z0-9\-_.~]+/gi, "$1sk-...****")
    .replace(/\b(sk-[a-zA-Z0-9]{8,})[a-zA-Z0-9_-]+/g, "$1****")
    .replace(/\b(gho_[a-zA-Z0-9_]{8,})[a-zA-Z0-9_]+/g, "$1****")
    .replace(/\b(github_pat_[a-zA-Z0-9_]{8,})[a-zA-Z0-9_]+/g, "$1****")
    .replace(/((?:api[_-]?key|x-api-key|authorization|token|secret|password)["'\s:=]+)(["']?)[^"'\s,}]+/gi, "$1$2****");
}

const dirtyHtml = `
  <h2 onclick="alert(1)">Report</h2>
  <script>window.evil = true</script>
  <iframe src="https://evil.example"></iframe>
  <a href="javascript:alert(1)" target="_self">bad</a>
  <a href="https://example.com" target="_blank">good</a>
  <div style="padding: 10px; text-align: left">safe layout</div>
  <span style="color:red; background-image:url(javascript:alert(1)); width:100%">styled</span>
  <table><tr><td style="padding: 10px; behavior: url(#bad)">cell</td></tr></table>
`;

const clean = sanitizeHtml(dirtyHtml);
assert.equal(clean.includes("<script"), false, "script tags must be removed");
assert.equal(clean.includes("<iframe"), false, "iframe tags must be removed");
assert.equal(clean.includes("onclick"), false, "event handler attributes must be removed");
assert.equal(clean.includes("javascript:"), false, "javascript URLs must be removed");
assert.equal(clean.includes("background-image"), false, "unsafe CSS properties must be removed");
assert.equal(clean.includes("behavior:"), false, "unsafe CSS values must be removed");
assert.match(clean, /rel="noopener noreferrer"/, "blank target links must get safe rel attributes");
assert.match(clean, /padding: 10px/, "safe report layout CSS should be preserved");
assert.match(clean, /text-align: left/, "safe report alignment CSS should be preserved");

const masked = maskApiKeys('Bearer sk-live1234567890abcdef token="github_pat_1234567890abcdef" apiKey: secret-value');
assert.equal(masked.includes("secret-value"), false, "plain apiKey value must be masked");
assert.equal(masked.includes("github_pat_1234567890abcdef"), false, "GitHub token must be masked");
assert.equal(masked.includes("sk-live1234567890abcdef"), false, "Bearer token must be masked");

const manifest = JSON.parse(read("manifest.json"));
const sidepanelSource = read("sidepanel.js");
const contentSource = read("content.js");
const agentLoopSource = read("modules/agentLoop.js");
assert.equal(manifest.permissions.includes("debugger"), false, "extension must not request debugger access");
assert.equal(manifest.host_permissions.includes("<all_urls>"), false, "extension must not request blanket install-time host access");
assert.equal(manifest.minimum_chrome_version, "114", "Side Panel builds must declare the supported Chrome floor");
assert.ok(manifest.content_scripts.every((entry) => entry.matches.every((match) => match.startsWith("https://"))), "content scripts must not run on HTTP Etsy routes");
assert.match(read("background.js"), /screenshotDisclosureConfirmed !== true/, "background must reject workflows without screenshot disclosure confirmation");
assert.match(read("DATA_GOVERNANCE.md"), /RB-01 through RB-06/, "data governance must preserve the real-browser production gate");
assert.equal((manifest.web_accessible_resources || []).length, 0, "internal extension resources must not be exposed to web pages");
assert.deepEqual(manifest.optional_host_permissions, [], "release must not offer arbitrary cross-origin permissions");
assert.match(sidepanelSource, /chrome\.permissions\.contains[\s\S]*chrome\.permissions\.request/, "custom service origins must be requested explicitly");
assert.match(sidepanelSource, /parsed\.username \|\| parsed\.password/, "custom service URLs must reject embedded credentials");
assert.match(sidepanelSource, /APPROVED_PROVIDER_ORIGINS/, "provider endpoints must be restricted to declared origins");
assert.match(contentSource, /attachShadow\(\{ mode: "closed" \}\)/, "page overlay must use a closed shadow root");
assert.match(contentSource, /Credentials and provider settings must live on an extension-origin page/, "page overlay must replace the legacy credential form before attachment");
assert.doesNotMatch(contentSource, /<input[^>]+id="(?:etsy-new-api-key|etsy-new-oauth-token|etsy-new-refresh-token|llm-api-key)"/, "page overlay source must not render secret input fields");
assert.match(agentLoopSource, /MODEL_DENIED_PAGE_MUTATION_TOOLS/, "model actions must use the centralized mutation deny policy");
for (const tool of ["click_by_text", "click_by_selector", "click_by_coordinate", "input_text_and_search", "image_search_1688", "image_search_taobao"]) {
  assert.match(agentLoopSource, new RegExp(`MODEL_DENIED_PAGE_MUTATION_TOOLS[\\s\\S]*${tool}`), `${tool} must be denied to the model`);
}

console.log("security smoke passed");

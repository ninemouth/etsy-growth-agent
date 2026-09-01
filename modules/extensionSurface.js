const DEFAULT_PAGE = "sidepanel.html";

function extensionPageUrl(chromeApi, view = "main") {
  const suffix = view === "settings" ? "#settings" : "";
  return chromeApi.runtime.getURL(`${DEFAULT_PAGE}${suffix}`);
}

async function focusOrCreateExtensionTab(chromeApi, targetUrl) {
  const pageUrl = chromeApi.runtime.getURL(DEFAULT_PAGE);
  const tabs = await chromeApi.tabs.query({});
  const existing = tabs.find((tab) => String(tab.url || "").startsWith(pageUrl));
  if (Number.isInteger(existing?.id)) {
    const tab = await chromeApi.tabs.update(existing.id, { active: true, url: targetUrl });
    return { surface: "extension_tab", tabId: tab?.id ?? existing.id, url: targetUrl, reused: true };
  }
  const tab = await chromeApi.tabs.create({ active: true, url: targetUrl });
  return { surface: "extension_tab", tabId: tab?.id ?? null, url: targetUrl, reused: false };
}

export async function openExtensionSurface(chromeApi, { tabId, view = "main" } = {}) {
  if (!chromeApi?.runtime?.getURL || !chromeApi?.tabs?.query || !chromeApi?.tabs?.create) {
    throw new Error("Chrome extension surface APIs are unavailable.");
  }

  const targetUrl = extensionPageUrl(chromeApi, view);
  let sidePanelError = null;
  if (Number.isInteger(tabId) && typeof chromeApi.sidePanel?.open === "function") {
    try {
      if (typeof chromeApi.sidePanel.setOptions === "function") {
        await chromeApi.sidePanel.setOptions({
          tabId,
          path: `${DEFAULT_PAGE}${view === "settings" ? "#settings" : ""}`,
          enabled: true,
        });
      }
      await chromeApi.sidePanel.open({ tabId });
      return { surface: "side_panel", tabId, url: targetUrl, reused: false };
    } catch (error) {
      sidePanelError = error;
    }
  }

  const fallback = await focusOrCreateExtensionTab(chromeApi, targetUrl);
  return {
    ...fallback,
    fallbackReason: sidePanelError?.message || (Number.isInteger(tabId) ? "side_panel_unavailable" : "tab_id_unavailable"),
  };
}


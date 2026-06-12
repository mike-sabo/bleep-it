"use strict";

const enabledToggle = document.getElementById("enabled-toggle");
const modeBtns = document.querySelectorAll(".mode-btn");
const openOptions = document.getElementById("open-options");
const siteRow = document.getElementById("site-row");
const siteHost = document.getElementById("site-host");
const siteToggle = document.getElementById("site-toggle");

let currentHost = "";

function siteMatches(pattern, host) {
    pattern = (pattern || "").trim().toLowerCase();
    if (!pattern) return false;
    host = host.toLowerCase();
    if (pattern.startsWith("*.")) {
        const bare = pattern.slice(2);
        return host === bare || host.endsWith("." + bare);
    }
    return host === pattern || host.endsWith("." + pattern);
}

async function getActiveHost() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return "";
        const u = new URL(tab.url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return "";
        return u.hostname;
    } catch {
        return "";
    }
}

chrome.storage.sync.get(["enabled", "mode", "disabledSites"], async (result) => {
    enabledToggle.checked = result.enabled !== false;

    const currentMode = result.mode || "blur";
    modeBtns.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === currentMode);
    });

    currentHost = await getActiveHost();
    if (!currentHost) return;

    siteHost.textContent = currentHost;
    siteRow.hidden = false;

    const disabledSites = Array.isArray(result.disabledSites) ? result.disabledSites : [];
    const matched = disabledSites.some((p) => siteMatches(p, currentHost));
    siteToggle.checked = !matched;
});

enabledToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: enabledToggle.checked });
});

modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        modeBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        chrome.storage.sync.set({ mode: btn.dataset.mode });
    });
});

siteToggle.addEventListener("change", async () => {
    if (!currentHost) return;
    const { disabledSites = [] } = await chrome.storage.sync.get("disabledSites");
    const list = Array.isArray(disabledSites) ? [...disabledSites] : [];

    if (siteToggle.checked) {
        const next = list.filter((p) => !siteMatches(p, currentHost));
        await chrome.storage.sync.set({ disabledSites: next });
    } else {
        if (!list.some((p) => siteMatches(p, currentHost))) {
            list.push(currentHost);
            await chrome.storage.sync.set({ disabledSites: list });
        }
    }

    // Reload the active tab so the content script re-initializes cleanly.
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) chrome.tabs.reload(tab.id);
    } catch {
        /* no-op */
    }
});

openOptions.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

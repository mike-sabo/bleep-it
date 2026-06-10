"use strict";

const enabledToggle = document.getElementById("enabled-toggle");
const modeBtns = document.querySelectorAll(".mode-btn");
const openOptions = document.getElementById("open-options");

// Load current settings
chrome.storage.sync.get(["enabled", "mode"], (result) => {
    enabledToggle.checked = result.enabled !== false;
    const currentMode = result.mode || "blur";
    modeBtns.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === currentMode);
    });
});

// Toggle enabled
enabledToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: enabledToggle.checked });
});

// Mode selection
modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        modeBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        chrome.storage.sync.set({ mode: btn.dataset.mode });
    });
});

// Open options page
openOptions.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

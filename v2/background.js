"use strict";

// Bleep It! Background Service Worker (Manifest V3)

// Set up context menu on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "bleep-word",
        title: "Bleep this word!",
        contexts: ["selection"],
    });

    // Initialize default settings
    chrome.storage.sync.get(["enabled", "mode"], (result) => {
        if (result.enabled === undefined) {
            chrome.storage.sync.set({ enabled: true, mode: "blur" });
        }
    });
});

// Handle context menu click — add selected word to user list
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "bleep-word" || !info.selectionText) return;

    const word = info.selectionText.trim().toLowerCase();
    if (!word) return;

    chrome.storage.sync.get("userAddedWords", (result) => {
        const words = result.userAddedWords || [];

        if (!words.includes(word)) {
            words.push(word);
            chrome.storage.sync.set({ userAddedWords: words });
        }
    });
});

// Handle messages from content script (e.g., remove word)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "removeWord" && message.word) {
        const word = message.word.trim().toLowerCase();
        chrome.storage.sync.get("userAddedWords", (result) => {
            const words = (result.userAddedWords || []).filter((w) => w !== word);
            chrome.storage.sync.set({ userAddedWords: words });
        });
    }
});

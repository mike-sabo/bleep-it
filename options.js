"use strict";

// Bleep It! Options Page

const enabledToggle = document.getElementById("enabled-toggle");
const modeOptions = document.querySelectorAll(".mode-option");
const newWordInput = document.getElementById("new-word");
const addWordBtn = document.getElementById("add-word-btn");
const wordListEl = document.getElementById("word-list");
const statusMsg = document.getElementById("status-msg");

let userWords = [];

// Load settings from storage
async function loadSettings() {
    const result = await chrome.storage.sync.get(["enabled", "mode", "userAddedWords"]);

    // Enabled toggle
    enabledToggle.checked = result.enabled !== false;

    // Mode selection
    const currentMode = result.mode || "blur";
    modeOptions.forEach((opt) => {
        opt.classList.toggle("active", opt.dataset.mode === currentMode);
    });

    // Word list
    userWords = result.userAddedWords || [];
    renderWordList();
}

function renderWordList() {
    wordListEl.innerHTML = "";
    if (userWords.length === 0) {
        wordListEl.innerHTML = '<li class="empty-state">No custom words added yet.</li>';
        return;
    }

    for (const word of userWords) {
        const li = document.createElement("li");
        li.textContent = word;

        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-btn";
        removeBtn.textContent = "×";
        removeBtn.title = "Remove word";
        removeBtn.addEventListener("click", () => removeWord(word));

        li.appendChild(removeBtn);
        wordListEl.appendChild(li);
    }
}

function showStatus(msg) {
    statusMsg.textContent = msg;
    setTimeout(() => { statusMsg.textContent = ""; }, 2000);
}

function addWord() {
    const word = newWordInput.value.trim().toLowerCase();
    if (!word) return;

    if (userWords.includes(word)) {
        showStatus("Word already in list!");
        return;
    }

    userWords.push(word);
    chrome.storage.sync.set({ userAddedWords: userWords });
    renderWordList();
    newWordInput.value = "";
    showStatus("Word added!");
}

function removeWord(word) {
    userWords = userWords.filter((w) => w !== word);
    chrome.storage.sync.set({ userAddedWords: userWords });
    renderWordList();
    showStatus("Word removed.");
}

// Event listeners
enabledToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: enabledToggle.checked });
});

modeOptions.forEach((opt) => {
    opt.addEventListener("click", () => {
        modeOptions.forEach((o) => o.classList.remove("active"));
        opt.classList.add("active");
        chrome.storage.sync.set({ mode: opt.dataset.mode });
    });
});

addWordBtn.addEventListener("click", addWord);
newWordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addWord();
});

// Initialize
loadSettings();

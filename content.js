"use strict";

/**
 * Bleep It! Content Script
 * Scans text nodes for offensive words, wraps them in a span with a CSS class,
 * and observes DOM mutations to handle dynamically loaded content.
 */

(() => {
    const BLEEPED_CLASS = "bleep-it-censored";
    const PROCESSED_ATTR = "data-bleep-processed";

    let badWordsRegex = null;
    let sillyWords = [];
    let mode = "blur"; // "blur" | "symbols" | "silly"
    let isEnabled = true;

    // Build a single regex from all bad words for efficiency
    function buildRegex(words) {
        // Escape special regex chars, sort longest first for greedy match
        const escaped = words
            .map((w) => w.trim())
            .filter((w) => w.length > 0)
            .sort((a, b) => b.length - a.length)
            .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

        if (escaped.length === 0) return null;
        return new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
    }

    // Walk all text nodes under a root element
    function getTextNodes(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                // Skip script, style, textarea, input, and already-processed nodes
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                const tag = parent.tagName;
                if (
                    tag === "SCRIPT" ||
                    tag === "STYLE" ||
                    tag === "TEXTAREA" ||
                    tag === "INPUT" ||
                    tag === "NOSCRIPT" ||
                    tag === "CODE" ||
                    tag === "PRE"
                ) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (parent.classList.contains(BLEEPED_CLASS)) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (parent.hasAttribute(PROCESSED_ATTR)) {
                    return NodeFilter.FILTER_REJECT;
                }
                // Only process nodes with actual content
                if (node.nodeValue.trim().length === 0) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        const nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        return nodes;
    }

    // Get replacement content based on mode
    function getReplacementContent(matchedWord) {
        switch (mode) {
            case "symbols":
                return "#@$!%".repeat(Math.ceil(matchedWord.length / 5)).slice(0, matchedWord.length);
            case "silly":
                return sillyWords[Math.floor(Math.random() * sillyWords.length)] || "****";
            case "blur":
            default:
                return matchedWord; // Keep original text, CSS handles the blur
        }
    }

    // Process a single text node — split it and wrap matched words
    function processTextNode(textNode) {
        const text = textNode.nodeValue;
        if (!badWordsRegex || !badWordsRegex.test(text)) return;

        // Reset regex lastIndex since we use .test() above
        badWordsRegex.lastIndex = 0;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;

        while ((match = badWordsRegex.exec(text)) !== null) {
            // Add text before the match
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            // Create the censored span
            const span = document.createElement("span");
            span.className = BLEEPED_CLASS;
            span.setAttribute("aria-label", "censored");
            span.textContent = getReplacementContent(match[0]);
            fragment.appendChild(span);

            lastIndex = badWordsRegex.lastIndex;
        }

        // Add remaining text after last match
        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        // Replace the original text node
        const parent = textNode.parentNode;
        if (parent) {
            parent.setAttribute(PROCESSED_ATTR, "");
            parent.replaceChild(fragment, textNode);
        }
    }

    // Process all text nodes under a root
    function processRoot(root) {
        if (!isEnabled || !badWordsRegex) return;
        const textNodes = getTextNodes(root);
        for (const node of textNodes) {
            processTextNode(node);
        }
    }

    // MutationObserver to handle dynamically added content
    const observer = new MutationObserver((mutations) => {
        if (!isEnabled || !badWordsRegex) return;

        for (const mutation of mutations) {
            for (const addedNode of mutation.addedNodes) {
                if (addedNode.nodeType === Node.ELEMENT_NODE) {
                    // Skip our own censored spans
                    if (addedNode.classList?.contains(BLEEPED_CLASS)) continue;
                    if (addedNode.hasAttribute?.(PROCESSED_ATTR)) continue;
                    processRoot(addedNode);
                } else if (addedNode.nodeType === Node.TEXT_NODE) {
                    processTextNode(addedNode);
                }
            }
        }
    });

    // Load settings and word lists, then start
    async function init() {
        try {
            const storage = await chrome.storage.sync.get([
                "userAddedWords",
                "mode",
                "enabled",
            ]);

            isEnabled = storage.enabled !== false; // default true
            mode = storage.mode || "blur";

            if (!isEnabled) return;

            // Clear previous processing markers and unwrap censored spans
            document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
                el.removeAttribute(PROCESSED_ATTR);
            });
            document.querySelectorAll(`.${BLEEPED_CLASS}`).forEach((el) => {
                el.replaceWith(el.textContent);
            });
            // Normalize adjacent text nodes after unwrapping
            document.body.normalize();

            // Load built-in bad words from bundled JSON
            const response = await fetch(chrome.runtime.getURL("words/bad_words.json"));
            const builtInWords = await response.json();

            // Merge user words
            const userWords = storage.userAddedWords || [];
            const allBadWords = [...builtInWords, ...userWords];

            badWordsRegex = buildRegex(allBadWords);

            // Load silly words if needed
            if (mode === "silly") {
                const sillyResponse = await fetch(chrome.runtime.getURL("words/silly_words.json"));
                sillyWords = await sillyResponse.json();
            }

            // Process existing page content
            processRoot(document.body);

            // Observe for dynamic content
            observer.observe(document.body, {
                childList: true,
                subtree: true,
            });
        } catch (err) {
            console.error("[Bleep It!] Initialization error:", err);
        }
    }

    // ─── Right-click context menu on censored words ───────────────────────
    const MENU_CLASS = "bleep-it-context-menu";
    const REVEALED_CLASS = "bleep-it-revealed";
    let activeMenu = null;

    function removeContextMenu() {
        if (activeMenu) {
            activeMenu.remove();
            activeMenu = null;
        }
    }

    function revealWord(span) {
        span.classList.add(REVEALED_CLASS);
        setTimeout(() => {
            span.classList.remove(REVEALED_CLASS);
        }, 4000);
    }

    function removeWordFromList(span) {
        const word = span.textContent.trim().toLowerCase();
        // Send message to background to remove from user words
        chrome.runtime.sendMessage({ action: "removeWord", word });
        // Uncensor this word on the page immediately
        document.querySelectorAll(`.${BLEEPED_CLASS}`).forEach((el) => {
            if (el.textContent.trim().toLowerCase() === word) {
                el.replaceWith(el.textContent);
            }
        });
    }

    // Show custom context menu on right-click of censored spans
    document.addEventListener("contextmenu", (e) => {
        const target = e.target.closest(`.${BLEEPED_CLASS}`);
        if (!target) {
            removeContextMenu();
            return;
        }

        e.preventDefault();
        removeContextMenu();

        const menu = document.createElement("div");
        menu.className = MENU_CLASS;
        menu.style.cssText = `
            position: fixed;
            left: ${e.clientX}px;
            top: ${e.clientY}px;
            z-index: 2147483647;
        `;

        const revealBtn = document.createElement("button");
        revealBtn.textContent = "👁 Reveal word (4s)";
        revealBtn.className = "bleep-it-menu-item";
        revealBtn.addEventListener("click", () => {
            revealWord(target);
            removeContextMenu();
        });

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "✕ Remove from bleeped words";
        removeBtn.className = "bleep-it-menu-item";
        removeBtn.addEventListener("click", () => {
            removeWordFromList(target);
            removeContextMenu();
        });

        menu.appendChild(revealBtn);
        menu.appendChild(removeBtn);
        document.body.appendChild(menu);
        activeMenu = menu;
    });

    // Dismiss menu on click elsewhere
    document.addEventListener("click", (e) => {
        if (activeMenu && !activeMenu.contains(e.target)) {
            removeContextMenu();
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") removeContextMenu();
    });

    // ─── Settings change listener ───────────────────────────────────────────
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync") {
            observer.disconnect();
            if (changes.enabled?.newValue === false) {
                isEnabled = false;
                document.querySelectorAll(`.${BLEEPED_CLASS}`).forEach((el) => {
                    el.replaceWith(el.textContent);
                });
            } else {
                init();
            }
        }
    });

    // Start
    init();
})();

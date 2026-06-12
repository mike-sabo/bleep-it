"use strict";

/**
 * Bleep It! Content Script — Overlay strategy
 *
 * Instead of mutating the page's DOM (which breaks React/Vue/Angular
 * reconciliation on sites like Facebook), we render fixed-position overlay
 * boxes on top of each matched word using Range.getClientRects().
 *
 * The page's own DOM is never modified — we only append a single overlay
 * container to <html>, outside of any framework-owned subtree.
 */

(() => {
    const OVERLAY_CONTAINER_ID = "bleep-it-overlay-root";
    const OVERLAY_CLASS = "bleep-it-overlay";
    const MENU_CLASS = "bleep-it-context-menu";

    const SKIP_TAGS = new Set([
        "SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE",
        "TEXTAREA", "INPUT", "SELECT", "OPTION", "CODE", "PRE",
        "IFRAME", "OBJECT", "EMBED", "CANVAS", "AUDIO", "VIDEO",
    ]);

    // Skip very large text nodes (likely JSON / data blobs embedded in DOM).
    const MAX_TEXT_LENGTH = 2000;

    let badWordsRegex = null;
    let sillyWords = [];
    let mode = "blur";
    let isEnabled = true;
    let isSiteDisabled = false;

    let overlayRoot = null;
    /** @type {{textNode: Text, start: number, end: number, word: string, els: HTMLElement[]}[]} */
    let records = [];

    let observer = null;
    let scrollListener = null;
    let resizeListener = null;
    let repositionQueued = false;

    // ─── Helpers ────────────────────────────────────────────────────────────

    function buildRegex(words) {
        const escaped = words
            .map((w) => w.trim())
            .filter((w) => w.length > 0)
            .sort((a, b) => b.length - a.length)
            .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        if (escaped.length === 0) return null;
        return new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
    }

    function isSkippableElement(el) {
        if (!el) return true;
        if (SKIP_TAGS.has(el.tagName)) return true;
        if (el.namespaceURI && el.namespaceURI !== "http://www.w3.org/1999/xhtml") return true;
        if (el.isContentEditable) return true;
        if (el.id === OVERLAY_CONTAINER_ID) return true;
        const role = el.getAttribute && el.getAttribute("role");
        if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
        return false;
    }

    function hasSkippableAncestor(node) {
        let el = node.parentElement;
        while (el) {
            if (isSkippableElement(el)) return true;
            el = el.parentElement;
        }
        return false;
    }

    function shouldScanTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        const text = node.nodeValue;
        if (!text || !text.trim()) return false;
        if (text.length > MAX_TEXT_LENGTH) return false;
        const parent = node.parentElement;
        if (!parent) return false;
        if (isSkippableElement(parent)) return false;
        if (hasSkippableAncestor(node)) return false;
        return true;
    }

    function getReplacementContent(word) {
        switch (mode) {
            case "hide":
                return "";
            case "symbols":
                return "#@$!%".repeat(Math.ceil(word.length / 5)).slice(0, word.length);
            case "silly":
                return sillyWords[Math.floor(Math.random() * sillyWords.length)] || "****";
            case "blur":
            default:
                return "";
        }
    }

    // Walk up the tree to find the first ancestor with a non-transparent
    // background, so opaque overlays blend with the surrounding page.
    function getEffectiveBackground(el) {
        let cur = el;
        while (cur && cur !== document.documentElement) {
            const cs = getComputedStyle(cur);
            const bg = cs.backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
            cur = cur.parentElement;
        }
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        if (bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent") return bodyBg;
        return "#fff";
    }

    // ─── Overlay element management ─────────────────────────────────────────

    function ensureOverlayRoot() {
        if (overlayRoot && overlayRoot.isConnected) return overlayRoot;
        overlayRoot = document.createElement("div");
        overlayRoot.id = OVERLAY_CONTAINER_ID;
        // Container itself doesn't catch events; only the overlay tiles inside it do.
        overlayRoot.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 0;
            height: 0;
            pointer-events: none;
            z-index: 2147483646;
        `;
        document.documentElement.appendChild(overlayRoot);
        return overlayRoot;
    }

    function styleOverlayEl(el, rect, parentEl, word, rectIndex) {
        el.style.left = rect.left + "px";
        el.style.top = rect.top + "px";
        el.style.width = rect.width + "px";
        el.style.height = rect.height + "px";

        if (mode === "blur") {
            el.style.backdropFilter = "blur(6px)";
            el.style.webkitBackdropFilter = "blur(6px)";
            el.style.backgroundColor = "rgba(0,0,0,0.05)";
            el.style.color = "";
            el.style.font = "";
            el.textContent = "";
        } else {
            el.style.backdropFilter = "";
            el.style.webkitBackdropFilter = "";
            const cs = getComputedStyle(parentEl);
            el.style.backgroundColor = getEffectiveBackground(parentEl);
            el.style.color = cs.color;
            el.style.font = cs.font;
            el.style.fontWeight = cs.fontWeight;
            // For multi-rect words (wrapped across lines) only the first rect
            // shows replacement text; the rest are opaque blockers.
            el.textContent = rectIndex === 0 ? getReplacementContent(word) : "";
        }
    }

    function createOverlayEl(rect, parentEl, word, rectIndex) {
        const el = document.createElement("div");
        el.className = OVERLAY_CLASS;
        el.dataset.word = word;
        el.style.cssText = `
            position: fixed;
            pointer-events: auto;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            user-select: none;
            border-radius: 2px;
            line-height: 1;
            white-space: nowrap;
        `;
        styleOverlayEl(el, rect, parentEl, word, rectIndex);
        return el;
    }

    function positionRecord(rec) {
        const node = rec.textNode;
        if (!node.isConnected) return false;
        // Verify the text hasn't changed under us.
        const slice = node.nodeValue.slice(rec.start, rec.end);
        if (slice.toLowerCase() !== rec.word.toLowerCase()) return false;

        const range = document.createRange();
        try {
            range.setStart(node, rec.start);
            range.setEnd(node, rec.end);
        } catch {
            return false;
        }
        const rects = Array.from(range.getClientRects())
            .filter((r) => r.width > 0 && r.height > 0);

        // Trim extra overlay elements.
        while (rec.els.length > rects.length) {
            rec.els.pop().remove();
        }
        const parent = node.parentElement;
        if (!parent) return false;

        for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];
            let el = rec.els[i];
            if (!el) {
                el = createOverlayEl(rect, parent, rec.word, i);
                ensureOverlayRoot().appendChild(el);
                rec.els[i] = el;
            } else {
                styleOverlayEl(el, rect, parent, rec.word, i);
            }
        }
        return rects.length > 0;
    }

    function repositionAll() {
        for (let i = records.length - 1; i >= 0; i--) {
            const rec = records[i];
            const node = rec.textNode;
            if (!node.isConnected ||
                node.nodeValue.length < rec.end ||
                node.nodeValue.slice(rec.start, rec.end).toLowerCase() !== rec.word.toLowerCase()) {
                for (const el of rec.els) el.remove();
                records.splice(i, 1);
                continue;
            }
            positionRecord(rec);
        }
    }

    function scheduleReposition() {
        if (repositionQueued) return;
        repositionQueued = true;
        requestAnimationFrame(() => {
            repositionQueued = false;
            repositionAll();
        });
    }

    // ─── Scanning ───────────────────────────────────────────────────────────

    function scanTextNode(node) {
        if (!shouldScanTextNode(node)) return;
        if (!badWordsRegex) return;
        const text = node.nodeValue;
        if (!badWordsRegex.test(text)) return;
        badWordsRegex.lastIndex = 0;
        let m;
        while ((m = badWordsRegex.exec(text)) !== null) {
            const rec = {
                textNode: node,
                start: m.index,
                end: m.index + m[0].length,
                word: m[0],
                els: [],
            };
            records.push(rec);
            positionRecord(rec);
        }
    }

    function scanRoot(root) {
        if (!root) return;
        if (root.nodeType === Node.TEXT_NODE) {
            scanTextNode(root);
            return;
        }
        if (root.nodeType !== Node.ELEMENT_NODE) return;
        if (isSkippableElement(root)) return;

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                return shouldScanTextNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            },
        });
        let n;
        while ((n = walker.nextNode())) scanTextNode(n);
    }

    // Drop any records pointing at a given text node (used when it changes).
    function dropRecordsForNode(node) {
        for (let i = records.length - 1; i >= 0; i--) {
            if (records[i].textNode === node) {
                for (const el of records[i].els) el.remove();
                records.splice(i, 1);
            }
        }
    }

    function clearAllOverlays() {
        for (const rec of records) for (const el of rec.els) el.remove();
        records = [];
        if (overlayRoot && overlayRoot.isConnected) overlayRoot.remove();
        overlayRoot = null;
    }

    // ─── MutationObserver ───────────────────────────────────────────────────

    function makeObserver() {
        return new MutationObserver((mutations) => {
            if (!isEnabled || isSiteDisabled || !badWordsRegex) return;
            let needsReposition = false;
            for (const m of mutations) {
                if (m.type === "childList") {
                    for (const added of m.addedNodes) {
                        if (added.nodeType === Node.ELEMENT_NODE &&
                            added.id === OVERLAY_CONTAINER_ID) continue;
                        scanRoot(added);
                    }
                    if (m.removedNodes.length > 0 || m.addedNodes.length > 0) {
                        needsReposition = true;
                    }
                } else if (m.type === "characterData") {
                    dropRecordsForNode(m.target);
                    scanTextNode(m.target);
                }
            }
            if (needsReposition) scheduleReposition();
        });
    }

    // ─── Init / lifecycle ───────────────────────────────────────────────────

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

    function teardown() {
        if (observer) observer.disconnect();
        observer = null;
        if (scrollListener) window.removeEventListener("scroll", scrollListener, true);
        if (resizeListener) window.removeEventListener("resize", resizeListener);
        scrollListener = null;
        resizeListener = null;
        clearAllOverlays();
    }

    async function init() {
        try {
            const storage = await chrome.storage.sync.get([
                "userAddedWords",
                "mode",
                "enabled",
                "disabledSites",
            ]);

            isEnabled = storage.enabled !== false;
            mode = storage.mode || "blur";
            const disabled = Array.isArray(storage.disabledSites) ? storage.disabledSites : [];
            isSiteDisabled = disabled.some((p) => siteMatches(p, location.hostname));

            teardown();
            if (!isEnabled || isSiteDisabled) return;

            const response = await fetch(chrome.runtime.getURL("words/bad_words.json"));
            const builtIn = await response.json();
            const user = storage.userAddedWords || [];
            badWordsRegex = buildRegex([...builtIn, ...user]);
            if (!badWordsRegex) return;

            if (mode === "silly") {
                const r = await fetch(chrome.runtime.getURL("words/silly_words.json"));
                sillyWords = await r.json();
            }

            if (!document.body) return;

            ensureOverlayRoot();
            scanRoot(document.body);

            observer = makeObserver();
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
            });

            scrollListener = () => scheduleReposition();
            resizeListener = () => scheduleReposition();
            window.addEventListener("scroll", scrollListener, true);
            window.addEventListener("resize", resizeListener);

            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(scheduleReposition);
            }
        } catch (err) {
            console.error("[Bleep It!] Initialization error:", err);
        }
    }

    // ─── Right-click context menu on overlay tiles ──────────────────────────
    let activeMenu = null;

    function removeContextMenu() {
        if (activeMenu) {
            activeMenu.remove();
            activeMenu = null;
        }
    }

    function revealWordEverywhere(word) {
        const target = word.toLowerCase();
        const matching = records.filter((r) => r.word.toLowerCase() === target);
        for (const rec of matching) for (const el of rec.els) el.style.visibility = "hidden";
        setTimeout(() => {
            for (const rec of matching) {
                for (const el of rec.els) if (el.isConnected) el.style.visibility = "";
            }
        }, 4000);
    }

    document.addEventListener("contextmenu", (e) => {
        const target = e.target.closest?.(`.${OVERLAY_CLASS}`);
        if (!target) {
            removeContextMenu();
            return;
        }
        e.preventDefault();
        removeContextMenu();

        const word = target.dataset.word || "";

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
            revealWordEverywhere(word);
            removeContextMenu();
        });

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "✕ Remove from bleeped words";
        removeBtn.className = "bleep-it-menu-item";
        removeBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "removeWord", word: word.toLowerCase() });
            removeContextMenu();
        });

        const disableSiteBtn = document.createElement("button");
        disableSiteBtn.textContent = `⊘ Disable on ${location.hostname}`;
        disableSiteBtn.className = "bleep-it-menu-item";
        disableSiteBtn.addEventListener("click", async () => {
            const { disabledSites = [] } = await chrome.storage.sync.get("disabledSites");
            const list = Array.isArray(disabledSites) ? [...disabledSites] : [];
            if (!list.includes(location.hostname)) {
                list.push(location.hostname);
                await chrome.storage.sync.set({ disabledSites: list });
            }
            removeContextMenu();
        });

        menu.append(revealBtn, removeBtn, disableSiteBtn);
        document.documentElement.appendChild(menu);
        activeMenu = menu;
    });

    document.addEventListener("click", (e) => {
        if (activeMenu && !activeMenu.contains(e.target)) removeContextMenu();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") removeContextMenu();
    });

    // ─── Settings change listener ───────────────────────────────────────────
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const relevant = ["enabled", "mode", "userAddedWords", "disabledSites"];
        if (!relevant.some((k) => k in changes)) return;
        init();
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();

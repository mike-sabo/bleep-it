"use strict";

/**
 * Bleep It! Content Script — CSS Custom Highlight API strategy
 *
 * Primary mechanism: the browser's CSS Custom Highlight API
 * (CSS.highlights + ::highlight()). Text ranges are styled at the
 * browser's text-rendering layer, which gives us three big wins over
 * positioned overlay tiles:
 *
 *   1. Highlights flow with the text natively — no scroll listeners, no
 *      flicker exposing the underlying word as the page scrolls.
 *   2. There is no DOM element on top of the page, so site chrome
 *      (Gmail's sticky headers, sidebars, popovers) is never obscured
 *      and z-index conflicts go away entirely.
 *   3. The page's own DOM is never mutated, so frameworks like
 *      React/Vue/Angular keep their virtual-DOM diffs intact.
 *
 * Fallback path: the `symbols` and `silly` modes need to *replace* the
 * word with different text, which the Highlight API can't do. For those
 * modes we render an overlay tile on top of the highlight. The
 * highlight underneath guarantees the bad word stays censored even if
 * the tile briefly lags during scroll, and the tile uses a low z-index
 * so it doesn't fight with site chrome.
 *
 * If the browser somehow lacks the Highlight API, the script falls back
 * to overlay-only rendering for every mode.
 */

(() => {
    const OVERLAY_CONTAINER_ID = "bleep-it-overlay-root";
    const OVERLAY_CLASS = "bleep-it-overlay";
    const MENU_CLASS = "bleep-it-context-menu";

    const HIGHLIGHT_NAMES = {
        blur: "bleep-it-blur",
        hide: "bleep-it-hide",
        symbols: "bleep-it-symbols",
        silly: "bleep-it-silly",
    };

    const HAS_HIGHLIGHTS =
        typeof CSS !== "undefined" &&
        CSS.highlights &&
        typeof Highlight === "function" &&
        typeof Range === "function";

    const modeNeedsOverlay = (m) => m === "symbols" || m === "silly";

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
    let highlight = null;
    let highlightName = null;
    /** @type {{textNode: Text, start: number, end: number, word: string, range: Range|null, els: HTMLElement[]}[]} */
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
            case "symbols":
                return "#@$!%".repeat(Math.ceil(word.length / 5)).slice(0, word.length);
            case "silly":
                return sillyWords[Math.floor(Math.random() * sillyWords.length)] || "****";
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

    // ─── Highlight (CSS Custom Highlight API) management ────────────────────

    function ensureHighlight() {
        if (!HAS_HIGHLIGHTS) return null;
        const desiredName = HIGHLIGHT_NAMES[mode] || HIGHLIGHT_NAMES.blur;
        if (highlight && highlightName === desiredName) return highlight;
        if (highlightName) CSS.highlights.delete(highlightName);
        highlight = new Highlight();
        highlightName = desiredName;
        CSS.highlights.set(highlightName, highlight);
        return highlight;
    }

    function clearHighlight() {
        if (highlightName && HAS_HIGHLIGHTS) CSS.highlights.delete(highlightName);
        highlight = null;
        highlightName = null;
    }

    function addRangeToHighlight(node, start, end) {
        const h = ensureHighlight();
        if (!h) return null;
        const range = new Range();
        try {
            range.setStart(node, start);
            range.setEnd(node, end);
        } catch {
            return null;
        }
        h.add(range);
        return range;
    }

    function removeRangeFromHighlight(range) {
        if (highlight && range) highlight.delete(range);
    }

    // ─── Overlay element management (symbols / silly modes only) ───────────

    function ensureOverlayRoot() {
        if (overlayRoot && overlayRoot.isConnected) return overlayRoot;
        overlayRoot = document.createElement("div");
        overlayRoot.id = OVERLAY_CONTAINER_ID;
        // Anchored to the document (not the viewport) so tiles scroll with
        // the page natively. A modest z-index keeps tiles above inline
        // content but below site chrome (Gmail headers, popovers, etc.) —
        // the Highlight API underneath guarantees the bad word stays
        // censored even if a tile is briefly covered.
        overlayRoot.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 0;
            height: 0;
            pointer-events: none;
            z-index: 1;
        `;
        document.documentElement.appendChild(overlayRoot);
        return overlayRoot;
    }

    function styleOverlayEl(el, rect, parentEl, word, rectIndex) {
        // rect is viewport-relative; convert to document coords so the absolutely
        // positioned tile rides along with the page during window scroll.
        el.style.left = (rect.left + window.scrollX) + "px";
        el.style.top = (rect.top + window.scrollY) + "px";
        el.style.width = rect.width + "px";
        el.style.height = rect.height + "px";

        const cs = getComputedStyle(parentEl);
        el.style.backgroundColor = getEffectiveBackground(parentEl);
        el.style.color = cs.color;
        el.style.font = cs.font;
        el.style.fontWeight = cs.fontWeight;
        // For multi-rect words (wrapped across lines) only the first rect
        // shows replacement text; the rest are opaque blockers.
        el.textContent = rectIndex === 0 ? getReplacementContent(word) : "";
    }

    function createOverlayEl(rect, parentEl, word, rectIndex) {
        const el = document.createElement("div");
        el.className = OVERLAY_CLASS;
        el.dataset.word = word;
        el.style.cssText = `
            position: absolute;
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

    function positionRecordOverlay(rec) {
        const node = rec.textNode;
        if (!node.isConnected) return false;
        if (!rec.range) return false;
        const rects = Array.from(rec.range.getClientRects())
            .filter((r) => r.width > 0 && r.height > 0);

        // Trim extra overlay elements.
        while (rec.els.length > rects.length) rec.els.pop().remove();
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

    function recordIsStale(rec) {
        const node = rec.textNode;
        if (!node.isConnected) return true;
        const v = node.nodeValue;
        if (!v || v.length < rec.end) return true;
        return v.slice(rec.start, rec.end).toLowerCase() !== rec.word.toLowerCase();
    }

    function dropRecord(rec) {
        for (const el of rec.els) el.remove();
        removeRangeFromHighlight(rec.range);
    }

    function repositionAll() {
        const overlaysActive = modeNeedsOverlay(mode) || !HAS_HIGHLIGHTS;
        for (let i = records.length - 1; i >= 0; i--) {
            const rec = records[i];
            if (recordIsStale(rec)) {
                dropRecord(rec);
                records.splice(i, 1);
                continue;
            }
            if (overlaysActive) positionRecordOverlay(rec);
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
        const overlaysActive = modeNeedsOverlay(mode) || !HAS_HIGHLIGHTS;
        let m;
        while ((m = badWordsRegex.exec(text)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            let range = addRangeToHighlight(node, start, end);
            if (!range && overlaysActive) {
                // No Highlight API available; we still need a Range for
                // getClientRects() when positioning the overlay.
                range = new Range();
                try { range.setStart(node, start); range.setEnd(node, end); }
                catch { range = null; }
            }
            const rec = {
                textNode: node,
                start,
                end,
                word: m[0],
                range,
                els: [],
            };
            records.push(rec);
            if (overlaysActive) positionRecordOverlay(rec);
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
                dropRecord(records[i]);
                records.splice(i, 1);
            }
        }
    }

    function cleanupDetachedRecords() {
        for (let i = records.length - 1; i >= 0; i--) {
            if (!records[i].textNode.isConnected) {
                dropRecord(records[i]);
                records.splice(i, 1);
            }
        }
    }

    function clearAllOverlays() {
        for (const rec of records) dropRecord(rec);
        records = [];
        if (overlayRoot && overlayRoot.isConnected) overlayRoot.remove();
        overlayRoot = null;
        clearHighlight();
    }

    // ─── MutationObserver ───────────────────────────────────────────────────

    function makeObserver() {
        return new MutationObserver((mutations) => {
            if (!isEnabled || isSiteDisabled || !badWordsRegex) return;
            const overlaysActive = modeNeedsOverlay(mode) || !HAS_HIGHLIGHTS;
            let hadRemovals = false;
            let needsReposition = false;
            for (const m of mutations) {
                if (m.type === "childList") {
                    for (const added of m.addedNodes) {
                        if (added.nodeType === Node.ELEMENT_NODE &&
                            added.id === OVERLAY_CONTAINER_ID) continue;
                        scanRoot(added);
                    }
                    if (m.removedNodes.length > 0) hadRemovals = true;
                    if (m.removedNodes.length > 0 || m.addedNodes.length > 0) {
                        needsReposition = true;
                    }
                } else if (m.type === "characterData") {
                    dropRecordsForNode(m.target);
                    scanTextNode(m.target);
                }
            }
            // Removed subtrees can leave records pointing at detached nodes
            // (and stale ranges sitting in the Highlight set). Sweep them.
            if (hadRemovals) cleanupDetachedRecords();
            if (needsReposition && overlaysActive) scheduleReposition();
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

            ensureHighlight();
            const overlaysActive = modeNeedsOverlay(mode) || !HAS_HIGHLIGHTS;
            if (overlaysActive) ensureOverlayRoot();

            scanRoot(document.body);

            observer = makeObserver();
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
            });

            // Highlight-only modes (blur/hide) re-flow natively with the
            // page text — no scroll/resize listeners needed. We only pay
            // that cost when overlay tiles are actually being positioned.
            if (overlaysActive) {
                scrollListener = () => scheduleReposition();
                resizeListener = () => scheduleReposition();
                window.addEventListener("scroll", scrollListener, true);
                window.addEventListener("resize", resizeListener);

                if (document.fonts && document.fonts.ready) {
                    document.fonts.ready.then(scheduleReposition);
                }
            }
        } catch (err) {
            console.error("[Bleep It!] Initialization error:", err);
        }
    }

    // ─── Right-click context menu on bleeped words ─────────────────────────
    let activeMenu = null;

    function removeContextMenu() {
        if (activeMenu) {
            activeMenu.remove();
            activeMenu = null;
        }
    }

    function getCaretPos(x, y) {
        if (document.caretRangeFromPoint) {
            const r = document.caretRangeFromPoint(x, y);
            if (!r) return null;
            return { node: r.startContainer, offset: r.startOffset };
        }
        if (document.caretPositionFromPoint) {
            const p = document.caretPositionFromPoint(x, y);
            if (!p) return null;
            return { node: p.offsetNode, offset: p.offset };
        }
        return null;
    }

    function findBleepedWordAt(x, y) {
        const pos = getCaretPos(x, y);
        if (!pos || !pos.node || pos.node.nodeType !== Node.TEXT_NODE) return null;
        for (const rec of records) {
            if (rec.textNode === pos.node &&
                pos.offset >= rec.start &&
                pos.offset <= rec.end) {
                return rec.word;
            }
        }
        return null;
    }

    function revealWordEverywhere(word) {
        const target = word.toLowerCase();
        const matching = records.filter((r) => r.word.toLowerCase() === target);
        // Temporarily hide overlay tiles (symbols / silly modes).
        for (const rec of matching) for (const el of rec.els) el.style.visibility = "hidden";
        // Temporarily remove the matching ranges from the highlight set.
        const restored = [];
        if (highlight) {
            for (const rec of matching) {
                if (rec.range) {
                    highlight.delete(rec.range);
                    restored.push(rec);
                }
            }
        }
        setTimeout(() => {
            for (const rec of matching) {
                for (const el of rec.els) if (el.isConnected) el.style.visibility = "";
            }
            if (highlight) {
                for (const rec of restored) {
                    if (rec.textNode.isConnected && rec.range) {
                        try { highlight.add(rec.range); } catch { /* range invalid */ }
                    }
                }
            }
        }, 4000);
    }

    document.addEventListener("contextmenu", (e) => {
        // First check if user right-clicked an overlay tile (symbols/silly).
        let word = null;
        const overlayTarget = e.target.closest?.(`.${OVERLAY_CLASS}`);
        if (overlayTarget) {
            word = overlayTarget.dataset.word || null;
        } else {
            // For highlight-only modes there's no element to click on, so
            // resolve the caret position to find a bleeped range underneath.
            word = findBleepedWordAt(e.clientX, e.clientY);
        }

        if (!word) {
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

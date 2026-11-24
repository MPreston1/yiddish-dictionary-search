'use strict';

// Core of the Yiddish Dictionary Search app. Load order (see index.html):
//   app.js (this file) -> ycd.js -> jnw.js -> relay.js -> ceyd.js
// This file holds what the dictionaries share (text normalization, highlighting,
// the dictionary toggles/tabs, the search entry point, Settings shell, find bar,
// Yiddish keyboard). Each dictionary lives in its own file and plugs in through
// registerDict(). These are plain scripts, so top-level names are shared between
// the files, and onclick="..." handlers in index.html can still reach them.

'use strict';

// ── Unicode normalization ───────────────────────────────────────────────────
// normalizeYiddishWithMap() is the single source of truth for every rule
// below. It walks the original text once, left to right, and for each
// "chunk" it consumes (1 original char that expands to 2, or 2 original
// chars that collapse to 1, or an ordinary passthrough char) it records
// both the normalized-text range and the original-text range that chunk
// came from. This lets callers that only need the normalized string ignore
// the map (see normalizeYiddish() below), while callers that need to
// highlight matches in the *original* text (see highlightTokens()) can
// convert a match found in normalized coordinates back to original
// coordinates.
//
// Rule behavior is identical to the previous chained-.replace() version,
// with one correction: U+FB1F is now fully decomposed all the way down to
// its primitive letters, matching what U+05F2 already produces on its own.
//   U+05F2 (Yod-Yod ligature, "double yod")            -> U+05D9 + U+05D9
//   U+FB1F (Yod-Yod-Patah ligature)                    -> U+05D9 + U+05D9 + U+05B7
//   U+05F0 (Vov-Vov ligature, "double vov")             -> U+05D5 + U+05D5
//   U+05F1 (Vov-Yod ligature)                           -> U+05D5 + U+05D9
//   U+05D1 + U+05BF (Vet, "bet" + rafe)                 -> U+05D1
//   U+05E4 + U+05BF (Fey, "pey" + rafe)                 -> U+05E4
//   U+05D5 + U+05BC (Vov + dagesh, "vov melupm")        -> U+05D5
//   U+05EA + U+05BC (Tav + dagesh)                       -> U+05EA
//   U+05DB + U+05BC (Kof, "khof" + dagesh)               -> U+05DB
//   U+05D9 + U+05B4 (Yod + hiriq, "yud khirik")          -> U+05D9
//   U+FB1D (Yod-with-hiriq precomposed ligature)          -> U+05D9
// FB1F is fully expanded (rather than left as U+05F2 + U+05B7) because text
// sourced from different places encodes "pasekh tsvey yudn" inconsistently:
// some as the single precomposed U+FB1F character, some as a separate
// U+05F2 ligature followed by a combining patah, and some as fully spelled-
// out keyboard input (two plain yuds + patah). Since the loop only checks
// each rule against characters in the *original* text (it never re-scans
// its own output), leaving FB1F at the intermediate U+05F2 + U+05B7 stage
// meant it could never reach the same fully-decomposed form the other two
// encodings produce -- so a word stored with a precomposed FB1F would never
// match the same word typed on a keyboard. Fully decomposing all three
// representations down to the same primitive letters fixes that. Pey +
// dagesh (U+05BC, "פּ") is intentionally left untouched, because YCD
// included the dagesh. Kof + dagesh (U+05BC, "כּ"), by contrast, is
// folded down to plain kof (כ) because YCD does not include the dagesh.
// Yod + hiriq (U+05B4, "יִ") is likewise folded down to plain yod (י), so
// that a search containing the pointed form also catches entries spelled
// with a bare yod (and vice versa, since the query and the entry text are
// both normalized). As with FB1F above, this letter can be encoded two
// ways depending on the source: as the single precomposed character U+FB1D,
// or as a plain yod followed by a separate combining hiriq (what a keyboard
// typically produces). Both are handled so they reduce to the same plain yod.
function normalizeYiddishWithMap(text) {
    let normalized = '';
    const chunks = []; // { normStart, normEnd, origStart, origEnd }
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        const c2 = i + 1 < text.length ? text[i + 1] : '';
        let out, consumed;
        if (c === '\u05F2') {
            out = '\u05D9\u05D9';
            consumed = 1;
        } else if (c === '\uFB1F') {
            out = '\u05D9\u05D9\u05B7';
            consumed = 1;
        } else if (c === '\u05F0') {
            out = '\u05D5\u05D5';
            consumed = 1;
        } else if (c === '\u05F1') {
            out = '\u05D5\u05D9';
            consumed = 1;
        } else if (c === '\u05D1' && c2 === '\u05BF') {
            out = '\u05D1';
            consumed = 2;
        } else if (c === '\u05E4' && c2 === '\u05BF') {
            out = '\u05E4';
            consumed = 2;
        } else if (c === '\u05D5' && c2 === '\u05BC') {
            out = '\u05D5';
            consumed = 2;
        } else if (c === '\u05EA' && c2 === '\u05BC') {
            out = '\u05EA';
            consumed = 2;
        } else if (c === '\uFB1D') {
            out = '\u05D9';
            consumed = 1;
        } else if (c === '\u05D9' && c2 === '\u05B4') {
            out = '\u05D9';
            consumed = 2;
        } else if (c === '\u05DB' && c2 === '\u05BC') {
            out = '\u05DB';
            consumed = 2;
        } else {
            out = c;
            consumed = 1;
        }

        const normStart = normalized.length;
        normalized += out;
        chunks.push({normStart, normEnd: normalized.length, origStart: i, origEnd: i + consumed});
        i += consumed;
    }
    return {normalized, chunks};
}

function normalizeYiddish(text) {
    return normalizeYiddishWithMap(text).normalized;
}

// Finds the chunk containing a given index into the normalized string
// (0 <= idx < chunks-covered length). Used to map a match found in
// normalized coordinates back to the original text's coordinates.
function findChunkForNormIndex(chunks, idx) {
    let lo = 0, hi = chunks.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const ch = chunks[mid];
        if (idx < ch.normStart) hi = mid - 1;
        else if (idx >= ch.normEnd) lo = mid + 1;
        else return ch;
    }
    return null;
}

// ── State ────────────────────────────────────────────────────────────────────
let findMatches = [];    // DOM text nodes + offsets for find-in-page
let findIndex = -1;

// ── Persistence via IndexedDB ─────────────────────────────────────────────────
// IndexedDB is far more persistent than localStorage on iOS PWAs --
// Safari does not evict it the way it does localStorage.
const IDB_NAME = 'DictionaryApp';
const IDB_STORE = 'data';
const IDB_VERSION = 1;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = e => {
            e.target.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

// Shared word-boundary definition: used by both the whole-word filters and
// the whole-word highlighter, so they can't disagree about what a "word" is.
// Uses Unicode property escapes (letters, combining marks, digits) rather than
// \w, which only covers ASCII and would treat accented Latin letters and IPA
// characters (e.g. í, ə) as word boundaries.
const WB_PRE = '(?<![\\p{L}\\p{M}\\p{N}_\u0590-\u05ff\ufb1d-\ufb4f])';
const WB_POST = '(?![\\p{L}\\p{M}\\p{N}_\u0590-\u05ff\ufb1d-\ufb4f])';

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Dictionaries: which are pressed, which are available ──────────────────────
// Which dictionaries exist is decided by the files that are loaded: each one
// calls registerDict() (see the bottom of ycd.js, jnw.js, ceyd.js). A dictionary
// may say it is not available right now (EYD, while the relay doesn't answer).
const DICTS = [];                // ids, in display order (filled by registerDict)
const dictModules = {};          // id -> {search, available?, local?, init?, onSettingsOpen?, onSettingsClose?}
let dictOn = {};                 // what the user has pressed

// A dictionary file calls this once, at load time, to plug itself into the app.
//   search(query, opts)  runs a search and fills #results-<id> / #count-<id>
//   available()          optional; false hides the dictionary (default: always available)
//   local                optional; true if search() is synchronous and local (run after the remote ones)
//   init()               optional; called once at startup (may be async)
//   onSettingsOpen() / onSettingsClose()   optional; Settings dialog hooks
function registerDict(id, mod) {
    DICTS.push(id);
    dictModules[id] = mod;
    dictOn[id] = true;
    if (mod.onSettingsOpen || mod.onSettingsClose) {
        registerSettingsHooks({open: mod.onSettingsOpen, close: mod.onSettingsClose});
    }
}

function dictAvailable(d) {
    const m = dictModules[d];
    return !m.available || m.available();
}

let activeResultTab = 'ycd';
let scopeSearchTimer = null;

function enabledDicts() {
    const on = DICTS.filter(d => dictOn[d] && dictAvailable(d));
    return on.length ? on : ['ycd'];
}

function loadDictState() {
    try {
        const saved = JSON.parse(localStorage.getItem('dictSet') || 'null');
        if (saved && typeof saved === 'object') {
            for (const d of DICTS) if (typeof saved[d] === 'boolean') dictOn[d] = saved[d];
            return;
        }
        const old = localStorage.getItem('dictScope');   // from before there were three dictionaries
        if (old === 'ycd') dictOn.jnw = false;
        if (old === 'jnw') dictOn.ycd = false;
    } catch (e) {
    }
}

// Update columns, buttons and tabs to match the current state (no search).
function refreshDictUI() {
    if (!DICTS.some(d => dictOn[d] && dictAvailable(d))) dictOn.ycd = true;
    const enabled = enabledDicts();
    for (const d of DICTS) {
        document.getElementById('col-' + d).classList.toggle('hidden-col', !enabled.includes(d));
    }
    try {
        localStorage.setItem('dictSet', JSON.stringify(dictOn));
    } catch (e) {
    }
    syncScopeUI();
}

function applyDictScope() {
    refreshDictUI();
    // Re-run the current search (if any) under the new selection. Wait until the
    // browser has painted the button/tab change first, so a press is acknowledged
    // before the (possibly slow) search starts. Rapid presses collapse into one search.
    clearTimeout(scopeSearchTimer);
    requestAnimationFrame(() => {
        scopeSearchTimer = setTimeout(doSearch, 0);
    });
}

// At least one available dictionary always stays pressed.
function toggleDict(which) {
    const next = {...dictOn, [which]: !dictOn[which]};
    if (!DICTS.some(d => next[d] && dictAvailable(d))) return;
    dictOn = next;
    applyDictScope();
}

function showResultTab(which) {
    activeResultTab = which;
    syncScopeUI();
    // Find only looks at the visible dictionary, so refresh it for the new tab.
    if (document.getElementById('findbar').classList.contains('open')) findReset();
}

// Reflect the selection in the buttons, and set up the phone tabs.
function syncScopeUI() {
    const enabled = enabledDicts();
    if (!enabled.includes(activeResultTab)) activeResultTab = enabled[0];
    for (const d of DICTS) document.getElementById('toggle-' + d).hidden = !dictAvailable(d);
    document.getElementById('results-columns').classList.toggle('tabs-on', enabled.length >= 2);
    for (const d of DICTS) {
        const on = enabled.includes(d);
        document.getElementById('toggle-' + d).setAttribute('aria-pressed', String(on));
        const tab = document.getElementById('tab-' + d);
        tab.hidden = !on;
        const isActive = activeResultTab === d;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        document.getElementById('col-' + d).classList.toggle('active-tab', isActive);
    }
}

// Mirror each column's result count (just the number) into its phone tab.
function setupTabCounts() {
    for (const d of DICTS) {
        const src = document.getElementById('count-' + d);
        const dst = document.getElementById('tabcount-' + d);
        const update = () => {
            const m = /^([\d,]+)(?: of [\d,]+)? (?:fetched )?match/.exec(src.textContent.trim());
            dst.textContent = m ? m[1] : '';
        };
        new MutationObserver(update).observe(src, {childList: true, characterData: true, subtree: true});
        update();
    }
}

// ── Search ────────────────────────────────────────────────────────────────────
// Hands the query to every dictionary that is switched on. Remote dictionaries go
// first so their requests are under way while the (synchronous) local one runs.
function doSearch() {
    const query = document.getElementById('search-input').value.trim();
    const opts = {
        wholeWord: document.getElementById('whole-word').checked,
        exactPhrase: document.getElementById('exact-phrase').checked,
        displayAll: document.getElementById('jnw-display-all').checked,   // JNW only
    };
    const enabled = enabledDicts();
    const order = [...enabled].sort((a, b) => !!dictModules[a].local - !!dictModules[b].local);
    for (const d of order) dictModules[d].search(query, opts);

    // The YCD search resets the find bar itself; if YCD is off, do it here.
    if (!enabled.includes('ycd')) closeFind(true);
}

// ── Highlighting (used by YCD and JNW) ───────────────────────────────────────
function highlightTokens(text, tokens, wholeWord = false) {
    if (!tokens || !tokens.length) return escapeHTML(text);

    // Find match positions against the normalized text (so e.g. ײ/יי and
    // בֿ/ב are treated as equivalent when matching), but keep a map back to
    // the original text so the HTML we build preserves whatever the
    // original characters actually were (e.g. a rafe diacritic that
    // normalization would otherwise have discarded).
    const {normalized, chunks} = normalizeYiddishWithMap(text);
    const lower = normalized.toLowerCase();
    const ranges = [];
    for (const token of tokens) {
        if (wholeWord) {
            // Only highlight occurrences bounded by non-word characters, matching
            // the whole-word filter used when selecting results.
            const re = new RegExp(WB_PRE + escapeRegex(token) + WB_POST, 'gu');
            let m;
            while ((m = re.exec(lower)) !== null) {
                ranges.push([m.index, m.index + m[0].length]);
                if (m[0].length === 0) re.lastIndex++;
            }
        } else {
            let pos = 0;
            while (true) {
                const idx = lower.indexOf(token, pos);
                if (idx === -1) break;
                ranges.push([idx, idx + token.length]);
                pos = idx + token.length;
            }
        }
    }
    if (!ranges.length) return escapeHTML(text);

    // Map each normalized-coordinate range to original-text coordinates.
    // If a match only partially overlaps a chunk (e.g. it lands on just one
    // of the two characters an expanded ligature produced), we round
    // outward to the whole original character(s) that chunk came from,
    // since a single original character can't be half-highlighted.
    const origRanges = ranges.map(([s, e]) => {
        const startChunk = findChunkForNormIndex(chunks, s);
        const endChunk = findChunkForNormIndex(chunks, e - 1);
        return [startChunk.origStart, endChunk.origEnd];
    });

    // Merge overlapping ranges (now in original-text coordinates; rounding
    // outward above can occasionally cause new overlaps)
    origRanges.sort((a, b) => a[0] - b[0]);
    const merged = [origRanges[0]];
    for (const [s, e] of origRanges.slice(1)) {
        if (s <= merged[merged.length - 1][1])
            merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
        else merged.push([s, e]);
    }

    // Build HTML from the ORIGINAL text, not the normalized text
    let html = '', pos = 0;
    for (const [s, e] of merged) {
        if (s > pos) html += escapeHTML(text.slice(pos, s));
        html += `<mark>${escapeHTML(text.slice(s, e))}</mark>`;
        pos = e;
    }
    if (pos < text.length) html += escapeHTML(text.slice(pos));
    return html;
}

function escapeHTML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Links to the dictionaries' own sites ─────────────────────────────────────
// The YCD / JNW title links can't work without a connection, so grey them out.
function updateDictLinks() {
    const offline = navigator.onLine === false;
    document.querySelectorAll('a.dict-link').forEach(a => {
        a.style.pointerEvents = offline ? 'none' : '';
        a.style.opacity = offline ? '.45' : '';
        if (offline) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled');
    });
}


window.addEventListener('online', updateDictLinks);
window.addEventListener('offline', updateDictLinks);
updateDictLinks();

// ── Settings dialog ───────────────────────────────────────────────────────────
// Each part with its own Settings section (the dictionaries, the relay) fills it in
// and shuts it down through hooks: registerSettingsHooks({open, close}), both optional.
// registerDict() does this for a dictionary's onSettingsOpen / onSettingsClose.
const settingsHooks = [];

function registerSettingsHooks(hooks) {
    settingsHooks.push(hooks);
}

function openSettings() {
    document.getElementById('settings-overlay').classList.add('open');
    for (const h of settingsHooks) if (h.open) h.open();
}

function closeSettings() {
    for (const h of settingsHooks) if (h.close) h.close();
    document.getElementById('settings-overlay').classList.remove('open');
}

// ── Find in results ───────────────────────────────────────────────────────────
function toggleFind() {
    const bar = document.getElementById('findbar');
    if (bar.classList.contains('open')) {
        closeFind();
    } else {
        bar.classList.add('open');
        document.getElementById('find-input').focus();
    }
}

function closeFind(silent) {
    document.getElementById('findbar').classList.remove('open');
    document.getElementById('find-input').value = '';
    document.getElementById('find-count').textContent = '';
    clearFindHighlights();
    findMatches = [];
    findIndex = -1;
}

function findReset() {
    clearFindHighlights();
    findMatches = [];
    findIndex = -1;
    document.getElementById('find-count').textContent = '';
    const q = document.getElementById('find-input').value.trim();
    if (!q) return;
    buildFindMatches(q);
    if (findMatches.length) {
        findIndex = 0;
        scrollToFind();
    }
    updateFindCount();
}

function findNext() {
    if (!findMatches.length) {
        findReset();
        return;
    }
    findIndex = (findIndex + 1) % findMatches.length;
    scrollToFind();
    updateFindCount();
}

function findPrev() {
    if (!findMatches.length) {
        findReset();
        return;
    }
    findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
    scrollToFind();
    updateFindCount();
}

function updateFindCount() {
    const el = document.getElementById('find-count');
    el.textContent = findMatches.length
        ? `${findIndex + 1} of ${findMatches.length}`
        : 'No matches';
}

// Find works by wrapping text nodes in <span class="find-hl"> elements
function buildFindMatches(query) {
    const container = document.getElementById('results-columns');
    const q = query.toLowerCase();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            const el = n.parentElement;
            if (!el || el.closest('#result-tabs')) return NodeFilter.FILTER_REJECT;
            const col = el.closest('.result-col');
            return col && col.offsetParent === null ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
    });
    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
        const text = node.textContent;
        const lower = text.toLowerCase();
        let pos = 0;
        while (true) {
            const idx = lower.indexOf(q, pos);
            if (idx === -1) break;
            hits.push({node, start: idx, end: idx + q.length});
            pos = idx + q.length;
        }
    }

    // Wrap hits in spans (process in reverse to preserve offsets)
    const spans = [];
    for (let i = hits.length - 1; i >= 0; i--) {
        const {node, start, end} = hits[i];
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const span = document.createElement('span');
        span.className = 'find-hl';
        span.style.background = '#FFE082';
        span.style.borderRadius = '2px';
        range.surroundContents(span);
        spans.unshift(span);
    }
    findMatches = spans;
}

function clearFindHighlights() {
    document.querySelectorAll('.find-hl').forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
    });
    // Merge adjacent text nodes
    document.getElementById('results-columns').normalize();
}

function scrollToFind() {
    document.querySelectorAll('.find-hl').forEach((s, i) => {
        s.style.background = i === findIndex ? '#FF9800' : '#FFE082';
    });
    if (findMatches[findIndex]) {
        findMatches[findIndex].scrollIntoView({behavior: 'smooth', block: 'center'});
    }
}

// ── Enter key on search ───────────────────────────────────────────────────────
document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
});

// ── Yiddish typing mode (Yiddish Klal layout) ─────────────────────────────────
// Maps physical keys (event.code) to the Yiddish Klal Mac layout:
// [plain, shift, option, shift+option]. Keys not listed here type normally.
const YK_MAP = {
    KeyA: ['אַ', 'א'],
    KeyS: ['ס', 'ת'],
    KeyD: ['ד', 'דזש'],
    KeyF: ['פֿ', 'ף'],
    KeyG: ['ג', 'דזש'],
    KeyH: ['ה', 'ח'],
    KeyJ: ['ײ', 'דזש'],
    KeyK: ['ק', 'כּ'],
    KeyL: ['ל', 'ל'],
    KeyQ: ['ק', 'כּ'],
    KeyW: ['ש', 'שׂ'],
    KeyE: ['ע', 'ײ'],
    KeyR: ['ר', 'טש'],
    KeyT: ['ט', 'תּ', 'תֿ'],
    KeyY: ['ײַ', 'ױ'],
    KeyU: ['ו', 'וּ'],
    KeyI: ['י', 'יִ'],
    KeyO: ['אָ', 'ױ'],
    KeyP: ['פּ', 'פ'],
    KeyZ: ['ז', 'זש'],
    KeyX: ['כ', 'ך', 'כֿ'],
    KeyC: ['צ', 'ץ'],
    KeyV: ['װ', 'בֿ'],
    KeyB: ['ב', 'בּ'],
    KeyN: ['נ', 'ן'],
    KeyM: ['מ', 'ם'],
    Minus: ['־', '-', '–', '—'],
    Equal: ['=', '+', '⸗'],
    BracketLeft: ['[', '„', '{', '’'],
    BracketRight: [']', '“', '}', '”'],
    Backslash: ['\\', '|', '׳', '״'],
    Quote: ["'", '"', '′', '″'],
    Semicolon: [';', ':', '…']
};

let yiddishOn = false;
try {
    yiddishOn = localStorage.getItem('yiddishTyping') === '1';
} catch (e) {
}
let yidLastWasTilde = false;

function updateYiddishUI() {
    const btn = document.getElementById('yid-toggle');
    btn.textContent = yiddishOn ? 'א' : 'A';
    btn.classList.toggle('on', yiddishOn);
    btn.setAttribute('aria-pressed', yiddishOn ? 'true' : 'false');
    ['search-input', 'find-input'].forEach(id =>
        document.getElementById(id).classList.toggle('yid-on', yiddishOn));
}

function setYiddish(on) {
    yiddishOn = on;
    try {
        localStorage.setItem('yiddishTyping', on ? '1' : '0');
    } catch (e) {
    }
    updateYiddishUI();
}

function insertAtCursor(el, text) {
    let ok = false;
    try {
        ok = document.execCommand('insertText', false, text);
    } catch (e) {
    }
    if (!ok) {
        const start = el.selectionStart == null ? el.value.length : el.selectionStart;
        const end = el.selectionEnd == null ? start : el.selectionEnd;
        el.setRangeText(text, start, end, 'end');
        el.dispatchEvent(new Event('input', {bubbles: true}));
    }
}

function yiddishKeydown(e) {
    if (e.isComposing || e.ctrlKey || e.metaKey) return;

    // "~" toggles the mode; "~~" types a literal "~" and leaves the mode unchanged.
    if (e.key === '~') {
        e.preventDefault();
        if (e.repeat) return;
        if (yidLastWasTilde) {
            yidLastWasTilde = false;
            setYiddish(!yiddishOn);
            insertAtCursor(e.target, '~');
        } else {
            yidLastWasTilde = true;
            setYiddish(!yiddishOn);
        }
        return;
    }

    if (['Shift', 'Alt', 'Control', 'Meta', 'CapsLock'].includes(e.key)) return;
    yidLastWasTilde = false;

    // Caps Lock types plain Latin, as in the Mac layout.
    if (!yiddishOn || e.getModifierState('CapsLock')) return;

    const m = YK_MAP[e.code];
    if (!m) return;
    const out = e.altKey ? (e.shiftKey ? m[3] : m[2]) : (e.shiftKey ? m[1] : m[0]);
    if (!out) return;
    e.preventDefault();
    insertAtCursor(e.target, out);
}

['search-input', 'find-input'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', yiddishKeydown));

const yidBtn = document.getElementById('yid-toggle');
yidBtn.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the box
yidBtn.addEventListener('click', () => {
    setYiddish(!yiddishOn);
    document.getElementById('search-input').focus();
});
updateYiddishUI();

// ── Init ──────────────────────────────────────────────────────────────────────
// Runs once every script has loaded (so every dictionary has registered). Restores
// the last-used dictionary selection and shows/hides columns accordingly, without
// triggering a search; then lets each dictionary load its own data.
function startApp() {
    loadDictState();
    refreshDictUI();
    setupTabCounts();
    for (const d of DICTS) {
        const m = dictModules[d];
        if (m.init) Promise.resolve(m.init()).catch(e => console.warn(d + ' init failed:', e));
    }
}
document.addEventListener('DOMContentLoaded', startApp);

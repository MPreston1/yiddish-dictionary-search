'use strict';

// Core of the Yiddish Dictionary Search app. Load order (see index.html):
//   app.js (this file) -> ycd.js -> jnw.js -> relay.js -> ceyd.js
// This file holds what the dictionaries share (small helpers, text normalization,
// highlighting, the dictionary toggles/tabs, the search entry point, Settings shell,
// find bar, Yiddish keyboard). Each dictionary lives in its own file and plugs in through
// registerDict(). These are plain scripts, so top-level names are shared between
// the files, and onclick="..." handlers in index.html can still reach them.

// ── Small shared helpers ─────────────────────────────────────────────────────
// Used by every file (plain scripts share their top-level names).

// Shorthand for document.getElementById.
const $ = id => document.getElementById(id);

// localStorage that never throws. It can be unavailable or full (private browsing,
// storage turned off), and nothing kept in it is worth failing over.
const store = {
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
        }
    },
    setJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
        }
    },
    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {
        }
    },
};

// Messages the dictionaries show in their results area, and a helper to show one.
// `spinner` puts the "searching" spinner in front of the text.
const MSG_PROMPT = 'Type a word and tap Search.';
const MSG_NO_MATCHES = 'No matches found.';

function showMessage(container, text, {spinner = false} = {}) {
    container.innerHTML = `<p class="message">${spinner ? '<span class="spinner"></span> ' : ''}${escapeHTML(text)}</p>`;
}

// The count line shown above a dictionary's results: 1,234 matches for "word".
function matchCountText(n, query) {
    return `${n.toLocaleString()} match${n !== 1 ? 'es' : ''} for "${query}"`;
}

// ── Unicode normalization ───────────────────────────────────────────────────
// normalizeYiddishWithMap() is the single source of truth for the normalization
// rules. It walks the original text once, left to right, and for each "chunk" it
// consumes (1 original char that expands to 2, 2 original chars that collapse to 1,
// or an ordinary passthrough char) it records both the normalized-text range and the
// original-text range that chunk came from. Callers that only need the normalized
// string use normalizeYiddish() below; callers that need to highlight matches in the
// *original* text (see highlightTokens()) use the map to convert a match found in
// normalized coordinates back to original coordinates.
//
// Why FB1F is fully decomposed: the same word ("pasekh tsvey yudn") is encoded three
// ways depending on the source: the precomposed U+FB1F, a U+05F2 ligature followed by
// a combining patah, or two plain yuds + patah typed on a keyboard. The loop only
// checks the *original* text (it never re-scans its own output), so FB1F has to go
// straight to the primitive letters for all three to reduce to the same string.
//
// Pey + dagesh is intentionally left alone, because YCD includes that dagesh. Kof +
// dagesh is folded to plain kof because YCD does not. Yod + hiriq is folded to plain
// yod so a pointed search also finds entries spelled with a bare yod (the query and
// the entry text are both normalized). Like FB1F, that letter can be encoded as the
// precomposed U+FB1D or as a yod + a separate hiriq; both reduce to the same plain yod.

// A single character that expands (or collapses) to something else.
const NORM_EXPAND = {
    '\u05F2': '\u05D9\u05D9',          // double yod             -> yod yod
    '\uFB1F': '\u05D9\u05D9\u05B7',    // yod-yod-patah          -> yod yod patah
    '\u05F0': '\u05D5\u05D5',          // double vov             -> vov vov
    '\u05F1': '\u05D5\u05D9',          // vov-yod                -> vov yod
    '\uFB1D': '\u05D9',                // yod-with-hiriq         -> yod
};

// Base letter -> the combining mark that is dropped when it directly follows it.
const NORM_DROP_MARK = {
    '\u05D1': '\u05BF',                // vet: bet + rafe
    '\u05E4': '\u05BF',                // fey: pey + rafe
    '\u05D5': '\u05BC',                // vov + dagesh ("vov melupm")
    '\u05EA': '\u05BC',                // tav + dagesh
    '\u05DB': '\u05BC',                // kof + dagesh
    '\u05D9': '\u05B4',                // yod + hiriq
};

function normalizeYiddishWithMap(text) {
    let normalized = '';
    const chunks = []; // { normStart, normEnd, origStart, origEnd }
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        let out = NORM_EXPAND[c];
        let consumed = 1;
        if (out === undefined) {
            out = c;
            const mark = NORM_DROP_MARK[c];
            if (mark && text[i + 1] === mark) consumed = 2;   // (the `mark &&` guard matters at end-of-string)
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
let findMatches = [];    // the <span class="find-hl"> elements for find-in-page (ycd.js resets this too: keep the name)
let findIndex = -1;
const FIND_HL_COLOR = '#FFE082';
const FIND_HL_CURRENT = '#FF9800';

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

// Wraps one IDBRequest in a promise.
function idbRequest(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// Reads the values stored under `keys`, as an array in the same order (a key that was
// never stored comes back undefined). The connection is always closed, even on failure.
async function idbGet(...keys) {
    const db = await openDB();
    try {
        const st = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE);
        return await Promise.all(keys.map(k => idbRequest(st.get(k))));
    } finally {
        db.close();
    }
}

// Runs fn(store) in one readwrite transaction (queue the puts/deletes inside it) and
// waits until the data is really committed. All-or-nothing: if fn throws, nothing is
// written. Rejects if the transaction errors or is aborted (e.g. storage quota), and
// always closes the connection.
async function idbWrite(fn) {
    const db = await openDB();
    try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        try {
            fn(tx.objectStore(IDB_STORE));
        } catch (e) {
            try {
                tx.abort();
            } catch (_) {
                // already finished: nothing left to roll back, and the real error matters more
            }
            throw e;
        }
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = e => reject(e.target.error);
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
    } finally {
        db.close();
    }
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

// Every non-overlapping occurrence of `needle` in `haystack`, as [start, end] pairs.
// An empty needle matches nothing (it would otherwise never advance).
function indexOfAll(haystack, needle) {
    const found = [];
    if (!needle) return found;
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
        found.push([i, i + needle.length]);
    }
    return found;
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

// What is shown when nothing else is available: the local dictionary, which never
// depends on the network or the relay.
const FALLBACK_DICT = 'ycd';
let activeResultTab = FALLBACK_DICT;
let scopeSearchTimer = null;

function enabledDicts() {
    const on = DICTS.filter(d => dictOn[d] && dictAvailable(d));
    return on.length ? on : [FALLBACK_DICT];
}

function loadDictState() {
    try {
        const saved = JSON.parse(store.get('dictSet') || 'null');
        if (saved && typeof saved === 'object') {
            for (const d of DICTS) if (typeof saved[d] === 'boolean') dictOn[d] = saved[d];
            return;
        }
        const old = store.get('dictScope');   // from before there were three dictionaries
        if (old === 'ycd') dictOn.jnw = false;
        if (old === 'jnw') dictOn.ycd = false;
    } catch (e) {
    }
}

// Update columns, buttons and tabs to match the current state (no search).
function refreshDictUI() {
    if (!DICTS.some(d => dictOn[d] && dictAvailable(d))) dictOn[FALLBACK_DICT] = true;
    const enabled = enabledDicts();
    for (const d of DICTS) {
        $('col-' + d).classList.toggle('hidden-col', !enabled.includes(d));
    }
    store.setJSON('dictSet', dictOn);
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
    if ($('findbar').classList.contains('open')) findReset();
}

// Reflect the selection in the buttons, and set up the phone tabs.
function syncScopeUI() {
    const enabled = enabledDicts();
    if (!enabled.includes(activeResultTab)) activeResultTab = enabled[0];
    $('results-columns').classList.toggle('tabs-on', enabled.length >= 2);
    for (const d of DICTS) {
        const on = enabled.includes(d);
        const isActive = activeResultTab === d;
        const toggle = $('toggle-' + d);
        toggle.hidden = !dictAvailable(d);
        toggle.setAttribute('aria-pressed', String(on));
        const tab = $('tab-' + d);
        tab.hidden = !on;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        $('col-' + d).classList.toggle('active-tab', isActive);
    }
}

// Mirror each column's result count (just the number) into its phone tab.
function setupTabCounts() {
    for (const d of DICTS) {
        const src = $('count-' + d);
        const dst = $('tabcount-' + d);
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
    const query = $('search-input').value.trim();
    const opts = {
        wholeWord: $('whole-word').checked,
        exactPhrase: $('exact-phrase').checked,
        displayAll: $('jnw-display-all').checked,   // JNW only
    };
    const enabled = enabledDicts();
    const order = enabled.sort((a, b) => !!dictModules[a].local - !!dictModules[b].local);
    for (const d of order) dictModules[d].search(query, opts);

    // The YCD search resets the find bar itself; if YCD is off, do it here.
    if (!enabled.includes('ycd')) closeFind();
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
            for (const r of indexOfAll(lower, token)) ranges.push(r);
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
    $('settings-overlay').classList.add('open');
    for (const h of settingsHooks) if (h.open) h.open();
}

function closeSettings() {
    for (const h of settingsHooks) if (h.close) h.close();
    $('settings-overlay').classList.remove('open');
}

// Esc closes the Settings dialog
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' &&
        $('settings-overlay').classList.contains('open')) {
        e.preventDefault();
        closeSettings();
    }
});

// ── Find in results ───────────────────────────────────────────────────────────
function toggleFind() {
    const bar = $('findbar');
    if (bar.classList.contains('open')) {
        closeFind();
    } else {
        bar.classList.add('open');
        $('find-input').focus();
    }
}

// Drops the highlights and the match list and blanks the counter. (The bar's own
// open/closed state and the typed query are left to the caller.)
function clearFindState() {
    clearFindHighlights();
    findMatches = [];
    findIndex = -1;
    $('find-count').textContent = '';
}

function closeFind() {
    $('findbar').classList.remove('open');
    $('find-input').value = '';
    clearFindState();
}

function findReset() {
    clearFindState();
    const q = $('find-input').value.trim();
    if (!q) return;
    buildFindMatches(q);
    if (findMatches.length) {
        findIndex = 0;
        scrollToFind();
    }
    updateFindCount();
}

// Moves to the next (+1) or previous (-1) match, wrapping around. With no matches
// yet (e.g. the query was just typed) it runs the search instead.
function stepFind(delta) {
    if (!findMatches.length) {
        findReset();
        return;
    }
    findIndex = (findIndex + delta + findMatches.length) % findMatches.length;
    scrollToFind();
    updateFindCount();
}

function findNext() {
    stepFind(1);
}

function findPrev() {
    stepFind(-1);
}

function updateFindCount() {
    const el = $('find-count');
    el.textContent = findMatches.length
        ? `${findIndex + 1} of ${findMatches.length}`
        : 'No matches';
}

// Find works by wrapping text nodes in <span class="find-hl"> elements
function buildFindMatches(query) {
    const container = $('results-columns');
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
        const lower = node.textContent.toLowerCase();
        for (const [start, end] of indexOfAll(lower, q)) hits.push({node, start, end});
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
        span.style.background = FIND_HL_COLOR;
        span.style.borderRadius = '2px';
        range.surroundContents(span);
        spans.push(span);
    }
    findMatches = spans.reverse();   // collected last-to-first; flip into document order
}

function clearFindHighlights() {
    document.querySelectorAll('.find-hl').forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
    });
    // Merge adjacent text nodes
    $('results-columns').normalize();
}

function scrollToFind() {
    findMatches.forEach((s, i) => {
        s.style.background = i === findIndex ? FIND_HL_CURRENT : FIND_HL_COLOR;
    });
    if (findMatches[findIndex]) {
        findMatches[findIndex].scrollIntoView({behavior: 'smooth', block: 'center'});
    }
}

// ── Enter key on search ───────────────────────────────────────────────────────
$('search-input').addEventListener('keydown', e => {
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

// The boxes the Yiddish keyboard works in.
const YID_INPUT_IDS = ['search-input', 'find-input'];

let yiddishOn = store.get('yiddishTyping') === '1';
let yidLastWasTilde = false;
// Pressing one of these alone types nothing and doesn't break a "~~" pair.
const YK_MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Control', 'Meta', 'CapsLock']);

function updateYiddishUI() {
    const btn = $('yid-toggle');
    btn.textContent = yiddishOn ? 'א' : 'A';
    btn.classList.toggle('on', yiddishOn);
    btn.setAttribute('aria-pressed', yiddishOn ? 'true' : 'false');
    YID_INPUT_IDS.forEach(id => $(id).classList.toggle('yid-on', yiddishOn));
}

function setYiddish(on) {
    yiddishOn = on;
    store.set('yiddishTyping', on ? '1' : '0');
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
        setYiddish(!yiddishOn);
        if (yidLastWasTilde) insertAtCursor(e.target, '~');
        yidLastWasTilde = !yidLastWasTilde;
        return;
    }

    if (YK_MODIFIER_KEYS.has(e.key)) return;
    yidLastWasTilde = false;

    // Caps Lock types plain Latin, as in the Mac layout.
    if (!yiddishOn || e.getModifierState('CapsLock')) return;

    const m = YK_MAP[e.code];
    if (!m) return;
    const out = m[(e.altKey ? 2 : 0) + (e.shiftKey ? 1 : 0)];
    if (!out) return;
    e.preventDefault();
    insertAtCursor(e.target, out);
}

YID_INPUT_IDS.forEach(id => $(id).addEventListener('keydown', yiddishKeydown));

const yidBtn = $('yid-toggle');
yidBtn.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the box
yidBtn.addEventListener('click', () => {
    setYiddish(!yiddishOn);
    $('search-input').focus();
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

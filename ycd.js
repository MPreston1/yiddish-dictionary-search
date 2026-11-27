'use strict';

// YCD: the Yiddish Cultural Dictionary. The one *local* dictionary: its entries are
// imported from a saved page (or downloaded from the site), parsed here, stored in
// IndexedDB, and searched in memory.
// Uses from app.js: $, store, showMessage/MSG_*, matchCountText, normalizeYiddish*,
// highlightTokens, WB_PRE/WB_POST, escapeRegex, escapeHTML, idbGet/idbWrite, closeFind,
// closeSettings, findMatches.

// ── State ────────────────────────────────────────────────────────────────────
let appData = {source_name: null, download_date: '', entries: []};
let currentMatches = [];   // entries from last search

// ── Persistence via IndexedDB ─────────────────────────────────────────────────
// Removes the stored YCD data (and only that). The IndexedDB store is shared with the
// JNW offline backup, so this deletes the two YCD keys rather than clearing the store.
// Throws if IndexedDB fails; callers decide what to do then.
async function clearYCDFromDB() {
    await idbWrite(st => {
        st.delete('meta');
        st.delete('entries');
    });
}

async function saveData() {
    try {
        // Store metadata and entries separately so we can load metadata fast
        await idbWrite(st => {
            st.put({
                source_name: appData.source_name,
                download_date: appData.download_date
            }, 'meta');
            st.put(appData.entries, 'entries');
        });
    } catch (e) {
        // Fall back to localStorage if IndexedDB fails
        store.setJSON('dict_backup', appData);
        console.warn('IndexedDB save failed:', e);
    }
}

async function loadData() {
    try {
        const [meta, entries] = await idbGet('meta', 'entries');
        if (meta && entries) {
            appData = {...meta, entries};
            return true;
        }
    } catch (e) {
        console.warn('IndexedDB load failed:', e);
    }
    // Try localStorage fallback
    const raw = store.get('dict_backup');
    if (raw) {
        try {
            appData = JSON.parse(raw);
            return true;
        } catch (_) {
        }
    }
    return false;
}

// ── HTML parsing (mirrors Python logic) ──────────────────────────────────────
const STOP_TERM = 'Notes, Abbreviations & Symbols';

function parseHTML(html) {
    // Pre-processing: remove malformed tags that cause false entry splits
    html = html.replace(/<p[^>]*><\/main><\/p>\s*/gi, '');
    html = html.replace(/<p[^>]*><main[^>]*><\/p>\s*/gi, '');
    // Remove <p> tags containing only an <img> -- they become false sentinels
    html = html.replace(/<p[^>]*>\s*(?:<a[^>]*>)?\s*<img[^>]*\/?>[^<]*(?:<\/a>)?\s*<\/p>\s*/gi, '');

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const firstMain = doc.querySelector('main');
    if (!firstMain) return [];

    const allParas = Array.from(doc.querySelectorAll('p'));
    const paras = [];
    for (const p of allParas) {
        const pos = firstMain.compareDocumentPosition(p);
        if (!(pos & 4) && !(pos & 16)) continue;
        let text = p.textContent;
        const stripped = text.replace(/\u00a0/g, '').replace(/&nbsp;/g, '').trim();
        if (stripped === '') {
            paras.push('');
        } else {
            text = text.replace(/\u00a0/g, ' ').replace(/&nbsp;/g, ' ').trim();
            paras.push(text);
        }
    }

    // Helper functions
    function startsWithLatin(text) {
        for (const c of text) {
            const cp = c.codePointAt(0);
            if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return true;
            if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) return false;
        }
        return false;
    }

    function splitMixedPara(text) {
        // Split a paragraph that starts with a Latin term followed by Hebrew.
        // Does NOT split paragraphs that start with Hebrew (definitions with
        // transliteration in brackets should not be mistaken for terms).
        if (!startsWithLatin(text)) return null;
        let inLatin = false;
        for (let i = 0; i < text.length; i++) {
            const cp = text.codePointAt(i);
            if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) inLatin = true;
            if (inLatin && ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f))) {
                let splitPos = i;
                while (splitPos > 0 && (text[splitPos - 1] === ' ' || text[splitPos - 1] === '\u00a0')) splitPos--;
                const termPart = text.slice(0, splitPos).trim();
                const defPart = text.slice(splitPos).trim();
                if (termPart && defPart) return [termPart, defPart];
            }
        }
        return null;
    }

    function cleanTerm(text) {
        // Strip leading non-Latin characters (e.g. stray Hebrew prefix chars like ך)
        for (let i = 0; i < text.length; i++) {
            const cp = text.codePointAt(i);
            if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return text.slice(i).trim();
        }
        return text.trim();
    }

    const entries = [];

    // Some source paragraphs contain an unbalanced term due to authoring
    // mistakes in the original HTML (see cleanTerm's note above about
    // stray leading characters) -- most commonly a missing closing
    // parenthesis, e.g. "advanced (academic level" with no ")". Rather
    // than silently leaving the term malformed, auto-append the missing
    // closing parenthes(es) and record a note on the entry so this is
    // visible (e.g. in the exported backup JSON) rather than silently
    // "fixed" and forgotten.
    function pushEntry(rawTerm, definition) {
        const term = cleanTerm(rawTerm);
        const opens = (term.match(/\(/g) || []).length;
        const closes = (term.match(/\)/g) || []).length;
        const missing = opens - closes;
        if (missing > 0) {
            entries.push({
                term: term + ')'.repeat(missing),
                definition,
                note: `Auto-added ${missing} closing parenthes${missing === 1 ? 'is' : 'es'} ` +
                    `(source term was unbalanced: "${term}")`
            });
        } else {
            entries.push({term, definition});
        }
    }

    let current = [];
    let i = 0;

    while (i < paras.length) {
        const para = paras[i];

        if (para === '') {
            if (current.length > 0) {
                // Lookahead: find next non-blank paragraph
                let j = i + 1;
                while (j < paras.length && paras[j] === '') j++;
                const nextPara = j < paras.length ? paras[j] : '';

                if (nextPara.trim() === STOP_TERM) {
                    if (current[0].trim() !== STOP_TERM)
                        pushEntry(current[0], current.slice(1));
                    break;
                }

                if (startsWithLatin(nextPara) || !nextPara) {
                    // Next para starts with Latin -> genuine end of entry
                    if (current[0].trim() !== STOP_TERM)
                        pushEntry(current[0], current.slice(1));
                    current = [];
                }
                // else: next para starts with Hebrew -> internal blank, keep going
            }
            i++;
            continue;
        }

        if (current.length === 0) {
            if (para.trim() === STOP_TERM) break;

            // Handle newline-separated term+definition (from <br/> in HTML)
            if (para.includes('\n')) {
                const parts = para.split('\n').map(p => p.trim()).filter(Boolean);
                if (parts.length > 1 && startsWithLatin(parts[0])) {
                    current.push(cleanTerm(parts[0]));
                    for (let k = 1; k < parts.length; k++) current.push(parts[k]);
                    i++;
                    continue;
                }
            }

            // Handle &nbsp;-separated term+definition in the same paragraph
            const split = splitMixedPara(para);
            if (split) {
                current.push(cleanTerm(split[0]));
                current.push(split[1]);
                i++;
                continue;
            }

            current.push(para);
        } else {
            current.push(para);
        }
        i++;
    }

    if (current.length > 0 && current[0].trim() !== STOP_TERM)
        pushEntry(current[0], current.slice(1));

    return entries;
}

// ── Bidi term display (mirrors Python logic) ──────────────────────────────────
const MIRROR = {'(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<'};

function mirrorChar(c) {
    return MIRROR[c] || c;
}

function bidiTermDisplay(text) {
    if (!text) return text;
    // Find first strong LTR character
    let first = -1;
    for (let i = 0; i < text.length; i++) {
        const cp = text.codePointAt(i);
        // Latin, Greek, Cyrillic, digits etc — not Hebrew (0x0590–0x05FF)
        if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) ||
            (cp >= 0x30 && cp <= 0x39) || (cp >= 0xC0 && cp <= 0x2AF) ||
            (cp >= 0x370 && cp <= 0x52F)) {
            first = i;
            break;
        }
    }
    if (first <= 0) return text;
    const leading = text.slice(0, first);
    const rest = text.slice(first);
    return rest + [...leading].reverse().map(mirrorChar).join('');
}

// ── Search ────────────────────────────────────────────────────────────────────
function searchYCD(query, {wholeWord = false, exactPhrase = false} = {}) {
    const entries = appData.entries;
    const results = $('results-ycd');
    const countEl = $('count-ycd');

    if (!entries.length) {
        showMessage(results, 'No dictionary loaded.');
        countEl.textContent = '';
        return;
    }
    if (!query) {
        showMessage(results, MSG_PROMPT);
        countEl.textContent = `${entries.length.toLocaleString()} entries loaded`;
        return;
    }

    // Normalize so U+FB1F matches keyboard-typed U+05F2+U+05B7
    const qNorm = normalizeYiddish(query.toLowerCase());
    const tokens = qNorm.split(/\s+/).filter(Boolean);


    function entryMatches(term, defnText) {
        const t = normalizeYiddish(term.toLowerCase());
        const d = normalizeYiddish(defnText.toLowerCase());
        if (exactPhrase && wholeWord) {
            // Both conditions together: the whole phrase, adjacent/in-order,
            // AND bounded by word boundaries at its start and end (so it can't
            // be embedded inside a longer word).
            const re = new RegExp(WB_PRE + escapeRegex(qNorm) + WB_POST, 'u');
            return re.test(t) || re.test(d);
        }
        if (exactPhrase) {
            return t.includes(qNorm) || d.includes(qNorm);
        }
        for (const token of tokens) {
            const tok = hay => wholeWord
                ? new RegExp(WB_PRE + escapeRegex(token) + WB_POST, 'u').test(hay)
                : hay.includes(token);
            if (!tok(t) && !tok(d)) return false;
        }
        return true;
    }

    currentMatches = entries.filter(e => entryMatches(e.term, e.definition.join(' ')));
    const count = currentMatches.length;
    countEl.textContent = matchCountText(count, query);

    // For exact-phrase mode, highlight only the full phrase as one unit.
    // For normal mode, highlight each individual token.
    const hlTokens = exactPhrase ? [qNorm] : tokens;
    renderResults(currentMatches, hlTokens, wholeWord);
    // Reset find state
    closeFind(true);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderResults(entries, tokens, wholeWord = false) {
    const container = $('results-ycd');
    if (!entries.length) {
        showMessage(container, MSG_NO_MATCHES);
        return;
    }

    const frag = document.createDocumentFragment();
    for (const entry of entries) {
        const div = document.createElement('div');
        div.className = 'entry';

        // Term
        const termDiv = document.createElement('div');
        termDiv.className = 'term';
        termDiv.innerHTML = highlightTokens(bidiTermDisplay(entry.term), tokens, wholeWord);
        div.appendChild(termDiv);

        // Definition paragraphs
        for (const para of entry.definition) {
            const p = document.createElement('div');
            p.className = 'defpara';
            p.innerHTML = highlightTokens(para, tokens, wholeWord);
            div.appendChild(p);
        }

        frag.appendChild(div);
    }
    container.innerHTML = '';
    container.appendChild(frag);
}

function downloadYCDBackup() {
    const entries = appData.entries || [];
    if (!entries.length) return;
    const dateStr = appData.download_date || new Date().toISOString().slice(0, 10);
    const payload = {
        source_name: appData.source_name || 'yiddishculturaldictionary.org (YCD)',
        download_date: dateStr,
        entry_count: entries.length,
        entries
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ycd_backup_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ── Status bar ────────────────────────────────────────────────────────────────
function refreshStatus() {
    const el = $('ycd-status');
    const n = appData.entries.length;
    const name = appData.source_name || '--';
    const dl = appData.download_date;
    if (n) {
        el.textContent = `Loaded: ${name}  |  ${n.toLocaleString()} entries` +
            (dl ? `  |  Downloaded: ${dl}` : '');
    } else {
        el.textContent = 'No dictionary loaded.';
    }
    $('ycd-backup-download').disabled = !n;
}

// ── File import ───────────────────────────────────────────────────────────────
function importFile() {
    $('file-input').click();
}

function handleFile(input) {
    const file = input.files[0];
    if (!file) return;
    closeSettings();
    const reader = new FileReader();
    reader.onload = e => {
        finishImport(e.target.result, file.name, '');
    };
    reader.readAsText(file, 'utf-8');
    input.value = '';
}

async function finishImport(html, sourceName, downloadDate) {
    const entries = parseHTML(html);
    if (!entries.length) {
        alert('No entries found. Make sure the file has a <main> tag and entries separated by blank paragraphs.');
        return;
    }
    // Explicitly free old data from memory and storage before loading new data,
    // so we don't briefly hold both old and new entries in memory at once.
    appData = {source_name: null, download_date: '', entries: []};
    currentMatches = [];
    findMatches = [];
    try {
        await clearYCDFromDB();
    } catch (e) {
    }

    // Now load the new data
    appData = {source_name: sourceName, download_date: downloadDate, entries};
    await saveData();
    refreshStatus();
    showMessage($('results-ycd'), 'Dictionary loaded. ' + MSG_PROMPT);
    $('count-ycd').textContent = '';
    alert(`Imported ${entries.length.toLocaleString()} entries from ${sourceName}`);
}

// ── Web import ────────────────────────────────────────────────────────────────

async function startWebImport() {
    const url = $('url-input').value.trim();
    if (!url) return;
    const progress = $('modal-progress');
    progress.innerHTML = '<span class="spinner"></span> Downloading…';

    try {
        // Use a CORS proxy since the iPhone can't do cross-origin requests directly
        // Try direct fetch first; fall back to proxy.
        let html;
        try {
            const resp = await fetch(url, {headers: {'Accept': 'text/html'}});
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            html = await resp.text();
        } catch (corsErr) {
            // Try allorigins CORS proxy
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
            const resp2 = await fetch(proxyUrl);
            if (!resp2.ok) throw new Error(`Proxy HTTP ${resp2.status}`);
            const data2 = await resp2.json();
            html = data2.contents;
        }

        const today = new Date().toISOString().slice(0, 10);
        closeSettings();
        finishImport(html, url, today);

        // Also offer to save as file on supported browsers
        if (window.showSaveFilePicker) {
            try {
                const fh = await window.showSaveFilePicker({
                    suggestedName: `downloaded_dictionary_${today}.html`,
                    types: [{description: 'HTML file', accept: {'text/html': ['.html']}}],
                });
                const writable = await fh.createWritable();
                await writable.write(html);
                await writable.close();
            } catch (e) { /* user cancelled save dialog -- fine */
            }
        }
    } catch (err) {
        progress.textContent = `Error: ${err.message}`;
    }
}

// ── Clear ─────────────────────────────────────────────────────────────────────
async function clearDictionary() {
    if (!appData.entries.length) {
        alert('No dictionary is currently loaded.');
        return;
    }
    if (!confirm('Remove the stored dictionary so you can import a new one?')) return;

    // Clear all in-memory references so the JS engine can garbage-collect
    // the entry objects immediately.
    appData = {source_name: null, download_date: '', entries: []};
    currentMatches = [];
    findMatches = [];

    // Await the async delete so IndexedDB is fully cleared before we return.
    // We explicitly delete the YCD records (not just overwrite them with empty
    // arrays) to ensure the storage is fully released. The JNW backup, which shares
    // the same store, is left alone.
    try {
        await clearYCDFromDB();
    } catch (e) {
        // Fallback: write empty data
        await saveData();
    }
    // Also clear localStorage fallback
    store.remove('dict_backup');

    refreshStatus();
    showMessage($('results-ycd'), 'Dictionary cleared.');
    $('count-ycd').textContent = '';
    $('search-input').value = '';
}

// ── Plug into the app ─────────────────────────────────────────────────────────
registerDict('ycd', {
    local: true,
    search: (query, opts) => searchYCD(query, opts),
    onSettingsOpen: refreshStatus,
    async init() {
        // loadData is async (IndexedDB), so wait for it before refreshing the UI.
        const loaded = await loadData();
        refreshStatus();
        if (appData.entries.length) {
            $('count-ycd').textContent =
                `${appData.entries.length.toLocaleString()} entries loaded`;
        }
        if (!loaded) {
            showMessage($('results-ycd'), MSG_PROMPT);
        }
    },
});

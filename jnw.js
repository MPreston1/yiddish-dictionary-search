'use strict';

// JNW: jiddischwoordenboek.nl. Searched live through its JSON API (with CORS
// fallbacks), or from a local offline backup that can be crawled, imported and
// downloaded in Settings.
// Uses from app.js: $, store, showMessage/MSG_*, matchCountText, normalizeYiddish,
// highlightTokens, WB_PRE/WB_POST, escapeRegex, escapeHTML, openDB/IDB_*.
// Also uses from relay.js: relayFetchUrl() (the Pi relay is one of the routes
// fetchWithCorsFallback tries, when it is up).

// ── JNW local backup storage (separate keys, same IndexedDB store) ─────────
async function saveJNWBackupToDB(meta, entries) {
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const st = tx.objectStore(IDB_STORE);
        st.put(meta, 'jnw_backup_meta');
        st.put(entries, 'jnw_backup_entries');
        await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = rej;
        });
        db.close();
    } catch (e) {
        console.warn('JNW backup save failed:', e);
    }
}

async function loadJNWBackupFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const st = tx.objectStore(IDB_STORE);
        const meta = await new Promise((res, rej) => {
            const r = st.get('jnw_backup_meta');
            r.onsuccess = () => res(r.result);
            r.onerror = rej;
        });
        const entries = await new Promise((res, rej) => {
            const r = st.get('jnw_backup_entries');
            r.onsuccess = () => res(r.result);
            r.onerror = rej;
        });
        db.close();
        if (meta && entries) return {meta, entries};
    } catch (e) {
        console.warn('JNW backup load failed:', e);
    }
    return null;
}

async function clearJNWBackupFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const st = tx.objectStore(IDB_STORE);
        st.delete('jnw_backup_meta');
        st.delete('jnw_backup_entries');
        await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = rej;
        });
        db.close();
    } catch (e) {
        console.warn('JNW backup clear failed:', e);
    }
}

// ── JNW live search (jiddischwoordenboek.nl) ────────────────────────────────
// JNW's site is a client-rendered Vue app, but it's backed by a JSON search
// API that the app itself calls (found by inspecting the Network tab):
//   https://jiddischwoordenboek.nl/api/search?q.all_zoek=<query>&start=0&rows=<n>
// We call that directly rather than scraping the rendered page.
let jnwSearchToken = 0;
const JNW_ROWS = 200; // how many hits to request per page (server appears to actually cap real page size around 100)
const JNW_LIVE_FETCH_CAP = 500; // live search pages up to this many total results before stopping, to balance completeness vs speed

function jnwApiUrl(query, start = 0, rows = JNW_ROWS) {
    return `https://jiddischwoordenboek.nl/api/search?q.all_zoek=${encodeURIComponent(query)}&start=${start}&rows=${rows}`;
}

function jnwWebUrl(query) {
    // A link a person can open in a browser to see the same search on JNW itself.
    return `https://jiddischwoordenboek.nl/?zoek=${encodeURIComponent(query)}`;
}

async function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, {...opts, signal: ctrl.signal});
    } finally {
        clearTimeout(timer);
    }
}

// Try a direct fetch, then a chain of public CORS proxies (each capped with
// its own timeout so one slow/dead proxy doesn't stall the whole search).
// Proxies come and go, so having more than one to fall back to matters.
async function fetchWithCorsFallback(url) {
    const attempts = [
        {name: 'direct', fetch: () => fetchWithTimeout(url, {headers: {'Accept': 'application/json'}}, 8000)},
        {
            name: 'allorigins',
            fetch: () => fetchWithTimeout(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {}, 9000)
        },
        {
            name: 'codetabs',
            fetch: () => fetchWithTimeout(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, {}, 9000)
        },
        {
            name: 'corsproxy.io',
            fetch: () => fetchWithTimeout(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, {}, 9000)
        },
    ];

    // The Pi relay (when it's reachable and offers /api/fetch) goes right after the direct
    // attempt, ahead of the public proxies: same job, but it's yours and doesn't come and go.
    const viaRelay = relayFetchUrl(url);
    if (viaRelay) {
        attempts.splice(1, 0, {
            name: 'Pi relay',
            fetch: () => fetchWithTimeout(viaRelay,
                {headers: {'X-Target-Accept': 'application/json'}}, 12000)
        });
    }

    // A route only counts if what came back looks like JNW's JSON. Otherwise (a block page,
    // an HTML shell, a proxy's error page with a 200) the next route gets its turn. If no
    // route returns JSON, the first odd response is still handed back, so the "couldn't
    // parse" panel can show what was received.
    const looksLikeJnwJson = text => {
        try {
            const data = JSON.parse(text);
            return !!data && Array.isArray(data.results) && !!data.summary;
        } catch (e) {
            return false;
        }
    };

    const errors = [];
    let oddResponse = null;
    for (const attempt of attempts) {
        try {
            const resp = await attempt.fetch();
            if (!resp.ok) {
                let why = `HTTP ${resp.status}`;
                if (attempt.name === 'Pi relay') {        // the relay says why in its JSON body
                    try {
                        const j = await resp.clone().json();
                        if (j && j.error) why += ` (${j.error})`;
                    } catch (e) {
                    }
                }
                throw new Error(why);
            }
            const text = await resp.text();
            if (!text) throw new Error('empty response');
            if (!looksLikeJnwJson(text)) {
                if (!oddResponse) oddResponse = {name: attempt.name, text};
                throw new Error('not JNW JSON');
            }
            fetchWithCorsFallback.lastVia = attempt.name; // diagnostic only — which channel actually served this
            return text;
        } catch (err) {
            const msg = err.name === 'AbortError' ? 'timed out' : err.message;
            errors.push(`${attempt.name}: ${msg}`);
        }
    }
    if (oddResponse) {
        fetchWithCorsFallback.lastVia = oddResponse.name;
        return oddResponse.text;
    }
    throw new Error(errors.join('; '));
}

// Pages live JNW search results up to `cap` total entries, advancing by
// however many the server actually returns per page (see the crawl code
// above for why — it caps real page size well below what `rows` requests).
// Cache-busted for the same reason the crawl is: proxies can serve stale
// pages otherwise. Stops early on error/parse-failure after the first page
// so a flaky later page doesn't blank out results we already have.
async function fetchJNWLivePaged(query, cap) {
    let start = 0;
    let numFound = null;
    const all = [];
    let firstPageError = null;
    let firstPageParseFailed = null;

    while (true) {
        const url = jnwApiUrl(query, start, JNW_ROWS) + `&_cb=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let raw;
        try {
            raw = await fetchWithCorsFallback(url);
        } catch (err) {
            if (start === 0) firstPageError = err;
            break;
        }

        let parsed;
        try {
            parsed = parseJNWApiResponse(raw);
        } catch (e) {
            parsed = null;
        }
        if (!parsed) {
            if (start === 0) firstPageParseFailed = raw;
            break;
        }

        numFound = parsed.numFound;
        all.push(...parsed.entries);
        const pageSize = parsed.entries.length;
        if (pageSize === 0 || all.length >= numFound || all.length >= cap) break;
        start += pageSize;
        await new Promise(r => setTimeout(r, 150)); // small courtesy pause between pages
    }

    return {entries: all, numFound: numFound ?? all.length, firstPageError, firstPageParseFailed};
}

// What the JNW count line says when it isn't showing match counts: which
// source the next search will use (like YCD's "N entries loaded").
let jnwCountShowsStatus = true;

function jnwSourceStatus() {
    const n = Array.isArray(window._jnwBackupEntries) ? window._jnwBackupEntries.length : 0;
    if (jnwOfflineModeActive() || (navigator.onLine === false && n > 0)) {
        return `${n.toLocaleString()} entries loaded (offline backup)`;
    }
    if (navigator.onLine === false) return 'no internet connection';
    return 'searching remote database';
}

function showJNWStatus() {
    $('count-jnw').textContent = jnwSourceStatus();
    jnwCountShowsStatus = true;
}

function clearJNWCount() {
    $('count-jnw').textContent = '';
    jnwCountShowsStatus = false;
}

async function searchJNW(query, opts = {}) {
    const {wholeWord = false, exactPhrase = false, displayAll = false} = opts;
    const token = ++jnwSearchToken; // lets a newer search cancel an older, in-flight one
    const container = $('results-jnw');
    const countEl = $('count-jnw');

    if (!query) {
        showMessage(container, MSG_PROMPT);
        showJNWStatus();
        return;
    }

    showMessage(container, 'Searching JNW…', {spinner: true});
    showJNWStatus();

    const webUrl = jnwWebUrl(query);
    // Use the local backup if the person turned on offline mode in Settings,
    // or automatically when the device reports no connection. (If the device
    // *claims* to be online but JNW can't be reached, there's a second
    // fallback below.)
    const hasBackup = Array.isArray(window._jnwBackupEntries) && window._jnwBackupEntries.length > 0;
    let offline = jnwOfflineModeActive();
    let autoNote = '';
    if (!offline && navigator.onLine === false) {
        if (hasBackup) {
            offline = true;
            autoNote = 'no internet connection';
        } else {
            container.innerHTML = '<div class="jnw-fallback">No internet connection, and no local JNW backup is loaded. ' +
                'Import or crawl a backup in Settings to search JNW offline.</div>';
            clearJNWCount();
            return;
        }
    }

    let entries, numFound;

    if (offline) {
        ({entries, numFound} = searchJNWLocalBackup(query));
    } else {
        const result = await fetchJNWLivePaged(query, JNW_LIVE_FETCH_CAP);
        if (token !== jnwSearchToken) return; // a newer search superseded this one

        if (result.firstPageError && hasBackup) {
            // Navigator said "online" but JNW (and every proxy) failed — e.g.
            // captive portal, bad signal. Fall back to the local backup.
            offline = true;
            autoNote = "couldn't reach JNW";
            ({entries, numFound} = searchJNWLocalBackup(query));
        } else {
            if (result.firstPageError) {
                container.innerHTML = `<div class="jnw-fallback">Couldn't reach JNW (${escapeHTML(result.firstPageError.message)}).
        <a href="${webUrl}" target="_blank" rel="noopener">Search on jiddischwoordenboek.nl ↗</a></div>`;
                clearJNWCount();
                return;
            }

            if (result.firstPageParseFailed) {
                // Couldn't confidently parse the response — don't guess. Show a link
                // out, plus the raw text we actually received so this can be fixed
                // without needing browser dev tools.
                const raw = result.firstPageParseFailed;
                const preview = raw.length > 8000 ? raw.slice(0, 8000) + '\n…(truncated)' : raw;
                container.innerHTML = `<div class="jnw-fallback">Couldn't parse JNW's response.
        <a href="${webUrl}" target="_blank" rel="noopener">Open the search on jiddischwoordenboek.nl ↗</a>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;">Show raw response received (for debugging)</summary>
          <textarea readonly style="width:100%;height:200px;font-size:10px;margin-top:6px;" onclick="this.select()">${escapeHTML(preview)}</textarea>
        </details></div>`;
                clearJNWCount();
                return;
            }

            ({entries, numFound} = result);
        }
    }

    const offlineSuffix = offline ? (autoNote ? ` (offline backup — ${autoNote})` : ' (offline backup)') : '';

    // JNW's own API has no "whole word" / "exact phrase" options, and its
    // own matching logic is broader than a literal headword match (it seems
    // to also match on other fields and/or do fuzzy matching). So unless
    // "Display all" is checked, we always filter down to entries whose
    // headword (trefwoord) literally contains the searched sequence — this
    // is the JNW-side default now. If "Whole word" is also checked, that
    // filter is additionally required to land on word boundaries (which,
    // combined with the phrase-adjacency the default already requires, is
    // the same "both conditions together" combination used on the YCD side).
    // Always run through the ranker so main-term matches come first; with
    // "Display all", non-matching entries are kept too (listed last).
    const filtered = filterJNWEntriesByTerm(entries, query, {wholeWord, keepAll: displayAll});

    const fetchedNote = entries.length < numFound ? ` (${numFound.toLocaleString()} total on JNW)` : '';

    // Same tokenization approach as YCD's highlighter, so the same searched
    // word(s) get highlighted in JNW's results too.
    const qNormJ = normalizeYiddish(query.toLowerCase());
    const tokensJ = qNormJ.split(/\s+/).filter(Boolean);
    const hlTokensJ = exactPhrase ? [qNormJ] : tokensJ;

    if (!filtered.length) {
        showMessage(container, MSG_NO_MATCHES);
        jnwCountShowsStatus = false;
        countEl.textContent = (displayAll
            ? matchCountText(0, query)
            : `0 of ${entries.length.toLocaleString()} fetched match${entries.length !== 1 ? 'es' : ''}${fetchedNote}`) + offlineSuffix;
        return;
    }

    const shown = filtered.length < entries.length
        ? `${filtered.length.toLocaleString()} of ${entries.length.toLocaleString()} fetched match${entries.length !== 1 ? 'es' : ''}${fetchedNote}`
        : (filtered.length < numFound
            ? `${filtered.length.toLocaleString()} of ${numFound.toLocaleString()} matches shown`
            : matchCountText(filtered.length, query));
    jnwCountShowsStatus = false;
    countEl.textContent = shown + offlineSuffix;

    const frag = document.createDocumentFragment();
    for (const entry of filtered) {
        const div = document.createElement('div');
        div.className = 'jnw-entry';

        const row = document.createElement('div');
        row.className = 'jnw-term-row';
        const term = document.createElement('span');
        term.className = 'jnw-term';
        term.innerHTML = highlightTokens(entry.term, hlTokensJ, wholeWord) + (entry.toevoeg ? ` (${escapeHTML(entry.toevoeg)})` : '');
        row.appendChild(term);
        if (entry.href) {
            const a = document.createElement('a');
            a.className = 'jnw-open';
            a.href = entry.href;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'JNW ↗';
            row.appendChild(a);
        }
        div.appendChild(row);

        if (entry.belongsTo && entry.belongsTo.length) {
            const bel = document.createElement('div');
            bel.className = 'jnw-belongs';
            bel.innerHTML = 'belongs to: ' + entry.belongsTo
                .map(b => `<span class="jnw-belongs-term">${highlightTokens(b, hlTokensJ, wholeWord)}</span>`)
                .join(', ');
            div.appendChild(bel);
        }
        if (entry.meta) {
            const meta = document.createElement('div');
            meta.className = 'jnw-meta';
            meta.innerHTML = entry.meta;
            div.appendChild(meta);
        }
        if (entry.kenmerk) {
            const kenmerk = document.createElement('div');
            kenmerk.className = 'jnw-kenmerk';
            kenmerk.textContent = `character: ${entry.kenmerk}`;
            div.appendChild(kenmerk);
        }
        if (entry.translation) {
            const trans = document.createElement('div');
            trans.className = 'jnw-snippet';
            trans.innerHTML = highlightTokens(entry.translation, hlTokensJ, wholeWord);
            div.appendChild(trans);
        }
        if (entry.seeAlso && entry.seeAlso.length) {
            const see = document.createElement('div');
            see.className = 'jnw-seealso';
            see.innerHTML = 'see also: ' + entry.seeAlso
                .map(x => `<span class="jnw-seealso-term">${highlightTokens(x, hlTokensJ, wholeWord)}</span>`)
                .join(' · ');
            div.appendChild(see);
        }
        if (entry.examples && entry.examples.length) {
            const box = document.createElement('div');
            box.className = 'jnw-examples';
            let html = `<div class="jnw-examples-label">Examples (${entry.examples.length})</div>`;
            for (const ex of entry.examples) {
                html += '<div class="jnw-example">' +
                    `<div class="jnw-ex-phrase">${highlightTokens(ex.phrase, hlTokensJ, wholeWord)}</div>` +
                    (ex.pron ? `<div class="jnw-ex-pron">${formatJNWMarkup(ex.pron)}</div>` : '') +
                    (ex.translation ? `<div class="jnw-ex-trans">${highlightTokens(ex.translation, hlTokensJ, wholeWord)}</div>` : '') +
                    (ex.seeAlso ? `<div class="jnw-ex-see">see also: <span>${highlightTokens(ex.seeAlso, hlTokensJ, wholeWord)}</span></div>` : '') +
                    '</div>';
            }
            box.innerHTML = html;
            div.appendChild(box);
        }
        frag.appendChild(div);
    }
    container.innerHTML = '';
    container.appendChild(frag);
}

// Filters JNW entries client-side against their headword (trefwoord),
// since JNW's own matching is broader than a literal headword match and
// its API doesn't support whole-word/exact-phrase options. Called for
// every search unless "Display all" is checked (see searchJNW).
function filterJNWEntriesByTerm(entries, query, {wholeWord, keepAll = false}) {
    // Strip bidi control marks (e.g. U+200F RLM, which JNW embeds in some
    // trefwoord_naklik values) and collapse the resulting whitespace runs
    // down to single spaces, so a plain-typed query matches an entry whose
    // multi-part term has one of these invisible marks sitting between words.
    const clean = s => s.replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();

    const qNorm = clean(normalizeYiddish(query.toLowerCase()));

    // The baseline (always applied unless "Display all" is checked) requires
    // the searched words to appear adjacent and in order in the headword —
    // i.e. the old "Exact phrase" behavior. "Whole word" strengthens that
    // same adjacent-phrase match by also requiring word boundaries at its
    // start and end, so it can't be embedded inside a longer word.
    const re = wholeWord
        ? new RegExp(WB_PRE + escapeRegex(qNorm) + WB_POST, 'u')
        : null;

    const norm = x => clean(normalizeYiddish(String(x || '').toLowerCase()));
    const hits = t => wholeWord ? re.test(t) : t.includes(qNorm);
    const anyHit = arr => arr.some(x => hits(norm(x)));

    // Ranking — lower comes first:
    //   0  the main term matches and the entry is a real headword (no belongsTo)
    //   1  the main term matches but it's a phrase that belongs to another keyword
    //   2  the keyword a phrase "belongs to" matches
    //   3  a see-also (doorverw) term matches, on the entry or on one of its examples
    //   4  no match at all (only kept when "Display all" is checked)
    // Entries keep JNW's own order within each rank (the sort is stable).
    const rankOf = e => {
        const isPhrase = (e.belongsTo || []).length > 0;
        if (hits(norm(e.term))) return isPhrase ? 1 : 0;
        if (anyHit(e.belongsTo || [])) return 2;
        if (anyHit(e.seeAlso || []) || anyHit((e.examples || []).map(x => x.seeAlso || '').filter(Boolean))) return 3;
        return 4;
    };

    return entries
        .map((e, i) => ({e, i, r: rankOf(e)}))
        .filter(x => keepAll || x.r < 4)
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map(x => x.e);
}

// Parses a response from https://jiddischwoordenboek.nl/api/search, whose
// shape is: { summary: { numFound, ... }, results: [ { trefwoord,
// trefwoord_naklik, uitspraak, uitspraak_naklik, vert_zoek, toevoeg,
// kenmerk, url, ... }, ... ] }
// Returns { entries, numFound } — entries may be empty (genuinely no
// matches) — or null if the response wasn't recognized as this API's shape
// at all (so the caller can fall back to a plain link instead of guessing).

// JNW marks up some text (in `uitspraak`/`uitspraak_naklik`) with [u]...[/u]
// to mean bold+underline. This converts that into safe HTML (escaping
// everything else first, so no other tag/markup in the source can sneak
// through).
function formatJNWMarkup(s) {
    const parts = s.split(/(\[u\]|\[\/u\])/);
    let html = '';
    let open = false;
    for (const part of parts) {
        if (part === '[u]') {
            html += '<b><u>';
            open = true;
        } else if (part === '[/u]') {
            html += '</u></b>';
            open = false;
        } else html += escapeHTML(part);
    }
    if (open) html += '</u></b>'; // close an unterminated tag defensively
    return html;
}

// A JNW field may come back as a plain string or as an array of strings
// (both shapes have been observed across different fields); this normalizes
// either into one display string.
// JNW's own top-level `kenmerk` field isn't present on search-result hits;
// it's only found embedded inside the `xml` field, a string containing the
// full raw <artikel>...<trefregel><kenmerk>...</kenmerk>...</trefregel>
// XML for that entry. DOMParser handles entity-decoding/escaping correctly,
// which a regex wouldn't reliably do.
function extractKenmerkFromXml(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') return '';
    try {
        const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
        if (doc.querySelector('parsererror')) return '';
        return doc.querySelector('kenmerk')?.textContent?.trim() || '';
    } catch (e) {
        return '';
    }
}

// A parent entry's example phrases (<voorbeeldregel> elements) aren't
// separate top-level fields on a search hit; like kenmerk they only exist
// inside the `xml` string. Each has: voorbeeld (the phrase, with "~"
// standing for the headword), uitspraak, vert_zoek/vertaling, and
// sometimes doorverw (a "see also" pointer to another phrase).
function extractExamplesFromXml(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') return [];
    try {
        const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
        if (doc.querySelector('parsererror')) return [];
        const txt = (el, sel) => el.querySelector(sel)?.textContent?.trim() || '';
        return Array.from(doc.querySelectorAll('voorbeeldregel')).map(el => ({
            phrase: txt(el, 'voorbeeld'),
            pron: txt(el, 'uitspraak'),
            // vert_zoek is the same text without [b]/[br] markup
            translation: txt(el, 'vert_zoek') || txt(el, 'vertaling').replace(/\[br\]/g, ' ').replace(/\[\/?b\]/g, ''),
            seeAlso: txt(el, 'doorverw'),
        })).filter(x => x.phrase);
    } catch (e) {
        return [];
    }
}

function extractSeeAlsoFromXml(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') return [];
    try {
        const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
        if (doc.querySelector('parsererror')) return [];
        return Array.from(doc.querySelectorAll('trefregel > doorverw')).map(el => el.textContent.trim()).filter(Boolean);
    } catch (e) {
        return [];
    }
}

function jnwFieldText(v) {
    if (Array.isArray(v)) return v.filter(Boolean).join(' ');
    if (typeof v === 'string') return v.trim();
    return '';
}

function parseJNWApiResponse(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return null;
    }
    if (!data || !Array.isArray(data.results) || !data.summary) return null;

    const numFound = Number(data.summary.numFound) || 0;
    const entries = [];
    for (const r of data.results) {
        const trefwoordText = jnwFieldText(r.trefwoord) || jnwFieldText(r.title);
        if (!trefwoordText) continue;

        // trefwoord_naklik (not always present) is displayed as a continuation
        // of trefwoord, not as a separate field.
        const trefNaklikText = jnwFieldText(r.trefwoord_naklik);
        const term = [trefwoordText, trefNaklikText].filter(Boolean).join(' ');

        const toevoeg = Array.isArray(r.toevoeg) ? r.toevoeg.join(', ') : '';

        // hoort_bij_trefwoord (present on example phrases / sub-entries such as
        // "~ אין האַרצן") lists the headword(s) the phrase belongs to — the "~"
        // stands for that headword.
        const belongsTo = (Array.isArray(r.hoort_bij_trefwoord) ? r.hoort_bij_trefwoord : (typeof r.hoort_bij_trefwoord === 'string' ? [r.hoort_bij_trefwoord] : []))
            .map(x => String(x).replace(/[\u200e\u200f]/g, '').trim()).filter(Boolean);

        // kenmerk (not always present) — a short grammatical/usage tag JNW
        // attaches to some entries. Not a top-level field on search hits; it's
        // embedded inside the `xml` field, so it's pulled out from there.
        const kenmerk = extractKenmerkFromXml(r.xml);
        const examples = extractExamplesFromXml(r.xml);

        // doorverw ("see also"): top-level array of related headwords/phrases.
        // Fall back to the entry's own <trefregel><doorverw> elements in the xml
        // (example phrases' own doorverw are handled separately, per example).
        let seeAlso = Array.isArray(r.doorverw) ? r.doorverw : (typeof r.doorverw === 'string' ? [r.doorverw] : []);
        if (!seeAlso.length) seeAlso = extractSeeAlsoFromXml(r.xml);
        seeAlso = seeAlso.map(x => String(x).replace(/[\u200e\u200f]/g, '').trim()).filter(Boolean);

        // uitspraak_naklik (not always present) is displayed as a continuation
        // of uitspraak, not as a separate field.
        const uitspraakText = Array.isArray(r.uitspraak) && r.uitspraak.length
            ? r.uitspraak.map(formatJNWMarkup).join('; ')
            : '';
        const naklikText = Array.isArray(r.uitspraak_naklik) && r.uitspraak_naklik.length
            ? r.uitspraak_naklik.map(formatJNWMarkup).join('; ')
            : '';
        const meta = [uitspraakText, naklikText].filter(Boolean).join(' ');

        const translation = Array.isArray(r.vert_zoek) ? r.vert_zoek.join('; ').replace(/\[br\]/g, ' ') : '';

        const href = r.url
            ? `https://jiddischwoordenboek.nl/api${r.url.startsWith('/') ? '' : '/'}${r.url}`
            : (r.pid ? `https://jiddischwoordenboek.nl/api/docs/${r.pid}` : null);

        entries.push({term, toevoeg, kenmerk, meta, translation, href, belongsTo, examples, seeAlso});
    }
    return {entries, numFound};
}

// ── JNW bulk backup (offline snapshot) ──────────────────────────────────────
// This is a *local backup tool*, separate from the live searchJNW() path
// above. It crawls the same public search API letter-by-letter (paging with
// `start`) to assemble a local snapshot in case jiddischwoordenboek.nl ever
// goes down. It is not wired into search — it only produces a downloadable
// JSON file.
const JNW_BASE_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ', 'ק', 'ר', 'ש', 'ת'];
const JNW_DIACRITIC_LETTERS = ['אַ', 'אָ', 'וּ', 'יִ', 'פּ', 'שׂ', 'תּ'];
const JNW_CRAWL_LETTERS = [...JNW_BASE_LETTERS, ...JNW_DIACRITIC_LETTERS];
const JNW_CRAWL_ROWS = 500; // rows per page for the backup crawl (live search still uses JNW_ROWS = 200)
const JNW_CRAWL_DELAY_MS = 350; // pause between requests to be polite to their server

let jnwCrawlCancelled = false;
let jnwCrawlRunning = false;
let jnwCrawlPauseResolve = null; // set while waiting on the user between letters

// ── Offline mode (search a locally stored backup instead of the live API) ──
let jnwBackupMeta = null;  // { source_name, crawled_date, entry_count } | null
let jnwOfflineMode = false; // whether searchJNW() should use the local backup

function jnwOfflineModeActive() {
    return jnwOfflineMode && Array.isArray(window._jnwBackupEntries) && window._jnwBackupEntries.length > 0;
}

function updateJNWOfflineUI() {
    const statusEl = $('jnw-offline-status');
    const toggleEl = $('jnw-offline-toggle');
    const clearBtn = $('jnw-clear-backup-btn');
    const downloadBtn = $('jnw-backup-download');
    const hasBackup = !!(jnwBackupMeta && Array.isArray(window._jnwBackupEntries) && window._jnwBackupEntries.length);

    if (hasBackup) {
        statusEl.textContent = `Local backup loaded: ${jnwBackupMeta.entry_count.toLocaleString()} entries` +
            (jnwBackupMeta.crawled_date ? ` (saved ${jnwBackupMeta.crawled_date})` : '');
        toggleEl.disabled = false;
        toggleEl.checked = jnwOfflineMode;
        clearBtn.disabled = false;
    } else {
        statusEl.textContent = 'No local backup loaded.';
        toggleEl.disabled = true;
        toggleEl.checked = false;
        clearBtn.disabled = true;
    }
    downloadBtn.disabled = !hasBackup;

    if (jnwCountShowsStatus) showJNWStatus();
}

// Connection changes alter which source a search would use.
window.addEventListener('online', () => {
    if (jnwCountShowsStatus) showJNWStatus();
});
window.addEventListener('offline', () => {
    if (jnwCountShowsStatus) showJNWStatus();
});

function setJNWOfflineMode(on) {
    jnwOfflineMode = on;
    store.set('jnwOfflineMode', on ? '1' : '0');
    updateJNWOfflineUI();
}

async function handleJNWBackupFile(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    let data;
    try {
        data = JSON.parse(await file.text());
    } catch (e) {
        alert('Could not read that file as JSON: ' + e.message);
        return;
    }
    if (!data || !Array.isArray(data.entries) || !data.entries.length) {
        alert('That file doesn\'t look like a JNW backup (expected an "entries" array).');
        return;
    }
    jnwBackupMeta = {
        source_name: data.source_name || 'jiddischwoordenboek.nl (JNW)',
        crawled_date: data.crawled_date || '',
        entry_count: data.entries.length
    };
    window._jnwBackupEntries = data.entries;
    await saveJNWBackupToDB(jnwBackupMeta, data.entries);
    updateJNWOfflineUI();
}

async function clearJNWBackup() {
    window._jnwBackupEntries = [];
    jnwBackupMeta = null;
    await clearJNWBackupFromDB();
    setJNWOfflineMode(false); // also updates the UI
}

// Broad substring match across term/toevoeg/translation, mirroring how
// JNW's own live API returns a broader-than-headword candidate set before
// filterJNWEntriesByTerm narrows it down. Needed because, unlike the live
// API, a local backup search starts from literally every entry.
function searchJNWLocalBackup(query) {
    const qNorm = normalizeYiddish(query.toLowerCase()).trim();
    const all = window._jnwBackupEntries || [];
    const entries = all.filter(e => {
        const hay = normalizeYiddish(`${e.term || ''} ${(e.belongsTo || []).join(' ')} ${(e.seeAlso || []).join(' ')} ${(e.examples || []).map(x => x.seeAlso || '').join(' ')} ${e.toevoeg || ''} ${e.translation || ''}`.toLowerCase());
        return hay.includes(qNorm);
    });
    return {entries, numFound: entries.length};
}

function cancelJNWBackup() {
    jnwCrawlStop();
}

// Called from the "Continue to Next Letter" / "Stop Here" pause buttons.
function jnwCrawlContinue() {
    if (jnwCrawlPauseResolve) {
        const r = jnwCrawlPauseResolve;
        jnwCrawlPauseResolve = null;
        r(true);
    }
}

function jnwCrawlStop() {
    jnwCrawlCancelled = true;
    if (jnwCrawlPauseResolve) {
        const r = jnwCrawlPauseResolve;
        jnwCrawlPauseResolve = null;
        r(false);
    }
}

function waitForUserToContinue() {
    $('jnw-backup-pause-btns').style.display = 'flex';
    return new Promise(resolve => {
        jnwCrawlPauseResolve = resolve;
    });
}

// Crawls one query term (a letter + '*') to exhaustion, paging with `start`,
// merging results into the given Map (dedupe key: href, else
// term|toevoeg|translation). Shared by the full multi-letter crawl and the
// single-letter tool below. Returns { gotThisLetter, addedThisLetter, numFound }.
async function crawlOneLetterIntoMap(letter, seenMap, logEl, progressEl, labelIndex, labelTotal) {
    const queryTerm = letter + '*';
    let start = 0, numFound = null, gotThisLetter = 0, addedThisLetter = 0;

    while (true) {
        if (jnwCrawlCancelled) break;
        progressEl.textContent =
            (labelIndex != null ? `Letter ${labelIndex}/${labelTotal} ` : '') +
            `"${queryTerm}" — start=${start}${numFound !== null ? ` of ${numFound}` : ''} — ` +
            `${seenMap.size.toLocaleString()} unique entries so far`;

        let raw;
        try {
            // Cache-bust: several free CORS proxies cache responses, sometimes
            // loosely enough that different `start` values can come back
            // identical. Appending a unique, harmless param forces a fresh
            // request each time without affecting how JNW's own API parses it.
            const bustedUrl = jnwApiUrl(queryTerm, start, JNW_CRAWL_ROWS) + `&_cb=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            raw = await fetchWithCorsFallback(bustedUrl);
        } catch (err) {
            logEl.textContent += `⚠ "${queryTerm}" @ start=${start}: ${err.message}\n`;
            logEl.scrollTop = logEl.scrollHeight;
            break; // give up on this letter, move to the next one
        }

        let parsed;
        try {
            parsed = parseJNWApiResponse(raw);
        } catch (e) {
            parsed = null;
        }
        if (!parsed) {
            logEl.textContent += `⚠ "${queryTerm}" @ start=${start}: couldn't parse response\n`;
            logEl.scrollTop = logEl.scrollHeight;
            break;
        }

        // Diagnostic fingerprint: first and last returned term, plus which
        // proxy channel served this page. If these repeat identically across
        // different `start` values, the requests are being served from a cache
        // (proxy-side) rather than genuinely re-querying JNW.
        const firstTerm = parsed.entries[0]?.term || '(none)';
        const lastTerm = parsed.entries[parsed.entries.length - 1]?.term || '(none)';
        logEl.textContent += `  (via ${fetchWithCorsFallback.lastVia || '?'}) start=${start}: first="${firstTerm}" last="${lastTerm}"\n`;
        logEl.scrollTop = logEl.scrollHeight;

        numFound = parsed.numFound;
        let addedThisPage = 0;
        for (const e of parsed.entries) {
            // Include toevoeg (the field that seems to carry homograph/sense
            // distinctions) so two different entries that happen to share the
            // same headword + translation don't collapse into one.
            const key = e.href || `${e.term}|${e.toevoeg}|${e.translation}`;
            if (!seenMap.has(key)) {
                seenMap.set(key, e);
                addedThisPage++;
            }
        }
        gotThisLetter += parsed.entries.length;
        addedThisLetter += addedThisPage;

        // If a page returns far fewer *new* entries than it returned *raw*
        // results, that page was mostly re-serving documents we already have —
        // a sign of unstable pagination on the server side rather than a
        // dedup problem here. Surface it instead of hiding it.
        if (parsed.entries.length > 0 && addedThisPage < parsed.entries.length * 0.5) {
            logEl.textContent += `  ↳ note: page at start=${start} returned ${parsed.entries.length} results but only ${addedThisPage} were new (possible unstable pagination)\n`;
            logEl.scrollTop = logEl.scrollHeight;
        }

        // Advance by however many entries the server actually returned, not by
        // the rows we requested — the server appears to cap the real page size
        // well below what we ask for, and stepping by the requested amount
        // silently skips everything in between.
        const pageSize = parsed.entries.length;
        const reachedEnd = pageSize === 0 || gotThisLetter >= numFound;
        if (reachedEnd) break;
        start += pageSize;
        await new Promise(r => setTimeout(r, JNW_CRAWL_DELAY_MS));
    }

    logEl.textContent += `"${queryTerm}": ${gotThisLetter.toLocaleString()} raw results, ${addedThisLetter.toLocaleString()} new unique (numFound=${numFound ?? '?'})\n`;
    logEl.scrollTop = logEl.scrollHeight;

    return {gotThisLetter, addedThisLetter, numFound};
}

async function startJNWBackup() {
    if (jnwCrawlRunning) return;
    jnwCrawlRunning = true;
    jnwCrawlCancelled = false;

    const progressEl = $('jnw-backup-progress');
    const logEl = $('jnw-backup-log');
    const startBtn = $('jnw-backup-start');
    const cancelBtn = $('jnw-backup-cancel');
    const downloadBtn = $('jnw-backup-download');
    const singleBtn = $('jnw-single-letter-btn');

    logEl.textContent = '';
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    downloadBtn.disabled = true;
    singleBtn.disabled = true;

    const seen = new Map(); // dedupe key -> entry

    for (let i = 0; i < JNW_CRAWL_LETTERS.length; i++) {
        if (jnwCrawlCancelled) break;
        const letter = JNW_CRAWL_LETTERS[i];

        await crawlOneLetterIntoMap(letter, seen, logEl, progressEl, i + 1, JNW_CRAWL_LETTERS.length);

        const isLastLetter = i === JNW_CRAWL_LETTERS.length - 1;
        if (jnwCrawlCancelled || isLastLetter) continue;

        progressEl.textContent =
            `Paused after "${letter}*" (${i + 1}/${JNW_CRAWL_LETTERS.length}) — ` +
            `${seen.size.toLocaleString()} unique entries so far. Continue to "${JNW_CRAWL_LETTERS[i + 1]}*"?`;
        const shouldContinue = await waitForUserToContinue();
        $('jnw-backup-pause-btns').style.display = 'none';
        if (!shouldContinue) break;
    }

    $('jnw-backup-pause-btns').style.display = 'none';
    window._jnwBackupEntries = Array.from(seen.values());
    progressEl.textContent = jnwCrawlCancelled
        ? `Cancelled — ${seen.size.toLocaleString()} unique entries collected so far.`
        : `Done — ${seen.size.toLocaleString()} unique entries collected.`;

    if (window._jnwBackupEntries.length) {
        jnwBackupMeta = {
            source_name: 'jiddischwoordenboek.nl (JNW)',
            crawled_date: new Date().toISOString().slice(0, 10),
            entry_count: window._jnwBackupEntries.length
        };
        await saveJNWBackupToDB(jnwBackupMeta, window._jnwBackupEntries);
    }
    updateJNWOfflineUI();

    startBtn.disabled = false;
    cancelBtn.disabled = true;
    singleBtn.disabled = false;
    jnwCrawlRunning = false;
}

// Crawls just one letter/diacritic (for testing, or to top up an existing
// backup incrementally). Merges into whatever backup is already loaded
// rather than starting over, unlike the full multi-letter crawl above.
async function startJNWSingleLetterCrawl() {
    if (jnwCrawlRunning) return;
    const letter = $('jnw-single-letter-select').value;
    if (!letter) return;

    jnwCrawlRunning = true;
    jnwCrawlCancelled = false;

    const progressEl = $('jnw-backup-progress');
    const logEl = $('jnw-backup-log');
    const startBtn = $('jnw-backup-start');
    const cancelBtn = $('jnw-backup-cancel');
    const singleBtn = $('jnw-single-letter-btn');

    startBtn.disabled = true;
    cancelBtn.disabled = false;
    singleBtn.disabled = true;

    logEl.textContent += `— Testing "${letter}*" only —\n`;
    logEl.scrollTop = logEl.scrollHeight;

    // Seed the dedupe map from whatever backup already exists, so this adds
    // to it rather than replacing it.
    const seen = new Map();
    for (const e of (window._jnwBackupEntries || [])) {
        const key = e.href || `${e.term}|${e.toevoeg}|${e.translation}`;
        seen.set(key, e);
    }
    const before = seen.size;

    await crawlOneLetterIntoMap(letter, seen, logEl, progressEl, null, null);

    window._jnwBackupEntries = Array.from(seen.values());
    jnwBackupMeta = {
        source_name: jnwBackupMeta?.source_name || 'jiddischwoordenboek.nl (JNW)',
        crawled_date: new Date().toISOString().slice(0, 10),
        entry_count: window._jnwBackupEntries.length
    };
    await saveJNWBackupToDB(jnwBackupMeta, window._jnwBackupEntries);
    updateJNWOfflineUI();

    progressEl.textContent = jnwCrawlCancelled
        ? `Stopped — added ${(seen.size - before).toLocaleString()} new entries so far (${seen.size.toLocaleString()} total in backup).`
        : `Done testing "${letter}*" — added ${(seen.size - before).toLocaleString()} new entries (${seen.size.toLocaleString()} total in backup).`;

    startBtn.disabled = false;
    cancelBtn.disabled = true;
    singleBtn.disabled = false;
    jnwCrawlRunning = false;
}

function downloadJNWBackup() {
    const entries = window._jnwBackupEntries || [];
    if (!entries.length) return;
    const dateStr = jnwBackupMeta?.crawled_date || new Date().toISOString().slice(0, 10);
    const payload = {
        source_name: jnwBackupMeta?.source_name || 'jiddischwoordenboek.nl (JNW)',
        crawled_date: dateStr,
        entry_count: entries.length,
        entries
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jnw_backup_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ── Plug into the app ─────────────────────────────────────────────────────────
registerDict('jnw', {
    search: (query, opts) => searchJNW(query, opts),
    onSettingsOpen: updateJNWOfflineUI,
    onSettingsClose() {
        if (jnwCrawlRunning) jnwCrawlStop(); // don't leave a paused/running crawl unseen
    },
    async init() {
        showMessage($('results-jnw'), MSG_PROMPT);

        // Restore a previously saved JNW local backup (if any) and the user's
        // last offline-mode preference, so both persist across app launches.
        const jnwBackup = await loadJNWBackupFromDB();
        if (jnwBackup) {
            jnwBackupMeta = jnwBackup.meta;
            window._jnwBackupEntries = jnwBackup.entries;
        }
        jnwOfflineMode = store.get('jnwOfflineMode') === '1';
        updateJNWOfflineUI();

        // Populate the single-letter test/crawl dropdown.
        const singleSelect = $('jnw-single-letter-select');
        singleSelect.innerHTML = JNW_CRAWL_LETTERS
            .map(l => `<option value="${l}">${l}*</option>`)
            .join('');
    },
});

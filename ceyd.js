'use strict';

// EYD: the Comprehensive English-Yiddish Dictionary (englishyiddishdictionary.com),
// reached through your own private relay (see relay.js). EYD stays hidden until the
// relay answers.
// Uses from app.js: $, store, showMessage/MSG_*, matchCountText, refreshDictUI, enabledDicts.
// Uses from relay.js: relayAvailable, getRelayUrl.

// ── EYD (English-Yiddish dictionary) via the private relay ────────────────────
// The relay appearing or disappearing shows or hides EYD (relay.js announces it).
window.addEventListener('relaychange', () => {
    refreshDictUI();
    if (relayAvailable) {
        const query = $('search-input').value.trim();
        if (query && enabledDicts().includes('ceyd')) searchCeyd(query);
        else showCeydStatus();
    }
});

function ceydTranslit() {
    return store.get('ceydTranslit') === '1';
}

// Like JNW's status line: shown before a search and while one is running, then
// replaced by the match count.
function showCeydStatus() {
    $('count-ceyd').textContent = 'searching remote database';
}

let ceydToken = 0;

async function searchCeyd(query, opts = {}) {
    const container = $('results-ceyd');
    const countEl = $('count-ceyd');
    const token = ++ceydToken;
    showCeydStatus();
    if (!query) {
        showMessage(container, MSG_PROMPT);
        return;
    }
    showMessage(container, 'Searching EYD…', {spinner: true});
    const p = new URLSearchParams({q: query, lang: opts.lang || 'auto', translit: ceydTranslit() ? '1' : '0'});
    if (opts.id) p.set('id', opts.id);
    if (opts.extend) p.set('extend', '1');
    try {
        const r = await fetch(getRelayUrl() + '/api/search?' + p, {cache: 'no-store'});
        const d = await r.json();
        if (token !== ceydToken) return;
        if (!r.ok) throw new Error(d.error || r.status);
        renderCeyd(d, container, countEl);
    } catch (e) {
        if (token !== ceydToken) return;
        countEl.textContent = '';
        container.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'jnw-fallback';
        div.textContent = "Couldn't search the English-Yiddish dictionary: " + e.message;
        container.append(div);
    }
}

function renderCeyd(d, container, countEl) {
    container.textContent = '';
    const real = d.choices.filter(c => !c.more);
    if (!d.entries.length) {
        showMessage(container, MSG_NO_MATCHES);
        countEl.textContent = matchCountText(0, d.query);   // (the phone tab shows this number)
        return;
    }
    // With several headwords the site sends a list of choices, one per headword. With a
    // single hit it sends no choices at all, just the entry itself, so count the entries.
    const n = real.length || d.entries.length;
    countEl.textContent = matchCountText(n, d.query);
    if (d.choices.length) {
        const wrap = document.createElement('div');
        wrap.className = 'ceyd-choices';
        let sepDone = false;
        for (const c of d.choices) {
            if (!c.top && !sepDone && d.choices.some(x => x.top)) {
                sepDone = true;
                const sep = document.createElement('div');
                sep.className = 'ceyd-sep';
                wrap.append(sep);
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ceyd-chip' + (c.top ? ' top' : '') + (c.selected ? ' sel' : '');
            b.textContent = c.more ? 'More…' : c.label;
            b.onclick = () => searchCeyd(d.query, {lang: d.lang, id: c.id, extend: c.extend});
            wrap.append(b);
        }
        container.append(wrap);
        const sel = wrap.querySelector('.sel');
        if (sel) wrap.scrollTop = Math.max(0, sel.offsetTop - 8);
    }
    for (const rows of d.entries) {
        const entry = document.createElement('div');
        entry.className = 'entry';
        for (const r of rows) {
            const row = document.createElement('div');
            row.className = 'ceyd-row' + (r.sub ? ' sub' : '');
            const en = document.createElement('div');
            en.className = 'term';
            en.innerHTML = r.en;
            row.append(en);
            if (r.yi || r.tr) {
                const yi = document.createElement('div');
                yi.className = 'defpara';
                yi.innerHTML = r.yi;
                if (r.tr) {
                    const tr = document.createElement('span');
                    tr.className = 'ceyd-tr';
                    tr.textContent = r.tr;
                    yi.append(tr);
                }
                row.append(yi);
            }
            entry.append(row);
        }
        container.append(entry);
    }
    const src = document.createElement('div');
    src.className = 'col-count';
    src.style.textAlign = 'center';
    src.textContent = '© Comprehensive English-Yiddish Dictionary';
    container.append(src);
}

function setCeydTranslit(on) {
    store.set('ceydTranslit', on ? '1' : '0');
    const query = $('search-input').value.trim();
    if (query && enabledDicts().includes('ceyd')) searchCeyd(query);
}

// Settings for EYD (the relay's own address and status are in relay.js)
function syncCeydSettings() {
    $('ceyd-translit').checked = ceydTranslit();
}

// ── Plug into the app ─────────────────────────────────────────────────────────
registerDict('ceyd', {
    available: () => relayAvailable,   // hidden until the relay answers
    search: query => searchCeyd(query),
    onSettingsOpen: syncCeydSettings,
});

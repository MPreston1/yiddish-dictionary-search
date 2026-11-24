'use strict';

// EYD: the Comprehensive English-Yiddish Dictionary (englishyiddishdictionary.com),
// reached through your own private relay (dictionary-relay on the Pi). EYD stays
// hidden until the relay answers. The relay can also fetch JNW for jnw.js.
// Uses from app.js: refreshDictUI, enabledDicts.

// ── State ────────────────────────────────────────────────────────────────────
let ceydAvailable = false;                            // is the relay reachable right now?
let ceydReason = '';                                  // why the last check failed (shown in Settings)
let relayCanFetch = false;                            // does the relay also offer /api/fetch (used for JNW)?

// ── EYD (English-Yiddish dictionary) via the private relay ────────────────────
// The address typed in Settings. Blank when this page is served by the Pi itself.
function getSavedCeydUrl() {
    try {
        return (localStorage.getItem('ceydRelayUrl') || '').trim().replace(/\/+$/, '');
    } catch (e) {
        return '';
    }
}

// The relay to use: the saved address or, on a page the relay serves itself
// (it adds window.PI_HOSTED), that same server.
function getCeydUrl() {
    return getSavedCeydUrl() || (window.PI_HOSTED ? window.location.origin : '');
}

function ceydTranslit() {
    try {
        return localStorage.getItem('ceydTranslit') === '1';
    } catch (e) {
        return false;
    }
}

function ceydStatusText() {
    if (!getCeydUrl()) return 'Not set up. EYD stays hidden.';
    if (ceydAvailable) return window.PI_HOSTED && !getSavedCeydUrl() ? 'Connected. This page is served by your Pi.' : 'Connected.';
    return `Can't reach the relay (${ceydReason || 'is Tailscale on?'}). EYD stays hidden until it can.`;
}

// Ask the relay whether it is there. Fails quietly (and EYD stays hidden) when it isn't.
async function checkCeyd() {
    const base = getCeydUrl();
    let ok = false;
    let canFetch = false;
    ceydReason = '';
    if (base) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
            const r = await fetch(base + '/api/ping', {signal: ctrl.signal, cache: 'no-store'});
            if (!r.ok) {
                ceydReason = `the relay answered HTTP ${r.status}` + (r.status === 404 ? ' - is it updated and restarted?' : '');
            } else {
                const j = await r.json();
                ok = j.ok === true && (j.service === 'dictionary-relay' || j.service === 'ceyd-relay');
                canFetch = ok && Array.isArray(j.features) && j.features.includes('fetch');
                if (!ok) ceydReason = 'unexpected reply from that address';
            }
        } catch (e) {
            ceydReason = e.name === 'AbortError'
                ? 'no answer within 4 seconds - is Tailscale on?'
                : 'blocked or unreachable - not on Tailscale, or the browser refused the cross-site request';
        }
        clearTimeout(timer);
    }
    const changed = ok !== ceydAvailable;
    ceydAvailable = ok;
    relayCanFetch = canFetch;
    if (changed) {
        refreshDictUI();
        const query = document.getElementById('search-input').value.trim();
        if (ok && query && enabledDicts().includes('ceyd')) searchCeyd(query);
        else if (ok) showCeydStatus();
    }
    const st = document.getElementById('ceyd-status');
    if (st) st.textContent = ceydStatusText();
    return ok;
}

window.addEventListener('online', checkCeyd);
window.addEventListener('offline', () => {
    if (ceydAvailable) {
        ceydAvailable = false;
        refreshDictUI();
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkCeyd();
});

// Like JNW's status line: shown before a search and while one is running, then
// replaced by the match count.
function showCeydStatus() {
    document.getElementById('count-ceyd').textContent = 'searching remote database';
}

let ceydToken = 0;

async function searchCeyd(query, opts = {}) {
    const container = document.getElementById('results-ceyd');
    const countEl = document.getElementById('count-ceyd');
    const token = ++ceydToken;
    showCeydStatus();
    if (!query) {
        container.innerHTML = '<p class="message">Type a word and tap Search.</p>';
        return;
    }
    container.innerHTML = '<p class="message"><span class="spinner"></span> Searching EYD…</p>';
    const p = new URLSearchParams({q: query, lang: opts.lang || 'auto', translit: ceydTranslit() ? '1' : '0'});
    if (opts.id) p.set('id', opts.id);
    if (opts.extend) p.set('extend', '1');
    try {
        const r = await fetch(getCeydUrl() + '/api/search?' + p, {cache: 'no-store'});
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
        container.innerHTML = '<p class="message">No matches found.</p>';
        countEl.textContent = '';
        return;
    }
    countEl.textContent = `${real.length.toLocaleString()} match${real.length !== 1 ? 'es' : ''} for "${d.query}"`;
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

// Settings for EYD
function syncCeydSettings() {
    const urlInput = document.getElementById('ceyd-url-input');
    urlInput.value = getSavedCeydUrl();
    if (window.PI_HOSTED) urlInput.placeholder = 'Leave blank: this page is served by your Pi';
    document.getElementById('ceyd-translit').checked = ceydTranslit();
    document.getElementById('ceyd-status').textContent = ceydStatusText();
}

async function saveCeydUrl() {
    const input = document.getElementById('ceyd-url-input');
    let v = input.value.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
        localStorage.setItem('ceydRelayUrl', v);
    } catch (e) {
    }
    input.value = v;
    document.getElementById('ceyd-status').textContent = 'Checking…';
    await checkCeyd();
}

function clearCeydUrl() {
    try {
        localStorage.removeItem('ceydRelayUrl');
    } catch (e) {
    }
    document.getElementById('ceyd-url-input').value = '';
    ceydAvailable = false;
    refreshDictUI();
    document.getElementById('ceyd-status').textContent = ceydStatusText();
    if (window.PI_HOSTED) checkCeyd();   // this server is still the relay
}

function setCeydTranslit(on) {
    try {
        localStorage.setItem('ceydTranslit', on ? '1' : '0');
    } catch (e) {
    }
    const query = document.getElementById('search-input').value.trim();
    if (query && enabledDicts().includes('ceyd')) searchCeyd(query);
}

// ── Plug into the app ─────────────────────────────────────────────────────────
registerDict('ceyd', {
    available: () => ceydAvailable,
    search: query => searchCeyd(query),
    onSettingsOpen: syncCeydSettings,
    init: checkCeyd,            // shows EYD only if the private relay answers
});

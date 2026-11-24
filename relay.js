'use strict';

// The relay: your own private server (dictionary-relay, on the Pi), reached over Tailscale
// or the home network. It is not a dictionary itself; it is a service two parts use:
//   - ceyd.js: EYD is searched through it, and stays hidden until it answers.
//   - jnw.js: when it offers /api/fetch, it is one of the routes JNW lookups try, ahead
//     of the public CORS proxies (see relayFetchUrl below).
// This file only keeps track of whether the relay is up and where it is. Anything that
// should react to that listens for the "relaychange" event on window.
// Uses from app.js: registerSettingsHooks.

// ── State ────────────────────────────────────────────────────────────────────
let relayAvailable = false;                           // is the relay reachable right now?
let relayReason = '';                                 // why the last check failed (shown in Settings)
let relayCanFetch = false;                            // does the relay also offer /api/fetch (used for JNW)?

function relayChanged() {
    window.dispatchEvent(new Event('relaychange'));
}

// The address typed in Settings. Blank when this page is served by the Pi itself.
// (The storage key keeps its old name, 'ceydRelayUrl', so addresses already saved on
// your devices keep working.)
function getSavedRelayUrl() {
    try {
        return (localStorage.getItem('ceydRelayUrl') || '').trim().replace(/\/+$/, '');
    } catch (e) {
        return '';
    }
}

// The relay to use: the saved address or, on a page the relay serves itself
// (it adds window.PI_HOSTED), that same server.
function getRelayUrl() {
    return getSavedRelayUrl() || (window.PI_HOSTED ? window.location.origin : '');
}

// If the relay is up and can fetch pages for us, the URL that fetches `url` through it;
// otherwise null.
function relayFetchUrl(url) {
    if (!relayAvailable || !relayCanFetch) return null;
    return `${getRelayUrl()}/api/fetch?url=${encodeURIComponent(url)}`;
}

function relayStatusText() {
    if (!getRelayUrl()) return 'Not set up. EYD stays hidden.';
    if (relayAvailable) return window.PI_HOSTED && !getSavedRelayUrl() ? 'Connected. This page is served by your Pi.' : 'Connected.';
    return `Can't reach the relay (${relayReason || 'is Tailscale on?'}). EYD stays hidden until it can.`;
}

// Ask the relay whether it is there. Fails quietly (and EYD stays hidden) when it isn't.
async function checkRelay() {
    const base = getRelayUrl();
    let ok = false;
    let canFetch = false;
    relayReason = '';
    if (base) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
            const r = await fetch(base + '/api/ping', {signal: ctrl.signal, cache: 'no-store'});
            if (!r.ok) {
                relayReason = `the relay answered HTTP ${r.status}` + (r.status === 404 ? ' - is it updated and restarted?' : '');
            } else {
                const j = await r.json();
                ok = j.ok === true && (j.service === 'dictionary-relay' || j.service === 'ceyd-relay');
                canFetch = ok && Array.isArray(j.features) && j.features.includes('fetch');
                if (!ok) relayReason = 'unexpected reply from that address';
            }
        } catch (e) {
            relayReason = e.name === 'AbortError'
                ? 'no answer within 4 seconds - is Tailscale on?'
                : 'blocked or unreachable - not on Tailscale, or the browser refused the cross-site request';
        }
        clearTimeout(timer);
    }
    const changed = ok !== relayAvailable;
    relayAvailable = ok;
    relayCanFetch = canFetch;
    if (changed) relayChanged();
    const st = document.getElementById('relay-status');
    if (st) st.textContent = relayStatusText();
    return ok;
}

window.addEventListener('online', checkRelay);
window.addEventListener('offline', () => {
    if (relayAvailable) {
        relayAvailable = false;
        relayChanged();
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkRelay();
});


// ── Settings for the relay ────────────────────────────────────────────────────
function syncRelaySettings() {
    const urlInput = document.getElementById('relay-url-input');
    urlInput.value = getSavedRelayUrl();
    if (window.PI_HOSTED) urlInput.placeholder = 'Leave blank: this page is served by your Pi';
    document.getElementById('relay-status').textContent = relayStatusText();
}

async function saveRelayUrl() {
    const input = document.getElementById('relay-url-input');
    let v = input.value.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
        localStorage.setItem('ceydRelayUrl', v);
    } catch (e) {
    }
    input.value = v;
    document.getElementById('relay-status').textContent = 'Checking…';
    await checkRelay();
}

function clearRelayUrl() {
    try {
        localStorage.removeItem('ceydRelayUrl');
    } catch (e) {
    }
    document.getElementById('relay-url-input').value = '';
    relayAvailable = false;
    relayChanged();
    document.getElementById('relay-status').textContent = relayStatusText();
    if (window.PI_HOSTED) checkRelay();   // this server is still the relay
}

// ── Plug into the app ─────────────────────────────────────────────────────────
registerSettingsHooks({open: syncRelaySettings});
// Once everything has loaded (after app.js's own startup): is the relay there?
document.addEventListener('DOMContentLoaded', checkRelay);

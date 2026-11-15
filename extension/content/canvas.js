// CampusFallback content script for UMass Canvas (https://umamherst.instructure.com).
// The extension's own requests to Canvas don't carry the student's login, but requests from a Canvas page do.
// So the background sync asks this script to make its Canvas API calls: same-origin GETs to /api/v1/ only,
// answered with plain data (status, headers, body text). Nothing else is read from the page, and nothing is posted.
(() => {
  const ORIGIN = location.origin;
  const DEFAULT_TIMEOUT_MS = 15_000;

  async function get(rawUrl, timeoutMs) {
    let url;
    try { url = new URL(rawUrl, ORIGIN); } catch { return { error: 'Bad URL' }; }
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/v1/')) return { error: 'Only Canvas API GET requests are allowed' };
    try {
      const res = await fetch(url.href, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'manual', // a redirect means the session is gone (login page); report it, don't follow it
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 60_000)),
      });
      const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
      return {
        status: res.status,
        type: res.type,
        contentType: res.headers.get('Content-Type') || '',
        link: res.headers.get('Link') || '',
        rateRemaining: res.headers.get('X-Rate-Limit-Remaining'),
        text: redirected ? '' : await res.text(),
      };
    } catch (err) {
      return { networkError: err.name === 'TimeoutError' ? 'timed out' : err.message };
    }
  }

  // Only the extension can send these (web pages cannot reach chrome.runtime.onMessage).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return undefined;
    if (msg?.type === 'canvasPing') {
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg?.type === 'canvasGet') {
      get(msg.url, msg.timeoutMs).then(sendResponse);
      return true; // answer asynchronously
    }
    return undefined;
  });

  // Tell the background a Canvas tab is open; it syncs if the last sync is more than 30 minutes old.
  chrome.runtime.sendMessage({ type: 'canvasTabReady' }).catch(() => {});
})();

// Read-only Canvas client. Every request here is a GET; submissions live in submit.js (Prompt 5).
// The client runs on a "transport" that performs one GET and returns plain JSON-safe data:
//   backgroundTransport - fetch from the extension itself (the mock, which needs no login)
//   tabTransport (background.js) - asks the content script in an open Canvas tab to fetch it same-origin,
//                                  so the browser attaches the student's Canvas session
import { CANVAS_BASE, FETCH_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS } from './config.js';

// kind: session | forbidden | notfound | network | http
export class CanvasError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.name = 'CanvasError';
    this.kind = kind;
    this.status = status;
  }
}

export const SESSION_MESSAGE = 'Log in to Canvas once to resume syncing';
const sessionExpired = (status) => new CanvasError('session', SESSION_MESSAGE, status);

// API calls must stay on the Canvas origin (this also covers the "next" links we follow).
function apiUrl(pathOrUrl) {
  const url = new URL(pathOrUrl, CANVAS_BASE);
  if (url.origin !== new URL(CANVAS_BASE).origin) throw new CanvasError('http', `Refusing to call ${url.origin}`);
  return url.href;
}

// Canvas prefixes session-authenticated JSON with "while(1);".
function parseJson(text) {
  try {
    return { ok: true, data: JSON.parse(String(text).replace(/^\s*while\(1\);/, '')) };
  } catch {
    return { ok: false, data: null };
  }
}

const MAX_PARALLEL = 3;
const RATE_LOW = 100; // Canvas's bucket starts near 700; below this, pause before the next request
const RATE_PAUSE_MS = 2000;
const RATE_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One GET with fetch, from wherever this code runs. Returns plain data, never throws:
// { status, type, contentType, link, rateRemaining, text } or { networkError }.
export async function backgroundTransport(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'manual', // a redirect means "go to the login page"; never follow it
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
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

const looksLikeHtml = (r) => /text\/html/i.test(r.contentType || '') || /^\s*</.test(r.text || '');

// A Canvas API client on top of a transport: at most 3 requests at a time, a shared pause when Canvas says
// its rate limit is running low, and a few backed-off retries when a 403 says "rate limit exceeded".
export function createCanvasClient(transport = backgroundTransport) {
  let active = 0;
  let pausedUntil = 0;
  const waiting = [];

  async function slot(fn) {
    if (active >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
    active += 1;
    try {
      const pause = pausedUntil - Date.now();
      if (pause > 0) await sleep(pause);
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function request(pathOrUrl, timeoutMs = FETCH_TIMEOUT_MS) {
    const url = apiUrl(pathOrUrl);
    for (let attempt = 0; ; attempt++) {
      const r = await slot(() => transport(url, timeoutMs));
      if (!r || r.error) throw new CanvasError('http', r?.error || 'No answer from the Canvas tab');
      if (r.networkError) throw new CanvasError('network', `Canvas unreachable (${r.networkError})`);
      // Only a redirect (to the login page) or an HTML page means the session is gone.
      if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw sessionExpired(r.status);

      const remaining = Number.parseFloat(r.rateRemaining);
      if (Number.isFinite(remaining) && remaining < RATE_LOW) pausedUntil = Math.max(pausedUntil, Date.now() + RATE_PAUSE_MS);
      if (r.status === 403 && /rate limit/i.test(r.text || '')) {
        if (attempt >= RATE_RETRIES) throw new CanvasError('http', 'Canvas rate limit: try again in a few minutes', 403);
        pausedUntil = Math.max(pausedUntil, Date.now() + RATE_PAUSE_MS * 2 ** attempt);
        continue;
      }

      const { ok, data } = parseJson(r.text);
      if (r.status === 401) {
        // No session: {"status":"unauthenticated"} (or an HTML login page). Logged in but not allowed: "unauthorized".
        throw looksLikeHtml(r) || data?.status === 'unauthenticated' ? sessionExpired(401) : new CanvasError('forbidden', 'Not allowed', 401);
      }
      if (r.status === 403) throw new CanvasError('forbidden', 'Not allowed', 403);
      if (r.status === 404) throw new CanvasError('notfound', 'Not found', 404);
      if (r.status < 200 || r.status >= 300) throw new CanvasError('http', `Canvas returned ${r.status}`, r.status);
      if (!ok) throw looksLikeHtml(r) ? sessionExpired(r.status) : new CanvasError('http', 'Canvas sent something that is not JSON', r.status);
      return { data, link: r.link || '' };
    }
  }

  const getOne = async (path) => (await request(path)).data;

  // Follows the Link header until there is no rel="next".
  async function getAll(path) {
    const out = [];
    let next = path;
    for (let page = 0; next && page < 50; page++) {
      const { data, link } = await request(next);
      if (!Array.isArray(data)) throw new CanvasError('http', 'Expected a list from Canvas');
      out.push(...data);
      next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] || null;
    }
    return out;
  }

  // Quick reachability check for the dashboard banner: 'ok' | 'session' | 'down'.
  async function probe(timeoutMs = 3000) {
    try {
      await request('/api/v1/courses?per_page=1', timeoutMs);
      return 'ok';
    } catch (err) {
      if (err.kind === 'session') return 'session';
      return err.kind === 'network' || err.kind === 'http' ? 'down' : 'ok';
    }
  }

  return { getOne, getAll, probe };
}

// The extension's own client (the mock, and the dashboard's status check).
const own = createCanvasClient();
export const getOne = (path) => own.getOne(path);
export const getAll = (path) => own.getAll(path);
export const probeCanvas = (timeoutMs) => own.probe(timeoutMs);

// File contents. Real Canvas redirects these to its file-storage domain, so redirects are followed here.
export async function downloadFile(url) {
  let res;
  let blob;
  try {
    res = await fetch(url, { method: 'GET', credentials: 'include', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (res.ok) blob = await res.blob();
  } catch (err) {
    throw new CanvasError('network', `Download failed (${err.name === 'TimeoutError' ? 'timed out' : err.message})`);
  }
  if (res.status === 401 || res.status === 403) throw new CanvasError('forbidden', 'Not allowed', res.status);
  if (res.status === 404) throw new CanvasError('notfound', 'Not found', 404);
  if (!res.ok) throw new CanvasError('http', `Download returned ${res.status}`, res.status);
  return blob;
}

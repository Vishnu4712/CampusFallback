// Service worker: scheduled syncs and queue retries only. New submissions start from the dashboard page.
import { syncAll } from './lib/sync.js';
import { db, getSyncState } from './lib/db.js';
import { SYNC_PERIOD_MIN, TARGET, CANVAS_BASE } from './lib/config.js';
import { processQueue, hasOpenItems, QUEUE_ALARM } from './lib/queue.js';
import { saveGradescopeCourse, gradescopeBase } from './lib/gradescope.js';

const SYNC_ALARM = 'sync';

async function ensureAlarm() {
  if (!(await chrome.alarms.get(SYNC_ALARM))) {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN });
  }
}

// The queue alarm ticks every minute while anything is waiting; each item has its own backoff (2 min and up).
async function ensureQueueAlarm() {
  if (await hasOpenItems()) {
    if (!(await chrome.alarms.get(QUEUE_ALARM))) chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(QUEUE_ALARM);
  }
}

async function runQueue(force) {
  try {
    await processQueue({ force });
  } finally {
    await ensureQueueAlarm();
  }
}

// A successful sync proves Canvas is back, so waiting items are retried at once.
async function syncThenRetry(transport) {
  const state = await syncAll({ transport });
  if (state.status === 'ok' && (await hasOpenItems())) await runQueue(true);
  return state;
}

// ---------- real Canvas: sync through an open Canvas tab ----------
// The extension's own requests to real Canvas don't carry the student's login, so on real Canvas every
// Canvas GET is made by content/canvas.js inside a Canvas tab. The mock is still synced directly.

const NO_TAB = { status: 'no-tab', message: 'Open Canvas once to sync' };
const SYNC_EVERY_MS = SYNC_PERIOD_MIN * 60_000;

// Each GET goes to the content script in that tab and comes back as plain data.
const tabTransport = (tabId) => (url, timeoutMs) => chrome.tabs.sendMessage(tabId, { type: 'canvasGet', url, timeoutMs })
  .catch(() => ({ networkError: 'the Canvas tab was closed or reloaded' }));

// The most recently used Canvas tab whose content script answers, or null.
async function findCanvasTab() {
  const tabs = await chrome.tabs.query({ url: `${CANVAS_BASE}/*` });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of tabs) {
    try {
      if ((await chrome.tabs.sendMessage(tab.id, { type: 'canvasPing' }))?.ok) return tab.id;
    } catch { /* no content script yet (tab opened before the extension loaded) */ }
  }
  return null;
}

// Every sync trigger goes through here. force: "Sync now"; otherwise at most once every 30 minutes.
async function startSync({ force = false, tabId = null } = {}) {
  if (TARGET !== 'real') return syncThenRetry();
  if (!force) {
    const { lastSuccessAt, lastAttemptAt } = await getSyncState();
    if (Date.now() - (lastSuccessAt || 0) < SYNC_EVERY_MS) return getSyncState();
    if (Date.now() - (lastAttemptAt || 0) < 2 * 60_000) return getSyncState(); // a failed run just happened
  }
  const tab = tabId ?? (await findCanvasTab());
  if (tab == null) return NO_TAB;
  return syncThenRetry(tabTransport(tab));
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); ensureQueueAlarm(); startSync({ force: true }); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); ensureQueueAlarm(); startSync(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) startSync();
  if (alarm.name === QUEUE_ALARM) runQueue(false);
});

// { type: 'syncNow' } -> replies with the sync state once the run finishes, or { status: 'no-tab', message }
//                       when real Canvas needs an open Canvas tab and none is open.
// { type: 'canvasTabReady' } -> from content/canvas.js: a Canvas tab opened; sync if the last one is 30+ minutes old.
// { type: 'queueChanged' } -> the dashboard queued something; make sure the alarm is running.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'syncNow') {
    startSync({ force: true }).then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === 'canvasTabReady') {
    const fromCanvas = sender.id === chrome.runtime.id && sender.tab && sender.url?.startsWith(`${CANVAS_BASE}/`);
    if (fromCanvas && TARGET === 'real') startSync({ tabId: sender.tab.id });
    return false;
  }
  // { type: 'gradescopeCourse', course } from content/gradescope.js. Accepted only from a tab showing a
  // Gradescope (or mock Gradescope) course page; the data is re-checked before it is stored.
  if (msg?.type === 'gradescopeCourse') {
    if (sender.id !== chrome.runtime.id || !sender.tab || !gradescopeBase(sender.url)) {
      sendResponse({ ok: false, error: 'Not allowed' });
      return false;
    }
    saveGradescopeCourse(msg.course, sender.url)
      .then((res) => {
        if (res.ok) chrome.runtime.sendMessage({ type: 'gradescopeUpdated' }).catch(() => {}); // open dashboards refresh
        sendResponse(res);
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'queueChanged') {
    ensureQueueAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  return undefined;
});

// "Gradescope is back" opens the assignment page; every other notification opens the dashboard.
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const itemId = Number(/^cf-gradescope-back-(\d+)-/.exec(id)?.[1]);
  const item = itemId ? await db.queue.get(itemId) : null;
  await chrome.tabs.create({ url: item?.gradescopeUrl || chrome.runtime.getURL('dashboard/dashboard.html') });
});

// Clicking the toolbar icon opens the dashboard, or focuses it if it is already open.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard/dashboard.html');
  const [open] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// For testing from the service worker console: await cf.syncAll(), await cf.db.assignments.toArray()
self.cf = { syncAll, db, getSyncState, processQueue };

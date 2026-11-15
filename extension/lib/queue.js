// Retry queue. Two types of item:
//   submit - Canvas: may need a seal (if the backend was unreachable) and a submission (if Canvas was down).
//            Retries resubmit the stored Blob, never a re-read from disk.
//   remind - Gradescope: sealed -> reminded -> done (or needs-professor). Never submitted by us; the student is
//            told when Gradescope is reachable and uploads the same file themselves.
// `open` = the item still needs background work (sealing, submitting or checking Gradescope).
// Runs from the service worker's alarm and from the dashboard; a Web Lock makes sure only one runs at a time.
import { db } from './db.js';
import { submitFile } from './submit.js';
import { timestamp } from './api.js';
import { gradescopeReachable, reminderExpired, REMIND_EVERY_MS } from './gradescope.js';

export const QUEUE_ALARM = 'queue';
const DELAYS_MIN = [2, 2, 2, 4, 8, 15, 30]; // minutes before retry n (the last one repeats)
const delayAfter = (attempts) => DELAYS_MIN[Math.min(Math.max(attempts - 1, 0), DELAYS_MIN.length - 1)] * 60_000;

const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export async function saveReceipt(receipt, extra = {}) {
  await db.receipts.put({ ...receipt, ...extra, savedAt: Date.now() });
}

// item: { type: 'submit' | 'remind', courseId, assignmentId, assignment: {name, courseName, due_at, html_url},
//         fileBlob, fileName, sha256, receipt, submit (bool), gradescopeUrl (remind only) }
export async function enqueue(item) {
  const now = Date.now();
  const remind = item.type === 'remind';
  const row = {
    ...item,
    type: remind ? 'remind' : 'submit',
    submitState: !remind && item.submit ? 'pending' : 'none', // pending | done | needs-professor | failed | replaced | none
    remindState: remind ? 'sealed' : null, // sealed | reminded | done | needs-professor | replaced
    sealState: item.receipt ? 'done' : 'pending', // pending | done
    open: 1,
    attempts: 0,
    lastError: null,
    createdAt: now,
    nextAttemptAt: now + (remind ? REMIND_EVERY_MS : DELAYS_MIN[0] * 60_000),
  };
  delete row.submit;
  if (remind || !item.submit) row.fileBlob = null; // nothing for us to submit, so the file is not kept
  return db.transaction('rw', db.queue, async () => {
    // A newer file for the same assignment replaces any older one still waiting.
    const older = await db.queue.where('assignmentId').equals(item.assignmentId)
      .filter((q) => q.submitState === 'pending' || q.remindState === 'sealed' || q.remindState === 'reminded').toArray();
    for (const q of older) {
      const patch = q.type === 'remind' ? { remindState: 'replaced' } : { submitState: 'replaced', fileBlob: null };
      await db.queue.update(q.id, { ...patch, open: q.sealState === 'pending' ? 1 : 0 });
    }
    return db.queue.add(row);
  });
}

// The student uploaded to Gradescope themselves.
export async function markRemindDone(id) {
  const item = await db.queue.get(id);
  if (!item || item.type !== 'remind') return;
  await db.queue.update(id, { remindState: 'done', doneAt: Date.now(), open: item.sealState === 'pending' ? 1 : 0 });
  chrome.runtime.sendMessage({ type: 'queueChanged' }).catch(() => {});
}

export const hasOpenItems = async () => (await db.queue.where('open').equals(1).count()) > 0;

// Processes items that are due (or all open items when force is true). Returns { events, busy }.
export async function processQueue({ force = false } = {}) {
  if (!navigator.locks) return run(force);
  return navigator.locks.request('campusfallback-queue', { ifAvailable: true }, (lock) => (lock ? run(force) : { busy: true, events: [] }));
}

async function run(force) {
  const events = [];
  const items = await db.queue.where('open').equals(1).toArray();
  let gradescopeUp; // checked at most once per run, and only if a reminder is waiting
  for (const item of items) {
    if (!force && item.nextAttemptAt > Date.now()) continue;
    const patch = { attempts: item.attempts + 1, lastTriedAt: Date.now() };
    const problems = [];

    if (item.sealState === 'pending') {
      try {
        const receipt = await timestamp(item.sha256);
        Object.assign(patch, { receipt, sealState: 'done' });
        await saveReceipt(receipt, { assignmentId: item.assignmentId, fileName: item.fileName });
        events.push({ type: 'sealed', item: { ...item, ...patch } });
      } catch (err) {
        problems.push(`Not sealed yet: ${err.message}`);
      }
    }

    if (item.submitState === 'pending') {
      try {
        const submission = await submitFile({ courseId: item.courseId, assignmentId: item.assignmentId, blob: item.fileBlob, fileName: item.fileName });
        Object.assign(patch, { submitState: 'done', submittedAt: submission.submitted_at, attempt: submission.attempt ?? null, fileBlob: null });
        events.push({ type: 'submitted', item: { ...item, ...patch } });
      } catch (err) {
        if (err.kind === 'locked') {
          patch.submitState = 'needs-professor';
          events.push({ type: 'locked', item: { ...item, ...patch }, message: err.message });
        } else if (err.kind === 'rejected' || err.kind === 'blocked') {
          patch.submitState = 'failed';
          events.push({ type: 'failed', item: { ...item, ...patch }, message: err.message });
        }
        problems.push(err.kind === 'session' ? 'Log in to Canvas to resume' : err.message);
      }
    }

    if (item.remindState === 'sealed') {
      if (reminderExpired(item)) {
        patch.remindState = 'needs-professor';
        events.push({ type: 'gradescope-expired', item: { ...item, ...patch } });
      } else {
        gradescopeUp ??= await gradescopeReachable();
        if (gradescopeUp) {
          Object.assign(patch, { remindState: 'reminded', remindedAt: Date.now() });
          events.push({ type: 'gradescope-back', item: { ...item, ...patch } });
        } else {
          problems.push('Gradescope is still unreachable');
        }
      }
    }

    const next = { ...item, ...patch };
    patch.open = next.sealState === 'pending' || next.submitState === 'pending' || next.remindState === 'sealed' ? 1 : 0;
    patch.lastError = problems.join(' · ') || null;
    // Gradescope is checked every 2 minutes with no backoff; everything else backs off.
    patch.nextAttemptAt = Date.now() + (next.remindState === 'sealed' ? REMIND_EVERY_MS : delayAfter(patch.attempts));
    await db.queue.update(item.id, patch);
  }

  if (events.length) notify(events);
  chrome.runtime.sendMessage({ type: 'queueUpdated' }).catch(() => {}); // tells open dashboards to refresh
  return { events, busy: false };
}

function notify(events) {
  for (const { type, item, message } of events) {
    const name = item.assignment?.name || 'your assignment';
    const text = {
      submitted: [`Uploaded on Canvas: ${name}`,`Canvas accepted ${item.fileName} at ${item.submittedAt ? eastern.format(new Date(item.submittedAt)) : 'just now'}.`],
      sealed: [`Sealed: ${name}`, `FreeTSA timestamped your file at ${eastern.format(new Date(item.receipt.genTime))}.`],
      locked: [`Canvas locked: ${name}`, 'Lifeline stopped retrying. Your professor has the sealed receipt.'],
      failed: [`Canvas refused: ${name}`, message || 'Lifeline stopped retrying.'],
      'gradescope-back': [`Gradescope is back — upload ${name} now`, `Upload ${item.fileName} (fingerprint ${item.sha256.slice(0, 8)}), the same file you sealed. Click to open the assignment.`],
      'gradescope-expired': [`Still no Gradescope: ${name}`, 'It has been 48 hours since the due date, so Lifeline stopped reminding you. Your professor has the sealed receipt.'],
    }[type];
    // Clicking a "Gradescope is back" notification opens the assignment page (see background.js).
    chrome.notifications.create(`cf-${type}-${item.id}-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: text[0],
      message: text[1],
      priority: 2,
    }).catch((err) => console.warn('[CampusFallback] notification failed:', err));
  }
}

// Gradescope assignments. Gradescope shows up inside Canvas as an external tool, and Lifeline never uploads
// to it: it seals the file, emails the professor, and tells the student when Gradescope is reachable again.
// The only request this file makes to Gradescope is a GET to check that it answers.
import { CANVAS_BASE, TARGET, KEEP_PAST_DUE_DAYS } from './config.js';
import { db } from './db.js';

const PING_TIMEOUT_MS = 5000;
export const REMIND_EVERY_MS = 2 * 60_000;
export const REMIND_GIVE_UP_MS = 48 * 3_600_000; // after the due date

const MOCK_PREFIX = `${CANVAS_BASE}/gradescope/`;
const PING_URL = TARGET === 'mock' ? `${CANVAS_BASE}/gradescope/ping` : 'https://www.gradescope.com/';

const toolUrl = (a) => String(a?.external_tool_tag_attributes?.url || '');

// A Canvas external_tool assignment that points at Gradescope (or the mock's Gradescope),
// or an assignment stored with source "gradescope".
export function isGradescope(a) {
  if (a?.source === 'gradescope') return true;
  if (!(a?.submission_types || []).includes('external_tool')) return false;
  const url = toolUrl(a);
  return /gradescope\.com/i.test(url) || (TARGET === 'mock' && url.startsWith(MOCK_PREFIX));
}

// Where "Open on Gradescope" goes. The mock has a real page. On real Canvas the tool URL is an LTI launch
// that only works from inside Canvas, so the student goes to Gradescope's own site to log in and upload.
export function gradescopeUrl(a) {
  if (a?.gradescope?.url) return a.gradescope.url; // read from the student's own Gradescope course page
  const url = toolUrl(a);
  if (TARGET === 'mock' && url.startsWith(MOCK_PREFIX)) return url;
  return 'https://www.gradescope.com/';
}

// True if Gradescope answers in time (5 s by default). Any status below 500 counts as up.
export async function gradescopeReachable(timeoutMs = PING_TIMEOUT_MS) {
  try {
    const res = await fetch(PING_URL, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

// Stop reminding 48 hours after the due date (or after the item was created, if there is no due date).
export function reminderExpired(item, now = Date.now()) {
  const due = Date.parse(item.assignment?.due_at) || item.createdAt;
  return now > due + REMIND_GIVE_UP_MS;
}

// ---------- deadlines read from Gradescope course pages ----------

const MAX_ROWS = 300;
const STATUSES = new Set(['not_submitted', 'submitted', 'graded', 'unknown']);
const HOUR = 3_600_000;

// The Gradescope site a page belongs to, which is also the base every stored link must start with.
// Real Gradescope, or the mock's copy when the mock is the Canvas target. Anything else: null.
export function gradescopeBase(pageUrl) {
  let url;
  try { url = new URL(pageUrl); } catch { return null; }
  if (url.origin === 'https://www.gradescope.com') return url.origin;
  if (TARGET === 'mock' && url.href.startsWith(MOCK_PREFIX)) return `${CANVAS_BASE}/gradescope`;
  return null;
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isoOrNull = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
function linkOn(base, v) {
  try {
    const url = new URL(v);
    return url.href.startsWith(`${base}/courses/`) ? url.href : null;
  } catch {
    return null;
  }
}

// Saves one course's assignments sent by the content script, replacing that course's rows in one transaction.
// Everything is re-checked here, because it comes from a web page. 0 rows never wipes what is saved.
export async function saveGradescopeCourse(payload, pageUrl) {
  const base = gradescopeBase(pageUrl);
  const courseId = String(payload?.courseId ?? '');
  if (!base || !/^\d{1,12}$/.test(courseId)) return { ok: false, error: 'Not a Gradescope course page' };
  const now = new Date().toISOString();
  const courseName = cleanText(payload.courseName, 120) || `Gradescope course ${courseId}`;
  const rows = [];
  for (const a of (Array.isArray(payload.assignments) ? payload.assignments : []).slice(0, MAX_ROWS)) {
    const assignmentId = String(a?.assignmentId ?? '');
    const name = cleanText(a?.name, 200);
    if (!/^\d{1,12}$/.test(assignmentId) || !name) continue;
    rows.push({
      id: `gs:${courseId}:${assignmentId}`,
      source: 'gradescope',
      courseId,
      courseName,
      name,
      dueAt: isoOrNull(a.dueAt),
      lateDueAt: isoOrNull(a.lateDueAt),
      status: STATUSES.has(a.status) ? a.status : 'unknown',
      url: linkOn(base, a.url) || `${base}/courses/${courseId}`,
      updatedAt: now,
    });
  }
  if (!rows.length) {
    console.warn(`[CampusFallback] Gradescope course ${courseId}: no assignments found on the page; keeping the saved ones`);
    return { ok: false, kept: true, error: 'No assignments found on this page; kept the saved ones' };
  }
  await db.transaction('rw', db.gradescope, async () => {
    await db.gradescope.where('courseId').equals(courseId).delete();
    await db.gradescope.bulkPut(rows);
  });
  return { ok: true, count: rows.length, courseName };
}

// "Problem Set 7 (Gradescope)" and "problem set 7" compare equal.
const normName = (s) => String(s || '').toLowerCase().replace(/\(gradescope\)/g, '').replace(/[^a-z0-9]/g, '');

// A Gradescope row in the shape the dashboard uses for Canvas assignments.
const asAssignment = (g) => ({
  id: g.id,
  source: 'gradescope',
  name: g.name,
  courseName: g.courseName,
  due_at: g.dueAt,
  lock_at: null,
  submission_types: ['external_tool'],
  html_url: g.url,
  gradescope: g,
});

// Canvas assignments plus Gradescope deadlines. A Canvas assignment and a Gradescope row with the same
// normalized name and due dates within 1 hour become one entry carrying both links (a.gradescope).
// Gradescope rows without a due date, or more than KEEP_PAST_DUE_DAYS past their (late) due date, are left out.
export function mergeDeadlines(canvas, gradescopeRows, now = Date.now()) {
  const cutoff = now - KEEP_PAST_DUE_DAYS * 86_400_000;
  const shown = gradescopeRows.filter((g) => g.dueAt && Math.max(Date.parse(g.dueAt), Date.parse(g.lateDueAt) || 0) >= cutoff);
  const used = new Set();
  const merged = canvas.map((a) => {
    const due = Date.parse(a.due_at);
    if (Number.isNaN(due)) return a;
    const match = shown.find((g) => !used.has(g.id) && normName(g.name) === normName(a.name) && Math.abs(Date.parse(g.dueAt) - due) <= HOUR);
    if (!match) return a;
    used.add(match.id);
    return { ...a, gradescope: match };
  });
  return [...merged, ...shown.filter((g) => !used.has(g.id)).map(asAssignment)];
}

export const GRADESCOPE_STATUS_LABELS = {
  not_submitted: 'Not submitted on Gradescope',
  submitted: 'Submitted on Gradescope',
  graded: 'Graded on Gradescope',
  unknown: 'Status unknown',
};

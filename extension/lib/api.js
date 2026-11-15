// CampusFallback backend client. Sends only a SHA-256 hash or short metadata (names and dates), never files.
import { API_BASE } from './config.js';

// kind: offline  - server unreachable, timed out, 5xx or rate-limited (retry later)
//       rejected - the server refused the request (4xx)
export class ApiError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

async function post(path, body, timeoutMs) {
  let res;
  let data = null;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    throw new ApiError('offline', err.name === 'TimeoutError' ? 'CampusFallback server timed out' : 'CampusFallback server unreachable');
  }
  if (res.ok) return data;
  const message = data?.error || `CampusFallback server returned ${res.status}`;
  throw new ApiError(res.status >= 500 || res.status === 429 ? 'offline' : 'rejected', message, res.status);
}

// -> { sha256, genTime, verifyUrl }. genTime is FreeTSA's clock, never this laptop's.
export const timestamp = (sha256) => post('/api/timestamp', { sha256 }, 15_000);

// assignments: [{ name, course, dueAt, points }], and nothing else: never descriptions or files.
// -> { text, source: 'gemini' | 'template' }. Throws ApiError.
export const digest = (assignments) => post('/api/digest', {
  assignments: assignments.map(({ name, course, dueAt, points }) => ({ name, course, dueAt, points })),
}, 12_000);

const eastern = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

// Same wording as the server's template, for when the server can't be reached.
// platform: 'canvas' (default) or 'gradescope'.
export function localEmailDraft({ courseName, assignmentName, dueAt, sealedAt, verifyUrl, platform = 'canvas' }) {
  const where = platform === 'gradescope' ? 'Gradescope' : 'Canvas';
  const due = dueAt ? ` before it was due (${eastern.format(new Date(dueAt))})` : '';
  const proof = sealedAt
    ? `To show my work was finished on time, a fingerprint of my file was timestamped by an independent service (FreeTSA) at ${eastern.format(new Date(sealedAt))}.`
    : `My file is ready and saved, and I will submit it the moment ${where} is back.`;
  const check = verifyUrl ? `\n\nYou can check the file I submit against that timestamp here:\n${verifyUrl}` : '';
  const then = platform === 'gradescope'
    ? 'I will upload the same file to Gradescope as soon as it is reachable again.'
    : 'I will submit the same file on Canvas as soon as it is reachable again.';
  return {
    subject: `${courseName}: ${assignmentName} - ${where} was unavailable at the deadline`,
    body: `Dear Professor,\n\nI tried to submit "${assignmentName}" for ${courseName}${due}, but ${where} was unavailable. ${proof}${check}\n\n${then} Thank you for your understanding.\n\nBest regards,`,
    source: 'local',
  };
}

// -> { subject, body, source: 'gemini' | 'template' | 'local' }. Never throws.
export async function draftEmail(details) {
  if (!details.dueAt) return localEmailDraft(details); // the server needs a due date
  try {
    const draft = await post('/api/draft-email', details, 12_000);
    if (typeof draft?.subject === 'string' && typeof draft?.body === 'string') return draft;
  } catch { /* fall through */ }
  return localEmailDraft(details);
}

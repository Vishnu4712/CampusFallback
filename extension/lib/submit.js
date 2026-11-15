// The 3-step Canvas file submission. This is the only code in the extension that writes to Canvas,
// and it refuses to run unless the target is the mock (real UMass Canvas is read-only).
import { CANVAS_BASE, CANVAS_WRITABLE } from './config.js';

const STEP_TIMEOUT_MS = 15_000;

// kind: down     - Canvas or its file storage did not answer, or returned 5xx (retry later)
//       session  - not logged in: 401, redirect to login, or an HTML page (retry after the student logs in)
//       locked   - 403 or "locked" (stop; the professor has to decide)
//       rejected - any other 4xx, e.g. wrong file type (stop; show the message)
//       blocked  - submissions are disabled for this Canvas target
export class SubmitError extends Error {
  constructor(kind, message, step = 0, status = 0) {
    super(message);
    this.name = 'SubmitError';
    this.kind = kind;
    this.step = step;
    this.status = status;
  }
}

export const canSubmitTo = (assignment) => CANVAS_WRITABLE && (assignment?.submission_types || []).includes('online_upload');

const canvasOrigin = new URL(CANVAS_BASE).origin;

function canvasUrl(path) {
  const url = new URL(path, CANVAS_BASE);
  if (url.origin !== canvasOrigin) throw new SubmitError('blocked', `Refusing to post to ${url.origin}`);
  return url.href;
}

function errorMessage(data, status) {
  return data?.errors?.[0]?.message || data?.message || data?.error || `Canvas returned ${status}`;
}

async function call(step, url, init) {
  let res;
  let text;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
    text = await res.text();
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'timed out after 15 s' : 'could not be reached';
    throw new SubmitError('down', `Canvas ${why} (step ${step} of 3)`, step);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new SubmitError('session', 'Canvas sent us to the login page', step, res.status);
  }
  let data = null;
  try { data = JSON.parse(text.replace(/^while\(1\);/, '')); } catch { /* not JSON */ }

  if (res.status >= 500) throw new SubmitError('down', `Canvas is down (${res.status}, step ${step} of 3)`, step, res.status);
  if (res.status === 401 && data?.status !== 'unauthorized') throw new SubmitError('session', 'Canvas needs you to log in again', step, 401);
  if (res.status === 401 || res.status === 403 || /\blocked\b/i.test(errorMessage(data, res.status))) {
    throw new SubmitError('locked', errorMessage(data, res.status), step, res.status);
  }
  if (!res.ok) throw new SubmitError('rejected', errorMessage(data, res.status), step, res.status);
  if (data === null) throw new SubmitError('session', 'Canvas answered with a login page', step, res.status);
  return { data, res };
}

// Canvas wants the _csrf_token cookie, URL-decoded, in X-CSRF-Token.
async function csrfToken() {
  const read = async () => (await chrome.cookies.get({ url: `${canvasOrigin}/`, name: '_csrf_token' }))?.value;
  let value = await read();
  if (!value) {
    // No cookie yet: any Canvas request sets one. If this fails, Canvas is down.
    await call(1, canvasUrl('/api/v1/courses?per_page=1'), { method: 'GET', credentials: 'include', redirect: 'manual' });
    value = await read();
  }
  if (!value) throw new SubmitError('session', 'No Canvas session cookie. Log in to Canvas once', 1);
  try { return decodeURIComponent(value); } catch { return value; }
}

// Submits one file. onStep(n, label) reports progress. Returns Canvas's submission ({ submitted_at, attempt, ... }).
export async function submitFile({ courseId, assignmentId, blob, fileName }, onStep = () => {}) {
  if (!CANVAS_WRITABLE) throw new SubmitError('blocked', 'Submitting is turned off for real Canvas in this build');
  const base = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
  const contentType = blob.type || 'application/octet-stream';

  onStep(1, 'asking Canvas for an upload slot');
  const token = await csrfToken();
  const apiPost = (step, path, params) => call(step, canvasUrl(path), {
    method: 'POST',
    credentials: 'include',
    redirect: 'manual',
    headers: { Accept: 'application/json', 'X-CSRF-Token': token },
    body: params,
  });
  const slot = (await apiPost(1, `${base}/self/files`, new URLSearchParams({ name: fileName, size: String(blob.size), content_type: contentType }))).data;
  if (!slot?.upload_url) throw new SubmitError('rejected', 'Canvas did not return an upload URL', 1);

  // Step 2 goes to Canvas's file storage (a different server on real Canvas). The upload URL itself is the credential.
  onStep(2, 'uploading the file');
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.upload_params || {})) form.append(key, value);
  form.append(slot.file_param || 'file', blob, fileName);
  const uploaded = await call(2, slot.upload_url, { method: 'POST', credentials: 'omit', body: form });
  let fileId = uploaded.data?.id;
  const location = uploaded.res.headers.get('Location');
  if (!fileId && location) fileId = (await call(2, location, { method: 'GET', credentials: 'include' })).data?.id;
  if (!fileId) throw new SubmitError('rejected', 'Canvas did not return a file id', 2);

  onStep(3, 'submitting the uploaded file');
  const params = new URLSearchParams();
  params.append('submission[submission_type]', 'online_upload');
  params.append('submission[file_ids][]', String(fileId));
  const submission = (await apiPost(3, base, params)).data;
  if (!submission?.submitted_at) throw new SubmitError('rejected', 'Canvas did not confirm the submission', 3);
  return submission;
}

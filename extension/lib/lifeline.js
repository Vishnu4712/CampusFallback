// Deadline lifeline. Runs in the dashboard page (never the service worker, which Chrome may stop mid-upload).
//   check -> fingerprint -> Canvas -> (only if Canvas can't take the file) seal -> queue -> email
// Gradescope assignments: check -> fingerprint -> seal -> queue a reminder -> email. Nothing is sent to Gradescope.
import { fingerprintFile, extensionOf } from './hash.js';
import { submitFile, canSubmitTo } from './submit.js';
import { timestamp, draftEmail } from './api.js';
import { enqueue, saveReceipt } from './queue.js';
import { CANVAS_WRITABLE } from './config.js';
import { db } from './db.js';
import { isGradescope, gradescopeUrl } from './gradescope.js';

export const STEPS = [
  ['check', 'Check the file'],
  ['fingerprint', 'Fingerprint it on this laptop'],
  ['canvas', 'Submit to Canvas'],
  ['seal', 'Seal the fingerprint with FreeTSA'],
  ['queue', 'Queue for auto-submit'],
  ['email', 'Email your professor'],
];

// Same steps, with labels that fit a Gradescope assignment.
const GRADESCOPE_LABELS = { canvas: 'Upload to Gradescope (you do this)', queue: 'Remind you when Gradescope is back' };
export const stepsFor = (assignment) => (isGradescope(assignment)
  ? STEPS.map(([key, label]) => [key, GRADESCOPE_LABELS[key] || label])
  : STEPS);

const GMAIL_MAX = 1800;
const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
export const formatEastern = (iso) => eastern.format(new Date(iso));

const TYPE_LABELS = { external_tool: 'an external tool such as Gradescope', on_paper: 'paper', none: 'no submission', online_text_entry: 'text entry', online_url: 'a website URL' };

// Gmail compose link, kept under about 1,800 characters by falling back to a short body with the verify link.
export function gmailComposeUrl(to, subject, body, verifyUrl, platform = 'canvas') {
  const build = (s, b) => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to || '')}&su=${encodeURIComponent(s)}&body=${encodeURIComponent(b)}`;
  let url = build(subject, body);
  if (url.length <= GMAIL_MAX) return url;
  const where = platform === 'gradescope' ? 'Gradescope' : 'Canvas';
  const short = `Dear Professor,\n\n${where} was unavailable when I tried to submit this assignment before the deadline.${verifyUrl ? ` Timestamp proof for my file:\n${verifyUrl}` : ''}\n\nI will ${platform === 'gradescope' ? 'upload the same file to Gradescope as soon as it is reachable' : 'submit the same file as soon as Canvas is back'}.\n\nBest regards,`;
  url = build(subject.slice(0, 120), short);
  return url.length <= GMAIL_MAX ? url : build(subject.slice(0, 60), short.slice(0, 600));
}

async function seal(sha256) {
  try {
    return { receipt: await timestamp(sha256) };
  } catch (error) {
    return { error };
  }
}

// onStep(key, state, detail): state is active | done | failed | skipped.
// Returns { outcome, sha256, receipt, submission, queueId, gmailUrl, draftSource, error }.
// outcome: blocked | submitted | rejected | queued | locked | sealed | remind (Gradescope)
export async function runLifeline({ assignment, courseName, file, teacherEmail }, onStep = () => {}) {
  const result = { outcome: null, sha256: null, receipt: null, submission: null, queueId: null, gmailUrl: null, draftSource: null, error: null };
  const types = assignment.submission_types || [];
  const uploadable = canSubmitTo(assignment);
  const gradescope = isGradescope(assignment);

  // 1. Check, before anything is sealed.
  onStep('check', 'active');
  const allowed = (assignment.allowed_extensions || []).map((e) => e.toLowerCase());
  const ext = extensionOf(file.name);
  let problem = null;
  if (!file.size) problem = 'This file is empty. Pick the file you meant to submit.';
  else if (uploadable && allowed.length && !allowed.includes(ext)) {
    problem = `Canvas only accepts ${allowed.map((e) => `.${e}`).join(', ')} for this assignment, and this file is ${ext ? `.${ext}` : 'missing an extension'}. Pick a different file.`;
  }
  if (problem) {
    onStep('check', 'failed', problem);
    return { ...result, outcome: 'blocked', error: problem };
  }
  const notUpload = gradescope
    ? 'Gradescope assignment: Lifeline will seal and email, then tell you when Gradescope is back so you can upload this same file'
    : !types.includes('online_upload')
    ? `Submitted through ${types.map((t) => TYPE_LABELS[t] || t).join(' or ') || 'another channel'}, so Lifeline will seal and email but cannot submit it for you`
    : !CANVAS_WRITABLE ? 'Submitting is off for real Canvas in this build, so Lifeline will seal and email only' : null;
  onStep('check', 'done', notUpload || `${file.name} is an accepted file type`);

  // 2. Fingerprint.
  onStep('fingerprint', 'active');
  const { sha256, blob } = await fingerprintFile(file);
  result.sha256 = sha256;
  onStep('fingerprint', 'done', `SHA-256 ${sha256.slice(0, 16)}…  (only this fingerprint leaves your laptop)`);

  // 3. Canvas first. Sealing is only for when Canvas can't take the file.
  let canvas = null; // submitted | down | session | locked | rejected
  if (uploadable) {
    onStep('canvas', 'active', 'Step 1 of 3: asking Canvas for an upload slot');
    try {
      result.submission = await submitFile(
        { courseId: assignment.courseId, assignmentId: assignment.id, blob, fileName: file.name },
        (n, label) => onStep('canvas', 'active', `Step ${n} of 3: ${label}`),
      );
      canvas = 'submitted';
      // Record it locally now, so the dashboard and digest know before the next sync.
      await db.assignments.update(assignment.id, { submission: result.submission });
      onStep('canvas', 'done', `Uploaded on Canvas at ${formatEastern(result.submission.submitted_at)}`);
    } catch (err) {
      canvas = err.kind;
      result.error = err.message;
      const detail = {
        down: `${err.message}. Lifeline will submit this exact file when Canvas is back`,
        session: `${err.message}. Login (NetID or Microsoft) may be down. Lifeline will keep trying`,
        locked: `Canvas says: ${err.message}. It can't be submitted automatically`,
        rejected: `Canvas refused the file: ${err.message}`,
        blocked: err.message,
      }[err.kind] || err.message;
      onStep('canvas', 'failed', detail);
    }
  } else {
    onStep('canvas', 'skipped', gradescope ? 'Lifeline never uploads to Gradescope; you will upload this same file' : 'Not a Canvas file upload');
  }

  // Canvas has the file, or the file itself is the problem: nothing to seal, queue or email.
  if (canvas === 'submitted' || canvas === 'rejected' || canvas === 'blocked') {
    const why = canvas === 'submitted' ? 'Not needed: Canvas has your work' : 'Fix the problem above and try again';
    onStep('seal', 'skipped', why);
    onStep('queue', 'skipped', why);
    onStep('email', 'skipped', why);
    return { ...result, outcome: canvas === 'submitted' ? 'submitted' : 'rejected' };
  }

  // 4. Canvas couldn't take it (down, login down, locked, or not a Canvas upload): seal the fingerprint.
  onStep('seal', 'active', 'Asking FreeTSA for a timestamp…');
  const sealed = await seal(sha256);
  if (sealed.receipt) {
    result.receipt = sealed.receipt;
    await saveReceipt(sealed.receipt, { assignmentId: assignment.id, fileName: file.name });
    const late = assignment.due_at && Date.parse(sealed.receipt.genTime) > Date.parse(assignment.due_at);
    onStep('seal', 'done', `Sealed at ${formatEastern(sealed.receipt.genTime)} by FreeTSA${late ? ' (after the due time)' : ''}`);
  } else {
    onStep('seal', 'failed', `Unsealed: connect to a hotspot. ${sealed.error.message}. Lifeline will retry automatically`);
  }

  // 5. Queue (before Gmail opens, so nothing is lost if the student switches tabs).
  const needSubmit = canvas === 'down' || canvas === 'session';
  if (gradescope) {
    result.gradescopeUrl = gradescopeUrl(assignment);
    result.queueId = await enqueue({ ...queueBase(assignment, courseName, file, sha256), type: 'remind', receipt: result.receipt, gradescopeUrl: result.gradescopeUrl });
    chrome.runtime.sendMessage({ type: 'queueChanged' }).catch(() => {});
    onStep('queue', 'done', 'Lifeline checks Gradescope every 2 minutes and notifies you when it is back');
  } else if (needSubmit || !result.receipt) {
    result.queueId = await enqueue({ ...queueBase(assignment, courseName, file, sha256), fileBlob: needSubmit ? blob : null, receipt: result.receipt, submit: needSubmit });
    chrome.runtime.sendMessage({ type: 'queueChanged' }).catch(() => {});
    onStep('queue', 'done', needSubmit
      ? 'Queued. Lifeline retries every 2 minutes and submits this exact file when Canvas is back'
      : 'Queued to seal as soon as the CampusFallback server is reachable');
  } else {
    onStep('queue', 'skipped', canvas === 'locked' ? 'Canvas has locked this assignment' : 'Nothing to submit on Canvas');
  }

  // 6. Email.
  onStep('email', 'active', 'Drafting your email…');
  const draft = await draftEmail({
    courseName,
    assignmentName: assignment.name,
    dueAt: assignment.due_at,
    sealedAt: result.receipt?.genTime ?? null,
    verifyUrl: result.receipt?.verifyUrl ?? null,
    platform: gradescope ? 'gradescope' : 'canvas',
  });
  result.draftSource = draft.source;
  result.gmailUrl = gmailComposeUrl(teacherEmail, draft.subject, draft.body, result.receipt?.verifyUrl, gradescope ? 'gradescope' : 'canvas');
  await chrome.tabs.create({ url: result.gmailUrl });
  const by = draft.source === 'gemini' ? 'drafted by Gemini' : 'standard wording';
  onStep('email', 'done', teacherEmail ? `Opened in Gmail, to ${teacherEmail} (${by}). Review it and press Send` : `Opened in Gmail (${by}). Add your professor's address, then press Send`);

  return { ...result, outcome: gradescope ? 'remind' : needSubmit ? 'queued' : canvas === 'locked' ? 'locked' : 'sealed' };
}

function queueBase(assignment, courseName, file, sha256) {
  return {
    courseId: assignment.courseId,
    assignmentId: assignment.id,
    // A copy, because sync drops assignments a week after they are due.
    assignment: { name: assignment.name, courseName, due_at: assignment.due_at ?? null, html_url: assignment.html_url ?? null },
    fileName: file.name,
    sha256,
  };
}

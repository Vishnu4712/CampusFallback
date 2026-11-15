// Lifeline dialog and the queue card on the dashboard.
import { runLifeline, stepsFor, formatEastern } from '../lib/lifeline.js';
import { canSubmitTo } from '../lib/submit.js';
import { isGradescope } from '../lib/gradescope.js';
import { shortHash } from '../lib/hash.js';

const ICONS = { pending: '○', active: '…', done: '✓', failed: '✕', skipped: '–' };
const STATE_WORDS = { pending: 'Not started', active: 'In progress', done: 'Done', failed: 'Problem', skipped: 'Skipped' };
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

// ---------- dialog ----------

// ctx: { course, teachers, onChange }
export function openLifeline(assignment, ctx) {
  const dialog = document.getElementById('lifeline-dialog');
  const body = document.getElementById('lifeline-body');
  const courseName = ctx.course?.name || ctx.course?.course_code || 'my course';
  const uploadable = canSubmitTo(assignment);
  const gradescope = isGradescope(assignment);
  const STEPS = stepsFor(assignment);
  const allowed = assignment.allowed_extensions || [];
  const teacherEmails = (ctx.teachers || []).map((t) => t.email).filter(Boolean);

  const fileInput = el('input', { type: 'file', id: 'lifeline-file', required: true, accept: uploadable && allowed.length ? allowed.map((e) => `.${e}`).join(',') : null });
  const emailInput = el('input', { type: 'email', id: 'lifeline-email', value: teacherEmails.join(', ') || null, placeholder: 'professor@umass.edu', autocomplete: 'email', multiple: true });
  const startButton = el('button', { type: 'submit', class: 'btn' }, uploadable ? 'Submit with Lifeline' : 'Seal and email');
  const formError = el('p', { class: 'form-error', role: 'alert', hidden: true });

  const stepNodes = new Map();
  const steps = el('ol', { class: 'steps', 'aria-label': 'Lifeline progress', hidden: true }, STEPS.map(([key, label]) => {
    const node = {
      li: el('li', { class: 'step', 'data-state': 'pending' }),
      icon: el('span', { class: 'step-icon', 'aria-hidden': 'true', text: ICONS.pending }),
      state: el('span', { class: 'sr-only', text: `${STATE_WORDS.pending}: ` }),
      detail: el('span', { class: 'step-detail' }),
    };
    node.li.append(node.icon, el('span', { class: 'step-text' }, node.state, el('span', { class: 'step-label', text: label }), node.detail));
    stepNodes.set(key, node);
    return node.li;
  }));
  const live = el('p', { class: 'sr-only', 'aria-live': 'polite' });
  const resultBox = el('div', { class: 'lifeline-result' });

  const setStep = (key, state, detail = '') => {
    const node = stepNodes.get(key);
    if (!node) return;
    node.li.dataset.state = state;
    node.icon.textContent = ICONS[state];
    node.state.textContent = `${STATE_WORDS[state]}: `;
    node.detail.textContent = detail;
    if (state !== 'active') live.textContent = `${STEPS.find(([k]) => k === key)[1]}: ${STATE_WORDS[state]}. ${detail}`;
  };

  const form = el('form', { class: 'lifeline-form', novalidate: true },
    el('label', { for: 'lifeline-file', text: 'Your file' }), fileInput,
    el('p', { class: 'hint', text: uploadable && allowed.length ? `Canvas accepts ${allowed.map((e) => `.${e}`).join(', ')} for this assignment.` : 'Any file type.' }),
    el('label', { for: 'lifeline-email', text: "Professor's email" }), emailInput,
    el('p', { class: 'hint', text: teacherEmails.length ? 'From Canvas. You can change it.' : 'Canvas does not show this address to students. Type it in, or add it in Gmail later.' }),
    formError,
    startButton);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files[0];
    const to = emailInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    formError.hidden = true;
    if (!file) return showError('Choose the file to submit.');
    if (to.some((a) => !EMAIL_RE.test(a))) return showError('That email address does not look right.');

    for (const [key] of STEPS) setStep(key, 'pending');
    steps.hidden = false;
    resultBox.replaceChildren();
    setFormEnabled(false);
    startButton.textContent = 'Working…';
    let result;
    try {
      result = await runLifeline({ assignment, courseName, file, teacherEmail: to.join(',') }, setStep);
    } catch (err) {
      result = { outcome: 'error', error: err.message };
    }
    renderResult(result);
    const retryable = ['blocked', 'rejected', 'error'].includes(result.outcome);
    setFormEnabled(retryable);
    startButton.textContent = retryable ? 'Try again' : 'Done';
    startButton.disabled = !retryable;
    ctx.onChange?.();
  });

  function showError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  function setFormEnabled(enabled) {
    fileInput.disabled = !enabled;
    emailInput.disabled = !enabled;
    startButton.disabled = !enabled;
  }

  function renderResult(r) {
    const headline = {
      submitted: ['ok', 'Uploaded on Canvas.'],
      queued: ['warn', 'Canvas is down. Your work is sealed and queued.'],
      locked: ['bad', 'Canvas has locked this assignment. Your work is sealed and your professor is emailed.'],
      sealed: ['ok', 'Sealed. Your professor is emailed.'],
      remind: ['warn', 'Sealed. Your professor is emailed. Lifeline will tell you when Gradescope is back.'],
      rejected: ['bad', 'Canvas refused the file.'],
      blocked: ['bad', 'Pick a different file.'],
      error: ['bad', `Something went wrong: ${r.error}`],
    }[r.outcome] || ['bad', 'Stopped.'];
    if (r.outcome === 'queued' && !r.receipt) headline[1] = 'Canvas is down and your file is not sealed yet. It is queued; connect to a hotspot.';
    resultBox.replaceChildren(...[
      el('p', { class: `result-headline result-${headline[0]}`, text: headline[1] }),
      r.receipt && el('dl', { class: 'facts receipt' },
        el('dt', { text: 'Sealed at' }), el('dd', { text: `${formatEastern(r.receipt.genTime)} (FreeTSA's clock)` }),
        el('dt', { text: 'Fingerprint' }), el('dd', {}, el('code', { title: r.sha256, text: shortHash(r.sha256) })),
        el('dt', { text: 'Proof link' }), el('dd', {}, el('a', { href: r.receipt.verifyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Verify page' }))),
      r.outcome === 'remind' && gradescopeActions({ sha256: r.sha256, fileName: fileInput.files[0]?.name, gradescopeUrl: r.gradescopeUrl }),
      r.gmailUrl && el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => chrome.tabs.create({ url: r.gmailUrl }) }, 'Open the email again'),
      r.outcome === 'queued' && el('p', { class: 'hint', text: 'You can close this. Keep Chrome open; you will get a notification when Canvas accepts the file.' }),
    ].filter(Boolean));
  }

  body.replaceChildren(...[
    el('p', { class: 'lifeline-assignment' },
      el('strong', { text: assignment.name }), el('br'),
      el('span', { class: 'file-meta', text: `${courseName}${assignment.due_at ? ` · Due ${formatEastern(assignment.due_at)}` : ''}` })),
    !uploadable && el('p', { class: 'notice', text: gradescope
      ? 'This is a Gradescope assignment. Lifeline seals your file and emails your professor, then tells you when Gradescope is back so you upload this same file. It never uploads to Gradescope for you.'
      : (assignment.submission_types || []).includes('online_upload')
      ? 'Submitting is turned off for real Canvas in this build. Lifeline will seal your file and email your professor.'
      : 'This assignment is not a Canvas file upload. Lifeline will seal your file and email your professor, but it cannot submit it for you.' }),
    form, steps, live, resultBox,
  ].filter(Boolean));
  if (!dialog.open) dialog.showModal();
  fileInput.focus();
}

// ---------- queue card ----------

// What to upload and where: the first 8 characters of the sealed fingerprint, so the student can check
// it is the same file, and a link to the assignment on Gradescope.
function gradescopeActions(item, onMarkDone) {
  return el('span', { class: 'gradescope-actions' },
    el('span', { class: 'file-meta' }, 'Upload ', el('strong', { text: item.fileName || 'the sealed file' }), ' · fingerprint ',
      el('code', { title: item.sha256, text: item.sha256.slice(0, 8) })),
    item.gradescopeUrl && el('a', { class: 'btn btn-quiet btn-small', href: item.gradescopeUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open on Gradescope' }),
    onMarkDone && el('button', { type: 'button', class: 'btn btn-small', onclick: (e) => { e.currentTarget.disabled = true; onMarkDone(item.id); } }, 'Uploaded — mark done'));
}

function describeRemind(item) {
  if (item.remindState === 'done') return ['ok', 'Uploaded to Gradescope'];
  if (item.remindState === 'needs-professor') return ['bad', 'Gradescope stayed down 48 h past the due date. Stopped reminding; your professor has the receipt'];
  if (item.remindState === 'reminded') return ['urgent', 'Gradescope is back: upload it now'];
  if (item.sealState === 'pending') return ['warn', 'Unsealed: connect to a hotspot · waiting for Gradescope'];
  return ['warn', 'Sealed · waiting for Gradescope (checked every 2 min)'];
}

function describe(item) {
  if (item.type === 'remind') return describeRemind(item);
  if (item.submitState === 'done') return ['ok', `Uploaded on Canvas ${item.submittedAt ? formatEastern(item.submittedAt) : ''}`];
  if (item.submitState === 'needs-professor') return ['bad', 'Canvas locked it. Stopped retrying; your professor has the receipt'];
  if (item.submitState === 'failed') return ['bad', `Canvas refused it: ${item.lastError || ''}`];
  if (item.submitState === 'pending') {
    const wait = Math.max(0, Math.round((item.nextAttemptAt - Date.now()) / 60_000));
    return ['warn', `Waiting for Canvas · next try ${wait ? `in ${wait} min` : 'now'}${item.lastError ? ` · ${item.lastError}` : ''}`];
  }
  if (item.sealState === 'pending') return ['warn', 'Unsealed: connect to a hotspot'];
  return ['ok', 'Sealed'];
}

// Still needs the student or the background: a Gradescope reminder that fired stays here until marked done.
const needsAttention = (q) => q.open || q.remindState === 'reminded';

// items: rows from db.queue. Shows open items and the 5 most recent finished ones.
export function renderQueueCard(container, items, { onRetry, onMarkDone }) {
  const visible = items.filter((q) => (q.submitState !== 'replaced' && q.remindState !== 'replaced') || q.open);
  const open = visible.filter(needsAttention);
  const recent = visible.filter((q) => !needsAttention(q)).sort((a, b) => (b.lastTriedAt || b.createdAt) - (a.lastTriedAt || a.createdAt)).slice(0, 5);
  container.hidden = open.length + recent.length === 0;
  if (container.hidden) return;

  const retry = el('button', { type: 'button', class: 'btn btn-small', disabled: !open.some((q) => q.open) }, 'Retry now');
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    retry.textContent = 'Retrying…';
    await onRetry();
  });

  container.replaceChildren(
    el('div', { class: 'queue-head' },
      el('h2', { id: 'queue-title', text: open.length ? `Lifeline queue (${open.length} waiting)` : 'Lifeline queue' }),
      retry),
    el('ul', { class: 'queue-list' }, [...open, ...recent].map((item) => {
      const [tone, text] = describe(item);
      return el('li', { class: 'queue-item' },
        el('span', { class: 'queue-name' }, el('strong', { text: item.assignment?.name || `Assignment ${item.assignmentId}` }), ` · ${item.fileName}`),
        el('span', { class: `badge badge-${tone}`, text }),
        item.receipt && el('span', { class: 'file-meta', text: `Sealed ${formatEastern(item.receipt.genTime)}` }),
        item.type === 'remind' && !['done', 'replaced'].includes(item.remindState) && gradescopeActions(item, onMarkDone));
    })));
}

// Badge for an assignment row, from its latest queue item.
export function queueBadge(item) {
  if (!item) return null;
  if (item.type === 'remind') {
    const [cls, text] = {
      sealed: ['warn', 'Waiting for Gradescope'],
      reminded: ['urgent', 'Upload to Gradescope now'],
      done: ['ok', 'Uploaded to Gradescope'],
      'needs-professor': ['urgent', 'Gradescope down: professor emailed'],
    }[item.remindState] || [];
    return text ? el('span', { class: `badge badge-${cls}`, text }) : null;
  }
  if (item.submitState === 'pending') return el('span', { class: 'badge badge-warn', text: 'Queued by Lifeline' });
  if (item.submitState === 'done') return el('span', { class: 'badge badge-ok', text: 'Uploaded on Canvas' });
  if (item.submitState === 'needs-professor') return el('span', { class: 'badge badge-urgent', text: 'Locked: professor emailed' });
  if (item.receipt) return el('span', { class: 'badge badge-ok', text: 'Sealed' });
  return null;
}

// Offline dashboard. Everything on screen is read from IndexedDB; the only network calls are the status
// check in the banner, the "Sync now" message to the service worker, and one digest refresh per sync.
import { getDashboardData, getFileBlob, getSyncState, getDigest, saveDigest, setExtraCourseIds } from '../lib/db.js';
import { digest as fetchDigest } from '../lib/api.js';
import { probeCanvas } from '../lib/canvas.js';
import { CANVAS_BASE, TARGET } from '../lib/config.js';
import { processQueue, markRemindDone } from '../lib/queue.js';
import { isGradescope, gradescopeUrl, gradescopeReachable, mergeDeadlines, GRADESCOPE_STATUS_LABELS } from '../lib/gradescope.js';
import { openLifeline as openLifelineDialog, renderQueueCard, queueBadge } from './lifeline-ui.js';

const TZ = 'America/New_York';
const DAY = 86_400_000;
const STATUS_EVERY_MS = 30_000;

const dateTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
const formatDateTime = (iso) => dateTimeFmt.format(new Date(iso));

const SUBMISSION_LABELS = {
  online_upload: 'File upload',
  online_text_entry: 'Text entry',
  online_url: 'Website URL',
  media_recording: 'Media recording',
  external_tool: 'External tool (for example Gradescope)',
  on_paper: 'On paper',
  online_quiz: 'Quiz',
  discussion_topic: 'Discussion',
  none: 'No submission',
  not_graded: 'Not graded',
};

const $ = (id) => document.getElementById(id);

let data = null;
let selectedId = null;
let syncSignature = '';
const courseById = new Map();
const fileById = new Map();
const rowById = new Map(); // assignment id -> { li, button }
const queueByAssignment = new Map(); // assignment id -> latest queue item
const RETRY_WHEN_ONLINE_MS = 20_000;
let relativeNodes = []; // [{ node, ms }] kept fresh by the status timer

// ---------- small helpers ----------

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

function relative(ms, now = Date.now()) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? 'in under a minute' : 'just now';
  const days = Math.round(abs / DAY);
  const text = abs < 3_600_000 ? `${Math.round(abs / 60_000)} min`
    : abs < 1.5 * DAY ? `${Math.round(abs / 3_600_000)} h`
    : `${days} days`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
}

// ---------- sanitizer ----------
// Canvas HTML is rebuilt from an allowlist: only these tags, and only href / colspan / rowspan as attributes.
// Scripts, iframes, styles, forms, images and every event handler are left behind.

const ALLOWED_TAGS = new Set(['P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'CODE', 'PRE', 'SPAN', 'DIV',
  'TABLE', 'CAPTION', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD']);
const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'LINK', 'META', 'BASE', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'VIDEO', 'AUDIO', 'CANVAS']);
const HEADING_MAP = { H1: 'h4', H2: 'h4', H3: 'h4', H4: 'h5', H5: 'h5', H6: 'h5' }; // keep the page's heading order intact
const XHTML = 'http://www.w3.org/1999/xhtml';

function sanitize(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const out = el('div', { class: 'rich' });
  copyClean(doc.body, out);
  return out;
}

function copyClean(from, to) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) { to.append(node.textContent); continue; }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName;
    if (node.namespaceURI !== XHTML || DROPPED_TAGS.has(tag)) continue; // dropped with everything inside
    if (tag === 'IMG') { if (node.alt) to.append(`[Image: ${node.alt}]`); continue; }
    if (!ALLOWED_TAGS.has(tag)) { copyClean(node, to); continue; } // unknown tag: keep its text only
    const clean = document.createElement(HEADING_MAP[tag] || tag.toLowerCase());
    if (tag === 'A') setSafeLink(clean, node.getAttribute('href'));
    if (tag === 'TD' || tag === 'TH') {
      for (const attr of ['colspan', 'rowspan']) {
        const n = parseInt(node.getAttribute(attr), 10);
        if (n > 1 && n < 100) clean.setAttribute(attr, n);
      }
    }
    copyClean(node, clean);
    to.append(clean);
  }
}

function setSafeLink(a, href) {
  let url;
  try { url = new URL(href, CANVAS_BASE); } catch { return; }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return;
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // Links to a Canvas file we have cached open the local copy instead.
  const fileId = url.origin === new URL(CANVAS_BASE).origin && Number(/\/files\/(\d+)/.exec(url.pathname)?.[1]);
  if (fileId && fileById.get(fileId)?.cachedUpdatedAt) a.dataset.fileId = fileId;
}

// ---------- banner ----------

function renderBanner() {
  const { sync } = data;
  $('target-chip').hidden = TARGET !== 'mock';
  const last = $('last-synced');
  if (sync.lastSuccessAt) {
    last.textContent = `Last synced ${relative(sync.lastSuccessAt)} (${timeFmt.format(new Date(sync.lastSuccessAt))})`;
    last.title = formatDateTime(sync.lastSuccessAt);
  } else {
    last.textContent = 'Not synced yet';
  }
  const note = $('sync-note');
  note.replaceChildren();
  if (sync.status === 'error' && sync.lastErrorKind === 'session') {
    note.append(el('a', { href: CANVAS_BASE, target: '_blank', rel: 'noopener noreferrer', text: 'Log in to Canvas once to resume syncing' }));
  } else if (sync.status === 'error') {
    note.textContent = 'Last sync failed; showing saved data';
    note.title = sync.lastError || '';
  }
  note.hidden = !note.hasChildNodes();
}

async function internetReachable() {
  try {
    await fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

// navigator.onLine alone is wrong on sign-in-portal Wi-Fi, so both checks are real timed fetches.
// Canvas and Gradescope are separate services, so each gets its own pill.
async function checkStatus() {
  let canvasStatus;
  let gradescopeStatus;
  if (!navigator.onLine) {
    canvasStatus = ['offline', 'Offline'];
    gradescopeStatus = ['offline', 'Offline'];
  } else {
    let [canvas, internet, gradescopeUp] = await Promise.all([probeCanvas(3000), internetReachable(), gradescopeReachable(3000)]);
    // On real Canvas this page can't send the student's Canvas login (only a Canvas tab can), so "not logged in"
    // here only proves Canvas answered. The sync, which runs through a Canvas tab, says whether the session expired.
    if (TARGET === 'real' && canvas === 'session' && data?.sync.lastErrorKind !== 'session') canvas = 'ok';
    if (canvas === 'ok') canvasStatus = ['online', 'Canvas online'];
    else if (canvas === 'session') canvasStatus = ['session', 'Canvas session expired'];
    else canvasStatus = internet ? ['unreachable', 'Canvas unreachable'] : ['offline', 'Offline'];
    gradescopeStatus = gradescopeUp ? ['online', 'Gradescope online'] : internet ? ['unreachable', 'Gradescope unreachable'] : ['offline', 'Offline'];
  }
  setPill('status-pill', canvasStatus);
  setPill('gradescope-pill', gradescopeStatus);
  // The service a waiting item needs is answering again: retry now instead of waiting for the next alarm.
  const stale = (q) => q.open && Date.now() - (q.lastTriedAt || q.createdAt) > RETRY_WHEN_ONLINE_MS;
  const ready = (q) => (q.remindState === 'sealed' ? gradescopeStatus[0] === 'online' : canvasStatus[0] === 'online');
  if (data?.queue.some((q) => stale(q) && ready(q))) retryQueueNow();
}

function setPill(id, [kind, text]) {
  const pill = $(id);
  pill.className = `pill pill-${kind}`;
  if (pill.textContent !== text) pill.textContent = text;
}

// ---------- assignments ----------

const canUpload = (a) => (a.submission_types || []).includes('online_upload');

function renderAssignments() {
  const now = Date.now();
  const dated = data.assignments.filter((a) => a.due_at).map((a) => ({ a, due: Date.parse(a.due_at) }));
  const asc = (x, y) => x.due - y.due;
  const groups = [
    ['Due this week', dated.filter((x) => x.due >= now && x.due <= now + 7 * DAY).sort(asc), 'Nothing due in the next 7 days.'],
    ['Recently due', dated.filter((x) => x.due < now).sort((x, y) => y.due - x.due)],
    ['Later', [...dated.filter((x) => x.due > now + 7 * DAY).sort(asc), ...data.assignments.filter((a) => !a.due_at).map((a) => ({ a, due: null }))]],
  ];

  rowById.clear();
  relativeNodes = [];
  const container = $('assignment-groups');
  container.replaceChildren(...groups.filter(([, items, emptyText]) => items.length || emptyText).map(([title, items, emptyText]) => {
    const headingId = `group-${title.toLowerCase().replaceAll(' ', '-')}`;
    return el('section', { class: 'group', 'aria-labelledby': headingId },
      el('h2', { id: headingId, text: items.length ? `${title} (${items.length})` : title }),
      items.length ? el('ul', {}, items.map(assignmentRow)) : el('p', { class: 'none', text: emptyText }));
  }));

  const ordered = groups.flatMap(([, items]) => items.map((x) => x.a.id));
  if (!ordered.includes(selectedId)) selectedId = ordered[0] ?? null;
  markSelected();
  renderDetail();
}

function dueBadge(due) {
  if (due == null) return null;
  const node = el('span', { class: 'badge' });
  relativeNodes.push({ node, ms: due });
  refreshRelative(node, due);
  return node;
}

function refreshRelative(node, ms) {
  const diff = ms - Date.now();
  node.textContent = diff >= 0 ? `Due ${relative(ms)}` : `Was due ${relative(ms)}`;
  node.className = `badge${diff >= 0 && diff < DAY ? ' badge-urgent' : ''}`;
}

// Canvas itself says this is submitted (synced, or recorded right after a Lifeline upload).
function canvasBadge(a) {
  const done = a.submission?.submitted_at || CANVAS_SUBMITTED.has(a.submission?.workflow_state);
  return done ? el('span', { class: 'badge badge-ok', text: 'Uploaded on Canvas' }) : null;
}

// Where the deadline came from: Canvas, Gradescope, or both (merged into one entry).
function sourceBadge(a) {
  const text = a.source === 'gradescope' ? 'Gradescope' : a.gradescope ? 'Canvas + Gradescope' : 'Canvas';
  return el('span', { class: `badge badge-source${a.source === 'gradescope' || a.gradescope ? ' badge-gs' : ''}`, text });
}

// Gradescope's own status, when it was read from the student's course page.
function gradescopeStatusBadge(a) {
  const status = a.gradescope?.status;
  if (status === 'submitted' || status === 'graded') return el('span', { class: 'badge badge-ok', text: GRADESCOPE_STATUS_LABELS[status] });
  return null;
}

const courseLabel = (a) => {
  const course = courseById.get(a.courseId);
  return course?.course_code || course?.name || a.courseName || 'Course';
};

function assignmentRow({ a, due }) {
  const button = el('button', { type: 'button', class: 'row-main', onclick: () => select(a.id) },
    el('span', { class: 'row-title', text: a.name }),
    el('span', { class: 'row-meta', text: `${courseLabel(a)} · ${due == null ? 'No due date' : formatDateTime(a.due_at)}` }),
    el('span', { class: 'row-badges' }, sourceBadge(a), dueBadge(due),
      canvasBadge(a) || gradescopeStatusBadge(a) || queueBadge(queueByAssignment.get(a.id)),
      !canUpload(a) && !a.source && !a.gradescope && el('span', { class: 'badge badge-warn', text: isGradescope(a) ? 'Submit on Gradescope' : 'Not a Canvas upload' })));
  const li = el('li', { class: 'row' }, button,
    el('button', { type: 'button', class: 'btn btn-quiet btn-small', 'aria-label': `Submit ${a.name} with Lifeline`, onclick: () => openLifeline(a) }, 'Lifeline'));
  rowById.set(a.id, { li, button });
  return li;
}

function markSelected() {
  for (const [id, { li, button }] of rowById) {
    li.classList.toggle('selected', id === selectedId);
    if (id === selectedId) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

function select(id) {
  selectedId = id;
  markSelected();
  renderDetail();
}

function renderDetail() {
  const panel = $('assignment-detail');
  const a = data.assignments.find((x) => x.id === selectedId);
  panel.hidden = !a;
  if (!a) return;
  const course = courseById.get(a.courseId);
  const fromGradescope = a.source === 'gradescope';
  const gs = a.gradescope;
  const types = fromGradescope ? 'Gradescope' : (a.submission_types || []).map((t) => SUBMISSION_LABELS[t] || t).join(', ') || 'Not specified';
  const linkedIds = [...new Set([...(a.description || '').matchAll(/\/files\/(\d+)/g)].map((m) => Number(m[1])))];
  const linked = linkedIds.map((id) => fileById.get(id)).filter(Boolean);

  const fact = (label, value) => [el('dt', { text: label }), el('dd', {}, value)];
  panel.replaceChildren(...[
    el('h2', { text: a.name }),
    el('p', { class: 'course', text: course?.name || a.courseName || '' }),
    el('dl', { class: 'facts' },
      fact('Due', a.due_at ? `${formatDateTime(a.due_at)} (${relative(Date.parse(a.due_at))})` : 'No due date'),
      a.lock_at && fact('Closes', formatDateTime(a.lock_at)),
      gs?.lateDueAt && fact('Late due', `${formatDateTime(gs.lateDueAt)} (${relative(Date.parse(gs.lateDueAt))})`),
      gs && fact('Gradescope', `${GRADESCOPE_STATUS_LABELS[gs.status] || 'Status unknown'} · read ${relative(Date.parse(gs.updatedAt))}`),
      a.points_possible != null && fact('Points', String(a.points_possible)),
      fact('Submit by', types),
      canUpload(a) && fact('File types', a.allowed_extensions?.length ? a.allowed_extensions.map((e) => `.${e}`).join(', ') : 'Any')),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => openLifeline(a) }, 'Submit with Lifeline'),
      !fromGradescope && a.html_url && el('a', { href: a.html_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open in Canvas' }),
      gs && el('a', { href: gradescopeUrl(a), target: '_blank', rel: 'noopener noreferrer', text: 'Open on Gradescope' })),
    !fromGradescope && el('h3', { class: 'section-title', text: 'Description' }),
    fromGradescope ? el('p', { class: 'none', text: 'Read from your Gradescope course page. Open Gradescope for the full assignment.' })
      : a.description ? sanitize(a.description) : el('p', { class: 'none', text: 'No description.' }),
    linked.length ? [el('h3', { class: 'section-title', text: 'Files for this assignment' }), el('ul', { class: 'files' }, linked.map(fileRow))] : null,
  ].flat().filter(Boolean));
  panel.scrollTop = 0;
}

function openLifeline(assignment) {
  openLifelineDialog(assignment, {
    course: courseById.get(assignment.courseId) || (assignment.courseName ? { name: assignment.courseName } : null),
    teachers: data.teachers.filter((t) => t.courseId === assignment.courseId),
    onChange: load,
  });
}

async function retryQueueNow() {
  try {
    await processQueue({ force: true });
  } catch (err) {
    toast(`Retry failed: ${err.message}`);
  }
  chrome.runtime.sendMessage({ type: 'queueChanged' }).catch(() => {});
  await load();
}

// ---------- "what's due this week" digest ----------

let digestTriedFor = null; // digest key a refresh was already attempted for, so a failing API is not retried until something changes

// Handed in: submitted on Canvas, or taken care of by Lifeline (submitted, waiting to auto-submit,
// or sealed and emailed). A Lifeline item that Canvas refused still counts as to-do.
const CANVAS_SUBMITTED = new Set(['submitted', 'graded', 'pending_review']);
function handedIn(a) {
  if (a.submission?.submitted_at || CANVAS_SUBMITTED.has(a.submission?.workflow_state)) return true;
  if (a.gradescope?.status === 'submitted' || a.gradescope?.status === 'graded') return true;
  const item = queueByAssignment.get(a.id);
  return Boolean(item) && item.submitState !== 'failed';
}

// The next 7 days, split into what is still to do and how many are already handed in.
// Only name, course, due date and points ever leave the laptop. Never descriptions or files.
function weekForDigest() {
  const now = Date.now();
  const week = data.assignments
    .map((a) => ({ a, due: Date.parse(a.due_at) }))
    .filter(({ due }) => due >= now && due <= now + 7 * DAY)
    .sort((x, y) => x.due - y.due);
  const todo = week.filter(({ a }) => !handedIn(a));
  return {
    handedIn: week.length - todo.length,
    items: todo.slice(0, 50).map(({ a }) => { // 50 is the server's limit
      const course = courseById.get(a.courseId);
      return {
        id: a.id,
        name: a.name,
        course: course?.course_code || course?.name || a.courseName || 'Course',
        dueAt: a.due_at,
        points: Number.isFinite(a.points_possible) ? a.points_possible : null,
      };
    }),
  };
}

function renderDigest(digest) {
  const card = $('digest-card');
  card.hidden = !digest;
  if (!digest) return;
  const source = { gemini: ' · Gemini', template: '' }[digest.source] ?? '';
  card.replaceChildren(
    el('div', { class: 'digest-head' },
      el('h2', { id: 'digest-title', text: 'This week at a glance' }),
      el('span', { class: 'digest-meta', text: `Digest from ${formatDateTime(digest.createdAt)}${source}` })),
    el('p', { class: 'digest-text', text: digest.text }));
  if (digest.handedIn > 0) {
    card.append(el('p', { class: 'digest-meta digest-done', text: `${digest.handedIn} already handed in this week, so not counted above.` }));
  }
}

// Shows the saved digest at once, then makes a new one when there has been a sync since, or when the
// to-do list changed (for example after a Lifeline submission). If the server can't be reached, the
// saved digest stays (or the card stays hidden if there is none).
async function refreshDigest() {
  const syncAt = data.sync.lastSuccessAt;
  const saved = await getDigest();
  renderDigest(saved);
  if (!syncAt) return;
  const week = weekForDigest();
  const key = `${syncAt}|${week.items.map((x) => x.id).join(',')}`;
  if (saved?.key === key || digestTriedFor === key) return;
  digestTriedFor = key;

  // Nothing left to do: no need to ask the server.
  if (!week.items.length) {
    const text = week.handedIn ? 'Everything due in the next 7 days is handed in. Nice work.' : 'Nothing is due in the next 7 days.';
    const fresh = { text, source: 'local', createdAt: Date.now(), key, handedIn: week.handedIn };
    await saveDigest(fresh);
    renderDigest(fresh);
    return;
  }
  try {
    const result = await fetchDigest(week.items);
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (!text) return;
    const fresh = { text, source: result.source, createdAt: Date.now(), key, handedIn: week.handedIn };
    await saveDigest(fresh);
    renderDigest(fresh);
  } catch {
    // offline or rejected: keep whatever is on screen
  }
}

// ---------- files ----------

function fileRow(file) {
  const cached = Boolean(file.cachedUpdatedAt);
  const meta = [formatBytes(file.size), file.updated_at && `updated ${dateFmt.format(new Date(file.updated_at))}`].filter(Boolean).join(' · ');
  return el('li', { class: 'file' },
    el('span', { class: 'file-name', text: file.display_name }),
    el('span', { class: 'file-meta', text: meta }),
    el('span', { class: `badge ${cached ? 'badge-ok' : ''}`, text: cached ? 'Cached' : 'Not cached' }),
    cached && el('button', { type: 'button', class: 'btn btn-quiet btn-small', 'aria-label': `Open ${file.display_name}`, onclick: () => openFile(file.id) }, 'Open'));
}

const VIEWABLE = /^(application\/pdf|text\/plain|image\/(png|jpeg|gif|webp))\b/;

async function openFile(id) {
  const meta = fileById.get(id);
  const stored = await getFileBlob(id);
  if (!stored) { toast('That file is not cached. It will download on the next sync.'); return; }
  const blob = stored.type ? stored : new Blob([stored], { type: meta?.contentType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  if (VIEWABLE.test(blob.type)) window.open(url, '_blank', 'noopener');
  else el('a', { href: url, download: meta?.display_name || 'file' }).click(); // anything else is saved, never rendered
}

// ---------- announcements and courses ----------

function renderAnnouncements() {
  const panel = $('panel-announcements');
  const items = data.announcements.map((n) => {
    const course = courseById.get(n.courseId);
    const who = n.author?.display_name || n.user_name;
    return el('article', { class: 'card' },
      el('h3', { text: n.title }),
      el('p', { class: 'byline', text: [course?.course_code || course?.name, who, n.posted_at && formatDateTime(n.posted_at)].filter(Boolean).join(' · ') }),
      sanitize(n.message));
  });
  panel.replaceChildren(el('h2', { class: 'section-title', text: 'Announcements' }),
    items.length ? el('div', { class: 'stack' }, items) : el('p', { class: 'none', text: 'No recent announcements.' }));
}

// "Courses to sync": the current semester always syncs; the student can tick other active courses.
function courseSettings() {
  const catalog = data.courseCatalog || [];
  if (!catalog.length) return null;
  const extra = new Set(data.extraCourseIds || []);
  const status = el('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const sorted = [...catalog].sort((a, b) => Number(b.current) - Number(a.current) || String(a.name).localeCompare(String(b.name)));
  const list = el('ul', { class: 'course-picks' }, sorted.map((c) => {
    const box = el('input', { type: 'checkbox', id: `pick-${c.id}`, value: c.id, checked: c.current || extra.has(c.id), disabled: c.current });
    const note = c.current ? 'this semester, always synced' : c.term || 'other term';
    return el('li', {}, box, el('label', { for: `pick-${c.id}` }, `${c.course_code || c.name} `, el('span', { class: 'file-meta', text: `${c.name !== c.course_code ? `${c.name} · ` : ''}${note}` })));
  }));
  list.addEventListener('change', async () => {
    const ids = [...list.querySelectorAll('input:checked:not(:disabled)')].map((b) => Number(b.value));
    await setExtraCourseIds(ids);
    data.extraCourseIds = ids;
    status.textContent = 'Saved. Click "Sync now" to apply.';
  });
  return el('details', { class: 'card course-settings' },
    el('summary', { text: `Courses to sync (${catalog.filter((c) => c.current || extra.has(c.id)).length} of ${catalog.length})` }),
    el('p', { class: 'hint', text: 'Courses from the current semester always sync. Tick other courses to keep them offline too; unticked ones are removed from this laptop on the next sync.' }),
    list, status);
}

function renderCourses() {
  const panel = $('panel-courses');
  const cards = data.courses.map((course) => {
    const teachers = data.teachers.filter((t) => t.courseId === course.id);
    const files = data.files.filter((f) => f.courseId === course.id);
    const known = new Set(files.map((f) => f.id));
    // Module files outside the cached set still get a line, so the student knows they exist.
    const others = data.moduleItems
      .filter((it) => it.courseId === course.id && it.type === 'File' && !known.has(it.content_id))
      .map((it) => ({ id: it.content_id, display_name: it.title, size: 0, updated_at: null, cachedUpdatedAt: null }));
    const allFiles = [...files, ...others].sort((x, y) => String(y.updated_at || '').localeCompare(String(x.updated_at || '')));
    return el('article', { class: 'card course-card' },
      el('h2', { text: course.name }),
      el('ul', { class: 'teachers' }, teachers.length ? teachers.map((t) => el('li', {}, `${t.name} · `,
        t.email ? el('a', { href: `mailto:${t.email}`, text: t.email }) : el('span', { class: 'file-meta', text: 'email not shown in Canvas' })))
        : el('li', { class: 'file-meta', text: 'No teacher listed.' })),
      el('details', {}, el('summary', { text: 'Syllabus' }),
        course.syllabus_body ? sanitize(course.syllabus_body) : el('p', { class: 'none', text: 'No syllabus saved for this course.' })),
      el('details', { open: true }, el('summary', { text: `Files (${allFiles.length})` }),
        allFiles.length ? el('ul', { class: 'files' }, allFiles.map(fileRow)) : el('p', { class: 'none', text: 'No files saved for this course.' })));
  });
  panel.replaceChildren(...[el('h2', { class: 'section-title', text: 'Courses and files' }), courseSettings(), el('div', { class: 'stack' }, cards)].filter(Boolean));
}

// ---------- tabs ----------

const tabs = [...document.querySelectorAll('[role="tab"]')];

function showTab(tab, focus = false) {
  for (const t of tabs) {
    const active = t === tab;
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !active;
  }
  if (focus) tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => showTab(tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const target = step ? tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]
      : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
    if (!target) return;
    event.preventDefault();
    showTab(target, true);
  });
}

// ---------- load and refresh ----------

async function load() {
  data = await getDashboardData();
  data.assignments = mergeDeadlines(data.assignments, data.gradescope); // Canvas + Gradescope, one entry per deadline
  syncSignature = signature(data.sync);
  courseById.clear();
  fileById.clear();
  for (const c of data.courses) courseById.set(c.id, c);
  for (const f of data.files) fileById.set(f.id, f);
  queueByAssignment.clear();
  for (const q of [...data.queue].sort((x, y) => x.createdAt - y.createdAt)) {
    if (q.submitState !== 'replaced' && q.remindState !== 'replaced') queueByAssignment.set(q.assignmentId, q);
  }
  renderQueueCard($('queue-card'), data.queue, { onRetry: retryQueueNow, onMarkDone: async (id) => { await markRemindDone(id); await load(); } });
  $('empty-state').hidden = data.courses.length > 0;
  renderBanner();
  renderAssignments();
  renderAnnouncements();
  renderCourses();
  refreshDigest();
}

const signature = (sync) => `${sync.status}|${sync.lastAttemptAt}|${sync.lastSuccessAt}`;

async function tick() {
  checkStatus();
  // Pick up syncs the service worker finished in the background.
  const sync = await getSyncState();
  if (signature(sync) !== syncSignature) await load();
  else { data.sync = sync; renderBanner(); }
  for (const { node, ms } of relativeNodes) refreshRelative(node, ms);
}

$('sync-now').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'syncNow' });
    if (result?.status === 'no-tab') toast(`${result.message}: open ${new URL(CANVAS_BASE).host} in a tab, then click Sync now.`);
  } catch (err) {
    toast(`Could not start a sync: ${err.message}`);
  }
  button.disabled = false;
  button.textContent = 'Sync now';
  await load();
  checkStatus();
});

// Cached-file links inside Canvas content open the local copy.
document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-file-id]');
  if (!link) return;
  event.preventDefault();
  openFile(Number(link.dataset.fileId));
});

// The service worker finished a queue retry.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'queueUpdated' || msg?.type === 'gradescopeUpdated') load();
});

window.addEventListener('online', checkStatus);
window.addEventListener('offline', checkStatus);
setInterval(tick, STATUS_EVERY_MS);

await load();
checkStatus();

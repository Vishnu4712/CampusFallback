// Mock Canvas for CampusFallback. In-memory only; it never talks to real Canvas.
//
// Switches (no CSRF token needed):
//   POST /__outage/on|off|storage   on = every Canvas route returns 503; storage = only uploads and downloads fail
//   POST /__session/on|off|html     off = /api returns 401 JSON; html = /api returns a 200 HTML login page
//   POST /__lock/:aid               submissions to that assignment return 403 "locked"
//   POST /__unlock/:aid
//   POST /__gradescope/on|off       off = the mock Gradescope (GET /gradescope/...) returns 503
//   GET  /gradescope/courses/:id    the saved Gradescope course page (fixtures/gradescope-course.html), scripts blocked
//   GET  /gradescope/account        course list, used by the extension's "Refresh Gradescope" button
//   POST /__reset[?due=N]           re-seed, clear submissions and switches; demo assignment due in N minutes (default 5)
//   GET  /__state                   switches plus received submissions (with SHA-256 of each file)
//
// Env: PORT (4000), DUE_IN_MIN (5), TEACHER_EMAIL (overrides seeded teacher emails for the demo)

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = Number(process.env.PORT) || 4000;
const BASE = `http://localhost:${PORT}`;
const DEMO_DUE_MIN = Number(process.env.DUE_IN_MIN) || 5;
const TEACHER_EMAIL = process.env.TEACHER_EMAIL || '';
const SEED = fs.readFileSync(new URL('./seed.json', import.meta.url), 'utf8').replaceAll('{{BASE}}', BASE);
const CSRF = crypto.randomBytes(32).toString('base64'); // has + / = so the cookie must be URL-decoded, as on real Canvas
const DAY = 86_400_000;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); // Canvas style: 2026-11-14T22:00:00Z
const arr = (v) => (v == null ? [] : [].concat(v));

let db;
const state = { outage: 'off', session: 'on', gradescope: 'on', locked: new Set() };

// ---------- seed ----------

// Smallest valid one-page PDF, so cached course files open as real PDFs in the demo.
function makePdf(title, lines) {
  const esc = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');
  const text = ['BT', '/F1 20 Tf', '72 720 Td', `(${esc(title)}) Tj`, '/F1 12 Tf',
    ...lines.flatMap((l) => ['0 -26 Td', `(${esc(l)}) Tj`]), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function reset(demoDueMin = DEMO_DUE_MIN) {
  const seed = JSON.parse(SEED);
  const now = Date.now();
  const today = Math.floor(now / DAY) * DAY; // file dates stay the same across restarts, so sync does not re-download

  const courses = seed.courses.map((c) => ({
    ...c,
    workflow_state: 'available',
    time_zone: 'America/New_York',
    enrollments: [{ type: 'student', role: 'StudentEnrollment', enrollment_state: 'active' }],
  }));

  const teachers = seed.teachers.map((t) => (t.email && TEACHER_EMAIL ? { ...t, email: TEACHER_EMAIL } : t));

  const assignments = seed.assignments.map(({ demo, due_in_minutes, lock_in_minutes, updated_days_ago, ...a }) => {
    const due = demo ? demoDueMin : due_in_minutes;
    return {
      ...a,
      due_at: due == null ? null : iso(now + due * 60_000),
      lock_at: lock_in_minutes == null ? null : iso(now + lock_in_minutes * 60_000),
      unlock_at: null,
      html_url: `${BASE}/courses/${a.course_id}/assignments/${a.id}`,
      updated_at: iso(now - updated_days_ago * DAY),
    };
  });

  const announcements = seed.announcements
    .map(({ course_id, posted_hours_ago, author, ...a }) => ({
      ...a,
      posted_at: iso(now - posted_hours_ago * 3_600_000),
      context_code: `course_${course_id}`,
      user_name: author,
      author: { display_name: author },
      html_url: `${BASE}/courses/${course_id}/discussion_topics/${a.id}`,
    }))
    .sort((x, y) => y.posted_at.localeCompare(x.posted_at));

  const files = seed.files.map(({ lines, updated_days_ago, ...f }) => {
    const pdf = /\.pdf$/i.test(f.display_name);
    const data = pdf ? makePdf(f.display_name.replace(/\.pdf$/i, ''), lines) : Buffer.from(lines.join('\n') + '\n');
    const at = iso(today - updated_days_ago * DAY);
    return { ...f, filename: f.display_name, 'content-type': pdf ? 'application/pdf' : 'text/plain', size: data.length, created_at: at, updated_at: at, data };
  });

  const modules = seed.modules.map((m, mi) => ({
    id: m.id,
    course_id: m.course_id,
    name: m.name,
    position: mi + 1,
    items: m.items.map((it, i) => {
      const id = m.id * 100 + i + 1;
      const item = { id, module_id: m.id, position: i + 1, indent: 0, html_url: `${BASE}/courses/${m.course_id}/modules/items/${id}` };
      if (it.file) {
        const f = files.find((x) => x.id === it.file);
        return { ...item, title: f.display_name, type: 'File', content_id: f.id, url: `${BASE}/api/v1/courses/${m.course_id}/files/${f.id}` };
      }
      if (it.assignment) {
        const a = assignments.find((x) => x.id === it.assignment);
        return { ...item, title: a.name, type: 'Assignment', content_id: a.id, url: `${BASE}/api/v1/courses/${m.course_id}/assignments/${a.id}` };
      }
      return { ...item, title: it.title, type: 'ExternalUrl', external_url: it.external_url, new_tab: true };
    }),
  }));

  db = { courses, teachers, assignments, announcements, files, modules, tokens: new Map(), uploads: new Map(), submissions: [], nextId: 7000 };
  state.outage = 'off';
  state.session = 'on';
  state.gradescope = 'on';
  state.locked.clear();
}

// ---------- helpers ----------

const isLocked = (a) => state.locked.has(a.id) || (a.lock_at !== null && Date.parse(a.lock_at) < Date.now());
const assignmentJson = (a) => ({ ...a, locked_for_user: isLocked(a) });
const courseJson = ({ syllabus_body, ...c }, req) => (arr(req.query.include).includes('syllabus_body') ? { ...c, syllabus_body } : c);
const fileJson = ({ data, sha256, assignment_id, ...f }) => ({
  ...f,
  url: `${BASE}/files/${f.id}/download?download_frd=1`,
  locked: false,
  hidden: false,
  locked_for_user: false,
});

const notFound = (res) => res.status(404).json({ errors: [{ message: 'The specified resource does not exist.' }] });
const forbidden = (res, message) => res.status(403).json({ status: 'unauthorized', errors: [{ message }] });
const badRequest = (res, message) => res.status(400).json({ errors: [{ message }] });
const unavailable = (res) => res.status(503).json({ errors: [{ message: 'Service Unavailable (mock outage)' }] });

// Canvas-style pagination: ?page=&per_page= (default 10, max 100) and a Link header.
function paginate(req, res, items) {
  const per = Math.min(Math.max(parseInt(req.query.per_page, 10) || 10, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const last = Math.max(Math.ceil(items.length / per), 1);
  const link = (p, rel) => {
    const u = new URL(req.originalUrl, BASE);
    u.searchParams.set('page', p);
    u.searchParams.set('per_page', per);
    return `<${u}>; rel="${rel}"`;
  };
  const links = [link(page, 'current')];
  if (page < last) links.push(link(page + 1, 'next'));
  if (page > 1) links.push(link(page - 1, 'prev'));
  links.push(link(1, 'first'), link(last, 'last'));
  res.set('Link', links.join(','));
  res.json(items.slice((page - 1) * per, page * per));
}

// Express is the only dependency, so multipart bodies are parsed by hand: { fields, file }.
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) return null;
  const delim = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  let file = null;
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.subarray(start, start + 2).toString() === '--') break; // closing boundary
    const next = buf.indexOf(delim, start);
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (next === -1 || headEnd === -1 || headEnd > next) break;
    const head = buf.subarray(start + 2, headEnd).toString('utf8');
    const body = buf.subarray(headEnd + 4, next - 2); // drop the CRLF before the next boundary
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    const name = /\bname="([^"]*)"/i.exec(head)?.[1];
    if (filename !== undefined) {
      file = { filename, contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] || 'application/octet-stream', data: Buffer.from(body) };
    } else if (name) {
      fields[name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, file };
}

const publicState = () => ({
  outage: state.outage,
  session: state.session,
  gradescope: state.gradescope,
  locked: [...state.locked],
  submissions: db.submissions.map((s) => ({
    assignment_id: s.assignment_id,
    submitted_at: s.submitted_at,
    late: s.late,
    attempt: s.attempt,
    files: s.attachments.map((f) => ({ filename: f.filename, size: f.size, sha256: db.uploads.get(f.id).sha256 })),
  })),
});

// ---------- app ----------

reset();
const app = express();
app.disable('x-powered-by');
app.set('query parser', 'extended'); // Express 5 defaults to "simple"; Canvas uses include[]=x style params

// CORS for the extension, the _csrf_token cookie, and a one-line request log.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin?.startsWith('chrome-extension://')) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, X-CSRF-Token',
      'Access-Control-Expose-Headers': 'Link',
      Vary: 'Origin',
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!/(?:^|;\s*)_csrf_token=/.test(req.headers.cookie || '')) {
    res.append('Set-Cookie', `_csrf_token=${encodeURIComponent(CSRF)}; Path=/`);
  }
  res.on('finish', () => {
    const url = req.originalUrl.replaceAll('%5B', '[').replaceAll('%5D', ']');
    console.log(`${new Date().toLocaleTimeString()}  ${res.statusCode}  ${req.method} ${url}`);
  });
  next();
});

// Switches
const setMode = (key, modes) => (req, res) => {
  if (!modes.includes(req.params.mode)) return badRequest(res, `Use one of: ${modes.join(', ')}`);
  state[key] = req.params.mode;
  res.json(publicState());
};
app.post('/__outage/:mode', setMode('outage', ['on', 'off', 'storage']));
app.post('/__session/:mode', setMode('session', ['on', 'off', 'html']));
app.post('/__gradescope/:mode', setMode('gradescope', ['on', 'off']));
app.post('/__lock/:aid', (req, res) => { state.locked.add(Number(req.params.aid)); res.json(publicState()); });
app.post('/__unlock/:aid', (req, res) => { state.locked.delete(Number(req.params.aid)); res.json(publicState()); });
app.post('/__reset', (req, res) => { reset(Number(req.query.due) || undefined); res.json(publicState()); });
app.get('/__state', (req, res) => res.json(publicState()));
app.get('/', (req, res) => res.json({ name: 'CampusFallback mock Canvas', ...publicState() }));

// Outage, session and CSRF gates
app.use(['/files', '/courses', '/upload'], (req, res, next) => (state.outage === 'off' ? next() : unavailable(res)));
app.use('/api', (req, res, next) => {
  if (state.outage === 'on') return unavailable(res);
  if (state.session === 'off') return res.status(401).json({ status: 'unauthenticated', errors: [{ message: 'user authorization required' }] });
  if (state.session === 'html') return res.type('html').send('<!doctype html><title>Log in</title><h1>NetID login (mock)</h1><form><input name="netid"></form>');
  if (req.method === 'POST') {
    // Header is required. If the request carries the cookie (a browser), the header must match it once URL-decoded.
    const header = req.get('X-CSRF-Token');
    const cookie = /(?:^|;\s*)_csrf_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    let expected = null;
    try { expected = cookie ? decodeURIComponent(cookie) : null; } catch { expected = ''; }
    if (!header || (expected !== null && header !== expected)) {
      return res.status(422).json({ errors: [{ message: 'Invalid or missing X-CSRF-Token' }] });
    }
  }
  next();
});

// ---------- Canvas API ----------

const api = express.Router();

api.param('cid', (req, res, next, cid) => {
  req.course = db.courses.find((c) => c.id === Number(cid));
  return req.course ? next() : notFound(res);
});
api.param('aid', (req, res, next, aid) => {
  req.assignment = db.assignments.find((a) => a.id === Number(aid) && a.course_id === req.course?.id);
  return req.assignment ? next() : notFound(res);
});

api.get('/courses', (req, res) => {
  const want = req.query.enrollment_state;
  const list = db.courses.filter((c) => !want || c.enrollments.some((e) => e.enrollment_state === want));
  paginate(req, res, list.map((c) => courseJson(c, req)));
});

api.get('/courses/:cid', (req, res) => res.json(courseJson(req.course, req)));

api.get('/courses/:cid/assignments', (req, res) => {
  const now = Date.now();
  const due = (a) => (a.due_at ? Date.parse(a.due_at) : null);
  const buckets = {
    upcoming: (a) => due(a) !== null && due(a) >= now && due(a) <= now + 7 * DAY,
    future: (a) => due(a) === null || due(a) >= now,
    past: (a) => due(a) !== null && due(a) < now,
  };
  const keep = buckets[req.query.bucket] || (() => true);
  // include[]=submission adds the student's latest submission, like real Canvas.
  const withSubmission = arr(req.query.include).includes('submission');
  paginate(req, res, db.assignments.filter((a) => a.course_id === req.course.id && keep(a))
    .map((a) => (withSubmission ? { ...assignmentJson(a), submission: selfSubmission(a.id) } : assignmentJson(a))));
});

api.get('/courses/:cid/assignments/:aid', (req, res) => res.json(assignmentJson(req.assignment)));

api.get('/courses/:cid/users', (req, res) => {
  const types = arr(req.query.enrollment_type);
  const teachers = db.teachers.filter((t) => t.course_id === req.course.id).map(({ course_id, ...t }) => t);
  paginate(req, res, !types.length || types.includes('teacher') ? teachers : []);
});

api.get('/announcements', (req, res) => {
  const codes = arr(req.query.context_codes);
  paginate(req, res, db.announcements.filter((a) => codes.includes(a.context_code)));
});

api.get('/courses/:cid/modules', (req, res) => {
  const withItems = arr(req.query.include).includes('items');
  const list = db.modules
    .filter((m) => m.course_id === req.course.id)
    .map(({ items, course_id, ...m }) => ({ ...m, items_count: items.length, ...(withItems ? { items } : {}) }));
  paginate(req, res, list);
});

const findFile = (id) => db.files.find((f) => f.id === Number(id)) || db.uploads.get(Number(id));
const fileMeta = (req, res) => {
  const f = findFile(req.params.fid);
  if (!f) return notFound(res);
  if (f.locked) return forbidden(res, 'This file is locked.');
  res.json(fileJson(f));
};
api.get('/courses/:cid/files/:fid', fileMeta);
api.get('/files/:fid', fileMeta);

// 3-step submission. Steps 1 and 3 are Canvas API calls; step 2 goes to the upload URL below.
const canSubmit = (req, res, next) => {
  if (isLocked(req.assignment)) return forbidden(res, 'This assignment is locked.');
  if (!req.assignment.submission_types.includes('online_upload')) return badRequest(res, 'This assignment does not accept file uploads.');
  next();
};

api.post('/courses/:cid/assignments/:aid/submissions/self/files', canSubmit, (req, res) => {
  const name = String(req.body?.name || 'upload');
  const token = crypto.randomBytes(16).toString('hex');
  db.tokens.set(token, { assignment_id: req.assignment.id, name });
  res.json({
    file_param: 'file',
    progress: null,
    upload_url: `${BASE}/upload/${token}`,
    upload_params: { filename: name, content_type: String(req.body?.content_type || 'application/octet-stream') },
  });
});

api.post('/courses/:cid/assignments/:aid/submissions', canSubmit, (req, res) => {
  const a = req.assignment;
  const sub = req.body?.submission || {};
  if (sub.submission_type !== 'online_upload') return badRequest(res, 'submission[submission_type] must be online_upload.');
  const files = arr(sub.file_ids).map((id) => db.uploads.get(Number(id)));
  if (!files.length || files.some((f) => !f || f.assignment_id !== a.id)) {
    return badRequest(res, 'submission[file_ids][] must list files uploaded for this assignment.');
  }
  const bad = a.allowed_extensions?.length && files.find((f) => !a.allowed_extensions.includes(f.filename.split('.').pop().toLowerCase()));
  if (bad) return badRequest(res, `File type not allowed: ${bad.filename}. Allowed: ${a.allowed_extensions.join(', ')}.`);
  const now = Date.now();
  const submission = {
    id: db.nextId++,
    assignment_id: a.id,
    user_id: 1,
    submission_type: 'online_upload',
    workflow_state: 'submitted',
    submitted_at: iso(now),
    attempt: db.submissions.filter((s) => s.assignment_id === a.id).length + 1,
    late: a.due_at !== null && now > Date.parse(a.due_at),
    attachments: files.map(fileJson),
  };
  db.submissions.push(submission);
  res.status(201).json(submission);
});

// The student's latest submission for an assignment, or Canvas's "unsubmitted" placeholder.
function selfSubmission(aid) {
  return db.submissions.findLast((s) => s.assignment_id === aid)
    || { assignment_id: aid, user_id: 1, workflow_state: 'unsubmitted', submitted_at: null, attempt: null };
}

api.get('/courses/:cid/assignments/:aid/submissions/self', (req, res) => res.json(selfSubmission(req.assignment.id)));

api.use((req, res) => notFound(res));
app.use('/api/v1', express.json(), express.urlencoded({ extended: true }), api);

// ---------- mock Gradescope (read-only; nothing can be uploaded here) ----------
// Separate from the Canvas outage switch, because Gradescope is a different service.

app.use('/gradescope', (req, res, next) => (state.gradescope === 'on' ? next() : res.status(503).type('text').send('Gradescope is temporarily unavailable (mock).')));
app.get('/gradescope/ping', (req, res) => res.json({ ok: true }));
const GS_FIXTURE = new URL('./fixtures/gradescope-course.html', import.meta.url);
const GS_FIXTURE_COURSE = 1393970; // the course id inside the saved page
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const gsPage = (title, body) => `<!doctype html><meta charset="utf-8"><title>${escHtml(title)} | Gradescope (mock)</title>
<body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">
<p style="color:#666">Gradescope (mock for the CampusFallback demo)</p>${body}</body>`;

// The real course page saved from Gradescope, read fresh on each request. Its own scripts are blocked, so the
// table stays exactly as saved; the extension's content script still runs (page CSP does not apply to it).
app.get('/gradescope/courses/:cid', (req, res) => {
  if (!/^\d+$/.test(req.params.cid)) return res.status(404).type('text').send('Not found');
  let html;
  try { html = fs.readFileSync(GS_FIXTURE, 'utf8'); } catch { return res.status(404).type('text').send('Add mock-canvas/fixtures/gradescope-course.html'); }
  res.set('Content-Security-Policy', "script-src 'none'; object-src 'none'; base-uri 'none'").type('html').send(html);
});

// Course list, like Gradescope's account page: the current term first.
app.get('/gradescope/account', (req, res) => res.type('html').send(gsPage('Your Courses',
  `<h1>Your Courses</h1><div class="courseList--coursesForTerm"><a class="courseBox" href="/gradescope/courses/${GS_FIXTURE_COURSE}">Fixture course</a></div>`)));

// Assignment and submission pages: a Canvas-linked Gradescope assignment shows its name and due date;
// links from the saved course page get a placeholder.
app.get(['/gradescope/courses/:cid/assignments/:aid', '/gradescope/courses/:cid/assignments/:aid/submissions/:sid'], (req, res) => {
  const a = db.assignments.find((x) => x.id === Number(req.params.aid) && x.course_id === Number(req.params.cid));
  const title = a ? a.name : `Assignment ${req.params.aid}`;
  res.type('html').send(gsPage(title, `<h1>${escHtml(title)}</h1>
${a?.due_at ? `<p>Due ${escHtml(new Date(a.due_at).toLocaleString('en-US', { timeZone: 'America/New_York' }))}</p>` : ''}
<p>On real Gradescope you would upload your PDF here. Upload the same file CampusFallback sealed, so its fingerprint matches the receipt your professor has.</p>`));
});

// ---------- file storage (outside /api, like the real Canvas file servers) ----------

// Step 2 of the submission: multipart POST with the file in the "file" part. The token in the URL is the auth.
app.post('/upload/:token', express.raw({ type: 'multipart/form-data', limit: '250mb' }), (req, res) => {
  const ticket = db.tokens.get(req.params.token);
  if (!ticket) return badRequest(res, 'Invalid or already used upload URL.');
  const parsed = Buffer.isBuffer(req.body) ? parseMultipart(req.body, req.get('Content-Type')) : null;
  if (!parsed?.file) return badRequest(res, 'Expected multipart/form-data with a "file" part.');
  db.tokens.delete(req.params.token);
  const { data } = parsed.file;
  const filename = parsed.fields.filename || parsed.file.filename || ticket.name;
  const at = iso(Date.now());
  const file = {
    id: db.nextId++,
    assignment_id: ticket.assignment_id,
    display_name: filename,
    filename,
    'content-type': parsed.fields.content_type || parsed.file.contentType,
    size: data.length,
    created_at: at,
    updated_at: at,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    data,
  };
  db.uploads.set(file.id, file);
  res.status(201).json(fileJson(file));
});

app.get(['/files/:fid/download', '/courses/:cid/files/:fid/download'], (req, res) => {
  const f = findFile(req.params.fid);
  if (!f) return notFound(res);
  if (f.locked) return forbidden(res, 'This file is locked.');
  res.attachment(f.filename).type(f['content-type']).send(f.data);
});

app.listen(PORT, () => {
  const demo = db.assignments.find((a) => a.id === 1001);
  console.log(`Mock Canvas on ${BASE}`);
  console.log(`Demo assignment "${demo.name}" is due at ${new Date(demo.due_at).toLocaleTimeString()} (${DEMO_DUE_MIN} min from now)`);
  console.log('Switches: POST /__outage/on|off|storage, /__session/on|off|html, /__lock/:aid, /__unlock/:aid, /__reset?due=N; GET /__state');
});

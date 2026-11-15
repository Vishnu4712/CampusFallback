// CampusFallback content script for Gradescope course pages (and the mock copy at localhost:4000/gradescope).
// Reads the student's own assignment table: name, due date, late due date, submission status and link.
// It never reads grades or scores, never logs in, never POSTs, and only fetches more pages when the student
// clicks "Refresh Gradescope" (at most once every 30 minutes).
(() => {
  const REFRESH_EVERY_MS = 30 * 60_000;
  const MAX_COURSES = 12;
  const TZ = 'America/New_York';

  // On the mock, Gradescope lives under /gradescope; on the real site, at the root.
  const COURSE_PATH = /^(\/gradescope)?\/courses\/(\d+)\/?$/;
  const here = COURSE_PATH.exec(location.pathname);
  if (!here) return; // only course pages, not assignment or submission pages
  const base = location.origin + (here[1] || '');

  // ---------- dates ----------

  // "2026-11-25 17:00:00 -0500" (Gradescope's datetime attribute) or any ISO string -> ISO UTC.
  function fromDatetimeAttr(value) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})$/.exec((value || '').trim());
    const t = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : Date.parse(value || '');
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  // Minutes that America/New_York is ahead of UTC at a moment (negative: -300 or -240).
  function nyOffsetMinutes(ms) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
    const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(name);
    return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : -300;
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  // Visible text such as "Nov 25 at  5:00PM", read as New York time. The page leaves out the year,
  // so the year that puts the date closest to today is used.
  function fromVisibleText(text) {
    const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(text || '');
    if (!m) return null;
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    let hour = Number(m[4]) % 12;
    if (m[6].toUpperCase() === 'PM') hour += 12;
    const now = new Date();
    const years = m[3] ? [Number(m[3])] : [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
    let best = null;
    for (const year of years) {
      const wall = Date.UTC(year, month, Number(m[2]), hour, Number(m[5]));
      const utc = wall - nyOffsetMinutes(wall) * 60_000;
      if (best === null || Math.abs(utc - now) < Math.abs(best - now)) best = utc;
    }
    return new Date(best).toISOString();
  }

  const timeOf = (el) => (el ? fromDatetimeAttr(el.getAttribute('datetime')) || fromVisibleText(el.textContent) : null);

  // ---------- parsing ----------

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function findTable(doc) {
    const byId = doc.querySelector('#assignments-student-table');
    if (byId) return byId;
    // Fallback: the table whose header has both a name column and a due column.
    return [...doc.querySelectorAll('table')].find((t) => {
      const head = clean(t.querySelector('thead')?.textContent).toLowerCase();
      return head.includes('name') && head.includes('due');
    }) || null;
  }

  // Status only: "graded" when a score is shown (the score itself is never read), otherwise the status text.
  function statusOf(row) {
    const cell = row.querySelector('.submissionStatus') || row.querySelectorAll('td')[0];
    if (!cell) return 'unknown';
    if (cell.querySelector('[class*="score"]')) return 'graded';
    const text = clean(cell.querySelector('.submissionStatus--text')?.textContent || cell.textContent).toLowerCase();
    if (/no submission|not submitted|missing/.test(text)) return 'not_submitted';
    if (/graded/.test(text)) return 'graded';
    if (/submitted/.test(text)) return 'submitted';
    return 'unknown';
  }

  // Returns { courseId, courseName, assignments: [{ assignmentId, name, dueAt, lateDueAt, status, url }] }.
  function parseCoursePage(doc, courseId) {
    const titleText = clean(doc.querySelector('title')?.textContent).replace(/\s*(Dashboard\s*)?\|\s*Gradescope\s*$/i, '');
    const courseName = clean(doc.querySelector('.courseHeader--title')?.textContent) || titleText;
    const coursePage = `${base}/courses/${courseId}`;
    const assignments = [];
    const table = findTable(doc);
    for (const row of table ? table.querySelectorAll('tbody tr') : []) {
      const head = row.querySelector('th') || row.querySelector('td');
      const link = head?.querySelector('a[href]');
      const button = head?.querySelector('button[data-assignment-id], [data-assignment-id]');
      const href = link?.getAttribute('href') || '';
      const assignmentId = button?.getAttribute('data-assignment-id') || /\/assignments\/(\d+)/.exec(href)?.[1];
      const name = clean(button?.getAttribute('data-assignment-title') || link?.textContent || button?.textContent || head?.textContent);
      if (!assignmentId || !name) continue;

      const times = [...row.querySelectorAll('time')];
      const isLate = (t) => /late/i.test(`${t.getAttribute('aria-label') || ''} ${t.textContent}`);
      const dueEls = times.filter((t) => /dueDate/i.test(t.className) || /^due/i.test(t.getAttribute('aria-label') || ''));
      const due = dueEls.find((t) => !isLate(t)) || null;
      const late = times.find(isLate) || null;

      // Submitted work links to the student's own submission page; unsubmitted work is submitted from the course page.
      const path = /^\/courses\/\d+\/assignments\/\d+(?:\/submissions\/\d+)?/.exec(href.replace(/^\/gradescope/, ''))?.[0];
      assignments.push({
        assignmentId,
        name,
        dueAt: timeOf(due),
        lateDueAt: timeOf(late),
        status: statusOf(row),
        url: path ? base + path : coursePage,
      });
    }
    return { courseId, courseName, assignments };
  }

  const save = (course) => chrome.runtime.sendMessage({ type: 'gradescopeCourse', course }).catch(() => ({ ok: false, error: 'CampusFallback is not running' }));

  // ---------- this page ----------

  const ui = makeUi();

  (async () => {
    const course = parseCoursePage(document, here[2]);
    if (!course.assignments.length) {
      console.warn('[CampusFallback] No assignments found on this Gradescope page; saved deadlines were kept.');
      ui.status('No assignments found on this page. Saved deadlines were kept.');
      return;
    }
    const res = await save(course);
    ui.status(res?.ok ? `Saved ${res.count} deadlines for offline use.` : (res?.error || 'Could not save.'));
  })();

  // ---------- "Refresh Gradescope": GET the student's own course pages ----------

  async function refreshAll() {
    const { gsLastRefresh = 0 } = await chrome.storage.local.get('gsLastRefresh');
    const wait = gsLastRefresh + REFRESH_EVERY_MS - Date.now();
    if (wait > 0) return ui.status(`Refreshed recently. Try again in ${Math.ceil(wait / 60_000)} min.`);
    await chrome.storage.local.set({ gsLastRefresh: Date.now() });

    ui.status('Finding your courses…');
    const get = async (url) => {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok || /\/login/.test(new URL(res.url).pathname)) throw new Error(res.ok ? 'Log in to Gradescope first' : `Gradescope returned ${res.status}`);
      return new DOMParser().parseFromString(await res.text(), 'text/html');
    };

    let ids;
    try {
      const account = await get(`${base}/account`);
      // The first term on the account page is the current one; fall back to every course link.
      const scope = account.querySelector('.courseList--coursesForTerm') || account;
      ids = [...new Set([...scope.querySelectorAll('a[href]')]
        .map((a) => /\/courses\/(\d+)\/?$/.exec(a.getAttribute('href'))?.[1]).filter(Boolean))].slice(0, MAX_COURSES);
    } catch (err) {
      return ui.status(`Refresh failed: ${err.message}`);
    }

    let saved = 0;
    for (const [i, id] of ids.entries()) {
      ui.status(`Reading course ${i + 1} of ${ids.length}…`);
      try {
        const res = await save(parseCoursePage(await get(`${base}/courses/${id}`), id));
        if (res?.ok) saved += 1;
      } catch (err) {
        console.warn(`[CampusFallback] Gradescope course ${id}: ${err.message}`);
      }
    }
    ui.status(`Refreshed ${saved} of ${ids.length} courses.`);
  }

  // A small, self-contained panel in the corner. Shadow DOM keeps Gradescope's styles out of it and ours out of the page.
  function makeUi() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box { font: 13px/1.4 system-ui, sans-serif; background: #fff; color: #1d1b1a; border: 1px solid #dedad5;
               border-left: 4px solid #881c1c; border-radius: 8px; padding: 8px 10px; max-width: 280px;
               box-shadow: 0 2px 10px rgba(0,0,0,.12); display: grid; gap: 6px; }
        b { color: #881c1c; }
        button { font: inherit; font-weight: 600; background: #881c1c; color: #fff; border: 0; border-radius: 6px;
                 padding: 5px 10px; cursor: pointer; justify-self: start; }
        button:disabled { opacity: .6; cursor: default; }
        button:focus-visible { outline: 3px solid #2b6cd4; outline-offset: 2px; }
      </style>
      <div class="box" role="region" aria-label="CampusFallback">
        <div><b>CampusFallback</b> <span class="msg" role="status" aria-live="polite">Reading deadlines…</span></div>
        <button type="button">Refresh Gradescope</button>
      </div>`;
    const msg = root.querySelector('.msg');
    const button = root.querySelector('button');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await refreshAll(); } finally { button.disabled = false; }
    });
    document.body.append(host);
    return { status: (text) => { msg.textContent = text; } };
  }
})();

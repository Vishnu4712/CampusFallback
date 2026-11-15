// Sync engine: copies Canvas into the local vault, one course at a time.
// Each course is replaced in a single transaction, so a failed or interrupted run never leaves a course half-written,
// and running it again simply picks up where it left off.
// The Canvas requests go through whichever transport is passed in (see canvas.js); everything else, including
// storing and file downloads, always runs here in the extension.
import { db, setSyncState, saveCourseCatalog, getExtraCourseIds } from './db.js';
import { createCanvasClient, downloadFile } from './canvas.js';
import { KEEP_PAST_DUE_DAYS, FILE_CACHE_CAP_BYTES, MAX_MODULE_FILES, MODULE_FILE_LOOKBACK } from './config.js';

const COURSE_TABLES = ['assignments', 'announcements', 'teachers', 'moduleItems'];
const isSkippable = (err) => err?.kind === 'forbidden' || err?.kind === 'notfound';

let running = null;

// Only one sync runs at a time; extra calls share the run in progress.
// transport: how Canvas GETs are made (default: from the extension itself).
export function syncAll({ transport } = {}) {
  running ??= run(createCanvasClient(transport)).finally(() => { running = null; });
  return running;
}

// The current semester: the newest term that has started (by start date when Canvas gives one),
// otherwise the newest enrollment_term_id. Courses without any term (like the mock's) all count as current.
export function currentTermId(courses, now = Date.now()) {
  const terms = courses.filter((c) => Number.isFinite(c.enrollment_term_id));
  if (!terms.length) return null;
  const started = terms.filter((c) => !c.term?.start_at || Date.parse(c.term.start_at) <= now);
  return Math.max(...(started.length ? started : terms).map((c) => c.enrollment_term_id));
}

// Courses to sync: the current semester, plus any the student ticked.
export function pickCourses(courses, extraIds = [], now = Date.now()) {
  const term = currentTermId(courses, now);
  const extra = new Set(extraIds);
  return courses.filter((c) => term === null || c.enrollment_term_id === term || extra.has(c.id));
}

async function run(client) {
  await setSyncState({ status: 'running', lastAttemptAt: Date.now() });
  const skipped = [];
  try {
    const all = await client.getAll('/api/v1/courses?enrollment_state=active&include[]=term&per_page=100');
    const term = currentTermId(all);
    await saveCourseCatalog(all.map((c) => ({
      id: c.id,
      name: c.name || c.course_code || `Course ${c.id}`,
      course_code: c.course_code || '',
      term: c.term?.name || null,
      current: term === null || c.enrollment_term_id === term,
    })));
    const courses = pickCourses(all, await getExtraCourseIds());
    for (const course of courses) {
      try {
        await syncCourse(client, course, skipped);
      } catch (err) {
        if (!isSkippable(err)) throw err; // outage or expired session: stop, keep what we have
        skipped.push(`course ${course.id}`);
      }
    }
    await removeOtherCourses(courses.map((c) => c.id));
    await cacheFiles(skipped);
    return await setSyncState({ status: 'ok', lastSuccessAt: Date.now(), lastError: null, lastErrorKind: null, skipped });
  } catch (err) {
    console.warn('[CampusFallback] sync failed:', err);
    return await setSyncState({ status: 'error', lastError: err.message || String(err), lastErrorKind: err.kind || 'unknown', skipped });
  }
}

// 401/403/404 on one resource is skipped; anything else fails the course (and the run).
async function optional(promise, fallback, label, skipped) {
  try {
    return await promise;
  } catch (err) {
    if (!isSkippable(err)) throw err;
    skipped.push(label);
    return fallback;
  }
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const index = i++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function syncCourse({ getOne, getAll }, course, skipped) {
  const cid = course.id;
  const base = `/api/v1/courses/${cid}`;

  // 1. Fetch everything first. Nothing is written until all of it has arrived.
  const [detail, allAssignments, announcements, teachers, modules] = await Promise.all([
    getOne(`${base}?include[]=syllabus_body`),
    // include[]=submission adds the student's own submission status (still a GET; safe on real Canvas).
    optional(getAll(`${base}/assignments?include[]=submission&per_page=100`), [], `course ${cid} assignments`, skipped),
    optional(getAll(`/api/v1/announcements?context_codes[]=course_${cid}&per_page=100`), [], `course ${cid} announcements`, skipped),
    optional(getAll(`${base}/users?enrollment_type[]=teacher&include[]=email&per_page=100`), [], `course ${cid} teachers`, skipped),
    optional(getAll(`${base}/modules?include[]=items&per_page=100`), [], `course ${cid} modules`, skipped),
  ]);

  const cutoff = Date.now() - KEEP_PAST_DUE_DAYS * 86_400_000;
  const assignments = allAssignments.filter((a) => !a.due_at || Date.parse(a.due_at) >= cutoff);

  const moduleItems = [];
  for (const m of modules) {
    // Canvas leaves out "items" for very large modules; fetch them separately then.
    const items = m.items ?? (m.items_count
      ? await optional(getAll(`${base}/modules/${m.id}/items?per_page=100`), [], `module ${m.id} items`, skipped)
      : []);
    for (const item of items) {
      moduleItems.push({ ...item, courseId: cid, moduleId: m.id, moduleName: m.name, modulePosition: m.position });
    }
  }

  // 2. Decide which files to keep: every file linked from an assignment, plus the newest module files.
  const linkedIds = new Set();
  for (const a of assignments) {
    for (const match of (a.description || '').matchAll(/\/files\/(\d+)/g)) linkedIds.add(Number(match[1]));
  }
  const moduleIds = moduleItems
    .filter((it) => it.type === 'File' && it.content_id && !linkedIds.has(it.content_id))
    .slice(-MODULE_FILE_LOOKBACK)
    .map((it) => it.content_id);

  const fetchDetails = (source) => async (id) => {
    const f = await optional(getOne(`${base}/files/${id}`), null, `file ${id}`, skipped);
    return f && {
      id: f.id,
      courseId: cid,
      display_name: f.display_name || f.filename,
      contentType: f['content-type'] || 'application/octet-stream',
      size: f.size || 0,
      updated_at: f.updated_at,
      url: f.url || null,
      source, // assignment | module
    };
  };
  const linkedFiles = (await pool([...linkedIds], 4, fetchDetails('assignment'))).filter(Boolean);
  const moduleFiles = (await pool([...new Set(moduleIds)], 4, fetchDetails('module')))
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, MAX_MODULE_FILES);
  const files = [...linkedFiles, ...moduleFiles];

  // 3. Swap the course's data in one transaction.
  const rows = {
    assignments: assignments.map((a) => ({ ...a, courseId: cid })),
    announcements: announcements.map((a) => ({ ...a, courseId: cid })),
    teachers: teachers.map((t) => ({ ...t, courseId: cid })),
    moduleItems,
  };
  await db.transaction('rw', [db.courses, db.files, db.fileBlobs, ...COURSE_TABLES.map((t) => db[t])], async () => {
    await db.courses.put({ ...course, ...detail, syncedAt: Date.now() });
    for (const table of COURSE_TABLES) {
      await db[table].where('courseId').equals(cid).delete();
      await db[table].bulkPut(rows[table]);
    }
    // Files keep their cache state; files no longer wanted are dropped along with their contents.
    const old = new Map((await db.files.where('courseId').equals(cid).toArray()).map((f) => [f.id, f]));
    const keep = new Set(files.map((f) => f.id));
    const gone = [...old.keys()].filter((id) => !keep.has(id));
    await db.files.bulkDelete(gone);
    await db.fileBlobs.bulkDelete(gone);
    await db.files.bulkPut(files.map((f) => ({
      ...f,
      cachedUpdatedAt: old.get(f.id)?.cachedUpdatedAt ?? null,
      cachedSize: old.get(f.id)?.cachedSize ?? 0,
      lastAccessed: old.get(f.id)?.lastAccessed ?? 0,
    })));
  });
}

// Courses that are no longer active, or no longer picked, are removed. Only called after the course list was fetched successfully.
async function removeOtherCourses(activeIds) {
  const active = new Set(activeIds);
  const gone = (await db.courses.toCollection().primaryKeys()).filter((id) => !active.has(id));
  if (!gone.length) return;
  await db.transaction('rw', [db.courses, db.files, db.fileBlobs, ...COURSE_TABLES.map((t) => db[t])], async () => {
    for (const cid of gone) {
      await db.fileBlobs.bulkDelete(await db.files.where('courseId').equals(cid).primaryKeys());
      await db.files.where('courseId').equals(cid).delete();
      for (const table of COURSE_TABLES) await db[table].where('courseId').equals(cid).delete();
      await db.courses.delete(cid);
    }
  });
}

// Downloads files that are missing or whose updated_at changed. A file that fails is simply left "not cached".
async function cacheFiles(skipped) {
  const wanted = (await db.files.toArray()).filter((f) => f.url && f.cachedUpdatedAt !== f.updated_at);
  for (const f of wanted) {
    if (f.size > FILE_CACHE_CAP_BYTES) continue;
    let blob;
    try {
      blob = await downloadFile(f.url);
    } catch (err) {
      if (err.kind === 'network') return; // Canvas file storage is down; try again next sync
      skipped.push(`file ${f.id} download`);
      continue;
    }
    if (blob.size > FILE_CACHE_CAP_BYTES) continue;
    await makeRoom(blob.size, f.id);
    await db.transaction('rw', [db.files, db.fileBlobs], async () => {
      if (!(await db.files.get(f.id))) return; // removed meanwhile
      await db.fileBlobs.put({ id: f.id, blob });
      await db.files.update(f.id, { cachedUpdatedAt: f.updated_at, cachedSize: blob.size, lastAccessed: Date.now() });
    });
  }
}

// Keeps the cache under the cap by dropping the least recently used files first.
async function makeRoom(bytes, exceptId) {
  const cached = (await db.files.toArray())
    .filter((f) => f.cachedUpdatedAt && f.id !== exceptId)
    .sort((a, b) => a.lastAccessed - b.lastAccessed);
  let total = cached.reduce((sum, f) => sum + f.cachedSize, 0);
  for (const f of cached) {
    if (total + bytes <= FILE_CACHE_CAP_BYTES) break;
    await db.transaction('rw', [db.files, db.fileBlobs], async () => {
      await db.fileBlobs.delete(f.id);
      await db.files.update(f.id, { cachedUpdatedAt: null, cachedSize: 0 });
    });
    total -= f.cachedSize;
  }
}

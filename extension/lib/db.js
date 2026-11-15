// The local vault. Everything the dashboard shows is read from here.
import Dexie from './vendor/dexie.mjs';
import { DB_NAME } from './config.js';

export const db = new Dexie(DB_NAME);

// Rows keep Canvas's own field names, plus courseId.
db.version(1).stores({
  courses: 'id', // includes syllabus_body
  assignments: 'id, courseId, due_at',
  announcements: 'id, courseId, posted_at',
  teachers: '[courseId+id], courseId',
  moduleItems: 'id, courseId',
  files: 'id, courseId', // details only: cachedUpdatedAt (null = not cached), cachedSize, lastAccessed
  fileBlobs: 'id', // { id, blob } kept apart so listing files never loads their contents
  meta: 'key',
});

// Lifeline (Prompt 5). Earlier tables carry over unchanged.
db.version(2).stores({
  queue: '++id, open, assignmentId', // see lib/queue.js for the fields
  receipts: 'sha256', // local copies of FreeTSA receipts: { sha256, genTime, verifyUrl, assignmentId, fileName, savedAt }
});

// Gradescope deadlines read from course pages the student opened (see content/gradescope.js).
// { id: 'gs:<courseId>:<assignmentId>', source: 'gradescope', courseId, courseName, name, dueAt, lateDueAt, status, url, updatedAt }
// No grades or scores are ever stored.
db.version(3).stores({
  gradescope: 'id, courseId',
});

const SYNC_KEY = 'sync';
const DEFAULT_SYNC_STATE = {
  status: 'never', // never | running | ok | error
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastErrorKind: null, // session | network | http | unknown
  skipped: [], // resources skipped on 401/403/404 in the last run
};

export async function getSyncState() {
  const row = await db.meta.get(SYNC_KEY);
  return { ...DEFAULT_SYNC_STATE, ...row?.value };
}

export async function setSyncState(patch) {
  const value = { ...(await getSyncState()), ...patch };
  await db.meta.put({ key: SYNC_KEY, value });
  return value;
}

// "What's due this week" digest: the last good one, kept so it still shows offline.
// { text, source, createdAt, key, handedIn }. key = last sync time + the ids still to do, so a new digest is
// made once per sync, or when a submission changes the to-do list.
const DIGEST_KEY = 'digest';

export async function getDigest() {
  return (await db.meta.get(DIGEST_KEY))?.value ?? null;
}

export async function saveDigest(value) {
  await db.meta.put({ key: DIGEST_KEY, value });
}

// Which courses sync. The current semester's courses always do; the student can tick extra ones.
// catalog: every active course from the last sync, [{ id, name, course_code, term, current }].
const CATALOG_KEY = 'courseCatalog';
const EXTRA_KEY = 'extraCourses';

export async function getCourseCatalog() {
  return (await db.meta.get(CATALOG_KEY))?.value ?? [];
}

export async function saveCourseCatalog(catalog) {
  await db.meta.put({ key: CATALOG_KEY, value: catalog });
}

export async function getExtraCourseIds() {
  return (await db.meta.get(EXTRA_KEY))?.value ?? [];
}

export async function setExtraCourseIds(ids) {
  await db.meta.put({ key: EXTRA_KEY, value: [...new Set(ids.map(Number).filter(Number.isFinite))] });
}

// ---------- read helpers for the dashboard ----------

// Everything the dashboard renders, in one read. File contents are not loaded here.
export async function getDashboardData() {
  const [courses, assignments, announcements, teachers, moduleItems, files, sync, queue, gradescope, courseCatalog, extraCourseIds] = await Promise.all([
    db.courses.toArray(),
    db.assignments.toArray(),
    db.announcements.orderBy('posted_at').reverse().toArray(),
    db.teachers.toArray(),
    db.moduleItems.toArray(),
    db.files.toArray(),
    getSyncState(),
    db.queue.toArray(),
    db.gradescope.toArray(),
    getCourseCatalog(),
    getExtraCourseIds(),
  ]);
  courses.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { courses, assignments, announcements, teachers, moduleItems, files, sync, queue, gradescope, courseCatalog, extraCourseIds };
}

// Returns the cached Blob (or null) and marks the file as recently used for cache eviction.
export async function getFileBlob(id) {
  const row = await db.fileBlobs.get(id);
  if (row) await db.files.update(id, { lastAccessed: Date.now() });
  return row?.blob ?? null;
}

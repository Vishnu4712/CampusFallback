// One flag picks the Canvas target.
//   'mock' — local mock Canvas on :4000. Reads and submissions.
//   'real' — real UMass Canvas. GET requests only; nothing in this extension may write to it.
export const TARGET = 'mock';

const TARGETS = {
  mock: { base: 'http://localhost:4000', writable: true },
  real: { base: 'https://umamherst.instructure.com', writable: false }, // synced through an open Canvas tab (content/canvas.js)
};

export const CANVAS_BASE = TARGETS[TARGET].base;
export const CANVAS_WRITABLE = TARGETS[TARGET].writable; // submit code must check this before any non-GET request

// Each target gets its own database, so real and mock data never mix.
export const DB_NAME = `campusfallback-${TARGET}`;

// CampusFallback backend. 'prod' is the Vultr deploy (server/README.md step 8); 'local' is `npm run dev`.
// The prod domain must also be in manifest.json host_permissions.
export const API_TARGET = 'local';
const LOCAL_API_BASE = 'http://localhost:3000';
const PROD_API_BASE = 'https://your-domain.example'; // TODO: the GoDaddy domain
export const API_BASE = API_TARGET === 'prod' ? PROD_API_BASE : LOCAL_API_BASE;

export const SYNC_PERIOD_MIN = 30;
export const FETCH_TIMEOUT_MS = 15_000;
export const DOWNLOAD_TIMEOUT_MS = 60_000;

// Assignments are fetched in full and filtered here: undated, not yet due, or due within the last N days.
// (Canvas's own 'upcoming' bucket drops an assignment the moment it is due, which is exactly when an outage hurts.)
export const KEEP_PAST_DUE_DAYS = 7;

export const FILE_CACHE_CAP_BYTES = 200 * 1024 * 1024;
export const MAX_MODULE_FILES = 10; // newest module files cached per course
export const MODULE_FILE_LOOKBACK = 30; // only the last N module file items are checked for "newest"

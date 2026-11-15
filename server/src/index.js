// CampusFallback backend. It only ever receives SHA-256 hashes and short metadata; never files or course content.
import './env.js'; // must be first: loads .env before the other modules read process.env
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import receiptRoutes from './routes/receipts.js';
import geminiRoutes from './routes/gemini.js';
import { storeKind, storeReachable } from './lib/db.js';
import { geminiConfigured } from './lib/gemini.js';

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // behind Caddy on the same machine, so rate limits see the real client IP

// Request log: method, path and status only. Bodies are never logged.
app.use((req, res, next) => {
  res.on('finish', () => console.log(`${new Date().toISOString()} ${res.statusCode} ${req.method} ${req.path}`));
  next();
});

const api = express.Router();

// Browsers may call the API only from the extension or this site. Requests without an Origin header
// (curl, same-origin page loads) pass; the rate limit below is what bounds those.
api.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin) && origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  return next();
});
api.use(cors({ origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'], maxAge: 600 }));
api.use(rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a minute.' },
}));
api.use(express.json({ limit: '10kb' })); // hashes and metadata are tiny; anything larger is refused

api.get('/health', async (req, res) => {
  res.json({ ok: true, store: storeKind, storeReachable: await storeReachable(), gemini: geminiConfigured });
});
api.use(receiptRoutes);
api.use(geminiRoutes);
api.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Bad JSON, oversized bodies and anything unexpected.
api.use((err, req, res, _next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[api]', err);
  res.status(status).json({ error: status === 413 ? 'Request too large' : status === 500 ? 'Unexpected error' : 'Bad request' });
});

app.use('/api', api);

// Public pages: landing page and /verify. Scripts and styles come only from this site, and the
// pages may only call this site's API, so a verify page can never send a file anywhere.
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '5m' }));
app.use((req, res) => res.status(404).type('text').send('Not found'));

app.listen(PORT, () => {
  console.log(`CampusFallback API on http://localhost:${PORT}  (verify page: /verify)`);
  console.log(`  receipts: ${storeKind === 'mongodb' ? 'MongoDB' : 'IN MEMORY ONLY (set MONGODB_URI)'}`);
  console.log(`  gemini:   ${geminiConfigured ? `on (${process.env.GEMINI_MODEL || 'default model'})` : 'OFF, using templates (set GEMINI_API_KEY)'}`);
  console.log(`  origins:  ${ALLOWED_ORIGINS.join(', ') || '(none)'}`);
});

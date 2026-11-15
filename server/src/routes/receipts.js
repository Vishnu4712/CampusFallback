// Timestamp receipts. The only thing a client ever sends here is a SHA-256 hash.
import { Router } from 'express';
import { createTimestamp, verifyTimestamp, SHA256_RE, TsaError } from '../lib/tsa.js';
import { findReceipt, saveReceipt, StoreError } from '../lib/db.js';

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const verifyUrlFor = (sha256) => `${PUBLIC_BASE_URL}/verify?sha256=${sha256}`;

const router = Router();

const summary = (r) => ({ sha256: r.sha256, genTime: new Date(r.genTime).toISOString(), verifyUrl: verifyUrlFor(r.sha256) });

function fail(res, err) {
  if (err instanceof TsaError) return res.status(502).json({ error: err.message });
  if (err instanceof StoreError) return res.status(503).json({ error: err.message });
  console.error('[receipts]', err);
  return res.status(500).json({ error: 'Unexpected error' });
}

// POST /api/timestamp { sha256 } -> { sha256, genTime, verifyUrl }
// Sealing the same hash again returns the first receipt.
router.post('/timestamp', async (req, res) => {
  const sha256 = typeof req.body?.sha256 === 'string' ? req.body.sha256.trim().toLowerCase() : '';
  if (!SHA256_RE.test(sha256)) return res.status(400).json({ error: 'sha256 must be 64 hex characters' });
  try {
    const existing = await findReceipt(sha256);
    if (existing) return res.json(summary(existing));
    const { tsrBase64, genTime } = await createTimestamp(sha256);
    const saved = await saveReceipt({ sha256, tsrBase64, genTime, createdAt: new Date() });
    return res.status(201).json(summary(saved));
  } catch (err) {
    return fail(res, err);
  }
});

// GET /api/receipt/:sha256 -> the receipt plus a fresh verification result, or 404.
// tsrBase64 is the raw FreeTSA reply, so anyone can check it themselves with openssl.
router.get('/receipt/:sha256', async (req, res) => {
  const sha256 = String(req.params.sha256).toLowerCase();
  if (!SHA256_RE.test(sha256)) return res.status(400).json({ error: 'sha256 must be 64 hex characters' });
  try {
    const receipt = await findReceipt(sha256);
    if (!receipt) return res.status(404).json({ error: 'No receipt found' });
    return res.json({
      ...summary(receipt),
      createdAt: new Date(receipt.createdAt).toISOString(),
      tsa: 'FreeTSA (freetsa.org)',
      verified: await verifyTimestamp(sha256, receipt.tsrBase64),
      tsrBase64: receipt.tsrBase64,
    });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;

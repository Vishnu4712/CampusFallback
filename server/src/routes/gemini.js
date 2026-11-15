// Gemini-backed drafts. Inputs are validated and capped so only short metadata can get through.
import { Router } from 'express';
import { draftEmail, draftDigest } from '../lib/gemini.js';
import { verifyUrlFor } from './receipts.js';

const router = Router();

// One line of text, trimmed and capped. Returns null if missing.
function shortText(value, max = 200) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function isoDate(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// POST /api/draft-email { courseName, assignmentName, dueAt, sealedAt?, verifyUrl?, platform? } -> { subject, body, source }
// platform: 'canvas' (default) or 'gradescope'.
// sealedAt and verifyUrl are left out when the file could not be sealed.
router.post('/draft-email', async (req, res) => {
  const body = req.body || {};
  const details = {
    courseName: shortText(body.courseName),
    assignmentName: shortText(body.assignmentName),
    dueAt: isoDate(body.dueAt),
    sealedAt: body.sealedAt == null ? null : isoDate(body.sealedAt),
    verifyUrl: body.verifyUrl == null ? null : shortText(body.verifyUrl, 300),
    platform: body.platform == null ? 'canvas' : body.platform,
  };
  if (!['canvas', 'gradescope'].includes(details.platform)) return res.status(400).json({ error: "platform must be 'canvas' or 'gradescope'" });
  if (!details.courseName || !details.assignmentName || !details.dueAt) {
    return res.status(400).json({ error: 'courseName, assignmentName and dueAt are required' });
  }
  if (body.sealedAt != null && !details.sealedAt) return res.status(400).json({ error: 'sealedAt must be a date' });
  // Only this server's own verify links may appear in an email it drafts.
  if (details.verifyUrl) {
    const sha256 = /[?&]sha256=([0-9a-f]{64})$/.exec(details.verifyUrl)?.[1];
    if (!sha256 || details.verifyUrl !== verifyUrlFor(sha256)) return res.status(400).json({ error: 'verifyUrl is not a link from this server' });
  }
  return res.json(await draftEmail(details));
});

// POST /api/digest { assignments: [{ name, course, dueAt, points }] } -> { text, source }
router.post('/digest', async (req, res) => {
  const list = req.body?.assignments;
  if (!Array.isArray(list) || list.length > 50) return res.status(400).json({ error: 'assignments must be a list of at most 50 items' });
  const assignments = [];
  for (const item of list) {
    const entry = {
      name: shortText(item?.name, 120),
      course: shortText(item?.course, 80),
      dueAt: isoDate(item?.dueAt),
      points: Number.isFinite(item?.points) ? item.points : null,
    };
    if (!entry.name || !entry.course || !entry.dueAt) return res.status(400).json({ error: 'each assignment needs name, course and dueAt' });
    assignments.push(entry);
  }
  return res.json(await draftDigest(assignments));
});

export default router;

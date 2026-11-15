// RFC 3161 timestamps from FreeTSA, built and checked with the openssl command-line tool.
// Only a SHA-256 hash ever goes in; the time comes from FreeTSA's clock, never this machine's.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const OPENSSL = process.env.OPENSSL_BIN || 'openssl';
const TSA_URL = 'https://freetsa.org/tsr';
const TIMEOUT_MS = 8000;
// openssl runs inside the certs folder and is given bare file names: OpenSSL 3 splits the -untrusted
// argument on spaces and commas, so a full path with a space in it would break verification.
const CERTS_DIR = fileURLToPath(new URL('../../certs/', import.meta.url));
const CA_FILE = 'cacert.pem';
const TSA_CERT = 'tsa.crt';

export const SHA256_RE = /^[0-9a-f]{64}$/;

export class TsaError extends Error {}

const openssl = (args) => run(OPENSSL, args, { timeout: TIMEOUT_MS, cwd: CERTS_DIR });

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-tsa-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// True only if the reply is signed by FreeTSA and covers exactly this hash.
async function verifyFile(sha256, tsrPath) {
  try {
    const { stdout } = await openssl(['ts', '-verify', '-digest', sha256, '-in', tsrPath, '-CAfile', CA_FILE, '-untrusted', TSA_CERT]);
    return /Verification: OK/.test(stdout);
  } catch {
    return false;
  }
}

// "Time stamp: Nov 14 21:15:02 2026 GMT" -> Date
async function readGenTime(tsrPath) {
  const { stdout } = await openssl(['ts', '-reply', '-in', tsrPath, '-text']);
  const match = /Time stamp:\s*(.+)/.exec(stdout);
  const time = match ? new Date(match[1].trim().replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1')) : null;
  if (!time || Number.isNaN(time.getTime())) throw new TsaError('Could not read the time from the FreeTSA reply');
  return time;
}

// Asks FreeTSA to timestamp the hash. Returns { tsrBase64, genTime } only after the reply verifies.
export async function createTimestamp(sha256) {
  if (!SHA256_RE.test(sha256)) throw new TsaError('Invalid SHA-256');
  return withTempDir(async (dir) => {
    const tsq = path.join(dir, 'request.tsq');
    const tsr = path.join(dir, 'reply.tsr');
    await openssl(['ts', '-query', '-digest', sha256, '-sha256', '-cert', '-out', tsq]);

    let reply;
    try {
      const res = await fetch(TSA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query' },
        body: await fs.readFile(tsq),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      reply = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new TsaError(`FreeTSA did not answer (${err.name === 'TimeoutError' ? 'timed out after 8 s' : err.message})`);
    }

    await fs.writeFile(tsr, reply);
    if (!(await verifyFile(sha256, tsr))) throw new TsaError('FreeTSA reply failed verification');
    return { tsrBase64: reply.toString('base64'), genTime: await readGenTime(tsr) };
  });
}

// Re-checks a stored receipt against the hash.
export async function verifyTimestamp(sha256, tsrBase64) {
  if (!SHA256_RE.test(sha256) || typeof tsrBase64 !== 'string') return false;
  return withTempDir(async (dir) => {
    const tsr = path.join(dir, 'reply.tsr');
    await fs.writeFile(tsr, Buffer.from(tsrBase64, 'base64'));
    return verifyFile(sha256, tsr);
  });
}

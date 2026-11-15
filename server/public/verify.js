// Verify page. The file is fingerprinted here with WebCrypto and never uploaded:
// the only thing sent to the server is its SHA-256 hash.
const SHA256_RE = /^[0-9a-f]{64}$/;

const eastern = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
});
const formatTime = (iso) => eastern.format(new Date(iso));
const shortHash = (h) => `${h.slice(0, 8)}…${h.slice(-8)}`;

// Same algorithm as the extension (extension/lib/hash.js): SHA-256 over the whole file's bytes.
async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// -> { status: 'found', receipt } | { status: 'missing' } | { status: 'error', message }
async function lookup(sha256) {
  try {
    const res = await fetch(`/api/receipt/${sha256}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { status: 'missing' };
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { status: 'error', message: data?.error || `Server returned ${res.status}` };
    return { status: 'found', receipt: data };
  } catch (err) {
    return { status: 'error', message: err.name === 'TimeoutError' ? 'The server took too long to answer.' : 'Could not reach the server.' };
  }
}

// Tiny DOM helper. Text is always set with textContent, never parsed as HTML.
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

function show(box, tone, title, ...body) {
  box.className = `result ${tone}`;
  box.replaceChildren(el('h2', { textContent: title }), ...body);
}

function facts(rows) {
  const dl = el('dl', { className: 'facts' });
  for (const [term, value, mono] of rows) {
    if (value) dl.append(el('dt', { textContent: term }), el('dd', { textContent: value, className: mono ? 'mono' : '' }));
  }
  return dl;
}

// Lets the professor check the FreeTSA receipt with openssl, without trusting this server.
function diyCheck(receipt) {
  const bytes = Uint8Array.from(atob(receipt.tsrBase64), (c) => c.charCodeAt(0));
  const fileName = `receipt-${receipt.sha256.slice(0, 12)}.tsr`;
  const download = el('a', {
    href: URL.createObjectURL(new Blob([bytes], { type: 'application/timestamp-reply' })),
    download: fileName,
    textContent: `Download the FreeTSA receipt (${fileName})`,
  });
  const command = [
    'curl -sO https://freetsa.org/files/cacert.pem -sO https://freetsa.org/files/tsa.crt',
    `openssl ts -verify -digest ${receipt.sha256} -in ${fileName} -CAfile cacert.pem -untrusted tsa.crt`,
  ].join('\n');
  return el('details', { className: 'diy' },
    el('summary', { textContent: 'Check it yourself with OpenSSL' }),
    el('p', {}, download),
    el('pre', {}, el('code', { textContent: command })),
    el('p', { textContent: 'It prints "Verification: OK" when the receipt is genuine and covers this exact file.' }));
}

const linkStatus = document.getElementById('link-status');
const result = document.getElementById('result');
const input = document.getElementById('file');
const drop = document.getElementById('drop');

// A link from a student's email carries the sealed fingerprint: /verify?sha256=<hex>
const fromLink = (new URLSearchParams(location.search).get('sha256') || '').trim().toLowerCase();
const expected = SHA256_RE.test(fromLink) ? fromLink : null;

async function describeLink() {
  if (!fromLink) return;
  if (!expected) {
    show(linkStatus, 'warn', 'This link is incomplete', el('p', { textContent: 'The fingerprint in the address is not valid. You can still drop the file below.' }));
    return;
  }
  show(linkStatus, 'info', 'Looking up the receipt in this link…');
  const found = await lookup(expected);
  if (found.status === 'found') {
    show(linkStatus, 'info', `The student sealed a file at ${formatTime(found.receipt.genTime)}`,
      el('p', { textContent: 'Drop the file they submitted below to confirm it is the same file.' }),
      facts([['Fingerprint', shortHash(expected), true]]));
  } else if (found.status === 'missing') {
    show(linkStatus, 'bad', 'No receipt exists for this link', el('p', { textContent: 'Nothing was sealed with the fingerprint in this address.' }));
  } else {
    show(linkStatus, 'warn', 'Could not look up this link', el('p', { textContent: found.message }));
  }
}

let current = 0; // ignores results from an earlier file if a newer one was dropped meanwhile

async function check(file) {
  const run = ++current;
  show(result, 'info', `Fingerprinting ${file.name}…`, el('p', { className: 'note', textContent: 'This happens in your browser. The file is not uploaded.' }));

  let sha256;
  try {
    sha256 = await sha256Hex(file);
  } catch {
    if (run === current) show(result, 'bad', 'Could not read this file', el('p', { textContent: 'Try choosing it again.' }));
    return;
  }
  if (run !== current) return;

  const found = await lookup(sha256);
  if (run !== current) return;

  const mismatch = expected && expected !== sha256;
  const fileRows = [['File', file.name], ['Fingerprint', sha256, true]];

  if (found.status === 'error') {
    show(result, 'warn', 'Could not check this file right now', el('p', { textContent: `${found.message} Try again in a minute.` }), facts(fileRows));
    return;
  }

  // A link names one specific file. Any other file fails, even one that has a receipt of its own.
  if (mismatch) {
    const ownReceipt = found.status === 'found' && found.receipt.verified
      ? ` This file was sealed separately at ${formatTime(found.receipt.genTime)}, so ask the student which file they meant to submit.`
      : '';
    show(result, 'bad', 'Not the file in this link',
      el('p', { textContent: `The fingerprint of this file does not match the one the student sealed. Even a one-byte change gives a different fingerprint.${ownReceipt}` }),
      facts([['File', file.name], ['This file', sha256, true], ['Link expects', expected, true]]));
    return;
  }

  if (found.status === 'missing') {
    show(result, 'bad', 'No receipt found', el('p', { textContent: 'This exact file was never sealed with CampusFallback.' }), facts(fileRows));
    return;
  }

  const { receipt } = found;
  const sealedAt = formatTime(receipt.genTime);
  if (!receipt.verified) {
    show(result, 'warn', 'A receipt exists, but it failed verification',
      el('p', { textContent: `The stored receipt says ${sealedAt}, but FreeTSA's signature on it did not check out, so that time cannot be trusted.` }),
      facts(fileRows), diyCheck(receipt));
    return;
  }

  show(result, 'ok', `Sealed at ${sealedAt}, verified by FreeTSA`,
    el('p', {
      textContent: expected
        ? 'This is the exact file in the student\'s link, and it existed at that time. The time comes from FreeTSA\'s clock, not the student\'s laptop.'
        : 'This exact file existed at that time. The time comes from FreeTSA\'s clock, not the student\'s laptop.',
    }),
    facts([...fileRows, ['Sealed', sealedAt], ['Authority', receipt.tsa]]),
    diyCheck(receipt));
}

input.addEventListener('change', () => {
  if (input.files[0]) check(input.files[0]);
  input.value = ''; // lets the same file be chosen again
});

// Drag and drop onto the drop zone; anywhere else on the page a drop is ignored instead of opening the file.
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('dragging'); });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('dragging'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) check(file);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

describeLink();

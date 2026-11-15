// SHA-256 fingerprints, computed on this laptop with WebCrypto. Only the hex string ever leaves the device.

export async function sha256Hex(data) {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Reads the file once and returns its fingerprint plus an in-memory copy.
// The copy is what gets submitted and queued, so the bytes sent are exactly the bytes that were sealed.
export async function fingerprintFile(file) {
  const bytes = await file.arrayBuffer();
  return {
    sha256: await sha256Hex(bytes),
    blob: new Blob([bytes], { type: file.type || 'application/octet-stream' }),
  };
}

export function extensionOf(fileName) {
  const match = /\.([^./\\]+)$/.exec(fileName || '');
  return match ? match[1].toLowerCase() : '';
}

export const shortHash = (sha256) => `${sha256.slice(0, 8)}…${sha256.slice(-8)}`;

// Receipt store: MongoDB Atlas, one document per SHA-256 (unique index).
// Without MONGODB_URI it falls back to memory so the API can be tried locally; those receipts are lost on restart.
import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URI || '';
export const storeKind = URI ? 'mongodb' : 'memory';

export class StoreError extends Error {}

const memory = new Map();
let collectionPromise = null;

// Connects on first use. A failed attempt is forgotten so the next request tries again.
function receipts() {
  collectionPromise ??= (async () => {
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const collection = client.db(client.options.dbName || 'campusfallback').collection('receipts');
    await collection.createIndex({ sha256: 1 }, { unique: true });
    return collection;
  })().catch((err) => {
    collectionPromise = null;
    throw new StoreError(`Receipt store unavailable (${err.message})`);
  });
  return collectionPromise;
}

export async function findReceipt(sha256) {
  if (!URI) return memory.get(sha256) || null;
  const collection = await receipts();
  try {
    return await collection.findOne({ sha256 }, { projection: { _id: 0 } });
  } catch (err) {
    throw new StoreError(`Receipt store unavailable (${err.message})`);
  }
}

// Stores the receipt. If another request stored this hash first, that earlier receipt wins and is returned.
export async function saveReceipt(receipt) {
  if (!URI) {
    if (!memory.has(receipt.sha256)) memory.set(receipt.sha256, receipt);
    return memory.get(receipt.sha256);
  }
  const collection = await receipts();
  try {
    await collection.insertOne({ ...receipt });
    return receipt;
  } catch (err) {
    if (err.code === 11000) return findReceipt(receipt.sha256);
    throw new StoreError(`Receipt store unavailable (${err.message})`);
  }
}

// Used by /api/health.
export async function storeReachable() {
  if (!URI) return true;
  try {
    await receipts();
    return true;
  } catch {
    return false;
  }
}

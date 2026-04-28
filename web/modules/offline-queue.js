// IndexedDB-backed queue for offline check-in / check-out operations.
const DB_NAME    = "thinkcrm-offline";
const DB_VERSION = 1;
const STORE_NAME = "ops";
const MAX_RETRIES = 3;

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("by_status",     "status",     { unique: false });
        store.createIndex("by_capturedAt", "capturedAt", { unique: false });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = ()  => reject(req.error);
  });
}

async function txStore(mode = "readonly") {
  const db    = await openDb();
  const tx    = db.transaction(STORE_NAME, mode);
  const store = tx.objectStore(STORE_NAME);
  return { tx, store };
}

function idbReq(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

export async function enqueue({ type, visitId, endpoint, method = "POST", payload }) {
  const op = {
    id:         crypto.randomUUID(),
    type,
    visitId,
    endpoint,
    method,
    payload,
    capturedAt: new Date().toISOString(),
    status:     "pending",
    retries:    0,
    lastError:  null
  };
  const { store } = await txStore("readwrite");
  await idbReq(store.add(op));
  return op.id;
}

export async function getPendingOps() {
  const { store } = await txStore("readonly");
  const all = await idbReq(store.getAll());
  return all
    .filter(op => op.status === "pending" || (op.status === "failed" && op.retries < MAX_RETRIES))
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export async function getQueueCount() {
  return (await getPendingOps()).length;
}

export async function markSyncing(id) {
  const { store } = await txStore("readwrite");
  const op = await idbReq(store.get(id));
  if (!op) return;
  op.status = "syncing";
  await idbReq(store.put(op));
}

export async function markDone(id) {
  const { store } = await txStore("readwrite");
  await idbReq(store.delete(id));
}

export async function markFailed(id, errorMessage) {
  const { store } = await txStore("readwrite");
  const op = await idbReq(store.get(id));
  if (!op) return;
  op.retries++;
  op.status    = "failed";
  op.lastError = errorMessage;
  await idbReq(store.put(op));
}

export async function getAllOps() {
  const { store } = await txStore("readonly");
  return idbReq(store.getAll());
}

export async function clearQueue() {
  const { store } = await txStore("readwrite");
  await idbReq(store.clear());
}

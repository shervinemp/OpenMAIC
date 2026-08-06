/**
 * Local snapshot storage for automatic backups.
 *
 * Snapshot blobs are kept inside a dedicated IndexedDB database
 * (`openmaic-backups`) so they survive page reloads, work in browsers that
 * prompt on every download, and can be restored without a file picker.
 *
 * Metadata and blob live in separate object stores so listing snapshots never
 * hauls large blobs into memory; the blob is fetched only on restore.
 */
export interface BackupSnapshotMeta {
  id: string;
  savedAt: number;
  label: string;
  size: number;
  courseCount: number;
  settingsIncluded: boolean;
}

const DB_NAME = 'openmaic-backups';
const STORE_META = 'snapshots';
const STORE_BLOB = 'blobs';
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOB)) {
        db.createObjectStore(STORE_BLOB, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open snapshot store'));
  });
}

async function run<R>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => R): Promise<R> {
  const db = await openDb();
  try {
    return await new Promise<R>((resolve, reject) => {
      const transaction = db.transaction([STORE_META, STORE_BLOB], mode);
      const value = work(transaction);
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Snapshot transaction failed'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Snapshot transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function putSnapshot(meta: BackupSnapshotMeta, blob: Blob): Promise<void> {
  await run('readwrite', (tx) => {
    tx.objectStore(STORE_META).put(meta);
    tx.objectStore(STORE_BLOB).put({ id: meta.id, blob });
  });
}

export async function listSnapshots(): Promise<BackupSnapshotMeta[]> {
  const db = await openDb();
  try {
    return await new Promise<BackupSnapshotMeta[]>((resolve, reject) => {
      const request = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).getAll();
      request.onsuccess = () => resolve(request.result as BackupSnapshotMeta[]);
      request.onerror = () => reject(request.error ?? new Error('Snapshot metadata read failed'));
    });
  } finally {
    db.close();
  }
}

export async function getSnapshotBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const request = db.transaction(STORE_BLOB, 'readonly').objectStore(STORE_BLOB).get(id);
      request.onsuccess = () => {
        const record = request.result as { id: string; blob: Blob } | undefined;
        resolve(record?.blob ?? null);
      };
      request.onerror = () => reject(request.error ?? new Error('Snapshot blob read failed'));
    });
  } finally {
    db.close();
  }
}

export async function deleteSnapshot(id: string): Promise<void> {
  await run('readwrite', (tx) => {
    tx.objectStore(STORE_META).delete(id);
    tx.objectStore(STORE_BLOB).delete(id);
  });
}

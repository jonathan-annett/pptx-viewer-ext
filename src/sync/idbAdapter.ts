// Generic async wrapper over a single (database, object-store) pair in
// IndexedDB. Built for M5.2.5 (the URI hash cache) but the surface is
// deliberately generic — M5.3 will reuse the same shape for the
// sha256 → ParseResult identity store.
//
// Why a thin wrapper and not idb-keyval / idb / etc:
//   - Bundle size matters (web extension).
//   - The whole API surface we need is open/get/put/delete/clear/count.
//   - We need to be defensive about IDB not being present at all — see
//     the "dead ends" entry on vscode.workspace.fs hanging without a
//     backing FS provider. Better to discover that on a single small
//     adapter than to find out 50 keystrokes deep.

export interface IdbStore<V> {
  /** Resolve to the stored value, or undefined when the key is absent. */
  get(key: string): Promise<V | undefined>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
  /** Drop every entry; used by tests and a future "Reset hash cache" command. */
  clear(): Promise<void>;
  /** Total number of entries — diagnostic only. */
  count(): Promise<number>;
  /** Release the connection. Idempotent. */
  close(): void;
}

export interface IdbOpenOptions {
  dbName: string;
  storeName: string;
  /** Schema version; bumping triggers onupgradeneeded to create the store. */
  version?: number;
}

/**
 * True when an IndexedDB factory is reachable from `globalThis`. The
 * vscode.dev extension host runs in a Web Worker context; `globalThis`
 * resolves to either `self` (worker) or `window` (page), and both expose
 * `indexedDB` when the host supports it. We've been burned before by VS
 * Code-hosted contexts that look like browsers but aren't (see the
 * "extensionUri hang" dead-end), so probe explicitly rather than assume.
 */
export function isIdbAvailable(): boolean {
  try {
    return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Open the named (database, store) pair and return an async wrapper. The
 * store is created on the first open via onupgradeneeded; subsequent opens
 * see the existing one.
 *
 * Throws if IndexedDB is unavailable. Callers should `isIdbAvailable()`
 * first or treat the failure as "no IDB tier", as the URI hash cache does.
 */
export function openIdbStore<V>(opts: IdbOpenOptions): Promise<IdbStore<V>> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return Promise.reject(new Error('IndexedDB is not available in this host'));
  }
  const dbName = opts.dbName;
  const storeName = opts.storeName;
  const version = opts.version ?? 1;

  return new Promise<IdbStore<V>>((resolve, reject) => {
    const req = idb.open(dbName, version);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
    req.onblocked = () => reject(new Error(`IDB open blocked for ${dbName}`));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Defensive — the upgrade should have created it, but a version
      // mismatch with an older app instance could leave the store absent.
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        reject(new Error(`IDB store '${storeName}' missing in '${dbName}'`));
        return;
      }
      resolve(wrap<V>(db, storeName));
    };
  });
}

function wrap<V>(db: IDBDatabase, storeName: string): IdbStore<V> {
  let closed = false;
  function tx(mode: IDBTransactionMode): IDBObjectStore {
    if (closed) throw new Error('IDB store closed');
    return db.transaction(storeName, mode).objectStore(storeName);
  }
  return {
    get(key) {
      return new Promise<V | undefined>((resolve, reject) => {
        const req = tx('readonly').get(key);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result as V | undefined);
      });
    },
    put(key, value) {
      return new Promise<void>((resolve, reject) => {
        const req = tx('readwrite').put(value as unknown as V & object, key);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve();
      });
    },
    delete(key) {
      return new Promise<void>((resolve, reject) => {
        const req = tx('readwrite').delete(key);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve();
      });
    },
    clear() {
      return new Promise<void>((resolve, reject) => {
        const req = tx('readwrite').clear();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve();
      });
    },
    count() {
      return new Promise<number>((resolve, reject) => {
        const req = tx('readonly').count();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

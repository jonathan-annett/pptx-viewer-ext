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
  /**
   * Read every value in the store. Used by callers that want a one-shot
   * warm-load into an in-memory index at activation (e.g. the search
   * engine's projection load). Linear in store size — not for stores that
   * could grow unbounded. The hash cache and parse cache deliberately
   * don't use this; they're lookup-on-demand and don't want to materialise
   * the whole store on startup.
   */
  getAll(): Promise<V[]>;
  /**
   * Read every entry in the store as [key, value] pairs. Like {@link getAll}
   * but preserves keys — useful for cache snapshots where the value doesn't
   * carry its key. Implemented via parallel `getAllKeys()` + `getAll()`;
   * IndexedDB guarantees both return in the same key order so the zip is
   * stable. Same caveats as getAll: linear in store size.
   */
  getAllEntries(): Promise<Array<[string, V]>>;
  /** Release the connection. Idempotent. */
  close(): void;
}

export interface IdbOpenOptions {
  dbName: string;
  storeName: string;
  /** Schema version; bumping triggers onupgradeneeded to create the store. */
  version?: number;
}

export interface IdbOpenMultiOptions {
  dbName: string;
  /**
   * Object stores to create on first open. All are created in a single
   * onupgradeneeded transaction. Opening the same DB twice for different
   * store names doesn't work (the second open sees the existing DB at the
   * same version, skips the upgrade, and can't find its store). When you
   * need more than one store under one DB, use {@link openIdbStores}.
   */
  storeNames: string[];
  /** Schema version; bump to add new stores to an existing DB. */
  version?: number;
}

export interface IdbMultiStore {
  /** Get a typed view over one of the stores opened together. */
  store<V>(storeName: string): IdbStore<V>;
  /** Close the underlying DB connection. Idempotent. */
  close(): void;
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
      // Owning store: close() releases the DB.
      resolve(makeStoreView<V>(db, storeName, true));
    };
  });
}

/**
 * Open one DB with multiple object stores. All stores are created in a
 * single onupgradeneeded so they exist on the same version — opening the
 * same DB twice for different store names doesn't work (second open sees
 * the DB at the same version, skips the upgrade, can't find its store).
 *
 * Bump `version` to add a new store to an existing DB: the upgrade
 * transaction creates any missing stores, leaves existing ones alone.
 */
export function openIdbStores(opts: IdbOpenMultiOptions): Promise<IdbMultiStore> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return Promise.reject(new Error('IndexedDB is not available in this host'));
  }
  const { dbName, storeNames } = opts;
  const version = opts.version ?? 1;

  return new Promise<IdbMultiStore>((resolve, reject) => {
    const req = idb.open(dbName, version);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
    req.onblocked = () => reject(new Error(`IDB open blocked for ${dbName}`));
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of storeNames) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      for (const name of storeNames) {
        if (!db.objectStoreNames.contains(name)) {
          db.close();
          reject(new Error(`IDB store '${name}' missing in '${dbName}'`));
          return;
        }
      }
      let closed = false;
      resolve({
        store<V>(storeName: string): IdbStore<V> {
          // Non-owning views: their close() is a no-op. The multi-store
          // owns the DB connection; tearing it down is multi.close()'s job.
          return makeStoreView<V>(db, storeName, false);
        },
        close() {
          if (closed) return;
          closed = true;
          db.close();
        },
      });
    };
  });
}

function makeStoreView<V>(db: IDBDatabase, storeName: string, ownsConnection: boolean): IdbStore<V> {
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
    getAll() {
      return new Promise<V[]>((resolve, reject) => {
        const req = tx('readonly').getAll();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result as V[]);
      });
    },
    async getAllEntries(): Promise<Array<[string, V]>> {
      // Two ops on one logical scan; the spec guarantees getAllKeys and
      // getAll iterate in the same key order so zipping is stable. Issued
      // in parallel — both share the same tier readonly tx model upstream.
      const [keys, values] = await Promise.all([
        new Promise<IDBValidKey[]>((resolve, reject) => {
          const req = tx('readonly').getAllKeys();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
        }),
        new Promise<V[]>((resolve, reject) => {
          const req = tx('readonly').getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result as V[]);
        }),
      ]);
      const out: Array<[string, V]> = new Array(keys.length);
      for (let i = 0; i < keys.length; i++) out[i] = [String(keys[i]), values[i]];
      return out;
    },
    close() {
      if (closed) return;
      closed = true;
      // Only the owning view releases the DB. Views handed out by a
      // multi-store wrapper share one connection — the multi-store's
      // close() owns the teardown.
      if (ownsConnection) db.close();
    },
  };
}

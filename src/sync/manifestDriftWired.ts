// vscode-wired half of the manifest drift computer (M4).
//
// Walks a manifest's entries, hashes each entry's on-disk file via the
// shared M5.2.5 cache + a single snapshot() read, classifies each via
// the pure `computeDriftRow` helper, and returns a `ManifestDriftMap`.
//
// Cost on a warm cache: roughly stat-time per entry (the snapshot path
// inside hashFileAtUri avoids re-reading the bytes when size+mtime are
// unchanged). Cost on a cold cache: stat + read + sha256 per file.
// Entries are processed in parallel via Promise.all — VS Code's fs ops
// are async-friendly, and a ~30-entry destination resolves in well
// under a second on warm caches.
//
// The pure side (`./manifestDrift.ts`) owns the four-state classifier;
// this module is the thin vscode adapter that produces the inputs.

import * as vscode from 'vscode';
import { log } from '../log';
import { hashFileAtUri } from './hash';
import { getHashCacheSingleton, type UriHashCache } from './hashCache';
import {
  computeDriftRow,
  type ManifestDriftMap,
} from './manifestDrift';
import type { Manifest } from './manifest-types';
import { vscodeFs } from './vscodeFs';

const MANIFEST_FILENAME = '.foldersync-manifest.json';

/**
 * Derive the destination root URI from a `.foldersync-manifest.json`
 * URI by stripping the trailing filename. Exposed so the manifest
 * editor can compute the same root for its FileSystemWatcher
 * registration.
 */
export function destRootFromManifestUri(manifestUri: vscode.Uri): vscode.Uri {
  const path = manifestUri.path;
  const suffix = `/${MANIFEST_FILENAME}`;
  const destPath = path.endsWith(suffix) ? path.slice(0, -suffix.length) : path;
  return manifestUri.with({ path: destPath || '/' });
}

/**
 * Compute drift for every entry in `manifest`. The returned map keys
 * are manifest entry keys (`source:relPath` per the manifest schema).
 * Entries the file system can't reach (stat throws) classify as
 * `missing`; the rest are hashed and compared.
 *
 * Errors per entry are caught and logged — one unreadable file
 * shouldn't sink the whole pass. The defensive failure mode is `missing`
 * for that row, which is the most informative status we can produce
 * without the bytes.
 */
export async function computeDriftMap(
  manifest: Manifest,
  destRootUri: vscode.Uri,
): Promise<ManifestDriftMap> {
  // The singleton is stored with the default URI shape; cast to the
  // vscode.Uri-flavoured variant so `hashFileAtUri` accepts it. Matches
  // the cast pattern used by planner.ts + runSync.ts.
  const cache = getHashCacheSingleton() as
    | UriHashCache<vscode.Uri>
    | undefined;
  // One IDB read up front beats N per-entry lookups on cold caches.
  // Falls back to undefined when no cache is configured (test contexts).
  const snapshot = cache ? await cache.snapshot() : undefined;
  const fs = vscodeFs();
  const map: ManifestDriftMap = new Map();
  const keys = Object.keys(manifest.entries);

  await Promise.all(
    keys.map(async (key) => {
      const entry = manifest.entries[key];
      const destUri = vscode.Uri.joinPath(destRootUri, entry.destPath);
      let actualSha: string | undefined;
      let fileExists = true;
      try {
        const result = await hashFileAtUri(fs, destUri, cache, {
          snapshot,
          needBytes: false,
        });
        actualSha = result.sha256;
      } catch (err) {
        // stat threw → file missing (the documented failure mode for
        // `vscode.workspace.fs.stat` when the target doesn't exist).
        // Other hash failures are rare; folding them into "missing"
        // keeps the UI legible and the log line surfaces the cause.
        fileExists = false;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/not found|ENOENT|EntryNotFound/i.test(msg)) {
          log(`drift: hash failed for ${destUri.toString()} — ${msg}`);
        }
      }
      map.set(key, computeDriftRow(key, entry.sha256, actualSha, fileExists));
    }),
  );

  return map;
}

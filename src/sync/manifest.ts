// Read .foldersync-manifest.json from a destination root.
//
// The manifest records what sync placed in this destination — the source
// identity, the relative path within the source, and the hash at the time
// of placement. The plan engine uses it to distinguish files we placed
// from files the user added independently, and to recognise overwrites.
//
// M2 ships read-only. Writes land in M4 (tmp+rename via writeManifest).
// Version-mismatch refusal shipped in M6.D — `readManifest` now returns a
// discriminated union so callers can refuse sync on an unknown schema
// version rather than silently treating the manifest as empty (which would
// clobber the user's prior tracking on the next write).
//
// Schema (per folder-sync-v1-plan.md):
//
//   {
//     "version": 1,
//     "lastSync": "<ISO timestamp>",
//     "entries": {
//       "<sourceWorkspaceFolder>:<relativePath>": {
//         "destPath": "<path under destination root>",
//         "size": 1234,
//         "sha256": "abc...",
//         "syncedAt": "<ISO timestamp>"
//       }
//     },
//     "decisions": {
//       "<sourceWorkspaceFolder>:<relativePath>": {
//         "destOnlyDelete": false,
//         "collisionOverwrite": true,
//         "warningOverride": false,
//         "decidedAt": "<ISO timestamp>"
//       }
//     }
//   }
//
// The `warningOverride` field is the per-file "Sync anyway" memory for
// override-severity validator warnings (e.g. pptx media-controls + embedded
// video). Older manifests written before warning overrides shipped lack the
// field; the parser defaults it to false so they continue to load cleanly.
//
// Missing or corrupt manifest → empty manifest. This is deliberate per the
// plan: an existing destination with no manifest surfaces every file as
// destination-only, making the state visible to the user via plan summary
// rather than hiding it behind a silent fallback.

import * as vscode from 'vscode';
import { log } from '../log';
import {
  emptyManifest,
  normaliseManifest,
  type Manifest,
  type ManifestReadResult,
} from './manifest-types';

export { emptyManifest, manifestKey, parseManifestText } from './manifest-types';
export type {
  Manifest,
  ManifestDecision,
  ManifestEntry,
  ManifestReadResult,
} from './manifest-types';

const MANIFEST_FILENAME = '.foldersync-manifest.json';

/**
 * Read the manifest at the given destination root URI.
 *
 * Returns a discriminated union:
 *   - `{ kind: 'ok', manifest }` for the happy path AND every recoverable
 *     failure (missing file, bad utf-8, corrupt JSON, structurally-wrong
 *     payload) — the documented soft-fallback to an empty manifest, which
 *     makes existing destination files surface as destination-only in the
 *     plan.
 *   - `{ kind: 'version-mismatch', actual }` when the file parses to a
 *     valid object but its `version` field is anything other than 1. Sync
 *     callers refuse to touch that destination; writing an empty manifest
 *     back would overwrite the user's prior tracking record. The viewer's
 *     informational surfaces treat this like a missing manifest.
 */
export async function readManifest(destRootUri: vscode.Uri): Promise<ManifestReadResult> {
  const uri = manifestUri(destRootUri);

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    // File doesn't exist — empty manifest is the documented behaviour.
    return okEmpty();
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    log(`sync: manifest at ${uri.toString()} is not valid utf-8 (${errMsg(err)}); treating as empty`);
    return okEmpty();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    log(`sync: manifest at ${uri.toString()} is corrupt JSON (${errMsg(err)}); treating as empty`);
    return okEmpty();
  }

  const result = normaliseManifest(raw);
  if (result.kind === 'version-mismatch') {
    log(
      `sync: manifest at ${uri.toString()} has unsupported version ${String(result.actual)} ` +
        `(extension supports version 1); refusing to sync this destination`,
    );
  } else if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    // normaliseManifest swallows this branch silently. Keep the diagnostic
    // here where we still have URI context — same shape as the corrupt-JSON
    // log line above.
    log(`sync: manifest at ${uri.toString()} top-level is not an object; treating as empty`);
  }
  return result;
}

function okEmpty(): ManifestReadResult {
  return { kind: 'ok', manifest: emptyManifest() };
}

export function manifestUri(destRootUri: vscode.Uri): vscode.Uri {
  const base = destRootUri.path.endsWith('/') ? destRootUri.path.slice(0, -1) : destRootUri.path;
  return destRootUri.with({ path: `${base}/${MANIFEST_FILENAME}` });
}

/**
 * Atomic manifest write: encode → writeFile(<path>.tmp) → rename to final.
 * Same pattern the executor uses for synced files. If anything along the
 * chain throws, the caller sees the failure and the destination's manifest
 * is left unchanged (the tmp file may linger; M6's orphan sweep cleans).
 */
export async function writeManifest(
  destRootUri: vscode.Uri,
  manifest: Manifest,
): Promise<void> {
  const finalUri = manifestUri(destRootUri);
  const tmpUri = destRootUri.with({ path: `${finalUri.path}.tmp` });
  // 2-space indent keeps the file diff-friendly when the user inspects it.
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
  await vscode.workspace.fs.writeFile(tmpUri, bytes);
  try {
    await vscode.workspace.fs.rename(tmpUri, finalUri, { overwrite: true });
  } catch (err) {
    try { await vscode.workspace.fs.delete(tmpUri); } catch { /* ignore */ }
    throw err;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

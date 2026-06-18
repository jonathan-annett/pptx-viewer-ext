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

import { getHost } from './host';
import { log } from '../log';
import {
  emptyManifest,
  normaliseManifest,
  type Manifest,
  type ManifestReadResult,
} from './manifest-types';
import {
  MANIFEST_FILENAMES,
  PREFERRED_MANIFEST_FILENAME,
  type ManifestFilename,
} from './manifestFilenames';

export { emptyManifest, manifestKey, parseManifestText } from './manifest-types';
export type {
  Manifest,
  ManifestDecision,
  ManifestEntry,
  ManifestReadResult,
} from './manifest-types';

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
export async function readManifest<U extends { toString(): string }>(
  destRootUri: U,
): Promise<ManifestReadResult> {
  // Find whichever manifest filename exists at this destination root. New
  // destinations land on the preferred `.syncManifest`; existing
  // destinations carrying the legacy `.foldersync-manifest.json` keep using
  // it (no silent migration of operator-owned files).
  const resolved = await resolveManifestUri(destRootUri);
  const uri = resolved.uri;

  if (!resolved.existed) {
    // File doesn't exist — empty manifest is the documented behaviour.
    return okEmpty();
  }
  let bytes: Uint8Array;
  try {
    bytes = await getHost<U>().fs.readFile(uri);
  } catch {
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

/**
 * URI of the *preferred* manifest filename at the root of a given
 * destination folder. Used when we need a canonical URI without touching
 * the filesystem (display labels, auto-open paths). For "where is the
 * actual file" paths, call {@link resolveManifestUri} instead.
 */
export function manifestUri<U>(destRootUri: U): U {
  return manifestUriAt(destRootUri, PREFERRED_MANIFEST_FILENAME);
}

function manifestUriAt<U>(destRootUri: U, filename: ManifestFilename): U {
  return getHost<U>().uri.join(destRootUri, filename);
}

/**
 * Resolve which manifest file to use at `destRootUri`. Checks the preferred
 * filename first (`.syncManifest`); falls back to the legacy
 * `.foldersync-manifest.json` if only that one exists; returns the
 * preferred URI with `existed: false` when neither does.
 */
export async function resolveManifestUri<U>(
  destRootUri: U,
): Promise<{ uri: U; filename: ManifestFilename; existed: boolean }> {
  const fs = getHost<U>().fs;
  const preferred = manifestUriAt(destRootUri, PREFERRED_MANIFEST_FILENAME);
  try {
    await fs.stat(preferred);
    return { uri: preferred, filename: PREFERRED_MANIFEST_FILENAME, existed: true };
  } catch { /* try legacy */ }
  for (const filename of MANIFEST_FILENAMES) {
    if (filename === PREFERRED_MANIFEST_FILENAME) continue;
    const candidate = manifestUriAt(destRootUri, filename);
    try {
      await fs.stat(candidate);
      return { uri: candidate, filename, existed: true };
    } catch { /* try next */ }
  }
  return { uri: preferred, filename: PREFERRED_MANIFEST_FILENAME, existed: false };
}

/**
 * Atomic manifest write: encode → writeFile(<path>.tmp) → rename to final.
 * Same pattern the executor uses for synced files. If anything along the
 * chain throws, the caller sees the failure and the destination's manifest
 * is left unchanged (the tmp file may linger; M6's orphan sweep cleans).
 */
export async function writeManifest<U>(
  destRootUri: U,
  manifest: Manifest,
): Promise<void> {
  // Write to whichever filename already exists at this destination, or to
  // the preferred new filename (`.syncManifest`) when neither exists. The
  // resolver does one stat on warm-migrated destinations, two on
  // legacy-only destinations — negligible per-sync overhead.
  const { fs, uri } = getHost<U>();
  const resolved = await resolveManifestUri(destRootUri);
  const finalUri = resolved.uri;
  // tmp sibling of the final file: <root>/<filename>.tmp
  const tmpUri = uri.join(destRootUri, resolved.filename + '.tmp');
  // 2-space indent keeps the file diff-friendly when the user inspects it.
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(tmpUri, bytes);
  try {
    await fs.rename(tmpUri, finalUri);
  } catch (err) {
    try { await fs.delete(tmpUri); } catch { /* ignore */ }
    throw err;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

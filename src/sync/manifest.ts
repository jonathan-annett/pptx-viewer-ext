// Read .foldersync-manifest.json from a destination root.
//
// The manifest records what sync placed in this destination — the source
// identity, the relative path within the source, and the hash at the time
// of placement. The plan engine uses it to distinguish files we placed
// from files the user added independently, and to recognise overwrites.
//
// M2 ships read-only. Writes land in M4 (tmp+rename via writeManifest).
// Version-mismatch refusal still belongs to M6.
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
//         "decidedAt": "<ISO timestamp>"
//       }
//     }
//   }
//
// Missing or corrupt manifest → empty manifest. This is deliberate per the
// plan: an existing destination with no manifest surfaces every file as
// destination-only, making the state visible to the user via plan summary
// rather than hiding it behind a silent fallback.

import * as vscode from 'vscode';
import { log } from '../log';
import {
  emptyManifest,
  type Manifest,
  type ManifestDecision,
  type ManifestEntry,
} from './manifest-types';

export { emptyManifest, manifestKey } from './manifest-types';
export type { Manifest, ManifestDecision, ManifestEntry } from './manifest-types';

const MANIFEST_FILENAME = '.foldersync-manifest.json';

/** Read the manifest at the given destination root URI. */
export async function readManifest(destRootUri: vscode.Uri): Promise<Manifest> {
  const uri = manifestUri(destRootUri);

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    // File doesn't exist — empty manifest is the documented behaviour.
    return emptyManifest();
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    log(`sync: manifest at ${uri.toString()} is not valid utf-8 (${errMsg(err)}); treating as empty`);
    return emptyManifest();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    log(`sync: manifest at ${uri.toString()} is corrupt JSON (${errMsg(err)}); treating as empty`);
    return emptyManifest();
  }

  return normalise(raw, uri);
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

/**
 * Validate the parsed JSON loosely. Anything we don't recognise as a v1
 * manifest collapses to an empty one — version-mismatch refusal is M6.
 */
function normalise(raw: unknown, uri: vscode.Uri): Manifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    log(`sync: manifest at ${uri.toString()} top-level is not an object; treating as empty`);
    return emptyManifest();
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    // M6 territory: surface the mismatch. For M2 we log and keep going.
    log(
      `sync: manifest at ${uri.toString()} has unrecognised version ${String(obj.version)} — ` +
        `treating as empty (a strict refusal lands in M6)`,
    );
    return emptyManifest();
  }

  const entries: { [key: string]: ManifestEntry } = {};
  if (obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)) {
    for (const [k, v] of Object.entries(obj.entries as Record<string, unknown>)) {
      const entry = asEntry(v);
      if (entry) entries[k] = entry;
    }
  }

  const decisions: { [key: string]: ManifestDecision } = {};
  if (obj.decisions && typeof obj.decisions === 'object' && !Array.isArray(obj.decisions)) {
    for (const [k, v] of Object.entries(obj.decisions as Record<string, unknown>)) {
      const decision = asDecision(v);
      if (decision) decisions[k] = decision;
    }
  }

  return {
    version: 1,
    lastSync: typeof obj.lastSync === 'string' ? obj.lastSync : null,
    entries,
    decisions,
  };
}

function asEntry(v: unknown): ManifestEntry | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const e = v as Record<string, unknown>;
  if (
    typeof e.destPath !== 'string' ||
    typeof e.size !== 'number' ||
    typeof e.sha256 !== 'string' ||
    typeof e.syncedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    destPath: e.destPath,
    size: e.size,
    sha256: e.sha256,
    syncedAt: e.syncedAt,
  };
}

function asDecision(v: unknown): ManifestDecision | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const d = v as Record<string, unknown>;
  if (
    typeof d.destOnlyDelete !== 'boolean' ||
    typeof d.collisionOverwrite !== 'boolean' ||
    typeof d.decidedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    destOnlyDelete: d.destOnlyDelete,
    collisionOverwrite: d.collisionOverwrite,
    decidedAt: d.decidedAt,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

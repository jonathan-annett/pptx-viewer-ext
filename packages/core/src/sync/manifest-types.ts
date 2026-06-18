// Pure data types and helpers for the sync manifest.
//
// Split out from manifest.ts so the plan engine (which only needs the types
// and the key helper) can be unit-tested under plain Node without pulling
// in the vscode import.

export interface ManifestEntry {
  destPath: string;
  size: number;
  sha256: string;
  syncedAt: string;
}

/**
 * A "Don't ask again" decision the user persisted from the plan webview.
 * Exactly one of the three intent fields is true per record; the manifest
 * stores them as a flat record so a single decision file can co-mingle the
 * different categories without a kind discriminator.
 */
export interface ManifestDecision {
  /** User accepted destination-only deletion for this rel-path. */
  destOnlyDelete: boolean;
  /** User accepted overwriting a collision for this rel-path. */
  collisionOverwrite: boolean;
  /**
   * User accepted shipping a file with override-severity warnings (e.g.
   * media-controls visible over embedded video). Doesn't apply to block-
   * severity warnings — those have no per-file override. Decoupled from
   * collisionOverwrite because a row may carry both kinds of decision over
   * its lifetime (and we want to remember each one independently).
   */
  warningOverride: boolean;
  decidedAt: string;
}

export interface Manifest {
  version: 1;
  lastSync: string | null;
  entries: { [key: string]: ManifestEntry };
  decisions: { [key: string]: ManifestDecision };
}

/**
 * Outcome of reading + validating a manifest file's contents. Two-variant
 * union so callers (planner, runSync, viewer, M6.E editor) can branch
 * cleanly between "use it" and "this destination is on an unknown schema
 * version — refuse to sync until the extension is updated".
 *
 * Missing files, corrupt JSON, and structurally-wrong-but-recoverable
 * payloads all fold into `kind: 'ok'` with an empty manifest — that's the
 * documented soft-fallback behaviour from the plan ("an existing destination
 * with no manifest surfaces every file as destination-only"). Version
 * mismatch is the only case that's distinct enough to block sync: the file
 * exists, it parses, and it claims a schema this extension doesn't speak,
 * so silently treating it as empty would clobber the user's prior tracking
 * data on the next write.
 */
export type ManifestReadResult =
  | { kind: 'ok'; manifest: Manifest }
  | { kind: 'version-mismatch'; actual: unknown };

export function emptyManifest(): Manifest {
  return { version: 1, lastSync: null, entries: {}, decisions: {} };
}

/**
 * Build the manifest key for a given source identity + relative path.
 * The source identity is the source workspace folder name (per plan).
 */
export function manifestKey(sourceWorkspaceFolder: string, relPath: string): string {
  return `${sourceWorkspaceFolder}:${relPath}`;
}

/**
 * Parse a manifest's text contents into a `ManifestReadResult`. Mirrors the
 * `parseSnapshot` / `parseSyncConfigText` pure-helper pattern used elsewhere
 * in the project so the file-IO half (`readManifest` in `manifest.ts`) and
 * the M6.E custom editor share one parser.
 *
 * Bad JSON, top-level not-an-object, top-level-is-array, or structurally-
 * wrong entries all collapse to `{ kind: 'ok', manifest: emptyManifest() }` —
 * the documented soft-fallback. A valid object whose `version` field is
 * anything other than 1 returns `{ kind: 'version-mismatch', actual }`.
 *
 * Pure — no vscode import, no logging. Callers that have URI context can log
 * around the result (see `readManifest`).
 */
export function parseManifestText(text: string): ManifestReadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'ok', manifest: emptyManifest() };
  }
  return normaliseManifest(raw);
}

/**
 * Lower-level pure helper: validate a parsed JSON value as a manifest. Used
 * by `parseManifestText` above and by `readManifest` which calls
 * `JSON.parse` directly so it can log corrupt-JSON warnings with URI context.
 */
export function normaliseManifest(raw: unknown): ManifestReadResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'ok', manifest: emptyManifest() };
  }
  const obj = raw as Record<string, unknown>;
  // A missing `version` field signals an incomplete or hand-created file
  // (e.g. an empty `{}` typed by an operator before the source-side sync
  // has written content). Soft-fallback to empty manifest rather than
  // surfacing the version-mismatch banner — that copy is reserved for
  // *intentional* non-1 versions written by a newer extension, where
  // refusing to interpret protects the user's tracking record. The
  // executor's writeManifest always emits version=1, so this loosening
  // costs no real safety against future-version manifests.
  if (obj.version === undefined) {
    return { kind: 'ok', manifest: emptyManifest() };
  }
  if (obj.version !== 1) {
    return { kind: 'version-mismatch', actual: obj.version };
  }

  const entries: { [key: string]: ManifestEntry } = {};
  if (obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)) {
    for (const [k, v] of Object.entries(obj.entries as Record<string, unknown>)) {
      const entry = asManifestEntry(v);
      if (entry) entries[k] = entry;
    }
  }

  const decisions: { [key: string]: ManifestDecision } = {};
  if (obj.decisions && typeof obj.decisions === 'object' && !Array.isArray(obj.decisions)) {
    for (const [k, v] of Object.entries(obj.decisions as Record<string, unknown>)) {
      const decision = asManifestDecision(v);
      if (decision) decisions[k] = decision;
    }
  }

  return {
    kind: 'ok',
    manifest: {
      version: 1,
      lastSync: typeof obj.lastSync === 'string' ? obj.lastSync : null,
      entries,
      decisions,
    },
  };
}

function asManifestEntry(v: unknown): ManifestEntry | undefined {
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

function asManifestDecision(v: unknown): ManifestDecision | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const d = v as Record<string, unknown>;
  if (
    typeof d.destOnlyDelete !== 'boolean' ||
    typeof d.collisionOverwrite !== 'boolean' ||
    typeof d.decidedAt !== 'string'
  ) {
    return undefined;
  }
  // warningOverride is a later addition; default to false when missing so
  // manifests written before it shipped continue to load. A wrong-typed
  // value also degrades to false rather than rejecting the whole record.
  const warningOverride =
    typeof d.warningOverride === 'boolean' ? d.warningOverride : false;
  return {
    destOnlyDelete: d.destOnlyDelete,
    collisionOverwrite: d.collisionOverwrite,
    warningOverride,
    decidedAt: d.decidedAt,
  };
}

// M4.6 — workspace snapshot, pure layer.
//
// Captures the shape of a vscode.dev workspace into a JSONC payload that
// lives on disk as `.admin-sync.jsonc` at the top of workspaceFolders[0].
// A globalState pointer remembers where the file is so the extension can
// find and replay it on a cold activation (folderless tab after a browser
// refresh).
//
// This module is "pure" in the substrate sense: no `import * as vscode`.
// It defines the types, the JSONC marshal/unmarshal, and equality. The
// vscode-touching half (read/write/captureCurrent) lives in
// ./snapshotStore.ts so this file is tsx-runnable for tests.

import {
  applyEdits,
  modify,
  parseTree,
  type ParseError,
  type Node,
} from 'jsonc-parser';

/** One workspace folder as remembered in the snapshot. */
export interface SnapshotFolder {
  /** URI as a string, e.g. "file:///Speakers%20Prep". Round-trips via vscode.Uri.parse. */
  uri: string;
  /** Display name. Users can override the folder display name independently of its URI. */
  name: string;
}

/** Subset of workspace configuration we capture. v1 captures known keys only. */
export type SnapshotSettings = Record<string, unknown>;

/** Top-level snapshot payload that gets serialised to JSONC. */
export interface Snapshot {
  /** Folders in the order they appeared in workspaceFolders. Position is load-bearing — workspaceFolders[0] is treated as the writable folder by user convention. */
  folders: SnapshotFolder[];
  /** Workspace-target settings, keyed by dotted setting name. */
  settings: SnapshotSettings;
  /** User-managed sha256 hex strings (lowercase) treated as placeholder files. The empty-file sha is implicit and not stored here. */
  placeholders: string[];
  /** ISO timestamp at capture. Diagnostic; not used for content equality. */
  capturedAt: string;
}

/**
 * Well-known sha256 of an empty byte sequence. Always treated as a placeholder
 * (Windows Explorer's "New PowerPoint Presentation" produces a zero-byte file
 * and operators rely on that workflow). Lives only in the consumer set
 * produced by `effectivePlaceholderSet`; never written to the on-disk array,
 * so the "cannot remove the default" UX is a property of the UI rather than
 * special-case writer logic.
 */
export const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * The set of sha256 hashes a consumer (viewer, planner) should treat as
 * placeholders. Always contains EMPTY_FILE_SHA256; user entries are added
 * lowercased for case-insensitive membership checks.
 */
export function effectivePlaceholderSet(snapshot: Snapshot | null): Set<string> {
  const set = new Set<string>([EMPTY_FILE_SHA256]);
  if (snapshot) {
    for (const h of snapshot.placeholders) set.add(h.toLowerCase());
  }
  return set;
}

/**
 * Pure helper: text → effective placeholder set. Lives here (rather than in
 * placeholderRegistry.ts) so it can be tested under plain Node — the registry
 * itself touches vscode.workspace. The registry wraps this for its disk read
 * path; consumers should go through the registry, not this helper directly.
 */
export function computeEffectiveSetFromText(text: string): Set<string> {
  const { snapshot } = parseSnapshot(text);
  return effectivePlaceholderSet(snapshot);
}

/** GlobalState pointer record. Stored under `folderSync.snapshotPointer`. */
export interface SnapshotPointer {
  /** URI of the `.admin-sync.jsonc` file, as a string. */
  uri: string;
  /** ISO timestamp matching the snapshot's `capturedAt` at write time. */
  lastWriteAt: string;
}

/**
 * Known workspace settings keys captured/restored by M4.6 v1.
 *
 * Why a fixed list rather than "everything at workspace scope":
 * VS Code's configuration API doesn't expose a clean enumeration of all
 * workspace-set keys — `getConfiguration().inspect(key).workspaceValue` is
 * per-key, and `getConfiguration()` enumerates section names rather than
 * leaf paths. Full-blob capture is M4.6 follow-up work; until then, this
 * array names the keys we explicitly understand. Add to it as new use
 * cases emerge.
 */
export const KNOWN_WORKSPACE_KEYS: readonly string[] = [
  'files.readonlyInclude',
  'files.readonlyExclude',
];

/** Header comment prepended to every marshalled snapshot file. */
const HEADER_COMMENT = `// Folder Sync workspace snapshot — managed automatically.
// Do not hand-edit. Use "Folder Sync: Open Admin Config" to view, or
// "Folder Sync: Clear Workspace Snapshot" to discard. This file is
// regenerated whenever the workspace topology changes; manual edits will
// be lost on the next topology event.
//
// The file lives at the top of workspaceFolders[0] by convention. The
// pointer in context.globalState.folderSync.snapshotPointer tells the
// extension where to find it on a cold start.
`;

/**
 * Serialise a snapshot to JSONC text, with the managed-by-extension header
 * comment as a preamble. Uses jsonc-parser's modify() against an empty
 * object so the formatting is consistent with how the rest of the sync
 * feature edits JSONC (preserving the convention even though there's no
 * prior content to preserve here).
 */
export function marshalSnapshot(snapshot: Snapshot): string {
  // Build the body as plain JSON first — modify() requires existing text to
  // edit, which is overkill for a fresh-write. Plain stringify produces the
  // right shape; we just prepend the header.
  const body = JSON.stringify(
    {
      folders: snapshot.folders,
      settings: snapshot.settings,
      placeholders: snapshot.placeholders,
      capturedAt: snapshot.capturedAt,
    },
    null,
    2,
  );
  return `${HEADER_COMMENT}${body}\n`;
}

/** Result of parsing JSONC into a Snapshot. */
export interface ParseSnapshotResult {
  /** The parsed snapshot, with missing/invalid fields defaulted. */
  snapshot: Snapshot;
  /** Diagnostics. Empty array on a clean parse. */
  errors: string[];
}

/**
 * Parse JSONC text into a Snapshot. Tolerant — missing fields default to
 * empty / now; unrecognised top-level keys are ignored. The errors array
 * is informational; the caller can choose to log them and still proceed
 * (the snapshot is always returned).
 */
export function parseSnapshot(text: string): ParseSnapshotResult {
  const errors: string[] = [];
  const parseErrors: ParseError[] = [];
  const tree = parseTree(text, parseErrors, { allowTrailingComma: true });
  for (const e of parseErrors) {
    errors.push(`JSONC parse error code=${e.error} at offset ${e.offset} (length ${e.length})`);
  }

  if (!tree || tree.type !== 'object') {
    errors.push('snapshot root is not an object');
    return { snapshot: emptySnapshot(), errors };
  }

  const folders = readFolders(tree, errors);
  const settings = readSettings(tree, errors);
  const placeholders = readPlaceholders(tree, errors);
  const capturedAt = readString(tree, 'capturedAt') ?? '';

  return {
    snapshot: { folders, settings, placeholders, capturedAt },
    errors,
  };
}

/** Empty snapshot with capturedAt set to the unix epoch. */
export function emptySnapshot(): Snapshot {
  return {
    folders: [],
    settings: {},
    placeholders: [],
    capturedAt: '1970-01-01T00:00:00.000Z',
  };
}

/**
 * Content equality for change detection. Compares folders (ordered) and
 * settings (key set + values), ignoring capturedAt. The atomic-write path
 * uses this to skip no-op writes.
 */
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.folders.length !== b.folders.length) return false;
  for (let i = 0; i < a.folders.length; i++) {
    if (a.folders[i].uri !== b.folders[i].uri) return false;
    if (a.folders[i].name !== b.folders[i].name) return false;
  }
  const aKeys = Object.keys(a.settings).sort();
  const bKeys = Object.keys(b.settings).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    // Compare values via stable stringification. Cheap and adequate for the
    // simple JSON-compatible values workspace settings hold.
    if (stableStringify(a.settings[aKeys[i]]) !== stableStringify(b.settings[bKeys[i]])) {
      return false;
    }
  }
  if (a.placeholders.length !== b.placeholders.length) return false;
  const aPlaceholders = new Set(a.placeholders.map((s) => s.toLowerCase()));
  for (const h of b.placeholders) {
    if (!aPlaceholders.has(h.toLowerCase())) return false;
  }
  return true;
}

// --- internals ---

function readFolders(root: Node, errors: string[]): SnapshotFolder[] {
  const node = findChild(root, 'folders');
  if (!node) return [];
  if (node.type !== 'array') {
    errors.push('folders is not an array');
    return [];
  }
  const out: SnapshotFolder[] = [];
  for (const item of node.children ?? []) {
    if (item.type !== 'object') {
      errors.push('folders entry is not an object');
      continue;
    }
    const uri = readString(item, 'uri');
    const name = readString(item, 'name');
    if (typeof uri !== 'string' || uri.length === 0) {
      errors.push('folders entry missing or empty uri');
      continue;
    }
    out.push({ uri, name: typeof name === 'string' ? name : uri });
  }
  return out;
}

function readPlaceholders(root: Node, errors: string[]): string[] {
  const node = findChild(root, 'placeholders');
  if (!node) return [];
  if (node.type !== 'array') {
    errors.push('placeholders is not an array');
    return [];
  }
  const out: string[] = [];
  for (const item of node.children ?? []) {
    if (item.type !== 'string') {
      errors.push('placeholders entry is not a string');
      continue;
    }
    const raw = item.value as string;
    if (raw.length === 0) continue;
    out.push(raw.toLowerCase());
  }
  return out;
}

function readSettings(root: Node, errors: string[]): SnapshotSettings {
  const node = findChild(root, 'settings');
  if (!node) return {};
  if (node.type !== 'object') {
    errors.push('settings is not an object');
    return {};
  }
  const out: SnapshotSettings = {};
  for (const prop of node.children ?? []) {
    // Object children come as { type: 'property', children: [keyNode, valueNode] }
    if (prop.type !== 'property') continue;
    const keyNode = prop.children?.[0];
    const valueNode = prop.children?.[1];
    if (!keyNode || keyNode.type !== 'string' || !valueNode) continue;
    const key = keyNode.value as string;
    out[key] = nodeToValue(valueNode);
  }
  return out;
}

function findChild(objectNode: Node, key: string): Node | undefined {
  if (objectNode.type !== 'object') return undefined;
  for (const prop of objectNode.children ?? []) {
    if (prop.type !== 'property') continue;
    const keyNode = prop.children?.[0];
    if (keyNode && keyNode.type === 'string' && keyNode.value === key) {
      return prop.children?.[1];
    }
  }
  return undefined;
}

function readString(objectNode: Node, key: string): string | undefined {
  const child = findChild(objectNode, key);
  if (!child || child.type !== 'string') return undefined;
  return child.value as string;
}

function nodeToValue(node: Node): unknown {
  switch (node.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return node.value;
    case 'array':
      return (node.children ?? []).map(nodeToValue);
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const prop of node.children ?? []) {
        if (prop.type !== 'property') continue;
        const k = prop.children?.[0];
        const v = prop.children?.[1];
        if (!k || k.type !== 'string' || !v) continue;
        obj[k.value as string] = nodeToValue(v);
      }
      return obj;
    }
    default:
      return undefined;
  }
}

function stableStringify(value: unknown): string {
  // JSON.stringify with sorted-keys replacer — adequate for the settings
  // values we capture (mostly arrays of glob strings, occasional booleans).
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

// `applyEdits` and `modify` are re-exported here so the wired layer can
// reuse them if it wants to edit `.admin-sync.jsonc` in place (preserving
// the header comment) rather than rewriting from scratch. v1 doesn't use
// this path, but keeping the surface available means the editor work in a
// later milestone can layer on top without dragging in a new dependency.
export { applyEdits, modify };

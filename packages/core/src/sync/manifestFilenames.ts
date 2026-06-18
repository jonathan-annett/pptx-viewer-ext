// Filenames the extension recognises as a destination-manifest file. Both
// share identical JSON content + semantics — `.syncManifest` is a forward-
// compatible alias for `.foldersync-manifest.json`. Mirrors the pattern in
// `configFilenames.ts` (`.sync.jsonc` ↔ `.roomSync`) and
// `snapshotFilenames.ts` (`.admin-sync.jsonc` ↔ `.eventSync`).
//
// `.syncManifest` is the preferred filename for newly-written manifests.
// Existing destinations carrying the legacy filename keep using it (writes
// land back on the same file, no silent migration) — but a fresh
// destination, or a destination the user has renamed to `.syncManifest`,
// gets the shorter name from this point forward.
//
// Centralised here so the watcher pattern, custom-editor selector, drift
// detector, and operator-mode probe paths share a single source of truth.

export const MANIFEST_FILENAMES = ['.foldersync-manifest.json', '.syncManifest'] as const;
export type ManifestFilename = (typeof MANIFEST_FILENAMES)[number];

/** Preferred filename for newly-written manifests. */
export const PREFERRED_MANIFEST_FILENAME: ManifestFilename = '.syncManifest';

/** Legacy filename that the preferred alias replaces. */
export const LEGACY_MANIFEST_FILENAME: ManifestFilename = '.foldersync-manifest.json';

/**
 * Discovery glob — matches every honoured manifest filename anywhere in the
 * tree. Used by the operator-mode watcher and source-config skip-list.
 */
export const MANIFEST_GLOB = '**/{.foldersync-manifest.json,.syncManifest}';

/**
 * Brace-expansion form of the manifest filenames, suitable for a
 * `RelativePattern` watcher pinned to a specific destination folder.
 */
export const MANIFEST_FILE_PATTERN = '{.foldersync-manifest.json,.syncManifest}';

/** True when the given filename (no path) is a recognised manifest name. */
export function isManifestFilename(name: string): name is ManifestFilename {
  return (MANIFEST_FILENAMES as readonly string[]).includes(name);
}

/**
 * Strip the path-prefix of a URI and return the bare filename. Works on
 * any object with a `.path: string` so it accepts `vscode.Uri` without
 * importing vscode here.
 */
export function manifestFilenameFromUri(uri: { path: string }): ManifestFilename | undefined {
  const path = uri.path;
  const idx = path.lastIndexOf('/');
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  return isManifestFilename(name) ? name : undefined;
}

/**
 * True iff `path` ends with `/<one-of-the-manifest-filenames>`. Used by
 * source-walk filters and watcher event handlers that previously matched
 * a single literal suffix.
 */
export function pathEndsWithManifestFilename(path: string): boolean {
  for (const f of MANIFEST_FILENAMES) {
    if (path.endsWith(`/${f}`)) return true;
  }
  return false;
}

/**
 * Strip the manifest-filename suffix from a path, returning the parent
 * folder's path. Returns the input unchanged when the path doesn't end
 * with a recognised manifest filename. Used to derive a destination root
 * from a manifest URI.
 */
export function stripManifestFilenameSuffix(path: string): string {
  for (const f of MANIFEST_FILENAMES) {
    const suffix = `/${f}`;
    if (path.endsWith(suffix)) return path.slice(0, -suffix.length) || '/';
  }
  return path;
}

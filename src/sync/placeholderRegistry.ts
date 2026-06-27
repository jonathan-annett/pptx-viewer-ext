// Placeholder registry — workspace-wide answer to "is this sha a placeholder?".
//
// The viewer (placeholder banner) and the search panel (per-URI placeholder
// indexing) need that answer without re-reading config on every call. This
// module owns the cached Set<string> and invalidates when the relevant setting
// changes.
//
// SLIM build: the user-configurable placeholder shas come from the
// `pptxViewer.placeholderHashes` setting (array of sha256 hex strings) plus the
// implicit zero-byte default. Previously they were sourced from the
// `.admin-sync.jsonc` snapshot/admin editor, which has moved to the PWA.

import * as vscode from 'vscode';

/**
 * Well-known sha256 of an empty byte sequence. Always treated as a placeholder
 * (Windows Explorer's "New PowerPoint Presentation" produces a zero-byte file
 * and operators rely on that workflow).
 */
export const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Config section + key for the user-managed placeholder sha list. */
const CONFIG_SECTION = 'pptxViewer';
const CONFIG_KEY = 'placeholderHashes';

let cached: Set<string> | undefined;
const changeEmitter = new vscode.EventEmitter<Set<string>>();

/**
 * Compute the effective placeholder set from the current setting value. Always
 * contains {@link EMPTY_FILE_SHA256}; user entries are lower-cased for
 * case-insensitive membership. Never throws.
 */
function computeSet(): Set<string> {
  const set = new Set<string>([EMPTY_FILE_SHA256]);
  try {
    const raw = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string[]>(CONFIG_KEY, []);
    if (Array.isArray(raw)) {
      for (const h of raw) {
        if (typeof h === 'string' && h.trim().length > 0) set.add(h.trim().toLowerCase());
      }
    }
  } catch {
    // Defensive — configuration read should never throw, but degrade to the
    // empty-default set rather than break a viewer render.
  }
  return set;
}

/**
 * The current active set. Reads the setting synchronously; the async signature
 * is kept for call-site compatibility with the previous disk-backed registry.
 */
export async function getActivePlaceholderSet(): Promise<Set<string>> {
  return getActivePlaceholderSetSync();
}

/** Sync read for renderers that must return HTML inline. */
export function getActivePlaceholderSetSync(): Set<string> {
  if (!cached) cached = computeSet();
  return cached;
}

/** Fires whenever the cache transitions to a new set. */
export const onDidChangePlaceholderSet: vscode.Event<Set<string>> = changeEmitter.event;

/** Test-only: reset the module state so a fresh test can start clean. */
export function _resetForTesting(): void {
  cached = undefined;
}

/**
 * Wire the registry up: seed the cache and re-read whenever the
 * `pptxViewer.placeholderHashes` setting changes. Returns a Disposable to push
 * onto `context.subscriptions`.
 */
export function activatePlaceholderRegistry(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  void context;
  cached = computeSet();

  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEY}`)) {
      cached = computeSet();
      changeEmitter.fire(cached);
    }
  });

  return {
    dispose(): void {
      configSub.dispose();
      changeEmitter.dispose();
    },
  };
}

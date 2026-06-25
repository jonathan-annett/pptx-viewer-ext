// Explorer file-decoration for placeholder stubs, backed by a dedicated
// crawler.
//
// On startup it sweeps every workspace folder (all roots — including sync
// destinations, unlike the search index which is sources-only) for deck files
// and marks the ones whose content sha is a placeholder (zero-byte stubs +
// any registered placeholder hash). Matches are badged in the Explorer with
// `propagate: true`, so the mark bubbles up through parent folders and an
// operator can spot — and drill into — a folder that still contains
// placeholders, the same way error/SCM decorations work.
//
// Why a crawler rather than piggy-backing on the search engine:
//   - Coverage: the search index excludes destination folders; placeholders
//     in a destination ("which slots haven't received their real deck yet?")
//     are exactly what an operator wants to see.
//   - Collapsed folders: VS Code only propagates a decoration to an ancestor
//     once it has been told about a descendant URI. Firing the change event
//     with the SPECIFIC placeholder URIs (not a blanket refresh) makes
//     collapsed folders shade immediately on startup.
//
// Cost is bounded: only `*.pptx` / `*.pdf` are walked (findFiles honours
// files.exclude / search.exclude), and hashing goes through the shared
// UriHashCache the sync + search subsystems already populate, so repeat scans
// are nearly free. The first cold sweep hashes each deck once in the
// background; activation never blocks on it.

import * as vscode from 'vscode';
import { vscodeFs } from '../sync/vscodeFs';
import { hashFileAtUri } from 'pptx-tools-core/sync/hash';
import { getHashCacheSingleton, type UriHashCache } from 'pptx-tools-core/sync/hashCache';
import {
  getActivePlaceholderSetSync,
  onDidChangePlaceholderSet,
} from '../sync/placeholderRegistry';
import { log } from 'pptx-tools-core/log';

const DECK_GLOB = '**/*.{pptx,pdf}';

const PLACEHOLDER_DECORATION: vscode.FileDecoration = {
  badge: 'P',
  tooltip: 'Placeholder — empty/stub deck (no content yet)',
  color: new vscode.ThemeColor('pptxSync.placeholderResourceForeground'),
  propagate: true,
};

/**
 * Register the placeholder Explorer crawler + decoration provider. Returns a
 * Disposable that tears down the provider, watcher, and subscriptions; push
 * it onto `context.subscriptions`.
 */
export function registerPlaceholderDecorations(): vscode.Disposable {
  const fs = vscodeFs();
  const changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  // uri string → Uri. String keys for membership; Uri values for firing the
  // change event (which needs Uri objects).
  const placeholders = new Map<string, vscode.Uri>();
  let disposed = false;

  const provider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: changeEmitter.event,
    provideFileDecoration(uri) {
      return placeholders.has(uri.toString()) ? PLACEHOLDER_DECORATION : undefined;
    },
  };
  const registration = vscode.window.registerFileDecorationProvider(provider);

  function cache(): UriHashCache<vscode.Uri> | undefined {
    return getHashCacheSingleton() as UriHashCache<vscode.Uri> | undefined;
  }

  /** Is this file currently a placeholder? Cheap on a warm hash cache; a
   *  read/stat failure (file vanished) resolves to false. */
  async function isPlaceholder(uri: vscode.Uri): Promise<boolean> {
    try {
      const { sha256 } = await hashFileAtUri(fs, uri, cache(), { needBytes: false });
      return getActivePlaceholderSetSync().has(sha256);
    } catch {
      return false;
    }
  }

  /** Re-evaluate one file and update the set; fire if its state changed. */
  async function refreshOne(uri: vscode.Uri): Promise<void> {
    if (disposed) return;
    const key = uri.toString();
    const was = placeholders.has(key);
    const now = await isPlaceholder(uri);
    if (now === was) return;
    if (now) placeholders.set(key, uri);
    else placeholders.delete(key);
    changeEmitter.fire(uri);
  }

  function drop(uri: vscode.Uri): void {
    if (placeholders.delete(uri.toString())) changeEmitter.fire(uri);
  }

  /** Full sweep of every workspace folder. Rebuilds the set and fires the
   *  union of old+new URIs so both freshly-marked files AND folders that just
   *  lost their last placeholder re-propagate (even while collapsed). */
  async function scanAll(): Promise<void> {
    if (disposed) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const prev = new Map(placeholders);
    const next = new Map<string, vscode.Uri>();
    for (const folder of folders) {
      let found: vscode.Uri[] = [];
      try {
        found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, DECK_GLOB));
      } catch (err) {
        log(`placeholder-scan: findFiles failed for ${folder.name} — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const uri of found) {
        if (disposed) return;
        if (await isPlaceholder(uri)) next.set(uri.toString(), uri);
      }
    }
    placeholders.clear();
    for (const [k, v] of next) placeholders.set(k, v);
    // Fire the union so VS Code re-queries every URI that gained OR lost the
    // mark and updates ancestor-folder propagation accordingly.
    const union = new Map(prev);
    for (const [k, v] of next) union.set(k, v);
    if (union.size > 0) changeEmitter.fire([...union.values()]);
    log(`placeholder-scan: ${placeholders.size} placeholder file(s) across ${folders.length} folder(s)`);
  }

  // ── Live updates ──────────────────────────────────────────────────────
  const watcher = vscode.workspace.createFileSystemWatcher(DECK_GLOB);
  const onCreate = watcher.onDidCreate((uri) => void refreshOne(uri));
  const onChange = watcher.onDidChange((uri) => void refreshOne(uri));
  const onDelete = watcher.onDidDelete((uri) => drop(uri));
  // Registered-placeholder set changed (admin snapshot edit) → re-evaluate all.
  const registrySub = onDidChangePlaceholderSet(() => void scanAll());
  // Folder added/removed → re-sweep.
  const foldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => void scanAll());

  // Kick the initial sweep in the background; activation doesn't block on it.
  void scanAll();

  return new vscode.Disposable(() => {
    disposed = true;
    registration.dispose();
    onCreate.dispose();
    onChange.dispose();
    onDelete.dispose();
    watcher.dispose();
    registrySub.dispose();
    foldersSub.dispose();
    changeEmitter.dispose();
  });
}

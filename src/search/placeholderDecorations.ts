// Explorer file-decoration for placeholder stubs.
//
// Marks placeholder files (zero-byte stubs + any registered placeholder
// hashes) with a badge + colour in the VS Code Explorer. `propagate: true`
// bubbles the mark up through parent folders, so an operator can spot that a
// folder *contains* placeholders and drill in to find them — the same
// affordance error/SCM decorations use.
//
// Source of truth is the search engine's uri→sha map (already maintained for
// the search index) intersected with the active placeholder set. That keeps
// this cheap (a map lookup per Explorer row, no hashing) and reuses work the
// indexer already did. Caveat: only files the indexer tracks (pptx/pdf in
// source — non-destination — folders) can be decorated; placeholders that
// exist only in a sync *destination* aren't in the index, so they're not
// marked. That matches where operators actually wire placeholders (the
// source event tree).

import * as vscode from 'vscode';
import type { SearchEngine } from './searchEngine';
import type { SearchIndexerHandle } from './indexer';
import {
  getActivePlaceholderSetSync,
  onDidChangePlaceholderSet,
} from '../sync/placeholderRegistry';

const PLACEHOLDER_DECORATION: vscode.FileDecoration = {
  badge: 'P',
  tooltip: 'Placeholder — empty/stub deck (no content yet)',
  color: new vscode.ThemeColor('pptxSync.placeholderResourceForeground'),
  propagate: true,
};

/**
 * Register the placeholder Explorer decoration. Returns a Disposable that
 * tears down the provider registration and its refresh subscriptions; push
 * it onto `context.subscriptions`.
 */
export function registerPlaceholderDecorations(
  engine: SearchEngine,
  indexer: SearchIndexerHandle,
): vscode.Disposable {
  const changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

  const provider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: changeEmitter.event,
    provideFileDecoration(uri) {
      const sha = engine.getShaForUri(uri.toString());
      if (!sha) return undefined; // not an indexed file
      return getActivePlaceholderSetSync().has(sha) ? PLACEHOLDER_DECORATION : undefined;
    },
  };

  const registration = vscode.window.registerFileDecorationProvider(provider);

  // Refresh all decorations when the index finishes a pass (badges appear
  // once shas are known) or when the placeholder set changes (admin edits).
  const progressSub = indexer.onProgress((p) => {
    if (p.phase === 'idle') changeEmitter.fire(undefined);
  });
  const placeholderSub = onDidChangePlaceholderSet(() => changeEmitter.fire(undefined));

  return vscode.Disposable.from(registration, progressSub, placeholderSub, changeEmitter);
}

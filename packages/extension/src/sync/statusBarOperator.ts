// Pure helpers for the operator-mode status bar surface.
//
// Sibling to `statusBar.ts` (which holds the vscode-API-wired
// `StatusBarItem` lifecycle). Factored out so the text-formatting +
// click-target picking can be exercised under plain Node — `statusBar.ts`
// imports vscode and isn't tsx-testable.
//
// "Operator mode" here is the destination-only workspace state detected
// by M1. The status bar's job in that mode: tell the operator (a)
// this workspace is a sync destination, (b) when the last sync landed,
// and (c) one click opens the manifest inspector.

import type { Command, Uri } from 'vscode';

const MANIFEST_VIEW_TYPE = 'folderSync.manifestEditor';

/**
 * Minimal snapshot of the canonical destination manifest used to drive
 * the status bar text + click target. `manifestUri` is what gets handed
 * to `vscode.openWith`. `lastSync` is the manifest's top-level field
 * (null when the file exists but no sync has ever recorded a timestamp).
 *
 * The wired layer (`destinationOnlyWired.ts`) populates this from a
 * fresh `readManifest` call each time the destination-only state
 * recomputes.
 */
export interface ManifestSummary {
  manifestUri: Uri;
  folderUri: Uri;
  lastSync: string | null;
}

export interface OperatorStatusText {
  text: string;
  tooltip: string;
}

/**
 * Status bar text + tooltip for operator mode.
 *
 * Three branches:
 *   1. No `canonicalManifest` — workspace is destination-only but the
 *      canonical folder (workspaceFolders[0]) doesn't have a manifest
 *      yet (or hit a version-mismatch / read error). Copy: "no manifest
 *      yet".
 *   2. Manifest present, `lastSync === null` — manifest file exists
 *      (e.g. created by hand or by a sync that failed before stamping
 *      lastSync) but no successful sync recorded yet. Copy: "never".
 *   3. Manifest present with a timestamp — relative-time formatted from
 *      `lastSync`.
 *
 * `now` is injected so tests can pin the relative-time output.
 */
export function formatOperatorText(
  canonicalManifest?: ManifestSummary,
  now: Date = new Date(),
): OperatorStatusText {
  if (!canonicalManifest) {
    return {
      text: '$(eye) Destination — no manifest yet',
      tooltip:
        'This workspace mirrors a sync destination. No manifest has been written yet — the main user hasn’t run a sync here. The status will update automatically when one arrives.',
    };
  }
  const rel = canonicalManifest.lastSync
    ? formatRelativeTime(canonicalManifest.lastSync, now)
    : 'never';
  const exact = canonicalManifest.lastSync ?? 'never';
  return {
    text: `$(eye) Destination only — last sync ${rel}`,
    tooltip:
      `This workspace mirrors a sync destination (read-only).\n` +
      `Last sync: ${exact}.\n` +
      `Click to open the manifest inspector.`,
  };
}

/**
 * Click target for the status bar in operator mode.
 *
 * With a canonical manifest: `vscode.openWith` against the manifest URI
 * + the M6.E custom editor view type. Wrapping in a `Command` (rather
 * than a bare command id) lets us pass the URI + view-type arguments
 * inline without a wrapper command registered in package.json.
 *
 * Without a canonical manifest (no-manifest-yet edge case): returns
 * undefined — the status bar item becomes non-actionable. M5 may swap
 * this for a fallback that opens an explanatory message; for v1 the
 * tooltip already explains the state.
 */
export function pickOperatorClickTarget(
  canonicalManifest?: ManifestSummary,
): Command | undefined {
  if (!canonicalManifest) return undefined;
  return {
    title: 'Open Folder Sync Manifest',
    command: 'vscode.openWith',
    arguments: [canonicalManifest.manifestUri, MANIFEST_VIEW_TYPE],
  };
}

/**
 * Coarse-grained relative-time formatter sized for a status bar slot.
 * Rounds DOWN to the nearest whole unit so a sync that landed 119
 * seconds ago reads "1 minute ago", not "2 minutes ago" — matches how
 * most VS Code surfaces (timeline, source-control) round.
 *
 * Negative deltas (clock skew, manifest written by a peer with a faster
 * clock) collapse to "just now" so the operator never sees a confusing
 * future timestamp. Older than ~30 days flips to a YYYY-MM-DD slice —
 * "47 days ago" is less scannable than the date itself at that range.
 */
export function formatRelativeTime(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const deltaMs = now.getTime() - then;
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  // Old enough that a date is more useful than a day count.
  return iso.slice(0, 10);
}

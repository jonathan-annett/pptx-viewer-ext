// State-comparison engine. Pure function from (source file list,
// destination file list, manifest) → a list of classified operations.
//
// No VS Code dependency — the walker + hash modules are the I/O boundary;
// this module just classifies, which keeps it testable under plain Node.
//
// Six categories, matching folder-sync-v1-plan.md:
//
//   create               source has it; destination doesn't
//   update-tracked       both have it; manifest knows the dest hash; source differs
//   update-collision     both have it; manifest doesn't agree with current dest
//   skip                 both have it; hashes match
//   delete-tracked       manifest has it; source removed it
//   destination-only     destination has it; no source file, no manifest entry

import type { Manifest } from './manifest-types';
import { manifestKey } from './manifest-types';

export type OpKind =
  | 'create'
  | 'update-tracked'
  | 'update-collision'
  | 'skip'
  | 'delete-tracked'
  | 'destination-only';

export interface FileInfo {
  relPath: string;
  size: number;
  sha256: string;
  /**
   * Validator output attached during the source walk. Destination-side
   * FileInfos always omit this — we only run validators against the bytes
   * we're about to push.
   */
  warnings?: PlanWarning[];
  /**
   * Alias-rewrite provenance (M2 of room-sync-format-v1-plan.md). Set on
   * source-side FileInfos when the source config's `path-aliases` rewrote
   * the relpath. Absent on destination-side FileInfos and on source-side
   * FileInfos from configs without aliases. The renderer surfaces this as a
   * tooltip on each row so the user can trace where the file actually lives
   * in the source tree.
   */
  aliasOrigin?: AliasOrigin;
}

export interface AliasOrigin {
  /** Source-relative path BEFORE the alias rewrite (the on-disk location). */
  sourceRelPath: string;
  /** LHS of the alias that matched (the source-relative directory). */
  from: string;
  /** RHS of the alias (the destination-relative directory). */
  to: string;
}

/**
 * A single per-file warning produced by a validator (e.g. the pptx kiosk-mode
 * check). Attached to the source-side PlanItem so the plan view can list
 * "files needing attention" without re-deriving them from raw FileInfos.
 *
 * The codes are an enumerated set, not a free-form string, so callers can
 * style or filter on them. New validators add codes here as they land.
 *
 * Severity tiers:
 *  - 'block'    — a file in this state would be broken at the destination
 *                 (kiosk show mode, externally-linked media). No per-file
 *                 override; the user must fix the source and re-plan.
 *  - 'override' — a quality concern that doesn't break the file, but the
 *                 user should acknowledge before shipping (e.g. media
 *                 controls visible over an embedded video at a conference,
 *                 or content also present at a different rel-path).
 *                 Surfaced in the plan webview with a "Sync anyway" checkbox
 *                 + "Don't ask again"; armed rows flow through the executor.
 *
 * Codes:
 *  - 'linked-media'      — pptx slide references externally-linked media.
 *  - 'show-type'         — pptx is set to kiosk/browse mode.
 *  - 'media-controls'    — pptx will render media-controls bar over an
 *                          embedded video at playback.
 *  - 'misfiled-content'  — same bytes have been observed at one or more
 *                          other rel-paths (M5.3 Phase D). Generic — not
 *                          pptx-specific — but only recorded for
 *                          content-addressed filetypes that benefit from
 *                          identity tracking (.pptx today).
 */
export interface PlanWarning {
  severity: 'block' | 'override';
  code: 'linked-media' | 'show-type' | 'media-controls' | 'misfiled-content';
  message: string;
}

export interface PlanItem {
  kind: OpKind;
  relPath: string;
  sourceSize?: number;
  destSize?: number;
  /** Hash of the file as it sits in the source. */
  sourceHash?: string;
  /** Hash of the file as it sits in the destination. */
  destHash?: string;
  /** Hash the manifest claims the destination has (if it has an entry). */
  manifestHash?: string;
  /**
   * Per-file validator warnings, copied from the source FileInfo at
   * classification time. Only ever populated on source-side items
   * (create / update-tracked / update-collision / skip).
   */
  warnings?: PlanWarning[];
  /**
   * Set when the manifest already records a "don't ask again" decision for
   * this file. Only attached to `update-collision` and `destination-only`
   * items — the two categories that show the interactive decision affordance.
   * The plan webview renders the checkbox pre-checked when this is present
   * with `accepted: true`, and `runSync` consults the same field to dispatch
   * remembered rows into the executor without requiring a fresh user toggle.
   */
  remembered?: { accepted: boolean };
  /**
   * True when the file's identity-hash matches a sha in the workspace
   * placeholder set (the empty-file default + user-added entries from
   * `.admin-sync.jsonc`). Plan view shows a [P] chip on these rows; the file
   * still flows through sync like any other artifact.
   *
   * The identity hash used per category:
   *   create, update-*, skip → sourceHash
   *   destination-only       → destHash
   *   delete-tracked         → manifestHash
   * Items with no recorded hash (shouldn't happen in practice) are never
   * flagged.
   */
  isPlaceholder?: boolean;
  /**
   * Alias-rewrite provenance copied from the source FileInfo at classification
   * time. Only ever attached to source-side items (create / update-* / skip).
   * The plan view renders this as a tooltip so the user can trace where the
   * file actually lives in the source tree under a `path-aliases` rewrite.
   */
  aliasOrigin?: AliasOrigin;
}

/**
 * Classify each file into one of six operation categories.
 *
 * `sourceWorkspaceFolderName` is the identifier embedded in manifest keys —
 * different sources writing to the same destination keep their entries
 * separate so cross-source removals don't accidentally match.
 */
export function classifyFiles(
  sourceWorkspaceFolderName: string,
  sourceFiles: readonly FileInfo[],
  destFiles: readonly FileInfo[],
  manifest: Manifest,
  placeholders: Set<string> = new Set<string>(),
): PlanItem[] {
  const items: PlanItem[] = [];
  const sourceMap = new Map(sourceFiles.map((f) => [f.relPath, f]));
  const destMap = new Map(destFiles.map((f) => [f.relPath, f]));

  // 1. Walk the source side. Every source file maps to one of:
  //    create / skip / update-tracked / update-collision.
  //    Warnings from the source FileInfo ride along onto each item — the
  //    plan view's Validation warnings section is a derived view of items
  //    with a non-empty `warnings` list.
  //
  //    Remembered decisions for the row's kind ride along too:
  //    - create / update-tracked with override-only warnings → consult
  //      manifest.decisions[key].warningOverride.
  //    - update-collision → consult manifest.decisions[key].collisionOverwrite.
  //      (Block-severity warnings on a collision skip the lookup — there's
  //      no decision that unblocks them.)
  //    - destination-only → consult manifest.decisions[key].destOnlyDelete.
  for (const sourceFile of sourceFiles) {
    const carry = carryWarnings(sourceFile);
    const origin = carryAliasOrigin(sourceFile);
    const destFile = destMap.get(sourceFile.relPath);
    const key = manifestKey(sourceWorkspaceFolderName, sourceFile.relPath);
    const warningCarry = rememberedForWarning(sourceFile, manifest, key);
    if (!destFile) {
      items.push({
        kind: 'create',
        relPath: sourceFile.relPath,
        sourceSize: sourceFile.size,
        sourceHash: sourceFile.sha256,
        ...carry,
        ...warningCarry,
        ...origin,
      });
      continue;
    }

    if (sourceFile.sha256 === destFile.sha256) {
      items.push({
        kind: 'skip',
        relPath: sourceFile.relPath,
        sourceSize: sourceFile.size,
        destSize: destFile.size,
        sourceHash: sourceFile.sha256,
        destHash: destFile.sha256,
        ...carry,
        ...origin,
      });
      continue;
    }

    const entry = manifest.entries[key];
    if (entry && entry.sha256 === destFile.sha256) {
      // Manifest agrees with current destination state → safe overwrite.
      items.push({
        kind: 'update-tracked',
        relPath: sourceFile.relPath,
        sourceSize: sourceFile.size,
        destSize: destFile.size,
        sourceHash: sourceFile.sha256,
        destHash: destFile.sha256,
        manifestHash: entry.sha256,
        ...carry,
        ...warningCarry,
        ...origin,
      });
    } else {
      // Manifest absent, or it disagrees — could be user-edited destination.
      const remembered = manifest.decisions[key]?.collisionOverwrite
        ? { remembered: { accepted: true as const } }
        : {};
      items.push({
        kind: 'update-collision',
        relPath: sourceFile.relPath,
        sourceSize: sourceFile.size,
        destSize: destFile.size,
        sourceHash: sourceFile.sha256,
        destHash: destFile.sha256,
        ...(entry ? { manifestHash: entry.sha256 } : {}),
        ...carry,
        ...remembered,
        ...origin,
      });
    }
  }

  // 2. Walk the manifest for tracked deletions — files we previously placed
  //    whose source has since removed them. Filter to entries owned by this
  //    source so we don't classify another source's files.
  const prefix = `${sourceWorkspaceFolderName}:`;
  const trackedRelPaths = new Set<string>();
  for (const key of Object.keys(manifest.entries)) {
    if (!key.startsWith(prefix)) continue;
    const relPath = key.slice(prefix.length);
    trackedRelPaths.add(relPath);
    if (sourceMap.has(relPath)) continue;
    const destFile = destMap.get(relPath);
    items.push({
      kind: 'delete-tracked',
      relPath,
      ...(destFile ? { destSize: destFile.size, destHash: destFile.sha256 } : {}),
      manifestHash: manifest.entries[key].sha256,
    });
  }

  // 3. Walk the destination — anything not covered by source iteration or
  //    by a tracked deletion is a destination-only file.
  for (const destFile of destFiles) {
    if (sourceMap.has(destFile.relPath)) continue;
    if (trackedRelPaths.has(destFile.relPath)) continue;
    const key = manifestKey(sourceWorkspaceFolderName, destFile.relPath);
    const remembered = manifest.decisions[key]?.destOnlyDelete
      ? { remembered: { accepted: true as const } }
      : {};
    items.push({
      kind: 'destination-only',
      relPath: destFile.relPath,
      destSize: destFile.size,
      destHash: destFile.sha256,
      ...remembered,
    });
  }

  // 4. Annotate placeholder status by the identity hash for each item's
  //    category. The ?? chain produces the right precedence naturally —
  //    `sourceHash` for create/update/skip, `destHash` for destination-only,
  //    `manifestHash` for delete-tracked. Skipping the work when the set is
  //    empty keeps the no-placeholder case (most plans) free of overhead.
  if (placeholders.size > 0) {
    for (const item of items) {
      const identityHash = item.sourceHash ?? item.destHash ?? item.manifestHash;
      if (identityHash && placeholders.has(identityHash)) {
        item.isPlaceholder = true;
      }
    }
  }

  return items;
}

/** Partition a flat plan into categories with stable ordering. */
export interface PlanSummary {
  create: PlanItem[];
  updateTracked: PlanItem[];
  updateCollision: PlanItem[];
  skip: PlanItem[];
  deleteTracked: PlanItem[];
  destinationOnly: PlanItem[];
  /**
   * Derived view: every item with at least one validator warning. Items also
   * remain in their primary category — this list is for rendering the
   * dedicated Validation warnings section in the plan webview.
   */
  warnings: PlanItem[];
}

export function summarisePlan(items: PlanItem[]): PlanSummary {
  const out: PlanSummary = {
    create: [],
    updateTracked: [],
    updateCollision: [],
    skip: [],
    deleteTracked: [],
    destinationOnly: [],
    warnings: [],
  };
  for (const item of items) {
    switch (item.kind) {
      case 'create': out.create.push(item); break;
      case 'update-tracked': out.updateTracked.push(item); break;
      case 'update-collision': out.updateCollision.push(item); break;
      case 'skip': out.skip.push(item); break;
      case 'delete-tracked': out.deleteTracked.push(item); break;
      case 'destination-only': out.destinationOnly.push(item); break;
    }
    if (item.warnings && item.warnings.length > 0) {
      out.warnings.push(item);
    }
  }
  // Stable, predictable ordering for the human reading the Output Channel.
  const byPath = (a: PlanItem, b: PlanItem): number => a.relPath.localeCompare(b.relPath);
  out.create.sort(byPath);
  out.updateTracked.sort(byPath);
  out.updateCollision.sort(byPath);
  out.skip.sort(byPath);
  out.deleteTracked.sort(byPath);
  out.destinationOnly.sort(byPath);
  out.warnings.sort(byPath);
  return out;
}

function carryWarnings(src: FileInfo): { warnings?: PlanWarning[] } {
  return src.warnings && src.warnings.length > 0
    ? { warnings: src.warnings }
    : {};
}

function carryAliasOrigin(src: FileInfo): { aliasOrigin?: AliasOrigin } {
  return src.aliasOrigin ? { aliasOrigin: src.aliasOrigin } : {};
}

/**
 * Look up a remembered "Sync anyway" decision for a source file's
 * override-severity warnings. Returns the shape the spread operator can
 * splat into a PlanItem.
 *
 * Three early-outs:
 *  - file has no warnings → nothing to remember
 *  - any warning is 'block' severity → no decision can unblock; ignore any
 *    stale warningOverride in the manifest
 *  - manifest has no warningOverride for this key → no carry
 *
 * Only consulted from green-path rows (create / update-tracked). Collisions
 * route through `collisionOverwrite` instead — overwrite arming on a
 * collision row implicitly covers its override warnings.
 */
function rememberedForWarning(
  src: FileInfo,
  manifest: Manifest,
  key: string,
): { remembered?: { accepted: true } } {
  const ws = src.warnings;
  if (!ws || ws.length === 0) return {};
  if (ws.some((w) => w.severity === 'block')) return {};
  return manifest.decisions[key]?.warningOverride
    ? { remembered: { accepted: true as const } }
    : {};
}

// ───── severity helpers ───────────────────────────────────────────────────
//
// Centralised so the executor, planHtml renderer, and runSync all classify
// warning-bearing items identically. A row is "blocked by warnings" if any
// warning is 'block' severity. A row is "override-only" if it has warnings
// and none are 'block' — the orange path can ship it with explicit arming.

/** True iff the item carries at least one 'block'-severity warning. */
export function hasBlockingWarning(item: PlanItem): boolean {
  return !!item.warnings?.some((w) => w.severity === 'block');
}

/**
 * True iff the item has warnings, all of which are 'override' severity. A
 * row with zero warnings returns false (no override is required because no
 * warning is present).
 */
export function hasOverridableWarningOnly(item: PlanItem): boolean {
  if (!item.warnings || item.warnings.length === 0) return false;
  return item.warnings.every((w) => w.severity === 'override');
}

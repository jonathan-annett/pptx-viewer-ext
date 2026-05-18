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
): PlanItem[] {
  const items: PlanItem[] = [];
  const sourceMap = new Map(sourceFiles.map((f) => [f.relPath, f]));
  const destMap = new Map(destFiles.map((f) => [f.relPath, f]));

  // 1. Walk the source side. Every source file maps to one of:
  //    create / skip / update-tracked / update-collision.
  for (const sourceFile of sourceFiles) {
    const destFile = destMap.get(sourceFile.relPath);
    if (!destFile) {
      items.push({
        kind: 'create',
        relPath: sourceFile.relPath,
        sourceSize: sourceFile.size,
        sourceHash: sourceFile.sha256,
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
      });
      continue;
    }

    const key = manifestKey(sourceWorkspaceFolderName, sourceFile.relPath);
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
      });
    } else {
      // Manifest absent, or it disagrees — could be user-edited destination.
      items.push({
        kind: 'update-collision',
        relPath: sourceFile.relPath,
        sourceSize: sourceFile.size,
        destSize: destFile.size,
        sourceHash: sourceFile.sha256,
        destHash: destFile.sha256,
        ...(entry ? { manifestHash: entry.sha256 } : {}),
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
    items.push({
      kind: 'destination-only',
      relPath: destFile.relPath,
      destSize: destFile.size,
      destHash: destFile.sha256,
    });
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
}

export function summarisePlan(items: PlanItem[]): PlanSummary {
  const out: PlanSummary = {
    create: [],
    updateTracked: [],
    updateCollision: [],
    skip: [],
    deleteTracked: [],
    destinationOnly: [],
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
  }
  // Stable, predictable ordering for the human reading the Output Channel.
  const byPath = (a: PlanItem, b: PlanItem): number => a.relPath.localeCompare(b.relPath);
  out.create.sort(byPath);
  out.updateTracked.sort(byPath);
  out.updateCollision.sort(byPath);
  out.skip.sort(byPath);
  out.deleteTracked.sort(byPath);
  out.destinationOnly.sort(byPath);
  return out;
}

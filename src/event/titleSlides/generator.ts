// Wired orchestrator for "Generate title slides".
//
// Called from the event editor's `generateTitleSlides` message handler.
// Walks the pure plan from `generatorPlan.ts`, runs per-deck stale-check
// against any existing output file, and writes one .pptx per (room, day)
// via `vscode.workspace.fs`. Stale-check uses the deterministic
// fingerprint embedded by `pptxBuild` (M3.8) so re-runs only touch decks
// whose underlying data actually changed.
//
// No tests here — this module's job is plumbing. The pure pieces it
// composes (planner, hash compute, version bump, deck builder, thumbnail
// time formatter) all have their own coverage.

import * as vscode from 'vscode';
import { log } from '../../log';
import type { EventSchedule, TitleSlidesBinding } from '../schedule';
import { displayTitleForSession } from '../scheduleData';
import type { Layout } from '../eventFolders';
import { planTitleSlideDecks, type DeckPlanEntry } from './generatorPlan';
import { titleSlideCapacity } from './binding';
import { inspectTemplate, type TemplateInspectResult } from './templateInspect';
import {
  buildTitleDeck,
  computeDeckHashes,
  nextDeckVersion,
  readDeckFingerprint,
} from './pptxBuild';
import { renderVersionThumbnail } from './thumbnail';
import { sha256Hex } from '../../sync/hash';

export async function generateTitleSlides(opts: {
  document: vscode.TextDocument;
  schedule: EventSchedule;
  binding: TitleSlidesBinding;
}): Promise<void> {
  const { document, schedule, binding } = opts;

  if (titleSlideCapacity(binding) === 0) {
    void vscode.window.showWarningMessage(
      'Title slides: binding has no Speaker slots — bind at least one frame to Speaker 1 first.',
    );
    return;
  }
  if (schedule.sessions.length === 0) {
    void vscode.window.showWarningMessage(
      'Title slides: this schedule has no sessions — nothing to generate.',
    );
    return;
  }

  const layout = await pickLayout();
  if (!layout) {
    log('title-slides: cancelled at layout pick');
    return;
  }

  const destUri = await pickDestination(document, schedule.config.name);
  if (!destUri) {
    log('title-slides: cancelled at destination pick');
    return;
  }

  const templateUri = resolveRelativeUri(document.uri, binding.templatePath);
  let templateBytes: Uint8Array;
  try {
    templateBytes = await vscode.workspace.fs.readFile(templateUri);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`title-slides: template read failed (${binding.templatePath}) — ${msg}`);
    void vscode.window.showErrorMessage(
      `Title slides: couldn't read template at ${binding.templatePath} — ${msg}. Re-bind?`,
    );
    return;
  }

  let inspection: TemplateInspectResult;
  try {
    inspection = inspectTemplate(templateBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`title-slides: inspectTemplate failed — ${msg}`);
    void vscode.window.showErrorMessage(
      `Title slides: template parse failed — ${msg}. Re-bind a valid template?`,
    );
    return;
  }

  const plan = planTitleSlideDecks({
    schedule,
    binding,
    layout,
    resolveSessionTitle: displayTitleForSession,
  });
  if (plan.decks.length === 0) {
    void vscode.window.showWarningMessage(
      'Title slides: planner produced no decks (no sessions match any rooms).',
    );
    return;
  }

  // Hash the template once across all (room, day) decks.
  const templateHash = await sha256Hex(templateBytes);
  const generatedAt = new Date().toISOString();

  let written = 0;
  let skipped = 0;
  let firstWrittenUri: vscode.Uri | undefined;
  const errors: Array<{ key: string; message: string }> = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Generating title slides (${plan.decks.length} deck${plan.decks.length === 1 ? '' : 's'})`,
      cancellable: false,
    },
    async (progress) => {
      const total = plan.decks.length;
      for (let i = 0; i < total; i++) {
        const entry = plan.decks[i];
        progress.report({
          message: `${entry.displayKey} (${i + 1}/${total})`,
          increment: 100 / total,
        });
        try {
          const result = await generateOneDeck({
            entry, destUri, templateBytes, templateHash,
            inspection, binding, generatedAt,
          });
          if (result.status === 'skipped') {
            skipped++;
          } else {
            written++;
            if (!firstWrittenUri) firstWrittenUri = result.uri;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`title-slides: ${entry.displayKey} failed — ${msg}`);
          errors.push({ key: entry.displayKey, message: msg });
        }
      }
    },
  );

  const summary =
    `Title slides: ${written} written, ${skipped} unchanged` +
    (errors.length > 0 ? `, ${errors.length} failed` : '') + '.';
  log(`title-slides: done — ${summary}`);

  if (errors.length > 0) {
    const detail = errors.map((e) => `  • ${e.key}: ${e.message}`).join('\n');
    void vscode.window.showWarningMessage(summary, { modal: false, detail });
    return;
  }

  if (written === 0 && skipped > 0) {
    void vscode.window.showInformationMessage(
      `${summary} Nothing changed since the last run.`,
    );
    return;
  }

  // Success: offer "Open output folder" / "Reveal first deck" when we have one.
  const actions: string[] = [];
  if (firstWrittenUri) actions.push('Reveal in Explorer');
  const choice = await vscode.window.showInformationMessage(summary, ...actions);
  if (choice === 'Reveal in Explorer' && firstWrittenUri) {
    try {
      await vscode.commands.executeCommand('revealFileInOS', firstWrittenUri);
    } catch {
      // revealFileInOS isn't supported in vscode.dev — fall back to revealInExplorerView
      try {
        await vscode.commands.executeCommand('revealInExplorer', firstWrittenUri);
      } catch {
        // last resort: just open the file
        await vscode.commands.executeCommand('vscode.open', firstWrittenUri);
      }
    }
  }
}

// ───── Per-deck build + write ────────────────────────────────────────────

async function generateOneDeck(opts: {
  entry: DeckPlanEntry;
  destUri: vscode.Uri;
  templateBytes: Uint8Array;
  templateHash: string;
  inspection: TemplateInspectResult;
  binding: TitleSlidesBinding;
  generatedAt: string;
}): Promise<{ status: 'written'; uri: vscode.Uri } | { status: 'skipped' }> {
  const { entry, destUri, templateBytes, templateHash, inspection, binding, generatedAt } = opts;
  const outputUri = vscode.Uri.joinPath(destUri, ...entry.outputPath.split('/'));

  // Stale-check against existing file (if any).
  let prevFingerprint = null;
  try {
    const existing = await vscode.workspace.fs.readFile(outputUri);
    prevFingerprint = readDeckFingerprint(existing);
  } catch {
    // ENOENT or similar → first generation; prevFingerprint stays null.
  }

  const buildInput = {
    templateBytes,
    inspection,
    binding,
    sessions: entry.sessions,
    day: entry.day,
    roomName: entry.roomName,
    precomputedTemplateHash: templateHash,
  };
  const hashes = await computeDeckHashes(buildInput);
  const { version, changed } = nextDeckVersion(prevFingerprint, hashes);
  if (!changed) {
    log(`title-slides: skip ${entry.displayKey} (already at v${version}, hashes match)`);
    return { status: 'skipped' };
  }

  // Render thumbnail. Failure is non-fatal — proceed without it.
  let thumbnailBytes: Uint8Array | undefined;
  try {
    thumbnailBytes = await renderVersionThumbnail({
      version,
      generatedAt,
      day: entry.day,
      roomName: entry.roomName,
    });
  } catch (err) {
    log(`title-slides: thumbnail render failed for ${entry.displayKey} — ${err instanceof Error ? err.message : String(err)}; proceeding without`);
  }

  const out = await buildTitleDeck({
    ...buildInput,
    deckVersion: version,
    generatedAt,
    thumbnailBytes,
  });

  // Ensure parent directory exists. createDirectory is recursive in the
  // FSA adapter so a fresh event tree builds in one call per leaf.
  const parentUri = vscode.Uri.joinPath(outputUri, '..');
  try {
    await vscode.workspace.fs.createDirectory(parentUri);
  } catch (err) {
    // Directory may already exist; some adapters surface that as an error.
    // Re-throw only if the subsequent write fails.
    log(`title-slides: createDirectory(${parentUri.toString()}) returned ${err instanceof Error ? err.message : String(err)}`);
  }

  await vscode.workspace.fs.writeFile(outputUri, out.bytes);
  log(`title-slides: wrote ${entry.displayKey} v${version} (${out.bytes.length} bytes) → ${outputUri.toString()}`);
  return { status: 'written', uri: outputUri };
}

// ───── UI pickers ────────────────────────────────────────────────────────

type LayoutItem = vscode.QuickPickItem & { value: Layout };

async function pickLayout(): Promise<Layout | undefined> {
  const choice = await vscode.window.showQuickPick<LayoutItem>(
    [
      {
        label: 'Room-major',
        description: '<event>/<room>/<day>/',
        detail: 'Title deck per (room, day) lands in the room\'s day folder.',
        value: 'room-major',
      },
      {
        label: 'Day-major',
        description: '<event>/<day>/<room>/',
        detail: 'Title deck per (room, day) lands in the day\'s room folder.',
        value: 'day-major',
      },
    ],
    {
      placeHolder: 'Choose folder layout (match your Generate folders choice)',
      title: 'Generate title slides',
    },
  );
  return choice?.value;
}

async function pickDestination(
  document: vscode.TextDocument,
  eventName: string,
): Promise<vscode.Uri | undefined> {
  const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const defaultUri = wsFolder?.uri ?? vscode.Uri.joinPath(document.uri, '..');
  const picks = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri,
    openLabel: 'Generate title slides here',
    title: `Generate "${eventName}" title slides into…`,
  });
  return picks && picks.length > 0 ? picks[0] : undefined;
}

// ───── URI helpers ───────────────────────────────────────────────────────

function resolveRelativeUri(baseUri: vscode.Uri, relPath: string): vscode.Uri {
  if (/^[a-z][a-z0-9+\-.]*:/i.test(relPath)) {
    return vscode.Uri.parse(relPath);
  }
  return vscode.Uri.joinPath(baseUri, '..', ...relPath.split('/'));
}

// vscode-wired half of the .eventSchedule custom text editor.
//
// Pairs with the pure renderer in eventEditorHtml.ts and the pure
// parse/marshal/mutate helpers in scheduleData.ts. Wired layer here owns:
//
//   - Registering the CustomTextEditorProvider for *.eventSchedule
//   - Parsing the document text → schedule view model on every render
//   - Receiving the webview's typed action messages, applying the matching
//     mutator, and writing the new text back to disk
//   - Surfacing parse errors as a banner so the user isn't left wondering
//     why their hand-edit "didn't take"
//   - Direct fs.writeFile bypass for the same reason configEditor.ts uses
//     it (applyEdit + save reliably dirties the in-memory document on
//     vscode.dev's FSA-backed file:// provider but does NOT always flush
//     bytes to disk — see CLAUDE.md's dead-end list)
//
// View-only fallback: a parse failure renders a banner + a "Reopen as text"
// button, never crashes the editor.

import * as vscode from 'vscode';
import { log } from '../log';
import {
  addRoom,
  addRooms,
  addSession,
  addSpeaker,
  addSpeakers,
  addTimeslot,
  applyDefaultTimeslotsToAllDays,
  clearAll,
  emptySchedule,
  isStructurallyEmpty,
  isValidTimeslotLabel,
  marshalSchedule,
  parseSchedule,
  regenerateFromConfig,
  removeRoom,
  removeSession,
  removeSpeaker,
  removeTimeslot,
  renameRoom,
  renameSpeaker,
  renameTimeslot,
  reorderTimeslots,
  replaceSessionSpeakersByNames,
  setDays,
  setDefaultTimeslots,
  setEventName,
  setSessionKind,
  setSessionSpeakers,
  setSessionTitle,
  setTitleSlidesBinding,
  swapSessionsInRoom,
} from './scheduleData';
import { renderBody, renderEventEditorHtml } from './eventEditorHtml';
import type { EventConfig, EventSchedule, SessionKind, TitleSlidesBinding } from './schedule';
import { planEventFolders, type Layout } from './eventFolders';
import { openBindingPanel } from './titleSlides/bindingUi';
import { generateTitleSlides } from './titleSlides/generator';
import { getActivePlaceholderSet } from '../sync/placeholderRegistry';
import { sha256Hex } from '../sync/hash';

const VIEW_TYPE = 'pptxViewer.eventEditor';

export class EventEditorProvider implements vscode.CustomTextEditorProvider {
  static register(): vscode.Disposable {
    const provider = new EventEditorProvider();
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Form state is per-document; preserving across hide/show avoids losing
      // the user's mid-edit affordances (open Add-speaker row, expanded Tools
      // section). Matches the admin editor's choice for the same reason.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    log(`event-editor: opened ${document.uri.toString()}`);

    const renderInitial = async (): Promise<void> => {
      panel.webview.html = await this.renderFor(document);
    };
    await renderInitial();

    // Re-render the body and push it to the webview. The webview replaces
    // `#root`'s innerHTML on receipt — event handlers are delegated on the
    // root element so they survive the swap.
    //
    // Two entry points:
    //
    //  1. Own writes: after fs.writeFile resolves, we call
    //     pushRefreshFromSchedule(next) with the freshly-mutated schedule
    //     directly. This avoids re-reading `document.getText()` — the
    //     in-memory TextDocument reloads from disk asynchronously after
    //     fs.writeFile, so a `document.getText()` here may still return
    //     the pre-write content and re-render the stale state.
    //
    //  2. External doc changes (someone editing the file via the raw-text
    //     editor, or a file-watcher event): we re-parse the document text
    //     and re-render. By the time onDidChangeTextDocument fires the
    //     document is up to date.
    const pushRefreshFromSchedule = async (schedule: EventSchedule): Promise<void> => {
      const text = marshalSchedule(schedule);
      const currentSha = await sha256Hex(new TextEncoder().encode(text));
      const placeholders = await getActivePlaceholderSet();
      const vm = {
        schedule,
        parseErrors: [],
        isEmpty: text.trim() === '',
        isPlaceholder: text.trim() === '' || placeholders.has(currentSha),
      };
      void panel.webview.postMessage({ type: 'docChanged', html: renderBody(vm) });
    };

    const pushRefreshFromDocument = async (): Promise<void> => {
      const vm = await buildViewModel(document);
      void panel.webview.postMessage({ type: 'docChanged', html: renderBody(vm) });
    };

    const docSub = vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      await pushRefreshFromDocument();
    });

    // Write back via direct fs.writeFile (no tmp+rename, no applyEdit) so
    // the bytes always reach disk on vscode.dev's FSA-backed file://
    // provider. We then push an immediate refresh using the next-schedule
    // we already have in memory, so the form updates without waiting for
    // the file-watcher round-trip. The watcher-driven refresh later (via
    // docSub) is a no-op visually because the rendered body is identical.
    const writeSchedule = async (next: EventSchedule): Promise<void> => {
      const text = marshalSchedule(next);
      if (text === document.getText()) {
        log('event-editor: setSchedule produced identical text — skipping write');
        return;
      }
      try {
        await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(text));
        log(`event-editor: wrote ${text.length} bytes to ${document.uri.toString()}`);
        await pushRefreshFromSchedule(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`event-editor: fs.writeFile failed — ${message}`);
        void vscode.window.showErrorMessage(
          `Event Schedule: could not save — ${message}`,
        );
      }
    };

    const mutate = async (
      fn: (current: EventSchedule) => EventSchedule,
    ): Promise<void> => {
      const parsed = parseSchedule(document.getText());
      const next = fn(parsed.schedule);
      await writeSchedule(next);
    };

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      if (!msg || typeof msg !== 'object') return;
      try {
        switch (msg.type) {
          case 'setEventName':
            await mutate((s) => setEventName(s, msg.name));
            break;
          case 'setDays':
            await mutate((s) => setDays(s, msg.days));
            break;
          case 'setDefaultTimeslots':
            await mutate((s) => setDefaultTimeslots(s, msg.labels));
            break;
          case 'applyDefaultTimeslotsToAllDays':
            await mutate((s) => applyDefaultTimeslotsToAllDays(s));
            break;
          case 'addSpeaker':
            await mutate((s) => addSpeaker(s, msg.name));
            break;
          case 'addSpeakers':
            await mutate((s) => addSpeakers(s, msg.names));
            break;
          case 'renameSpeaker':
            await mutate((s) => renameSpeaker(s, msg.speakerId, msg.name));
            break;
          case 'removeSpeaker':
            await mutate((s) => removeSpeaker(s, msg.speakerId));
            break;
          case 'addRoom':
            await mutate((s) => addRoom(s, { name: msg.name, kind: msg.kind }));
            break;
          case 'addRooms':
            await mutate((s) => addRooms(s, { names: msg.names, kind: msg.kind }));
            break;
          case 'renameRoom':
            await mutate((s) => renameRoom(s, msg.roomId, msg.name));
            break;
          case 'removeRoom':
            await mutate((s) => removeRoom(s, msg.roomId));
            break;
          case 'addSession':
            await mutate((s) =>
              addSession(s, {
                day: msg.day,
                timeslot: msg.timeslot,
                roomId: msg.roomId,
                kind: msg.kind,
                speakerIds: msg.speakerIds,
              }),
            );
            break;
          case 'removeSession':
            await mutate((s) => removeSession(s, msg.sessionId));
            break;
          case 'setSessionSpeakers':
            await mutate((s) => setSessionSpeakers(s, msg.sessionId, msg.speakerIds));
            break;
          case 'replaceSessionSpeakersByNames': {
            // Bulk replace via paste. The mutator returns conflicts +
            // newly-added speakers; we write the schedule first (so the
            // editor reflects the new state) then surface the modal
            // listing displaced speakers, so the operator sees what just
            // happened.
            const parsed = parseSchedule(document.getText());
            const result = replaceSessionSpeakersByNames(
              parsed.schedule,
              msg.sessionId,
              msg.names,
            );
            await writeSchedule(result.schedule);
            if (result.addedSpeakers.length > 0) {
              log(
                `event-editor: replaceSpeakersByNames auto-added ${result.addedSpeakers.length} ` +
                  `speaker(s): ${result.addedSpeakers.map((sp) => sp.name).join(', ')}`,
              );
            }
            if (result.conflicts.length > 0) {
              const detail = result.conflicts
                .map(
                  (c) =>
                    `• ${c.speakerName} was removed from ${c.fromRoomName} at ${c.day} ${c.timeslot}`,
                )
                .join('\n');
              const summary =
                result.conflicts.length === 1
                  ? '1 speaker was moved from another session at this timeslot'
                  : `${result.conflicts.length} speakers were moved from other sessions at this timeslot`;
              void vscode.window.showInformationMessage(
                summary,
                { modal: true, detail },
              );
            }
            break;
          }
          case 'setSessionKind':
            await mutate((s) => setSessionKind(s, msg.sessionId, msg.kind));
            break;
          case 'setSessionTitle':
            await mutate((s) => setSessionTitle(s, msg.sessionId, msg.title));
            break;
          case 'clearAll': {
            // Modal confirm matches the folderSync.clearSnapshot pattern.
            // Refusing here keeps a stale-tab "Clear" out of the data path.
            const confirmed = await vscode.window.showWarningMessage(
              'Clear this event schedule?',
              {
                modal: true,
                detail:
                  'All speakers, rooms, sessions, and vacancies will be removed. ' +
                  'The event name, days, and per-day timeslot labels will be preserved. ' +
                  'This cannot be undone.',
              },
              'Clear',
            );
            if (confirmed === 'Clear') {
              await mutate((s) => clearAll(s));
            } else {
              log('event-editor: clearAll declined by user');
            }
            break;
          }
          case 'addTimeslot':
            await mutate((s) => addTimeslot(s, msg.day, msg.label));
            break;
          case 'removeTimeslot': {
            // Count sessions about to be cascaded so the modal prompt names
            // a real consequence. Computed against the on-disk schedule;
            // mutate() re-parses inside the handler, but we need the count
            // before showing the modal.
            const parsed = parseSchedule(document.getText());
            const affected = parsed.schedule.sessions.filter(
              (s) => s.day === msg.day && s.timeslot === msg.label,
            ).length;
            const detail =
              affected > 0
                ? `Drops ${affected} session${affected === 1 ? '' : 's'} at ${msg.day} ${msg.label}. This cannot be undone.`
                : `No sessions are scheduled at ${msg.day} ${msg.label}.`;
            const confirmed = await vscode.window.showWarningMessage(
              `Remove timeslot ${msg.label} from ${msg.day}?`,
              { modal: true, detail },
              'Remove',
            );
            if (confirmed === 'Remove') {
              await mutate((s) => removeTimeslot(s, msg.day, msg.label));
            } else {
              log(`event-editor: removeTimeslot declined for ${msg.day}/${msg.label}`);
            }
            break;
          }
          case 'renameTimeslot':
            // The mutator already enforces validity, but a guard here lets
            // us log *why* a stale-tab message was refused.
            if (!isValidTimeslotLabel(msg.newLabel)) {
              log(
                `event-editor: renameTimeslot refused — invalid label ` +
                  `${JSON.stringify(msg.newLabel)}`,
              );
              break;
            }
            await mutate((s) => renameTimeslot(s, msg.day, msg.oldLabel, msg.newLabel));
            break;
          case 'reorderTimeslots':
            await mutate((s) => reorderTimeslots(s, msg.day, msg.newOrder));
            break;
          case 'swapSessionsInRoom':
            await mutate((s) =>
              swapSessionsInRoom(s, msg.day, msg.roomId, msg.labelA, msg.labelB),
            );
            break;
          case 'regenerate':
            await this.handleRegenerate(document, msg.config, writeSchedule);
            break;
          case 'generateFolders':
            await this.handleGenerateFolders(document);
            break;
          case 'bindTitleSlides':
            await this.handleBindTitleSlides(document, mutate);
            break;
          case 'generateTitleSlides':
            await this.handleGenerateTitleSlides(document);
            break;
          case 'openAsText':
            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            break;
          default:
            log(`event-editor: ignoring unknown message type ${String((msg as { type?: unknown }).type)}`);
        }
      } catch (err) {
        log(
          `event-editor: message handler failed (${msg.type}) — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });

    panel.onDidDispose(() => {
      docSub.dispose();
    });
  }

  /**
   * Apply a Regenerate-from-config request. The "may overwrite the user's
   * data" check sits here, not in the webview, so a stale tab can't bypass
   * it. Lookup goes through the active placeholder registry — the same
   * one the planner + viewer consult.
   */
  private async handleRegenerate(
    document: vscode.TextDocument,
    config: Partial<EventConfig>,
    writeSchedule: (next: EventSchedule) => Promise<void>,
  ): Promise<void> {
    const text = document.getText();
    const currentBytes = new TextEncoder().encode(text);
    const currentSha = await sha256Hex(currentBytes);
    const placeholders = await getActivePlaceholderSet();
    const isEmpty = text.trim() === '';
    const { schedule: parsed } = parseSchedule(text);
    const isPlaceholder =
      isEmpty || isStructurallyEmpty(parsed) || placeholders.has(currentSha);
    if (!isPlaceholder) {
      // Editor's UI also hides the button in this case; this is the
      // belt-and-braces refusal.
      log(
        `event-editor: regenerate refused — current content sha ${currentSha.slice(0, 8)} ` +
          `has authored data and is not in the placeholder registry`,
      );
      void vscode.window.showWarningMessage(
        'Regenerate is only available on placeholder schedules — this file appears to have authored data. ' +
          'Clear it (or mark it as a placeholder) first.',
      );
      return;
    }
    const next = regenerateFromConfig(config);
    log(`event-editor: regenerate applied — seed=${next.config.seed} sessions=${next.sessions.length}`);
    await writeSchedule(next);
  }

  /**
   * Open the title-slide binding panel. Picks a template via showOpenDialog
   * (defaulting to the currently-bound template if any), loads its bytes,
   * and hands off to `openBindingPanel` from titleSlides/bindingUi.ts.
   *
   * On save: write `config.titleSlides` back to the .eventSchedule via
   * the shared `mutate` helper (which uses workspace.fs.writeFile — same
   * FSA-flush workaround as everywhere else in this file).
   *
   * `templatePath` is stored relative to the .eventSchedule's directory,
   * so the binding travels cleanly across machines / clones of the same
   * project tree.
   */
  private async handleBindTitleSlides(
    document: vscode.TextDocument,
    mutate: (fn: (s: EventSchedule) => EventSchedule) => Promise<void>,
  ): Promise<void> {
    const parsed = parseSchedule(document.getText());
    const existing = parsed.schedule.config.titleSlides;

    const pickTemplate = async (
      currentRelPath?: string,
    ): Promise<{ bytes: Uint8Array; uri: vscode.Uri } | undefined> => {
      const defaultUri = currentRelPath
        ? this.resolveRelativeUri(document.uri, currentRelPath)
        : (vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? document.uri);
      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri,
        filters: { 'PowerPoint': ['pptx'] },
        openLabel: 'Use as title-slide template',
        title: 'Pick title-slide template (.pptx)',
      });
      if (!picks || picks.length === 0) return undefined;
      const uri = picks[0];
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return { bytes, uri };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`event-editor: bindTitleSlides — read failed for ${uri.toString()} — ${msg}`);
        void vscode.window.showErrorMessage(`Couldn't read template: ${msg}`);
        return undefined;
      }
    };

    const initial = await pickTemplate(existing?.templatePath);
    if (!initial) {
      log('event-editor: bindTitleSlides cancelled at template pick');
      return;
    }

    openBindingPanel({} as vscode.ExtensionContext, {
      templateBytes: initial.bytes,
      templatePath: this.relativePath(document.uri, initial.uri),
      existing,
      onSave: async (binding: TitleSlidesBinding) => {
        try {
          await mutate((s) => setTitleSlidesBinding(s, binding));
          log(`event-editor: bindTitleSlides saved — ${binding.fields.length} field(s) @ ${binding.templatePath}`);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`event-editor: bindTitleSlides save failed — ${msg}`);
          return { ok: false, error: msg };
        }
      },
      onChangeTemplate: async () => {
        const next = await pickTemplate(undefined);
        if (!next) return undefined;
        return {
          templateBytes: next.bytes,
          templatePath: this.relativePath(document.uri, next.uri),
        };
      },
    });
  }

  /**
   * Run the title-slide generator for the current schedule. Reads the
   * binding from `config.titleSlides`; refuses if absent (the UI hides
   * the button in that case, this is the belt-and-braces refusal).
   * The generator itself owns layout + destination picks + progress UI;
   * we just hand off the schedule + binding.
   */
  private async handleGenerateTitleSlides(document: vscode.TextDocument): Promise<void> {
    const parsed = parseSchedule(document.getText());
    const binding = parsed.schedule.config.titleSlides;
    if (!binding) {
      void vscode.window.showWarningMessage(
        'Generate title slides: no template bound yet. Click "Bind title-slide template…" first.',
      );
      return;
    }
    await generateTitleSlides({
      document,
      schedule: parsed.schedule,
      binding,
    });
  }

  /**
   * Compute a path from `fromUri`'s directory to `toUri`. Used to store
   * the template's location in the binding relative to the .eventSchedule.
   * Falls back to `toUri.toString()` if the URIs aren't comparable (different
   * scheme / authority).
   */
  private relativePath(fromUri: vscode.Uri, toUri: vscode.Uri): string {
    if (fromUri.scheme !== toUri.scheme || fromUri.authority !== toUri.authority) {
      return toUri.toString();
    }
    const fromParts = fromUri.path.split('/').slice(0, -1);
    const toParts = toUri.path.split('/');
    let i = 0;
    while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) {
      i++;
    }
    const ups = fromParts.slice(i).map(() => '..');
    const downs = toParts.slice(i);
    return [...ups, ...downs].join('/');
  }

  /** Inverse of `relativePath` — resolve a stored relative path against a base URI. */
  private resolveRelativeUri(baseUri: vscode.Uri, relPath: string): vscode.Uri {
    if (/^[a-z][a-z0-9+\-.]*:/i.test(relPath)) {
      // Looks like an absolute URI — use directly.
      return vscode.Uri.parse(relPath);
    }
    return vscode.Uri.joinPath(baseUri, '..', ...relPath.split('/'));
  }

  /**
   * Materialise the folder tree implied by the current schedule. Pure planner
   * lives in ./eventFolders.ts; this wired half asks the user for the bits
   * the CLI takes via flags (layout + destination), then walks the plan
   * through `vscode.workspace.fs` so it works in the web extension host.
   *
   * Existing `<roomId>.roomSync` templates are preserved on re-runs — the
   * operator may have hand-wired destinations into them already, and the
   * planner would otherwise emit a clean template that wipes their work.
   * Speaker placeholder files are overwritten unconditionally; they're
   * test fixtures and a fresh run should win.
   */
  private async handleGenerateFolders(document: vscode.TextDocument): Promise<void> {
    const parsed = parseSchedule(document.getText());
    if (parsed.schedule.sessions.length === 0) {
      void vscode.window.showWarningMessage(
        'Generate folders: this schedule has no sessions — nothing to emit.',
      );
      return;
    }

    // Ask layout first — it's the choice the CLI takes via --layout and
    // there's no useful default (organisers tend to think day-major,
    // distribution tends to be room-major; pick deliberately).
    type LayoutItem = vscode.QuickPickItem & { value: Layout };
    const layoutChoice = await vscode.window.showQuickPick<LayoutItem>(
      [
        {
          label: 'Room-major',
          description: '<event>/<room>/<day>/<timeslot>/',
          detail: 'One room\'s whole event under one folder. Natural for distribution to a destination room.',
          value: 'room-major',
        },
        {
          label: 'Day-major',
          description: '<event>/<day>/<room>/<timeslot>/',
          detail: 'One day\'s rooms grouped together. Natural for an organiser\'s view of "what\'s happening today".',
          value: 'day-major',
        },
      ],
      { placeHolder: 'Choose folder layout for the event tree', title: 'Generate folders' },
    );
    if (!layoutChoice) {
      log('event-editor: generateFolders cancelled at layout pick');
      return;
    }

    // Destination folder — default to the workspace folder containing this
    // document, fall back to the document's own parent dir if the file is
    // open without a workspace.
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const defaultDestUri = wsFolder?.uri ?? vscode.Uri.joinPath(document.uri, '..');
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: defaultDestUri,
      openLabel: 'Generate event folders here',
      title: `Generate "${parsed.schedule.config.name}" folders into…`,
    });
    if (!picks || picks.length === 0) {
      log('event-editor: generateFolders cancelled at folder picker');
      return;
    }
    const destUri = picks[0];

    // Pass outRoot:'' so the planner returns paths relative to destUri.
    // The web extension then splits on '/' and uses vscode.Uri.joinPath
    // to build per-entry URIs — works for any FS provider, including
    // vscode.dev's FSA-backed file://.
    const plan = planEventFolders({
      schedule: parsed.schedule,
      layout: layoutChoice.value,
      outRoot: '',
    });

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Generating folders for "${parsed.schedule.config.name}"`,
        cancellable: false,
      },
      async (progress) => {
        const total = plan.directories.length + plan.files.length;
        let done = 0;
        const tick = (label: string): void => {
          done++;
          progress.report({
            message: label,
            increment: total > 0 ? (100 / total) : 0,
          });
        };

        for (const dir of plan.directories) {
          const segments = dir.split('/').filter((s) => s.length > 0);
          const dirUri = vscode.Uri.joinPath(destUri, ...segments);
          try {
            await vscode.workspace.fs.createDirectory(dirUri);
          } catch (err) {
            log(
              `event-editor: generateFolders mkdir failed for ${dirUri.toString()} — ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          tick(dir);
        }

        let skippedRoomSync = 0;
        for (const f of plan.files) {
          const segments = f.path.split('/').filter((s) => s.length > 0);
          const fileUri = vscode.Uri.joinPath(destUri, ...segments);
          // Preserve hand-wired .roomSync templates on re-runs. Check stat
          // first; missing file → ENOENT → write. Any other error path
          // (permission etc.) we let fall through to the writeFile so the
          // real diagnostic surfaces.
          if (f.path.endsWith('.roomSync')) {
            let exists = false;
            try {
              await vscode.workspace.fs.stat(fileUri);
              exists = true;
            } catch {
              exists = false;
            }
            if (exists) {
              skippedRoomSync++;
              tick(`(kept) ${f.path}`);
              continue;
            }
          }
          try {
            await vscode.workspace.fs.writeFile(fileUri, f.bytes);
          } catch (err) {
            log(
              `event-editor: generateFolders writeFile failed for ${fileUri.toString()} — ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          tick(f.path);
        }

        const eventRootUri = vscode.Uri.joinPath(
          destUri,
          ...plan.eventRoot.split('/').filter((s) => s.length > 0),
        );
        const summary =
          `Generated ${plan.files.length - skippedRoomSync} file(s) across ` +
          `${plan.directories.length} directory(ies) under ${parsed.schedule.config.name}/` +
          (skippedRoomSync > 0 ? ` (kept ${skippedRoomSync} existing .roomSync template(s))` : '') +
          `.`;
        log(`event-editor: ${summary} → ${eventRootUri.toString()}`);
        const reveal = await vscode.window.showInformationMessage(summary, 'Reveal');
        if (reveal === 'Reveal') {
          await vscode.commands.executeCommand('revealInExplorer', eventRootUri);
        }
      },
    );
  }

  private async renderFor(document: vscode.TextDocument): Promise<string> {
    const vm = await buildViewModel(document);
    return renderEventEditorHtml(vm, makeNonce());
  }
}

// ───── view-model + helpers ────────────────────────────────────────────

async function buildViewModel(document: vscode.TextDocument): Promise<EventEditorViewModel> {
  const text = document.getText();
  const isEmpty = text.trim() === '';
  const { schedule, errors } = parseSchedule(text);
  // Sha-of-current-content drives the placeholder check used by the
  // Regenerate-button visibility gate. Pre-compute it here so the renderer
  // doesn't have to. Three gates feed isPlaceholder:
  //   1. The file is byte-empty (initial state).
  //   2. The file's sha is in the workspace placeholder registry.
  //   3. The schedule is structurally empty — no speakers, rooms,
  //      sessions, or vacancies. This is the post-Clear state: the
  //      file still has JSON scaffolding (config, timeslotsByDay) but
  //      no authored content, so Regenerate is safe.
  const currentSha = await sha256Hex(new TextEncoder().encode(text));
  const placeholders = await getActivePlaceholderSet();
  const isPlaceholder =
    isEmpty || isStructurallyEmpty(schedule) || placeholders.has(currentSha);
  return {
    schedule: isEmpty ? emptySchedule() : schedule,
    parseErrors: errors,
    isEmpty,
    isPlaceholder,
  };
}

export interface EventEditorViewModel {
  schedule: EventSchedule;
  parseErrors: string[];
  /** True when the document text is empty (whitespace-only). */
  isEmpty: boolean;
  /**
   * True when the file is safe to overwrite via Regenerate — either the
   * file is empty, or its sha256 is in the active placeholder registry.
   * Drives the Regenerate button's visibility.
   */
  isPlaceholder: boolean;
}

type WebviewMessage =
  | { type: 'setEventName'; name: string }
  | { type: 'setDays'; days: string[] }
  | { type: 'setDefaultTimeslots'; labels: string[] }
  | { type: 'applyDefaultTimeslotsToAllDays' }
  | { type: 'addSpeaker'; name: string }
  | { type: 'addSpeakers'; names: string[] }
  | { type: 'renameSpeaker'; speakerId: string; name: string }
  | { type: 'removeSpeaker'; speakerId: string }
  | { type: 'addRoom'; name: string; kind: 'plenary' | 'breakout' }
  | { type: 'addRooms'; names: string[]; kind: 'plenary' | 'breakout' }
  | { type: 'renameRoom'; roomId: string; name: string }
  | { type: 'removeRoom'; roomId: string }
  | {
      type: 'addSession';
      day: string;
      timeslot: string;
      roomId: string;
      kind: SessionKind;
      speakerIds?: string[];
    }
  | { type: 'removeSession'; sessionId: string }
  | { type: 'setSessionSpeakers'; sessionId: string; speakerIds: string[] }
  | { type: 'replaceSessionSpeakersByNames'; sessionId: string; names: string[] }
  | { type: 'setSessionKind'; sessionId: string; kind: SessionKind }
  | { type: 'setSessionTitle'; sessionId: string; title: string }
  | { type: 'clearAll' }
  | { type: 'addTimeslot'; day: string; label?: string }
  | { type: 'removeTimeslot'; day: string; label: string }
  | { type: 'renameTimeslot'; day: string; oldLabel: string; newLabel: string }
  | { type: 'reorderTimeslots'; day: string; newOrder: string[] }
  | {
      type: 'swapSessionsInRoom';
      day: string;
      roomId: string;
      labelA: string;
      labelB: string;
    }
  | { type: 'regenerate'; config: Partial<EventConfig> }
  | { type: 'generateFolders' }
  | { type: 'bindTitleSlides' }
  | { type: 'generateTitleSlides' }
  | { type: 'openAsText' };

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

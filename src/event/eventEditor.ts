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
  addSession,
  addSpeaker,
  emptySchedule,
  marshalSchedule,
  parseSchedule,
  regenerateFromConfig,
  removeRoom,
  removeSession,
  removeSpeaker,
  renameRoom,
  renameSpeaker,
  setDays,
  setEventName,
  setSessionKind,
  setSessionSpeakers,
} from './scheduleData';
import { renderBody, renderEventEditorHtml } from './eventEditorHtml';
import type { EventConfig, EventSchedule, SessionKind } from './schedule';
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
          case 'addSpeaker':
            await mutate((s) => addSpeaker(s, msg.name));
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
          case 'setSessionKind':
            await mutate((s) => setSessionKind(s, msg.sessionId, msg.kind));
            break;
          case 'regenerate':
            await this.handleRegenerate(document, msg.config, writeSchedule);
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
    const currentBytes = new TextEncoder().encode(document.getText());
    const currentSha = await sha256Hex(currentBytes);
    const placeholders = await getActivePlaceholderSet();
    const isPlaceholder = placeholders.has(currentSha);
    if (!isPlaceholder) {
      // Editor's UI also hides the button in this case; this is the
      // belt-and-braces refusal.
      log(
        `event-editor: regenerate refused — current content sha ${currentSha.slice(0, 8)} ` +
          `is not in the placeholder registry`,
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
  // doesn't have to.
  const currentSha = await sha256Hex(new TextEncoder().encode(text));
  const placeholders = await getActivePlaceholderSet();
  const isPlaceholder = isEmpty || placeholders.has(currentSha);
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
  | { type: 'addSpeaker'; name: string }
  | { type: 'renameSpeaker'; speakerId: string; name: string }
  | { type: 'removeSpeaker'; speakerId: string }
  | { type: 'addRoom'; name: string; kind: 'plenary' | 'breakout' }
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
  | { type: 'setSessionKind'; sessionId: string; kind: SessionKind }
  | { type: 'regenerate'; config: Partial<EventConfig> }
  | { type: 'openAsText' };

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

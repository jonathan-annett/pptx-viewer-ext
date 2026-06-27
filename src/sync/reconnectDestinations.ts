// Reconnect-missing-destinations flow.
//
// THE PROBLEM: a `.sync.jsonc` destination is matched live by its `uri`
// (topology.ts). On web that URI is an FSA handle string; when a folder's
// permission is revoked or its drive reconnects, the handle dies and the URI no
// longer matches any open workspace folder — the destination resolves to
// `workspaceFolderUri: null` ("not currently in the workspace") and the sync
// silently has nowhere to write. There's no way to re-point it from the UI.
//
// THE FLOW: a palette command + an auto-notification ("N destination(s)
// missing — Reconnect?") walk the unresolved destinations ONE BY ONE. For each:
//   1. tell the user which destination they're reconnecting,
//   2. trigger VS Code's Add-Folder picker (the FSA grant gesture),
//   3. capture the newly-added workspace folder (diff against a pre-add
//      snapshot of folder URIs — robust whether or not the host reloaded),
//   4. WRITE-PROBE it (write→read→assert→delete an ignored temp file) to prove
//      it's actually writable — a read-only `readDirectory` probe gives false
//      positives, and destinations need readwrite,
//   5. rewrite that destination's `uri` (and stamp its stable `id`) in the
//      `.sync.jsonc`, then reload the topology.
//
// RELOAD-DEFENSIVE: adding the first folder to an empty workspace reloads the
// extension host on web; whether adding to a populated workspace does is
// unconfirmed. So progress lives in `globalState` (a {@link ReconnectSession})
// and the grant is detected by diffing the *persisted* pre-add folder set
// against the live one — the same detection works in-process OR after a reload
// (on activation we offer "Continue?"). Nothing here blocks activation.

import * as vscode from 'vscode';
import { log } from '../log';
import type { SyncManager } from './manager';
import type { ResolvedTopology } from './topology';
import { rewriteDestinationUri } from './destinationId';
import { withTimeout } from './timeout';

const SESSION_KEY = 'folderSync.reconnectSession';
/** A live folder answers a small write+read fast; a dead handle hangs past this. */
const PROBE_TIMEOUT_MS = 5000;

/** One destination awaiting reconnection, identified durably across reloads. */
interface ReconnectTarget {
  /** `.sync.jsonc` whose destination entry we'll rewrite (URI string). */
  configUri: string;
  /** Stale on-disk destination URI — the match key when no id is stamped. */
  destUri: string;
  /** Stable destination id, when the config carries one (preferred match key). */
  destId?: string;
  /** Display name for the prompts. */
  name: string;
}

/** Persisted progress of an in-flight reconnect, survives a host reload. */
interface ReconnectSession {
  startedAt: string;
  /** Targets not yet processed (the active one is held separately). */
  queue: ReconnectTarget[];
  /** The target currently awaiting a folder grant, if any. */
  active?: ReconnectTarget;
  /**
   * Workspace folder URIs snapshotted immediately before the Add-Folder gesture
   * for `active`. The grant is `currentFolders \ foldersBeforeAdd`. Persisted so
   * the diff still works if the add reloaded the host mid-gesture.
   */
  foldersBeforeAdd?: string[];
}

type ApplyOutcome = 'done' | 'retry' | 'skip';
type PromptResult =
  | { outcome: 'granted'; grantUri: vscode.Uri }
  | { outcome: 'skip' }
  | { outcome: 'stop' };

/**
 * Collect the unresolved destinations from a topology as reconnect targets,
 * de-duplicated by (config, destination). Order follows the topology so the
 * prompts walk sources top-to-bottom.
 */
export function collectMissingTargets(topology: ResolvedTopology): ReconnectTarget[] {
  const out: ReconnectTarget[] = [];
  const seen = new Set<string>();
  for (const src of topology.sources) {
    const configUri = src.configUri.toString();
    for (const dest of src.destinations) {
      if (dest.workspaceFolderUri !== null) continue; // resolved — nothing to do
      const key = `${configUri}::${dest.id ?? dest.uri}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        configUri,
        destUri: dest.uri,
        ...(dest.id ? { destId: dest.id } : {}),
        name: dest.name,
      });
    }
  }
  return out;
}

/**
 * Owns the reconnect command, the auto-notification, and the persisted
 * resume-driven state machine. Register once at activation; dispose via
 * context.subscriptions.
 */
export class ReconnectController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private driving = false;
  /** Count last surfaced via the auto-notification; suppresses re-pestering. */
  private notifiedCount = -1;

  private constructor(
    private readonly manager: SyncManager,
    private readonly globalState: vscode.Memento,
  ) {}

  static register(manager: SyncManager, globalState: vscode.Memento): ReconnectController {
    const ctrl = new ReconnectController(manager, globalState);
    ctrl.disposables.push(
      vscode.commands.registerCommand('folderSync.reconnectMissingDestinations', () =>
        ctrl.start(),
      ),
      // Re-pointing a stale destination is the only way unresolved → resolved
      // happens, so a topology emit is the right trigger for the notification.
      manager.onDidChange((topo) => ctrl.onTopology(topo)),
    );
    // If a reconnect was mid-flight when the host last went down, offer to
    // continue — but never auto-mutate on activation (kept off the hot path).
    void ctrl.offerResume();
    return ctrl;
  }

  /** Entry point for the command + the notification's "Reconnect" button. */
  private async start(): Promise<void> {
    let session = this.loadSession();
    if (!session) {
      const targets = collectMissingTargets(this.manager.getTopology());
      if (targets.length === 0) {
        void vscode.window.showInformationMessage(
          'Folder Sync: no missing destinations to reconnect.',
        );
        return;
      }
      session = { startedAt: new Date().toISOString(), queue: targets };
      this.saveSession(session);
    }
    await this.drive(session);
  }

  /** Auto-notification on topology change. One toast per new unresolved count. */
  private onTopology(topology: ResolvedTopology): void {
    const count = collectMissingTargets(topology).length;
    if (count === 0) {
      this.notifiedCount = -1; // reset so a future regression re-notifies
      return;
    }
    // Don't pester while a reconnect session is already in flight, and only
    // re-toast when the count changes (a config save shouldn't re-nag).
    if (this.loadSession() || count === this.notifiedCount) return;
    this.notifiedCount = count;
    const noun = count === 1 ? 'destination is' : 'destinations are';
    void vscode.window
      .showWarningMessage(
        `Folder Sync: ${count} sync ${noun} missing from the workspace.`,
        'Reconnect',
        'Not now',
      )
      .then((pick) => {
        if (pick === 'Reconnect') void this.start();
      });
  }

  /** On activation, surface a stranded session without touching the FS. */
  private async offerResume(): Promise<void> {
    const session = this.loadSession();
    if (!session) return;
    const remaining = session.queue.length + (session.active ? 1 : 0);
    const pick = await vscode.window.showInformationMessage(
      `Folder Sync: a destination reconnect was in progress (${remaining} remaining).`,
      'Continue',
      'Discard',
    );
    if (pick === 'Continue') await this.drive(session);
    else if (pick === 'Discard') {
      this.clearSession();
      void vscode.window.showInformationMessage('Folder Sync: reconnect discarded.');
    }
  }

  /**
   * The state machine. Re-entrant-safe (a single `driving` guard). Loops
   * through the active target + queue, persisting after every transition so a
   * reload can resume from exactly here. Returns when the queue is drained or
   * the user steps away (the session is preserved for a later "Continue").
   */
  private async drive(session: ReconnectSession): Promise<void> {
    if (this.driving) return;
    this.driving = true;
    try {
      for (;;) {
        if (!session.active) {
          // Drop any queued target that resolved out-of-band, then take the next.
          session.queue = session.queue.filter((t) => this.isStillMissing(t));
          if (session.queue.length === 0) {
            await this.finish();
            return;
          }
          session.active = session.queue.shift();
          session.foldersBeforeAdd = undefined;
          this.saveSession(session);
        }
        const target = session.active!;
        if (!this.isStillMissing(target)) {
          // Reconnected elsewhere since we queued it — skip cleanly.
          session.active = undefined;
          session.foldersBeforeAdd = undefined;
          this.saveSession(session);
          continue;
        }

        // A grant may already be present: the add happened, then the host
        // reloaded before we could process it. Detect it before re-prompting.
        let grantUri = session.foldersBeforeAdd ? this.detectGrant(session) : undefined;
        if (!grantUri) {
          const r = await this.promptAndAdd(session, target);
          if (r.outcome === 'stop') {
            this.saveSession(session); // keep for later "Continue"
            return;
          }
          if (r.outcome === 'skip') {
            session.active = undefined;
            session.foldersBeforeAdd = undefined;
            this.saveSession(session);
            continue;
          }
          grantUri = r.grantUri;
        }

        const outcome = await this.applyGrant(target, grantUri);
        if (outcome === 'retry') continue; // active + foldersBeforeAdd kept → grant re-detected
        session.active = undefined;
        session.foldersBeforeAdd = undefined;
        this.saveSession(session);
        if (outcome === 'done') await this.manager.reload();
      }
    } finally {
      this.driving = false;
    }
  }

  /** Prompt, trigger the Add-Folder picker, and detect the granted folder. */
  private async promptAndAdd(
    session: ReconnectSession,
    target: ReconnectTarget,
  ): Promise<PromptResult> {
    const where = displayUri(target.configUri);
    const pick = await vscode.window.showInformationMessage(
      `Reconnect destination "${target.name}" (from ${where}). ` +
        `Choose its folder in the picker that opens.`,
      'Choose Folder…',
      'Skip',
    );
    if (pick === undefined) return { outcome: 'stop' }; // dismissed
    if (pick === 'Skip') return { outcome: 'skip' };

    // Snapshot BEFORE the gesture and persist — the grant is the new folder
    // not present in this set, computed the same way after a reload.
    session.foldersBeforeAdd = currentFolderUris();
    this.saveSession(session);
    try {
      await vscode.commands.executeCommand('workbench.action.addRootFolder');
    } catch (err) {
      log(`reconnect: addRootFolder failed — ${errMsg(err)}`);
      return { outcome: 'stop' };
    }
    // If the host reloaded during the add, we never reach here — the persisted
    // session resumes on activation. If we do reach here, detect synchronously.
    const grantUri = this.detectGrant(session);
    if (!grantUri) {
      void vscode.window.showInformationMessage(
        'Folder Sync: no folder was added. Run "Reconnect Missing Destinations" to continue.',
      );
      return { outcome: 'stop' };
    }
    return { outcome: 'granted', grantUri };
  }

  /** Write-probe the granted folder, then rewrite the config to point at it. */
  private async applyGrant(target: ReconnectTarget, grantUri: vscode.Uri): Promise<ApplyOutcome> {
    const probe = await writeProbe(grantUri);
    if (!probe.ok) {
      const choice = await vscode.window.showWarningMessage(
        `Folder Sync: "${target.name}" isn't writable (${probe.error}). ` +
          `Grant write access to the folder, then retry.`,
        'Retry',
        'Skip',
      );
      return choice === 'Retry' ? 'retry' : 'skip';
    }
    const rewritten = await this.rewriteConfig(target, grantUri);
    if (!rewritten) {
      void vscode.window.showWarningMessage(
        `Folder Sync: couldn't update the config for "${target.name}" — skipping.`,
      );
      return 'skip';
    }
    void vscode.window.showInformationMessage(
      `Folder Sync: reconnected "${target.name}".`,
    );
    return 'done';
  }

  /** Rewrite the destination's URI (and stamp its id) in its `.sync.jsonc`. */
  private async rewriteConfig(target: ReconnectTarget, grantUri: vscode.Uri): Promise<boolean> {
    let configUri: vscode.Uri;
    try {
      configUri = vscode.Uri.parse(target.configUri);
    } catch {
      return false;
    }
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(configUri);
      text = new TextDecoder('utf-8').decode(bytes);
    } catch (err) {
      log(`reconnect: read config failed — ${errMsg(err)}`);
      return false;
    }
    const result = rewriteDestinationUri(
      text,
      { uri: target.destUri, ...(target.destId ? { id: target.destId } : {}) },
      grantUri.toString(),
    );
    if (result.notFound) {
      log(`reconnect: destination not found in ${target.configUri} — config changed?`);
      return false;
    }
    if (result.text === text) return true; // already pointed there (idempotent)
    try {
      await vscode.workspace.fs.writeFile(configUri, new TextEncoder().encode(result.text));
      log(`reconnect: rewrote destination ${target.destId ?? target.destUri} → ${grantUri.toString()}`);
      return true;
    } catch (err) {
      log(`reconnect: write config failed — ${errMsg(err)}`);
      return false;
    }
  }

  private async finish(): Promise<void> {
    this.clearSession();
    await this.manager.reload();
    const remaining = collectMissingTargets(this.manager.getTopology()).length;
    if (remaining === 0) {
      void vscode.window.showInformationMessage('Folder Sync: all destinations reconnected.');
    } else {
      void vscode.window.showWarningMessage(
        `Folder Sync: reconnect finished — ${remaining} destination(s) still missing.`,
      );
    }
    log(`reconnect: session finished — ${remaining} still missing`);
  }

  /** Is this target still an unresolved destination in the live topology? */
  private isStillMissing(target: ReconnectTarget): boolean {
    const topo = this.manager.getTopology();
    for (const src of topo.sources) {
      if (src.configUri.toString() !== target.configUri) continue;
      for (const dest of src.destinations) {
        const matches = target.destId ? dest.id === target.destId : dest.uri === target.destUri;
        if (matches) return dest.workspaceFolderUri === null;
      }
    }
    return false; // gone from the config → nothing to reconnect
  }

  /** The workspace folder added since the pre-add snapshot, if exactly one. */
  private detectGrant(session: ReconnectSession): vscode.Uri | undefined {
    const before = new Set(session.foldersBeforeAdd ?? []);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const added = folders.filter((f) => !before.has(f.uri.toString()));
    if (added.length === 0) return undefined;
    if (added.length > 1) {
      log(`reconnect: ${added.length} folders added — using the first (${added[0].uri.toString()})`);
    }
    return added[0].uri;
  }

  private loadSession(): ReconnectSession | undefined {
    return this.globalState.get<ReconnectSession>(SESSION_KEY);
  }
  private saveSession(session: ReconnectSession): void {
    void this.globalState.update(SESSION_KEY, session);
  }
  private clearSession(): void {
    void this.globalState.update(SESSION_KEY, undefined);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Current workspace folder URIs as strings. */
function currentFolderUris(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString());
}

interface ProbeResult {
  ok: boolean;
  error?: string;
}

/**
 * Prove a folder is writable: write a small ignored temp file, read it back,
 * assert the bytes match, and delete it in a `finally`. A read-only
 * `readDirectory` probe (used by the background availability badges) gives
 * false positives — destinations need readwrite, and on web the write is also
 * what surfaces VS Code's readwrite permission grant. The probe name is in
 * BUILT_IN_IGNORES so a failed cleanup can never ship it via sync.
 */
export async function writeProbe(folderUri: vscode.Uri): Promise<ProbeResult> {
  const name = `.sync-writetest-${randHex(8)}.json`;
  const probeUri = appendUriPath(folderUri, name);
  const token = randHex(16);
  const payload = new TextEncoder().encode(`{"writeProbe":"${token}"}`);
  let wrote = false;
  try {
    await withTimeout(
      Promise.resolve(vscode.workspace.fs.writeFile(probeUri, payload)),
      PROBE_TIMEOUT_MS,
      `write probe ${folderUri.toString()}`,
    );
    wrote = true;
    const readBack = await withTimeout(
      Promise.resolve(vscode.workspace.fs.readFile(probeUri)),
      PROBE_TIMEOUT_MS,
      `read probe ${folderUri.toString()}`,
    );
    const ok = bytesEqual(readBack, payload);
    return ok ? { ok: true } : { ok: false, error: 'read-back mismatch' };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    if (wrote) {
      try {
        await withTimeout(
          Promise.resolve(vscode.workspace.fs.delete(probeUri)),
          PROBE_TIMEOUT_MS,
          `delete probe ${folderUri.toString()}`,
        );
      } catch (err) {
        // Best effort — the ignore pattern keeps a stray probe out of any sync.
        log(`reconnect: probe cleanup failed (${name}) — ${errMsg(err)}`);
      }
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function randHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function appendUriPath(base: vscode.Uri, segment: string): vscode.Uri {
  const joined = base.path.endsWith('/') ? `${base.path}${segment}` : `${base.path}/${segment}`;
  return base.with({ path: joined });
}

function displayUri(uriStr: string): string {
  try {
    const uri = vscode.Uri.parse(uriStr);
    return vscode.workspace.asRelativePath(uri, false) || uri.toString();
  } catch {
    return uriStr;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

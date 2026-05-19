// M4.6 cold-read URI probe.
//
// Purpose: settle the load-bearing unknown for the snapshot/silent-restore
// architecture — can vscode.workspace.fs.readFile resolve a captured URI for
// a folder that is NOT currently in workspaceFolders? If yes, the restore
// flow is one-step (read snapshot file → updateWorkspaceFolders). If no, the
// restore must mount the first folder before reading the snapshot file.
//
// This module is intentionally throwaway. It will be removed once M4.6 lands
// and the architecture is committed in one direction or the other.
//
// Two-phase command (single command, state-machined via globalState):
//   1. Capture phase: write a known-content probe file at the root of
//      workspaceFolders[0]; persist its URI + folder URI + expected byte
//      count to context.globalState; tell the user to close the folder (or
//      refresh the browser into a folderless state) and re-run.
//   2. Read phase: try to read the captured file URI without re-mounting,
//      via two URI-construction paths (vscode.Uri.parse, vscode.Uri.from).
//      Then mount the folder back and try again, as a sanity check that the
//      captured URI is valid. Each read is bounded by a timeout because a
//      missing FS provider is documented to hang rather than reject.

import * as vscode from 'vscode';
import { log } from '../log';

const PROBE_KEY = 'folderSync.probeData';
const PROBE_FILENAME = '.foldersync-probe.txt';
const READ_TIMEOUT_MS = 5000;

interface ProbeData {
  fileUri: string;       // toString() of the captured probe file URI
  folderUri: string;     // toString() of the workspace folder URI
  folderName: string;    // workspace folder display name at capture time
  expectedBytes: number; // length of the body we wrote
  capturedAt: string;    // ISO timestamp
}

export function registerProbe(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('folderSync.probeColdRead', async () => {
    log('--- probe: cold-read URI experiment ---');
    const existing = context.globalState.get<ProbeData>(PROBE_KEY);
    try {
      if (existing) {
        await runReadPhase(context, existing);
      } else {
        await runCapturePhase(context);
      }
    } catch (err) {
      log(`probe: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
    }
    log('--- probe: end ---');
    void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
  });
}

async function runCapturePhase(context: vscode.ExtensionContext): Promise<void> {
  log('probe: phase = capture');
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    log('probe: no workspace folder open — open one and re-run');
    return;
  }
  const target = folders[0];
  log(`probe: target folder = ${target.uri.toString()} (name="${target.name}")`);

  const fileUri = vscode.Uri.joinPath(target.uri, PROBE_FILENAME);
  const body = `folder-sync cold-read probe\n${new Date().toISOString()}\n`;
  const bodyBytes = new TextEncoder().encode(body);

  try {
    await vscode.workspace.fs.writeFile(fileUri, bodyBytes);
  } catch (err) {
    log(`probe: writeFile FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  log(`probe: wrote ${bodyBytes.byteLength} bytes to ${fileUri.toString()}`);

  const data: ProbeData = {
    fileUri: fileUri.toString(),
    folderUri: target.uri.toString(),
    folderName: target.name,
    expectedBytes: bodyBytes.byteLength,
    capturedAt: new Date().toISOString(),
  };
  await context.globalState.update(PROBE_KEY, data);

  log('probe: captured the following into globalState:');
  log(`  fileUri:    ${data.fileUri}`);
  log(`  folderUri:  ${data.folderUri}`);
  log(`  folderName: ${data.folderName}`);
  log(`  bytes:      ${data.expectedBytes}`);
  log('');
  log('probe: NEXT — close all workspace folders (File → Close Folder, or');
  log('       refresh the browser to land in a folderless vscode.dev tab),');
  log('       then run "Folder Sync: Probe Cold-Read" again to execute the');
  log('       read phase.');
}

async function runReadPhase(context: vscode.ExtensionContext, data: ProbeData): Promise<void> {
  log('probe: phase = read');
  log(`  captured at:           ${data.capturedAt}`);
  log(`  workspaceFolders.length: ${vscode.workspace.workspaceFolders?.length ?? 0}`);
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
    log('probe: WARNING — workspaceFolders is non-empty; this measures hot-read,');
    log('       not cold-read. Close the folder(s) and re-run for a true cold test.');
  }

  // Attempt 1: vscode.Uri.parse(captured-string) → readFile.
  let parsed: vscode.Uri;
  try {
    parsed = vscode.Uri.parse(data.fileUri);
    log(`probe: Uri.parse OK — scheme="${parsed.scheme}" authority="${parsed.authority}" path="${parsed.path}"`);
  } catch (err) {
    log(`probe: Uri.parse FAILED — ${err instanceof Error ? err.message : String(err)}`);
    await clearProbeData(context);
    return;
  }
  await tryRead('A. Uri.parse → readFile (cold)', parsed, data.expectedBytes);

  // Attempt 2: vscode.Uri.from({scheme, authority, path}) → readFile.
  // Tests whether an explicitly-reconstructed URI differs from the parsed one
  // (it shouldn't, but the FSA-backed scheme can be picky).
  const reconstructed = vscode.Uri.from({
    scheme: parsed.scheme,
    authority: parsed.authority,
    path: parsed.path,
    query: parsed.query,
    fragment: parsed.fragment,
  });
  log(`probe: Uri.from-reconstructed = ${reconstructed.toString()}`);
  log(`probe: equality with parsed = ${reconstructed.toString() === parsed.toString()}`);
  await tryRead('B. Uri.from → readFile (cold)', reconstructed, data.expectedBytes);

  // Attempt 3: mount the folder back, then read. Establishes the fallback
  // path (two-step restore) works at all, regardless of whether A/B did.
  log('probe: mounting folder back via updateWorkspaceFolders...');
  const folderUri = vscode.Uri.parse(data.folderUri);
  const insertAt = vscode.workspace.workspaceFolders?.length ?? 0;
  const added = vscode.workspace.updateWorkspaceFolders(insertAt, 0, {
    uri: folderUri,
    name: data.folderName,
  });
  log(`probe: updateWorkspaceFolders(insert ${insertAt}, 0, ...) returned ${added}`);
  // Give VS Code a tick to register the new folder + its FS provider.
  await new Promise((r) => setTimeout(r, 500));
  log(`probe: workspaceFolders.length after mount = ${vscode.workspace.workspaceFolders?.length ?? 0}`);

  await tryRead('C. parsed URI → readFile (post-mount)', parsed, data.expectedBytes);

  // Cleanup: clear globalState unconditionally; attempt to delete the probe
  // file. If delete fails, the user has a stray .foldersync-probe.txt — log
  // and move on; manual delete is trivial.
  await clearProbeData(context);
  try {
    await vscode.workspace.fs.delete(parsed);
    log('probe: cleanup — probe file deleted');
  } catch (err) {
    log(`probe: cleanup — delete failed (stray file may remain): ${err instanceof Error ? err.message : String(err)}`);
  }
  log('probe: cleanup complete — re-run "Folder Sync: Probe Cold-Read" to start a fresh capture');
}

async function clearProbeData(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(PROBE_KEY, undefined);
  log('probe: globalState[folderSync.probeData] cleared');
}

async function tryRead(label: string, uri: vscode.Uri, expectedBytes: number): Promise<void> {
  const start = Date.now();
  // readFile against a scheme with no registered FS provider is documented
  // to hang (see substrate dead-ends). Race against a timeout so the probe
  // command always terminates.
  const result = await Promise.race<
    { kind: 'ok'; bytes: Uint8Array } | { kind: 'err'; err: unknown } | { kind: 'timeout' }
  >([
    vscode.workspace.fs.readFile(uri).then(
      (bytes) => ({ kind: 'ok' as const, bytes }),
      (err) => ({ kind: 'err' as const, err }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' as const }), READ_TIMEOUT_MS)),
  ]);
  const elapsed = Date.now() - start;
  if (result.kind === 'ok') {
    const matches = result.bytes.byteLength === expectedBytes;
    log(`probe: ${label} → OK in ${elapsed}ms — ${result.bytes.byteLength} bytes (${matches ? 'matches' : 'MISMATCH'} expected ${expectedBytes})`);
  } else if (result.kind === 'err') {
    const msg = result.err instanceof Error ? result.err.message : String(result.err);
    log(`probe: ${label} → REJECTED in ${elapsed}ms — ${msg}`);
  } else {
    log(`probe: ${label} → TIMED OUT after ${elapsed}ms (readFile never resolved or rejected within ${READ_TIMEOUT_MS}ms)`);
  }
}

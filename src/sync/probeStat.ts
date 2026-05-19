// M5.2.5 stat-reliability probe.
//
// Purpose: settle the load-bearing unknown for the URI hash cache —
// does vscode.workspace.fs.stat return populated, stable `mtime` + `size`
// for FSA-granted files in vscode.dev? The cache shortcut
// (uri + size + mtime → sha256) is only viable if both fields are
// (a) populated (not 0/synthetic) and (b) stable across browser refresh.
//
// Two-phase command, state-machined via globalState. Mirrors the layout
// of src/sync/probe.ts (M4.6 cold-read probe).
//
//   1. Capture phase: walk each workspaceFolder to depth 3, collect up
//      to ~30 .pptx files, stat each, and persist {uri,size,mtime} for
//      every entry to globalState. Also stat one file 3x back-to-back
//      to measure within-session determinism + cost. Tell the user to
//      refresh the browser and re-run.
//   2. Verify phase: re-stat each captured URI and compare to stored
//      values. Log MATCH / MTIME-CHANGED / SIZE-CHANGED / GONE / ERROR
//      per entry; print a summary line. Clear globalState.
//
// Like src/sync/probe.ts, this module is intentionally throwaway — it
// will be removed once the hash cache lands and the question is settled.

import * as vscode from 'vscode';
import { log } from '../log';

const PROBE_KEY = 'folderSync.probeStatData';
const MAX_FILES_PER_FOLDER = 10;
const MAX_FILES_TOTAL = 30;
const WALK_MAX_DEPTH = 3;
const STAT_TIMEOUT_MS = 5000;
const BACK_TO_BACK_COUNT = 3;

interface ProbeStatEntry {
  uri: string;    // toString() of the file URI
  size: number;   // stat.size at capture time
  mtime: number;  // stat.mtime at capture time (ms since epoch, per VS Code API)
  ctime: number;  // stat.ctime at capture time
}

interface ProbeStatData {
  capturedAt: string;     // ISO timestamp
  entries: ProbeStatEntry[];
}

export function registerProbeStat(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('folderSync.probeStat', async () => {
    log('--- probe-stat: stat-reliability experiment ---');
    const existing = context.globalState.get<ProbeStatData>(PROBE_KEY);
    try {
      if (existing) {
        await runVerifyPhase(context, existing);
      } else {
        await runCapturePhase(context);
      }
    } catch (err) {
      log(`probe-stat: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
    }
    log('--- probe-stat: end ---');
    void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
  });
}

async function runCapturePhase(context: vscode.ExtensionContext): Promise<void> {
  log('probe-stat: phase = capture');
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    log('probe-stat: no workspace folders open — open at least one and re-run');
    return;
  }
  log(`probe-stat: walking ${folders.length} workspace folder(s)`);

  const collected: vscode.Uri[] = [];
  for (const folder of folders) {
    if (collected.length >= MAX_FILES_TOTAL) break;
    log(`probe-stat: walking ${folder.uri.toString()} (name="${folder.name}")`);
    const found = await collectPptxFiles(folder.uri, MAX_FILES_PER_FOLDER);
    log(`probe-stat:   collected ${found.length} .pptx file(s) from this folder`);
    for (const uri of found) {
      collected.push(uri);
      if (collected.length >= MAX_FILES_TOTAL) break;
    }
  }
  if (collected.length === 0) {
    log('probe-stat: no .pptx files found under any workspace folder — open a folder with pptx files and re-run');
    return;
  }
  log(`probe-stat: total ${collected.length} file(s) to stat`);

  // Stat each file. Log shape per entry; collect the {uri,size,mtime} we'll
  // persist for the verify phase.
  const entries: ProbeStatEntry[] = [];
  for (const uri of collected) {
    const result = await statWithTimeout(uri);
    if (result.kind === 'ok') {
      const s = result.stat;
      log(
        `probe-stat: OK ${uri.toString()} — size=${s.size} mtime=${s.mtime} ctime=${s.ctime} type=${s.type} (${result.elapsed}ms)`,
      );
      entries.push({
        uri: uri.toString(),
        size: s.size,
        mtime: s.mtime,
        ctime: s.ctime,
      });
    } else if (result.kind === 'err') {
      const msg = result.err instanceof Error ? result.err.message : String(result.err);
      log(`probe-stat: ERR ${uri.toString()} — ${msg} (${result.elapsed}ms)`);
    } else {
      log(`probe-stat: TIMEOUT ${uri.toString()} — stat did not resolve within ${STAT_TIMEOUT_MS}ms`);
    }
  }

  if (entries.length === 0) {
    log('probe-stat: every stat failed — cannot continue. See errors above.');
    return;
  }

  // Back-to-back stat on the first successful entry. Tells us:
  //   - is stat deterministic (same size/mtime across calls)?
  //   - is stat cheap enough that the hash cache shortcut is worthwhile
  //     (if stat is 50ms+ each, caching is not free)?
  const sample = vscode.Uri.parse(entries[0].uri);
  log(`probe-stat: back-to-back stat ×${BACK_TO_BACK_COUNT} on ${sample.toString()}`);
  for (let i = 0; i < BACK_TO_BACK_COUNT; i++) {
    const r = await statWithTimeout(sample);
    if (r.kind === 'ok') {
      log(`probe-stat:   [${i + 1}] size=${r.stat.size} mtime=${r.stat.mtime} (${r.elapsed}ms)`);
    } else if (r.kind === 'err') {
      log(`probe-stat:   [${i + 1}] ERR ${r.err instanceof Error ? r.err.message : String(r.err)} (${r.elapsed}ms)`);
    } else {
      log(`probe-stat:   [${i + 1}] TIMEOUT`);
    }
  }

  // Summary of capture-phase findings before we ask the user to refresh.
  const mtimeStats = summariseField(entries.map((e) => e.mtime));
  const sizeStats = summariseField(entries.map((e) => e.size));
  log('probe-stat: capture summary:');
  log(`  entries:        ${entries.length}`);
  log(`  mtime distinct: ${mtimeStats.distinct} (min=${mtimeStats.min} max=${mtimeStats.max} zeros=${mtimeStats.zeros})`);
  log(`  size distinct:  ${sizeStats.distinct} (min=${sizeStats.min} max=${sizeStats.max} zeros=${sizeStats.zeros})`);

  if (mtimeStats.zeros === entries.length) {
    log('probe-stat: ⚠️  every mtime is 0 — the FSA adapter is not populating it.');
    log('probe-stat:     The (uri,size,mtime)→sha256 shortcut is NOT VIABLE on this host.');
    log('probe-stat:     No point refreshing for verify phase; clearing capture state.');
    await context.globalState.update(PROBE_KEY, undefined);
    return;
  }

  const data: ProbeStatData = {
    capturedAt: new Date().toISOString(),
    entries,
  };
  await context.globalState.update(PROBE_KEY, data);

  log('');
  log('probe-stat: NEXT — refresh the browser tab (Cmd-R / Ctrl-R), wait for the');
  log('       workspace to restore via the snapshot, then run "Folder Sync: Probe');
  log('       Stat" again. The verify phase will re-stat every captured file and');
  log('       report whether mtime/size survived the refresh.');
}

async function runVerifyPhase(context: vscode.ExtensionContext, data: ProbeStatData): Promise<void> {
  log('probe-stat: phase = verify');
  log(`  captured at: ${data.capturedAt}`);
  log(`  entries:     ${data.entries.length}`);
  log(`  workspaceFolders.length: ${vscode.workspace.workspaceFolders?.length ?? 0}`);

  let matched = 0;
  let mtimeChanged = 0;
  let sizeChanged = 0;
  let gone = 0;
  let errored = 0;
  let mtimeDeltaSum = 0;

  for (const entry of data.entries) {
    const uri = vscode.Uri.parse(entry.uri);
    const result = await statWithTimeout(uri);
    if (result.kind === 'timeout') {
      log(`probe-stat: TIMEOUT ${entry.uri}`);
      errored++;
      continue;
    }
    if (result.kind === 'err') {
      const msg = result.err instanceof Error ? result.err.message : String(result.err);
      // FileNotFound is a meaningful distinct outcome — file was deleted or
      // the URI no longer resolves (e.g. folder rename invalidated it).
      const isNotFound = msg.includes('FileNotFound') || msg.includes('ENOENT');
      if (isNotFound) {
        log(`probe-stat: GONE ${entry.uri}`);
        gone++;
      } else {
        log(`probe-stat: ERROR ${entry.uri} — ${msg}`);
        errored++;
      }
      continue;
    }
    const s = result.stat;
    const sizeOk = s.size === entry.size;
    const mtimeOk = s.mtime === entry.mtime;
    if (sizeOk && mtimeOk) {
      matched++;
      // Keep this line concise — only the per-entry summary matters.
      log(`probe-stat: MATCH ${entry.uri} — size=${s.size} mtime=${s.mtime}`);
    } else if (!mtimeOk && sizeOk) {
      mtimeChanged++;
      const delta = s.mtime - entry.mtime;
      mtimeDeltaSum += Math.abs(delta);
      log(`probe-stat: MTIME-CHANGED ${entry.uri} — was=${entry.mtime} now=${s.mtime} delta=${delta}ms`);
    } else if (sizeOk === false && mtimeOk) {
      sizeChanged++;
      log(`probe-stat: SIZE-CHANGED ${entry.uri} — was=${entry.size} now=${s.size} (mtime stable)`);
    } else {
      mtimeChanged++;
      sizeChanged++;
      log(
        `probe-stat: BOTH-CHANGED ${entry.uri} — size ${entry.size}→${s.size}, mtime ${entry.mtime}→${s.mtime}`,
      );
    }
  }

  log('');
  log('probe-stat: verify summary:');
  log(`  matched:        ${matched} / ${data.entries.length}`);
  log(`  mtime-changed:  ${mtimeChanged}`);
  log(`  size-changed:   ${sizeChanged}`);
  log(`  gone:           ${gone}`);
  log(`  errored:        ${errored}`);
  if (mtimeChanged > 0) {
    log(`  avg |Δmtime|:   ${Math.round(mtimeDeltaSum / mtimeChanged)}ms`);
  }

  // Conclusion line — the headline finding the user came here for.
  if (matched === data.entries.length) {
    log('probe-stat: ✅ mtime + size are STABLE across refresh. URI hash cache is viable, IndexedDB tier earns its keep.');
  } else if (matched > 0 && mtimeChanged === data.entries.length - matched - gone - errored) {
    log('probe-stat: ⚠️  mtime is UNSTABLE across refresh on this host. Shortcut works within-session only; skip IndexedDB tier.');
  } else if (sizeChanged > 0) {
    log('probe-stat: ⚠️  size diverged for some files (real edits between capture and verify?). Re-run a clean capture if no edits happened.');
  } else {
    log(`probe-stat: ⚠️  mixed results (${matched}/${data.entries.length} matched) — read above per-entry detail.`);
  }

  await context.globalState.update(PROBE_KEY, undefined);
  log('probe-stat: globalState[folderSync.probeStatData] cleared — re-run to start a fresh capture');
}

// ---------- helpers ----------

async function collectPptxFiles(root: vscode.Uri, cap: number): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  await walk(root, 0, out, cap);
  return out;
}

async function walk(
  dir: vscode.Uri,
  depth: number,
  out: vscode.Uri[],
  cap: number,
): Promise<void> {
  if (out.length >= cap) return;
  if (depth > WALK_MAX_DEPTH) return;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    // Permission / scheme failure — silently skip; the probe is best-effort.
    return;
  }
  // Files first so a folder with pptx + subfolders fills the quota with the
  // pptx rather than blowing it on deep nested non-pptx files.
  entries.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] - b[1]));
  for (const [name, type] of entries) {
    if (out.length >= cap) return;
    if (name.startsWith('.')) continue; // skip hidden / our own state files
    const child = vscode.Uri.joinPath(dir, name);
    if (type === vscode.FileType.File) {
      if (name.toLowerCase().endsWith('.pptx')) {
        out.push(child);
      }
    } else if (type === vscode.FileType.Directory) {
      await walk(child, depth + 1, out, cap);
    }
  }
}

type StatResult =
  | { kind: 'ok'; stat: vscode.FileStat; elapsed: number }
  | { kind: 'err'; err: unknown; elapsed: number }
  | { kind: 'timeout' };

async function statWithTimeout(uri: vscode.Uri): Promise<StatResult> {
  const start = Date.now();
  return Promise.race<StatResult>([
    vscode.workspace.fs.stat(uri).then(
      (stat) => ({ kind: 'ok' as const, stat, elapsed: Date.now() - start }),
      (err) => ({ kind: 'err' as const, err, elapsed: Date.now() - start }),
    ),
    new Promise<StatResult>((resolve) =>
      setTimeout(() => resolve({ kind: 'timeout' as const }), STAT_TIMEOUT_MS),
    ),
  ]);
}

function summariseField(values: number[]): { distinct: number; min: number; max: number; zeros: number } {
  const set = new Set(values);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let zeros = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    if (v === 0) zeros++;
  }
  return {
    distinct: set.size,
    min: min === Number.POSITIVE_INFINITY ? 0 : min,
    max: max === Number.NEGATIVE_INFINITY ? 0 : max,
    zeros,
  };
}

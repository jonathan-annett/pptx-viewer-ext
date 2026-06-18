// Centralised logging. Writes to both:
//   - An injected sink — on the VS Code host the "Pptx Info" Output Channel
//     (View > Output > Pptx Info); on the PWA host the in-app Output window.
//   - The DevTools console (Help > Toggle Developer Tools).
// Both targets get the same lines so whichever the human is looking at, they
// see activation and per-file events.
//
// The sink is injected so this module carries no `vscode` dependency. The
// `log(message)` free function keeps its signature — its ~481 call sites are
// unchanged. Only `initLog` changed: it used to take a `vscode.ExtensionContext`
// and create the OutputChannel itself; now the host constructs the sink and
// passes it in (see `extension.ts`). Console output is emitted here directly so
// it works even before a sink is installed, exactly as before.

/** The one line-append surface a host supplies to back the Output Channel. */
export interface LogSink {
  appendLine(line: string): void;
}

let sink: LogSink | undefined;

export function initLog(s: LogSink): void {
  sink = s;
}

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  // eslint-disable-next-line no-console
  console.log('[pptx-viewer]', message);
  sink?.appendLine(line);
}

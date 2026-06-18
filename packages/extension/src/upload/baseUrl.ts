// Shared dropbox-server base-URL resolver.
//
// Both the M4 probe and the M5 UploadFlow need to decide where the
// dropbox-server lives. The setting `pptxViewer.dropboxBaseUrl` is the
// override; otherwise we fall back to the production deployment alongside
// the test harness.
//
// Kept tiny + vscode-touching so callers can `import { resolveDropboxBaseUrl }`
// without dragging the upload-protocol modules into their import graph.

import * as vscode from 'vscode';

export const DEFAULT_DROPBOX_BASE_URL = 'https://vscode.sophtwhere.com/dropbox';

/**
 * Return the configured dropbox-server base URL, falling back to the
 * production default. Whitespace-only values count as unset.
 */
export function resolveDropboxBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration('pptxViewer');
  const v = cfg.get<string>('dropboxBaseUrl');
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return DEFAULT_DROPBOX_BASE_URL;
}

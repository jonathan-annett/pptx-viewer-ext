// Host detection — distinguish vscode.dev (web) from desktop VS Code.
//
// Several behaviours in this extension exist to compensate for vscode.dev
// losing state across a browser refresh: `workspaceFolders` is empty on
// every cold start, and open editor tabs are replaced by the welcome page.
// The .admin-sync.jsonc workspace snapshot + silent restore (M4.6) and the
// last-active-tab replay both exist to paper over that.
//
// Desktop VS Code persists workspace folders and open tabs natively across
// restarts, so those restore paths would either be redundant or actively
// harmful there (re-adding folders the user removed last session, re-
// opening tabs the user closed). The *capture* side — writing the snapshot
// file and the active-tab marker — stays active on both platforms so a user
// can move a workspace freely between vscode.dev and desktop without
// losing the recorded state.
//
// Use `isWebHost()` to gate restore paths; leave capture paths unguarded.

import * as vscode from 'vscode';

export function isWebHost(): boolean {
  return vscode.env.uiKind === vscode.UIKind.Web;
}

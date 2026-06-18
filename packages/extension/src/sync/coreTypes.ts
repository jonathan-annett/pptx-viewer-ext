// Extension-side bindings of the (now generic-over-U) sync-engine types to the
// VS Code host's URI shape, `vscode.Uri`. Engine modules are generic so the PWA
// can bind its own `U`; the extension consumes these `vscode.Uri`-bound aliases
// so its call sites stay unparameterised. Phase 2 (monorepo) repoints the
// imports below at the `pptx-tools-core` package; these aliases stay here.

import type * as vscode from 'vscode';
import type {
  ResolvedTopology as GResolvedTopology,
  ResolvedSource as GResolvedSource,
  ResolvedDestination as GResolvedDestination,
  Diagnostic as GDiagnostic,
  SyncConfigConflict as GSyncConfigConflict,
} from 'pptx-tools-core/sync/topology';
import type {
  PlanForDestination as GPlanForDestination,
  ScopedPlanOptions as GScopedPlanOptions,
} from 'pptx-tools-core/sync/planner';
import type { SourceLoad as GSourceLoad } from 'pptx-tools-core/sync/config';

export type ResolvedTopology = GResolvedTopology<vscode.Uri>;
export type ResolvedSource = GResolvedSource<vscode.Uri>;
export type ResolvedDestination = GResolvedDestination<vscode.Uri>;
export type Diagnostic = GDiagnostic<vscode.Uri>;
export type SyncConfigConflict = GSyncConfigConflict<vscode.Uri>;
export type PlanForDestination = GPlanForDestination<vscode.Uri>;
export type ScopedPlanOptions = GScopedPlanOptions<vscode.Uri>;
export type SourceLoad = GSourceLoad<vscode.Uri>;

// Command registration + post-reload handoff for the Quick Setup New
// Event wizard. The exports here are the only entry points
// `extension.ts` needs to wire in — everything else (tokenization,
// artifact composition, wizard UI, executor) lives in sibling modules.
//
// M3 surface: registerQuickSetupCommand runs the showInputBox chain,
// then on success runs the post-collection executor (parent folder
// picker, collision check, modal confirm, file writes, handoff state,
// workspace replace via vscode.openFolder). M4 will add the
// post-reload handler.

import * as vscode from 'vscode';
import { log } from '../../log';
import { executeQuickSetup, runQuickSetupWizard } from './wizard';

export { handleQuickSetupPostReload } from './postReload';

/** Register the `event.quickSetup` palette command. */
export function registerQuickSetupCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand('event.quickSetup', async () => {
    log('--- quickSetup: wizard ---');
    const collected = await runQuickSetupWizard();
    if (collected === undefined) {
      log('quickSetup: cancelled (input phase)');
      return;
    }
    log(`quickSetup: eventName="${collected.eventName}"`);
    log(`quickSetup: days=${JSON.stringify(collected.days)}`);
    log(`quickSetup: timeslots=${JSON.stringify(collected.timeslots)}`);
    log(`quickSetup: rooms=${JSON.stringify(collected.rooms)}`);
    log(`quickSetup: speakers=${JSON.stringify(collected.speakerNames)}`);

    const ok = await executeQuickSetup(context, collected);
    if (!ok) {
      log('quickSetup: did not reach openFolder');
      void vscode.commands.executeCommand(
        'workbench.action.output.toggleOutput',
      );
    }
    // On success the extension host reloads — the success toast +
    // .eventSchedule auto-open fire from M4's post-reload handler.
  });
}

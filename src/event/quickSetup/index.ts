// Command registration + post-reload handoff for the Quick Setup New
// Event wizard. The exports here are the only entry points
// `extension.ts` needs to wire in — everything else (tokenization,
// artifact composition, wizard UI) lives in sibling modules.
//
// M2 surface (this commit): registerQuickSetupCommand runs the
// showInputBox chain and logs the collected inputs to the Output
// Channel. No folder ops yet — M3 wires picker + writes + openFolder.

import * as vscode from 'vscode';
import { log } from '../../log';
import { runQuickSetupWizard } from './wizard';

/**
 * Register the `event.quickSetup` palette command. M2 implementation
 * stops after collecting + logging the user's inputs; subsequent
 * milestones extend the same handler with folder creation, file
 * writing, and the openFolder reload + handoff.
 */
export function registerQuickSetupCommand(
  _context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand('event.quickSetup', async () => {
    log('--- quickSetup: wizard ---');
    const collected = await runQuickSetupWizard();
    if (collected === undefined) {
      log('quickSetup: cancelled');
      return;
    }
    log(`quickSetup: eventName="${collected.eventName}"`);
    log(`quickSetup: days=${JSON.stringify(collected.days)}`);
    log(`quickSetup: timeslots=${JSON.stringify(collected.timeslots)}`);
    log(`quickSetup: rooms=${JSON.stringify(collected.rooms)}`);
    log(`quickSetup: speakers=${JSON.stringify(collected.speakerNames)}`);
    log('quickSetup: collected — M3 will create folder + files next');
    void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
  });
}

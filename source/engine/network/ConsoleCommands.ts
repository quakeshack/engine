import { ConsoleCommand } from '../common/Cmd.ts';
import { eventBus, getCommonRegistry } from '../registry.ts';

let { Con, NET } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, NET } = getCommonRegistry());
});

/**
 * Copy a join link for the currently hosted session.
 */
export class InviteCommand extends ConsoleCommand {
  async run(): Promise<void> {
    const listenAddress = NET.GetListenAddress();

    if (listenAddress === null) {
      Con.PrintWarning('Cannot create invite link, not hosting.\n');
      return;
    }

    const shareLink = new URL(location.href);
    shareLink.searchParams.set('connect', listenAddress);
    shareLink.searchParams.delete('exec');
    shareLink.searchParams.delete('map');

    try {
      await navigator.clipboard.writeText(shareLink.toString());
      Con.Print(`This link has been copied to your clipboard:\n${shareLink.toString()}\n`);
    } catch {
      prompt('Share this link to invite players:', shareLink.toString());
    }
  }
}

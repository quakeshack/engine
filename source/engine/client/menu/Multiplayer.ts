import { K } from '../../../shared/Keys.ts';
import Cmd from '../../common/Cmd.ts';
import GameModule from '../../common/GameModule.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import { Action, Label, Spacer } from './MenuItem.ts';
import { MenuPage, VerticalLayout } from './MenuPage.ts';
import type { MenuStack } from './MenuStack.ts';
import { ServerEngineAPI } from '../../common/GameAPIs.ts';

interface ServerInfoSummary {
  readonly hostname?: string;
  readonly map?: string;
  readonly currentPlayers?: number;
  readonly maxPlayers?: number;
  readonly colo?: string | null;
  readonly country?: string | null;
}

interface ServerSessionSummary {
  readonly sessionId: string;
  readonly serverInfo?: ServerInfoSummary | null;
}

interface ServerListResponse {
  readonly servers?: ServerSessionSummary[] | null;
}

let { M, urls } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ M, urls } = getClientRegistry());
});

// CR: this whole menu is heavily WIP

// Menu (not connected)
// - player profile
// - list of servers
// - create game

// Menu (connected)
// - player profile
// - invite others
// - disconnect

// Menu: create game
// - coop / deathmatch
// - map selection
// - start game

export default class MultiplayerMainMenu extends MenuPage {
  staticItemCount: number | undefined;
  menuStack: MenuStack | null;

  // eslint-disable-next-line @typescript-eslint/require-await
  override async init(): Promise<void> {
    // M.m_multi is arriving later
    this.titlePic = M.p_multi;

    // const serverFields = GameModule.active?.ServerGameAPI.GetServerInfoFields();
    // const mapList = GameModule.active?.ServerGameAPI.GetMapList();

    // TODO: add server fields
    // for (const serverField of serverFields) {
    // }

    this.items.push(new Label({ label: 'Start Game:' }));

    // for (const map of mapList) {
    //   const action = new Action({
    //     label: map.label,
    //     action() {
    //       M.CloseMenu();

    //       ClientLifecycle.startGame.startMultiplayerGame(map.name);
    //     },
    //   });
    //   this.items.push(action);
    // }

    if (urls?.signalingURL) {
      // FIXME: move the start server list to the ClientGameAPI
      const serverActions = GameModule.active?.ServerGameAPI.GetStartServerList();

      console.assert(Array.isArray(serverActions), 'Expected GetStartServerList to return an array');

      for (const serverAction of serverActions ?? []) {
        this.items.push(new Action({
          label: serverAction.label,
          action() {
            M.CloseMenu();
            serverAction.callback(ServerEngineAPI);
          },
        }));
      }
    } else {
      this.items.push(new Action({
        label: 'Join local game',
        action() {
          M.CloseMenu();
          void Cmd.ExecuteString('connect self');
        },
      }));
    }

    this.items.push(new Spacer());

    this.staticItemCount = this.items.length;
  }

  override activate(): void {
    super.activate();
    if (urls?.signalingURL) {
      void this.refreshSessions();
    }
  }

  #addRefreshSessionsButton(): void {
    this.items.push(new Spacer());
    this.items.push(new Action({
      label: 'Refresh Sessions',
      action: async () => {
        await this.refreshSessions();
      },
    }));
  }

  async refreshSessions(): Promise<void> {
    // Reset to static items
    if (this.staticItemCount !== undefined && this.items.length > this.staticItemCount) {
      // Clean up previous dynamic items
      this.items.length = this.staticItemCount;
    }

    this.items.push(new Label({ label: 'Finding sessions...' }));

    try {
      if (!urls?.signalingURL) {
        throw new Error('Signaling URL is unavailable');
      }

      const signalingUrl = new URL(urls.signalingURL);
      const protocol = signalingUrl.protocol === 'wss:' ? 'https:' : 'http:';
      const url = `${protocol}//${signalingUrl.host}/list-servers`;

      const response = await fetch(url);
      const data = await response.json() as ServerListResponse;

      // Remove "Finding sessions..."
      this.items.length = 3;
      this.items.push(new Spacer());
      this.items.push(new Label({ label: 'Online Sessions:' }));

      if (!data.servers || data.servers.length === 0) {
        this.items.push(new Label({ label: 'No sessions found.' }));
        this.#addRefreshSessionsButton();
        return;
      }

      for (const session of data.servers) {
        const info = session.serverInfo || {};
        // const hostname = info.hostname || 'Unknown Server';
        const map = info.map || '?';
        const players = `${info.currentPlayers ?? 0}/${info.maxPlayers ?? 0}`;

        this.items.push(new Action({
          label: `${map} near ${[info.colo || null, info.country].filter(Boolean).join(', ')} [${players}]`,
          action() {
            M.CloseMenu();
            void Cmd.ExecuteString(`connect webrtc://${session.sessionId}`);
          },
        }));
      }

      this.#addRefreshSessionsButton();
    } catch (error: unknown) {
      // Remove loading indicator if present
      const lastItem = this.items[this.items.length - 1];
      if (lastItem && lastItem.label === 'Finding sessions...') {
        this.items.length = 4;
      }
      this.items.push(new Label({ label: 'Unable to fetch sessions' }));
      this.#addRefreshSessionsButton();
      console.error('Failed to fetch sessions:', error);
    }
  }

  constructor(menuStack: MenuStack | null = null) {
    const layout = new VerticalLayout({
      startY: 40,
      spacing: 8,
      labelX: 48,
      valueX: 220,
      cursorX: 32,
    });

    super({
      layout,
    });
    this.menuStack = menuStack;
  }

  /**
   * @returns True if handled.
   */
  override handleInput(key: K): boolean {
    if (key === K.ESCAPE) {
      this.deactivate();
      M.CloseMenu();
      return true;
    }
    return super.handleInput(key);
  }
}

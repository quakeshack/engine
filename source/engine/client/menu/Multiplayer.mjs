import PR from '../../server/Progs.mjs';
import { K } from '../../../shared/Keys.ts';
import Cmd from '../../common/Cmd.ts';
import { eventBus, registry } from '../../registry.mjs';
import { Action, Label, Spacer } from './MenuItem.mjs';
import { MenuPage, VerticalLayout } from './MenuPage.mjs';
import { ServerEngineAPI } from '../../common/GameAPIs.ts';

let { M } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ M } = registry);
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
  // eslint-disable-next-line @typescript-eslint/require-await
  async init() {
    // M.m_multi is arriving later
    this.titlePic = M.p_multi;

    // const serverFields = PR.QuakeJS.ServerGameAPI.GetServerInfoFields();
    // const mapList = PR.QuakeJS.ServerGameAPI.GetMapList();

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

    if (registry.urls?.signalingURL) {
      // FIXME: move the start serverlist to the ClientGameAPI
      const serverActions = PR.QuakeJS.ServerGameAPI.GetStartServerList();

      for (const serverAction of serverActions) {
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
          Cmd.ExecuteString('connect self');
        },
      }));
    }

    this.items.push(new Spacer());

    this.staticItemCount = this.items.length;
  }

  activate() {
    super.activate();
    if (registry.urls?.signalingURL) {
      void this.refreshSessions();
    }
  }

  #addRefreshSessionsButton() {
    this.items.push(new Spacer());
    this.items.push(new Action({
      label: 'Refresh Sessions',
      action: async () => {
        await this.refreshSessions();
      },
    }));
  }

  async refreshSessions() {
    // Reset to static items
    if (this.staticItemCount !== undefined && this.items.length > this.staticItemCount) {
      // Clean up previous dynamic items
      this.items.length = this.staticItemCount;
    }

    this.items.push(new Label({ label: 'Finding sessions...' }));

    try {
      const signalingUrl = new URL(registry.urls.signalingURL);
      const protocol = signalingUrl.protocol === 'wss:' ? 'https:' : 'http:';
      const url = `${protocol}//${signalingUrl.host}/list-servers`;

      const response = await fetch(url);
      const data = await response.json();

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
            Cmd.ExecuteString(`connect webrtc://${session.sessionId}`);
          },
        }));
      }

      this.#addRefreshSessionsButton();
    } catch (e) {
      // Remove loading indicator if present
      const lastItem = this.items[this.items.length - 1];
      if (lastItem && lastItem.label === 'Finding sessions...') {
        this.items.length = 4;
      }
      this.items.push(new Label({ label: 'Unable to fetch sessions' }));
      this.#addRefreshSessionsButton();
      console.error('Failed to fetch sessions:', e);
    }
  }

  /** @type {import('./MenuStack.mjs').MenuStack} */
  menuStack;

  /**
   * @param {import('./MenuStack.mjs').MenuStack} menuStack - Navigation stack
   */
  constructor(menuStack) {
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
   * @param {number} key - Key code
   * @returns {boolean} True if handled
   */
  handleInput(key) {
    if (key === K.ESCAPE) {
      this.deactivate();
      M.CloseMenu();
      return true;
    }
    return super.handleInput(key);
  }
};

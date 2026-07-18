import { eventBus, getClientRegistry } from '../../registry.ts';

let { COM, urls } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, urls } = getClientRegistry());
});

export interface DiscoveredSession {
  readonly sessionId: string;
  readonly map: string;
  readonly currentPlayers: number;
  readonly maxPlayers: number;
  readonly colo: string | null;
  readonly country: string | null;
}

interface ServerInfoSummary {
  readonly hostname?: string;
  readonly map?: string;
  readonly mod?: string;
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

/**
 * Looks up currently joinable multiplayer sessions from the master server's `/list-servers`
 * endpoint. Shared by the engine's own server-browser page and any mod-built lobby UI
 * (e.g. a session list embedded directly on a custom main menu), so the fetch/filter logic
 * exists exactly once.
 */
export default class SessionDiscovery {
  /**
   * Fetch sessions running the same game (mod) as this client -- e.g. hellwave sessions never
   * show up while playing id1 and vice versa.
   * @returns Sessions matching the active game/mod.
   */
  static async listSessions(): Promise<DiscoveredSession[]> {
    if (!urls?.signalingURL) {
      throw new Error('Signaling URL is unavailable');
    }

    const signalingUrl = new URL(urls.signalingURL);
    const protocol = signalingUrl.protocol === 'wss:' ? 'https:' : 'http:';
    const url = `${protocol}//${signalingUrl.host}/list-servers`;

    const response = await fetch(url);
    const data = await response.json() as ServerListResponse;

    const servers = (data.servers ?? []).filter((session) => session.serverInfo?.mod === COM.game);

    return servers.map((session) => {
      const info = session.serverInfo ?? {};
      return {
        sessionId: session.sessionId,
        map: info.map ?? '?',
        currentPlayers: info.currentPlayers ?? 0,
        maxPlayers: info.maxPlayers ?? 0,
        colo: info.colo ?? null,
        country: info.country ?? null,
      };
    });
  }
}

import { eventBus, getClientRegistry } from '../../registry.ts';

let { COM, Con, urls } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, urls } = getClientRegistry());
});

/** Fixed reconnect delay for the `/browser` push channel, matching `WebRTCDriver`'s signaling reconnect. */
const RECONNECT_DELAY_MS = 5000;

/**
 * Returns a readable message for an unknown error value.
 * @returns Readable error message.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export type ServerSettingValue = string | number | boolean;

export interface DiscoveredSession {
  readonly sessionId: string;
  readonly hostname: string;
  readonly map: string;
  readonly currentPlayers: number;
  readonly maxPlayers: number;
  readonly colo: string | null;
  readonly country: string | null;
  /** Every `Cvar.FLAG.SERVER`-flagged cvar the host reported, keyed by cvar name -- mod-specific interpretation is up to the caller. */
  readonly settings: Readonly<Record<string, ServerSettingValue>>;
}

interface ServerInfoSummary {
  readonly hostname?: string;
  readonly map?: string;
  readonly mod?: string;
  readonly currentPlayers?: number;
  readonly maxPlayers?: number;
  readonly colo?: string | null;
  readonly country?: string | null;
  readonly settings?: Record<string, ServerSettingValue> | null;
}

interface ServerSessionSummary {
  readonly sessionId: string;
  readonly serverInfo?: ServerInfoSummary | null;
}

interface ServerListResponse {
  readonly servers?: ServerSessionSummary[] | null;
}

/** Connection status of the real-time `/browser` push channel used by {@link SessionDiscovery.subscribe}. */
export type SessionDiscoveryStatus = 'connecting' | 'live' | 'reconnecting' | 'unavailable';

/** Loosely-typed push message from the master server's `/browser` WebSocket endpoint. */
interface BrowserMessage {
  readonly type: string;
  readonly servers?: ServerSessionSummary[];
  readonly server?: ServerSessionSummary;
  readonly sessionId?: string;
}

interface SessionDiscoveryListener {
  readonly onSessions: (sessions: DiscoveredSession[]) => void;
  readonly onStatus?: (status: SessionDiscoveryStatus) => void;
}

/**
 * Looks up currently joinable multiplayer sessions from the master server's `/list-servers`
 * endpoint and/or its real-time `/browser` WebSocket push channel. Shared by the engine's own
 * server-browser page and any mod-built lobby UI (e.g. a session list embedded directly on a
 * custom main menu), so the fetch/filter/live-update logic exists exactly once.
 */
export default class SessionDiscovery {
  static #listeners = new Set<SessionDiscoveryListener>();
  static #sessionsById = new Map<string, ServerSessionSummary>();
  static #status: SessionDiscoveryStatus = 'connecting';
  static #ws: WebSocket | null = null;
  static #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Fetch sessions running the same game (mod) as this client -- e.g. hellwave sessions never
   * show up while playing id1 and vice versa. One-shot; prefer {@link SessionDiscovery.subscribe} for anything
   * that stays on screen, since it updates live instead of going stale.
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

    return servers.map((session) => SessionDiscovery.#toDiscoveredSession(session));
  }

  /**
   * Subscribes to live session updates over the master server's `/browser` WebSocket channel.
   * The channel is shared and reference-counted across every subscriber -- the first call opens
   * it, the last matching unsubscribe closes it. `onSessions` fires with the full, filtered
   * session list on every server push (initial snapshot, and every add/update/remove diff
   * thereafter); `onStatus` reports the channel's own connection state so callers can render a
   * "reconnecting" hint without treating a live socket hiccup as an empty session list.
   * @returns An unsubscribe function; safe to call more than once.
   */
  static subscribe(
    onSessions: (sessions: DiscoveredSession[]) => void,
    onStatus?: (status: SessionDiscoveryStatus) => void,
  ): () => void {
    if (!urls?.signalingURL) {
      onStatus?.('unavailable');
      return () => {};
    }

    const listener: SessionDiscoveryListener = { onSessions, onStatus };
    SessionDiscovery.#listeners.add(listener);

    if (SessionDiscovery.#listeners.size === 1) {
      SessionDiscovery.#connect();
    } else {
      // Not the first subscriber -- hand over what the channel already knows instead of leaving
      // this listener waiting for the next diff.
      onStatus?.(SessionDiscovery.#status);
      onSessions(SessionDiscovery.#computeFilteredSessions());
    }

    let unsubscribed = false;

    return () => {
      if (unsubscribed) {
        return;
      }

      unsubscribed = true;
      SessionDiscovery.#listeners.delete(listener);

      if (SessionDiscovery.#listeners.size === 0) {
        SessionDiscovery.#disconnect();
      }
    };
  }

  /**
   * Asks the master server for a fresh full snapshot over the already-open `/browser` channel.
   * No-ops if the channel isn't open -- a reconnect already brings a fresh snapshot on its own.
   */
  static requestRefresh(): void {
    if (SessionDiscovery.#ws !== null && SessionDiscovery.#ws.readyState === 1) {
      SessionDiscovery.#ws.send(JSON.stringify({ type: 'request-server-list' }));
    }
  }

  static #toDiscoveredSession(session: ServerSessionSummary): DiscoveredSession {
    const info = session.serverInfo ?? {};
    return {
      sessionId: session.sessionId,
      hostname: info.hostname ?? 'UNNAMED', // matches WebRTCDriver#GatherServerInfo's own default
      map: info.map ?? '?',
      currentPlayers: info.currentPlayers ?? 0,
      maxPlayers: info.maxPlayers ?? 0,
      colo: info.colo ?? null,
      country: info.country ?? null,
      settings: info.settings ?? {},
    };
  }

  static #computeFilteredSessions(): DiscoveredSession[] {
    return Array.from(SessionDiscovery.#sessionsById.values())
      .filter((session) => session.serverInfo?.mod === COM.game)
      .map((session) => SessionDiscovery.#toDiscoveredSession(session));
  }

  static #setStatus(status: SessionDiscoveryStatus): void {
    SessionDiscovery.#status = status;

    for (const listener of SessionDiscovery.#listeners) {
      listener.onStatus?.(status);
    }
  }

  static #notify(): void {
    const sessions = SessionDiscovery.#computeFilteredSessions();

    for (const listener of SessionDiscovery.#listeners) {
      listener.onSessions(sessions);
    }
  }

  static #onMessage(message: BrowserMessage): void {
    switch (message.type) {
      case 'server-list':
        SessionDiscovery.#sessionsById.clear();
        for (const session of message.servers ?? []) {
          SessionDiscovery.#sessionsById.set(session.sessionId, session);
        }
        SessionDiscovery.#notify();
        break;

      case 'server-added':
      case 'server-updated':
        if (message.server) {
          SessionDiscovery.#sessionsById.set(message.server.sessionId, message.server);
          SessionDiscovery.#notify();
        }
        break;

      case 'server-removed':
        if (message.sessionId) {
          SessionDiscovery.#sessionsById.delete(message.sessionId);
          SessionDiscovery.#notify();
        }
        break;

      default:
        break;
    }
  }

  static #buildBrowserUrl(): string | null {
    if (!urls?.signalingURL) {
      return null;
    }

    // Scheme always comes from the current page (never the configured value's own scheme), same
    // rule `WebRTCDriver.Init()` uses for `/signaling` -- an https page must never attempt a
    // mixed-content `ws://` connection.
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = new URL(urls.signalingURL).host;
    return `${protocol}//${host}/browser`;
  }

  static #connect(): void {
    if (SessionDiscovery.#ws !== null && (SessionDiscovery.#ws.readyState === 1 || SessionDiscovery.#ws.readyState === 0)) {
      return;
    }

    if (SessionDiscovery.#reconnectTimer !== null) {
      clearTimeout(SessionDiscovery.#reconnectTimer);
      SessionDiscovery.#reconnectTimer = null;
    }

    const url = SessionDiscovery.#buildBrowserUrl();

    if (url === null) {
      SessionDiscovery.#setStatus('unavailable');
      return;
    }

    SessionDiscovery.#setStatus('connecting');

    try {
      const ws = new WebSocket(url);
      SessionDiscovery.#ws = ws;

      ws.onopen = () => {
        if (SessionDiscovery.#ws !== ws) {
          return;
        }

        Con.DPrint(`SessionDiscovery: Connected to ${url}\n`);
        SessionDiscovery.#setStatus('live');
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (SessionDiscovery.#ws !== ws || typeof event.data !== 'string') {
          return;
        }

        SessionDiscovery.#onMessage(JSON.parse(event.data) as BrowserMessage);
      };

      ws.onerror = (errorEvent: Event) => {
        console.debug('SessionDiscovery: WebSocket error', errorEvent);
      };

      ws.onclose = () => {
        if (SessionDiscovery.#ws !== ws) {
          return;
        }

        SessionDiscovery.#ws = null;

        if (SessionDiscovery.#listeners.size === 0) {
          return;
        }

        SessionDiscovery.#setStatus('reconnecting');
        SessionDiscovery.#scheduleReconnect();
      };
    } catch (error) {
      Con.PrintError(`SessionDiscovery: Failed to connect to ${url}:\n${getErrorMessage(error)}\n`);
      SessionDiscovery.#setStatus('reconnecting');
      SessionDiscovery.#scheduleReconnect();
    }
  }

  static #scheduleReconnect(): void {
    if (SessionDiscovery.#reconnectTimer !== null) {
      return;
    }

    SessionDiscovery.#reconnectTimer = setTimeout(() => {
      SessionDiscovery.#reconnectTimer = null;
      SessionDiscovery.#connect();
    }, RECONNECT_DELAY_MS);
  }

  static #disconnect(): void {
    if (SessionDiscovery.#reconnectTimer !== null) {
      clearTimeout(SessionDiscovery.#reconnectTimer);
      SessionDiscovery.#reconnectTimer = null;
    }

    SessionDiscovery.#ws?.close();
    SessionDiscovery.#ws = null;
    SessionDiscovery.#sessionsById.clear();
    SessionDiscovery.#status = 'connecting';
  }
}

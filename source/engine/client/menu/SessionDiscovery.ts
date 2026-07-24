import type { WebRTCDriver } from '../../network/NetworkDrivers.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';

let { COM, Con, NET, urls } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, NET, urls } = getClientRegistry());
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
  /**
   * Smoothed round-trip latency to this session's host in ms (see `WebRTCDriver.startSessionPing`,
   * `plans/session-ping-latency.md`), or `null` while still measuring or once `pingUnreachable` is
   * set. Only ever populated for sessions returned by {@link SessionDiscovery.subscribe} -- a
   * one-shot {@link SessionDiscovery.listSessions} call never probes.
   */
  readonly ping: number | null;
  /** `true` once a ping probe has confirmed this host is unreachable -- distinct from `ping` being `null` while still probing. */
  readonly pingUnreachable: boolean;
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
/** A session's own ping-probe result, tracked separately from the master-server-reported data. */
interface PingState {
  readonly ping: number | null;
  readonly unreachable: boolean;
}

export default class SessionDiscovery {
  static #listeners = new Set<SessionDiscoveryListener>();
  static #sessionsById = new Map<string, ServerSessionSummary>();
  static #status: SessionDiscoveryStatus = 'connecting';
  static #ws: WebSocket | null = null;
  static #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** sessionIds with a currently-running ping probe -- see `#ensureProbe`/`#stopProbe`. */
  static #probedSessionIds = new Set<string>();
  /** Latest ping result per probed sessionId; absent entirely while still awaiting the first pong. */
  static #pingState = new Map<string, PingState>();

  /**
   * Coarse RTT brackets sessions are sorted by (see `plans/session-ping-latency.md` §6): index 0
   * is "< 60ms" ... 4 is "350ms+"; 5 is "still probing" (no measurement yet); 6 is "unreachable"
   * (a probe confirmed the host can't be reached). Sorting by bracket rather than raw ms means a
   * session only ever reorders when it crosses a bracket boundary, not on every measurement.
   */
  static readonly #PING_BRACKET_THRESHOLDS_MS = [60, 120, 200, 350] as const;
  static readonly #PING_BRACKET_STILL_PROBING = 5;
  static readonly #PING_BRACKET_UNREACHABLE = 6;

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
    const pingState = SessionDiscovery.#pingState.get(session.sessionId);
    return {
      sessionId: session.sessionId,
      hostname: info.hostname ?? 'UNNAMED', // matches WebRTCDriver#GatherServerInfo's own default
      map: info.map ?? '?',
      currentPlayers: info.currentPlayers ?? 0,
      maxPlayers: info.maxPlayers ?? 0,
      colo: info.colo ?? null,
      country: info.country ?? null,
      settings: info.settings ?? {},
      ping: pingState?.ping ?? null,
      pingUnreachable: pingState?.unreachable ?? false,
    };
  }

  /**
   * Bracket-sorts sessions by ping (see `#PING_BRACKET_THRESHOLDS_MS`). `Array.prototype.sort` is
   * stable, and the input is already in first-seen order (`#sessionsById` is a `Map`, which never
   * reorders an existing key on update) -- so ties within one bracket keep their original relative
   * order for free, without needing an explicit secondary sort key.
   * @returns A new array; the input is never mutated.
   */
  static #sortByPing(sessions: DiscoveredSession[]): DiscoveredSession[] {
    return sessions.slice().sort((a, b) => SessionDiscovery.#getPingBracket(a) - SessionDiscovery.#getPingBracket(b));
  }

  static #getPingBracket(session: DiscoveredSession): number {
    if (session.pingUnreachable) {
      return SessionDiscovery.#PING_BRACKET_UNREACHABLE;
    }

    if (session.ping === null) {
      return SessionDiscovery.#PING_BRACKET_STILL_PROBING;
    }

    const ping = session.ping;
    const bracket = SessionDiscovery.#PING_BRACKET_THRESHOLDS_MS.findIndex((threshold) => ping < threshold);
    return bracket === -1 ? SessionDiscovery.#PING_BRACKET_THRESHOLDS_MS.length : bracket;
  }

  static #computeFilteredSessions(): DiscoveredSession[] {
    const sessions = Array.from(SessionDiscovery.#sessionsById.values())
      .filter((session) => session.serverInfo?.mod === COM.game)
      .map((session) => SessionDiscovery.#toDiscoveredSession(session));

    return SessionDiscovery.#sortByPing(sessions);
  }

  /**
   * `NET.driverRegistry` always registers `'webrtc'` as a real `WebRTCDriver` (`Network.ts`'s own
   * bootstrap) -- cast rather than `instanceof`, so a test double only needs to match the public
   * `startSessionPing`/`stopSessionPing` shape, not literally extend the class.
   * @returns The registered WebRTC driver, or `null` if somehow never registered.
   */
  static #getWebRTCDriver(): WebRTCDriver | null {
    return NET.driverRegistry.get('webrtc') as WebRTCDriver | null;
  }

  /**
   * Starts a ping probe for a session (no-op if one is already running) and stops any probe for a
   * session no longer in `sessionIds` -- called on every live session-list change so probing tracks
   * exactly what's currently visible, never more.
   */
  static #syncProbes(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of sessionIds) {
      SessionDiscovery.#ensureProbe(sessionId);
    }

    for (const sessionId of SessionDiscovery.#probedSessionIds) {
      if (!sessionIds.has(sessionId)) {
        SessionDiscovery.#stopProbe(sessionId);
      }
    }
  }

  static #ensureProbe(sessionId: string): void {
    if (SessionDiscovery.#probedSessionIds.has(sessionId)) {
      return;
    }

    SessionDiscovery.#probedSessionIds.add(sessionId);
    SessionDiscovery.#getWebRTCDriver()?.startSessionPing(sessionId, (rtt) => {
      SessionDiscovery.#onPing(sessionId, rtt);
    });
  }

  static #stopProbe(sessionId: string): void {
    if (!SessionDiscovery.#probedSessionIds.delete(sessionId)) {
      return;
    }

    SessionDiscovery.#getWebRTCDriver()?.stopSessionPing(sessionId);
    SessionDiscovery.#pingState.delete(sessionId);
  }

  static #onPing(sessionId: string, rtt: number | null): void {
    if (!SessionDiscovery.#probedSessionIds.has(sessionId)) {
      return; // a stale callback from a probe already stopped for this session
    }

    SessionDiscovery.#pingState.set(sessionId, { ping: rtt, unreachable: rtt === null });
    SessionDiscovery.#notify();
  }

  /**
   * Current game-matching sessionIds, i.e. exactly the set `#computeFilteredSessions` would probe.
   * @returns The set of sessionIds currently matching `COM.game`.
   */
  static #currentGameSessionIds(): Set<string> {
    const sessionIds = new Set<string>();

    for (const session of SessionDiscovery.#sessionsById.values()) {
      if (session.serverInfo?.mod === COM.game) {
        sessionIds.add(session.sessionId);
      }
    }

    return sessionIds;
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
        SessionDiscovery.#syncProbes(SessionDiscovery.#currentGameSessionIds());
        SessionDiscovery.#notify();
        break;

      case 'server-added':
      case 'server-updated':
        if (message.server) {
          SessionDiscovery.#sessionsById.set(message.server.sessionId, message.server);
          SessionDiscovery.#syncProbes(SessionDiscovery.#currentGameSessionIds());
          SessionDiscovery.#notify();
        }
        break;

      case 'server-removed':
        if (message.sessionId) {
          SessionDiscovery.#sessionsById.delete(message.sessionId);
          SessionDiscovery.#stopProbe(message.sessionId);
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

    // No listener is left watching -- stop every still-running probe rather than leaving it going
    // until the next unrelated session update happens to diff it away.
    for (const sessionId of SessionDiscovery.#probedSessionIds) {
      SessionDiscovery.#stopProbe(sessionId);
    }
  }
}

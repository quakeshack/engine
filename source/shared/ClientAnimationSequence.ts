import type { ClientEdict } from '../engine/client/ClientEntities.ts';

/**
 * One state in a {@link ClientAnimationSequence}.
 */
export interface ClientSequenceState<S extends string> {
  /**
   * Numeric model frame assigned to `ClientEdict.frame` on entering this state. Unlike the
   * server's `_defineState` (which resolves a string keyframe against the model's QC-parsed
   * frame-name table), client models carry no such name table, so this is always a plain frame
   * index -- new client-only cosmetic sequences are authored fresh in TypeScript anyway, with no
   * legacy named frames to resolve against.
   */
  readonly keyframe: number;
  /** Seconds until `tick()` auto-advances to `next`, once elapsed since entering this state. */
  readonly duration: number;
  /**
   * Next state to advance to once `duration` elapses. `null` marks a terminal state that stays
   * put until the owning handler acts (e.g. calls `remove()`).
   */
  readonly next: S | null;
  /**
   * Fired once, synchronously, when this state is entered via `tick()`'s auto-advance -- never
   * by `setState()`, so resuming from saved data doesn't replay one-shot side effects (spawning a
   * dlight, playing a sound) that already fired before the save.
   */
  readonly onEnter?: () => void;
}

/**
 * Lightweight, self-timed analog of the server's `_defineState`/`_defineSequence` state machine,
 * for triggered, one-shot, multi-frame client-only cosmetic effects (an explosion that spawns a
 * dlight on one frame and smoke on another, then frees itself). Keeps the parts of the server
 * pattern worth keeping (a typed state-key union, declarative per-state duration/next/callback);
 * drops the parts that don't apply client-side: `ScheduledThink`/`nextthink` coupling (a client
 * handler's `think()` already runs every frame -- this just needs to remember when it entered the
 * current state and compare against its own duration) and, especially, the server's
 * function-serialization via `toString()`/`new Function()` for `ScheduledThink.callback` -- a
 * client sequence's current state is just a string key from a statically-declared table, so
 * `serialize()`/`setState()` round-trip `(state, enteredAt)` with no eval-adjacent reconstruction.
 *
 * Composed by a `BaseClientEdictHandler` the same way `ClientEntityPhysics` is -- a handler owns
 * its `ClientEdict` 1:1 for its whole lifetime, so this holds a direct reference, no `WeakRef`.
 */
export class ClientAnimationSequence<S extends string> {
  #clientEdict: ClientEdict;
  #states: Readonly<Record<S, ClientSequenceState<S>>>;
  #current: S;
  /** Absolute time the current state was entered, or `null` until the first `tick()` call. */
  #enteredAt: number | null = null;

  constructor(clientEdict: ClientEdict, states: Readonly<Record<S, ClientSequenceState<S>>>, initial: S) {
    this.#clientEdict = clientEdict;
    this.#states = states;
    this.#current = initial;
  }

  /**
   * @returns The current state key.
   */
  get current(): S {
    return this.#current;
  }

  /**
   * Call once per `think()`. Enters the initial state on the first call (firing its `onEnter` and
   * assigning its `keyframe`), then advances to `next` once `duration` has elapsed since entering
   * the current state. A terminal state (`next: null`) never advances on its own -- the owning
   * handler decides when to act on it (e.g. calling `remove()`).
   */
  tick(currentTime: number): void {
    if (this.#enteredAt === null) {
      this.#enter(this.#current, currentTime, true);
      return;
    }

    const state = this.#states[this.#current];

    if (state.next !== null && (currentTime - this.#enteredAt) >= state.duration) {
      this.#enter(state.next, currentTime, true);
    }
  }

  /**
   * Jumps directly to a state without waiting out a duration and without firing its `onEnter` --
   * used to resume from saved data, where a one-shot side effect (a spawned dlight, a played
   * sound) already fired before the save and must not fire again.
   */
  setState(state: S, enteredAt: number): void {
    this.#enter(state, enteredAt, false);
  }

  #enter(state: S, enteredAt: number, fireOnEnter: boolean): void {
    this.#current = state;
    this.#enteredAt = enteredAt;
    this.#clientEdict.frame = this.#states[state].keyframe;

    if (fireOnEnter) {
      this.#states[state].onEnter?.();
    }
  }

  /**
   * Flat, JSON-safe snapshot for `BaseClientEdictHandler.serialize()` to fold in, with `enteredAt`
   * relative to `currentTime` -- the same relative-time-on-save, absolute-time-on-restore trick
   * `R.SerializeParticles()` already uses for `die`. Re-anchor on load via
   * `setState(data.state, newCurrentTime + data.enteredAt)`.
   * @returns The current state and how long ago it was entered, relative to `currentTime`.
   */
  serialize(currentTime: number): { state: S; enteredAt: number } {
    return {
      state: this.#current,
      enteredAt: (this.#enteredAt ?? currentTime) - currentTime,
    };
  }
}

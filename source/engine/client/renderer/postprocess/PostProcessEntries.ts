import type {
  PostProcessEffectDescriptor,
  PostProcessPlacement,
  PostProcessPulseDescriptor,
  PostProcessPulseOptions,
  PostProcessStackOptions,
  PostProcessStage,
  PostProcessTiming,
} from '../../../../shared/GameInterfaces.ts';

/** The settings of one entry, after the effect has filled in what the game left out. */
type Settings = Record<string, unknown>;

/** The channel the game uses when it does not name one. */
const DEFAULT_CHANNEL = 'default';

/** The longest a single `advance()` moves time, so a stalled frame does not skip a fade. */
export const MAX_ADVANCE = 0.1;

/**
 * What the entries need to know about the effect they name.
 */
export interface PostProcessEntryEffect {
  /** Settings with which the effect changes nothing; the numbers that are listed here are the ones that fade. */
  readonly neutral: object;

  /** The stage the effect runs in when an entry does not say. */
  readonly defaultStage: PostProcessStage;

  /**
   * Fills in what an entry left out and repairs what is not a finite number.
   * @returns The complete settings.
   */
  resolveSettings(settings: object): object;
}

/**
 * Finds the effect of an id, `undefined` for an effect that is not registered.
 */
export type PostProcessEntryEffectLookup = (id: string) => PostProcessEntryEffect | undefined;

/**
 * One thing to apply this frame: the effect and the settings it shows at this moment of its fade or pulse.
 */
export interface ResolvedPostProcessEntry {
  readonly id: string;
  readonly settings: object;
}

/** One entry of a channel's stack, with the fade it is in. */
interface StackEntry {
  readonly id: string;
  readonly matchKey: string;
  readonly stage: PostProcessStage | undefined;
  /** Where the current fade starts from, `null` for nothing. */
  from: Settings | null;
  /** Where it goes, `null` for nothing. */
  to: Settings | null;
  /** Length of the current fade in seconds, 0 when it has settled. */
  duration: number;
  elapsed: number;
  /** Whether the entry is on its way out: it is removed when the fade ends. */
  leaving: boolean;
}

/** One running pulse. */
interface Pulse {
  readonly id: string;
  readonly key: string | null;
  readonly stage: PostProcessStage | undefined;
  readonly placement: PostProcessPlacement;
  readonly settings: Settings;
  readonly timing: Required<PostProcessTiming>;
  age: number;
}

/** What belongs to one channel. */
interface Channel {
  stack: StackEntry[];
  pulses: Pulse[];
}

/**
 * The entries of the post-process stack over time: the persistent stack of each channel with its cross-fades,
 * and the pulses that remove themselves. It knows nothing of GL; `PostProcess` asks it what to apply each frame
 * and tells it how much time has passed.
 */
export default class PostProcessEntries {
  readonly #lookup: PostProcessEntryEffectLookup;
  readonly #channels = new Map<string, Channel>();

  /**
   * @param lookup Finds the effect of an id.
   */
  constructor(lookup: PostProcessEntryEffectLookup) {
    this.#lookup = lookup;
  }

  /**
   * Computes how strongly a pulse shows at an age.
   * @param timing The shape of the pulse.
   * @param age Seconds since it started.
   * @returns 0 to 1: rising during the fade-in, 1 while it holds, falling during the fade-out and 0 after.
   */
  static pulseIntensity(timing: Required<PostProcessTiming>, age: number): number {
    const { fadeIn, hold, fadeOut } = timing;

    // no duration at all: full strength for the frame it was started in, which is as long as it lives
    if (fadeIn + hold + fadeOut === 0) {
      return 1;
    }

    if (age < fadeIn) {
      return age / fadeIn;
    }

    if (age < fadeIn + hold) {
      return 1;
    }

    if (age < fadeIn + hold + fadeOut) {
      return 1 - (age - fadeIn - hold) / fadeOut;
    }

    return 0;
  }

  /**
   * Moves the settings of an effect between nothing and a target. Numbers the effect lists as neutral are
   * interpolated; everything else (a tint color, a period) is taken as it is from the target, or from where the
   * entry came from while it fades out, because the numbers carry the intensity.
   * @param neutral The settings with which the effect changes nothing.
   * @param from Where the fade starts, `null` for nothing.
   * @param to Where it ends, `null` for nothing.
   * @param progress 0 at `from`, 1 at `to`.
   * @returns The settings to show.
   */
  static blend(neutral: object, from: Settings | null, to: Settings | null, progress: number): Settings {
    const result: Settings = { ...(to ?? from ?? {}) };
    const rest = neutral as Settings;

    for (const key of Object.keys(rest)) {
      const base = rest[key];

      if (typeof base !== 'number') {
        continue;
      }

      const start = from !== null && typeof from[key] === 'number' ? from[key] : base;
      const end = to !== null && typeof to[key] === 'number' ? to[key] : base;

      result[key] = start + (end - start) * progress;
    }

    return result;
  }

  /**
   * Replaces the stack of a channel.
   * @param stack The new entries in the order they are applied.
   * @param options The channel and the seconds to cross-fade over.
   */
  setStack(stack: readonly PostProcessEffectDescriptor[], options: PostProcessStackOptions = {}): void {
    const channel = this.#channel(options.channel);
    const fade = Number.isFinite(options.fade ?? Number.NaN) ? Math.max(0, options.fade!) : 0;
    const previous = new Map(channel.stack.map((entry) => [entry.matchKey, entry]));
    const ordinals = new Map<string, number>();
    const next: StackEntry[] = [];

    for (const descriptor of stack) {
      if (descriptor === null || descriptor === undefined) {
        continue;
      }

      const matchKey = this.#uniqueMatchKey(descriptor, ordinals, next);
      const to = this.#resolve(descriptor.id, descriptor.settings);
      const before = previous.get(matchKey);
      previous.delete(matchKey);

      let from: Settings | null = to;

      if (fade > 0) {
        from = before !== undefined ? this.#display(before) : null;
      }

      next.push({
        id: descriptor.id,
        matchKey,
        stage: descriptor.stage,
        from,
        to,
        duration: fade,
        elapsed: 0,
        leaving: false,
      });
    }

    if (fade > 0) {
      // what is not in the new stack fades out after the entries that are
      for (const gone of previous.values()) {
        next.push({ ...gone, from: this.#display(gone), to: null, duration: fade, elapsed: 0, leaving: true });
      }
    }

    channel.stack = next;
  }

  /**
   * Forgets everything: every stack, every fade and every pulse, and the order the channels were first used in.
   */
  reset(): void {
    this.#channels.clear();
  }

  /**
   * Removes the stack of a channel at once. Running pulses are left to end on their own.
   * @param channel The channel, or every channel when left out.
   */
  clearStack(channel?: string): void {
    if (channel !== undefined) {
      const found = this.#channels.get(channel);

      if (found !== undefined) {
        found.stack = [];
      }

      return;
    }

    for (const found of this.#channels.values()) {
      found.stack = [];
    }
  }

  /**
   * Whether a stack is set, not counting entries that are fading out.
   * @param channel The channel, or any channel when left out.
   * @returns True when there is an entry that is meant to stay.
   */
  hasStack(channel?: string): boolean {
    if (channel !== undefined) {
      return this.#channels.get(channel)?.stack.some((entry) => !entry.leaving) ?? false;
    }

    for (const found of this.#channels.values()) {
      if (found.stack.some((entry) => !entry.leaving)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether anything is left to apply: a stack, an entry that fades out, or a pulse.
   * @returns True when {@link PostProcessEntries.collect} would return something for some stage.
   */
  hasEntries(): boolean {
    for (const found of this.#channels.values()) {
      if (found.stack.length > 0 || found.pulses.length > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Starts a pulse. A pulse that runs under the same key is replaced and starts over.
   * @param descriptor The entry, with how long it lasts.
   * @param options The channel it is composed in.
   */
  pulse(descriptor: PostProcessPulseDescriptor, options: PostProcessPulseOptions = {}): void {
    const channel = this.#channel(options.channel);
    const key = descriptor.key ?? null;

    if (key !== null) {
      channel.pulses = channel.pulses.filter((existing) => existing.key !== key);
    }

    const duration = (value: number | undefined): number => (Number.isFinite(value ?? Number.NaN) ? Math.max(0, value!) : 0);

    channel.pulses.push({
      id: descriptor.id,
      key,
      stage: descriptor.stage,
      placement: descriptor.placement ?? 'above',
      settings: this.#resolve(descriptor.id, descriptor.settings),
      timing: {
        fadeIn: duration(descriptor.timing.fadeIn),
        hold: duration(descriptor.timing.hold),
        fadeOut: duration(descriptor.timing.fadeOut),
      },
      age: 0,
    });
  }

  /**
   * Lets time pass: fades progress and pulses age, and what has ended is removed. A pulse without any duration
   * is shown for the frame it was started in and gone with the first time that passes.
   * @param deltaTime Seconds.
   */
  advance(deltaTime: number): void {
    const step = Math.min(Math.max(deltaTime, 0), MAX_ADVANCE);

    for (const channel of this.#channels.values()) {
      for (const entry of channel.stack) {
        if (entry.duration === 0) {
          continue;
        }

        entry.elapsed += step;

        if (entry.elapsed >= entry.duration) {
          entry.from = entry.to;
          entry.duration = 0;
          entry.elapsed = 0;
        }
      }

      channel.stack = channel.stack.filter((entry) => !(entry.leaving && entry.duration === 0));

      for (const pulse of channel.pulses) {
        pulse.age += step;
      }

      channel.pulses = channel.pulses.filter((pulse) => {
        const { fadeIn, hold, fadeOut } = pulse.timing;

        return pulse.age < fadeIn + hold + fadeOut || (step === 0 && pulse.age === 0);
      });
    }
  }

  /**
   * Lists what to apply in a stage, in the order to apply it: channels in the order they were first used and
   * within one the pulses placed below, the stack, then the pulses placed above, each group in the order it was
   * started. Entries of an effect that is not registered are skipped.
   * @param stage The stage.
   * @returns The effects and the settings they show right now.
   */
  collect(stage: PostProcessStage): ResolvedPostProcessEntry[] {
    const result: ResolvedPostProcessEntry[] = [];

    for (const channel of this.#channels.values()) {
      for (const pulse of channel.pulses) {
        if (pulse.placement === 'below') {
          this.#collectPulse(pulse, stage, result);
        }
      }

      for (const entry of channel.stack) {
        const effect = this.#lookup(entry.id);

        if (effect !== undefined && (entry.stage ?? effect.defaultStage) === stage) {
          result.push({ id: entry.id, settings: this.#display(entry) });
        }
      }

      for (const pulse of channel.pulses) {
        if (pulse.placement === 'above') {
          this.#collectPulse(pulse, stage, result);
        }
      }
    }

    return result;
  }

  /**
   * Adds a pulse to a list when it belongs to the stage.
   */
  #collectPulse(pulse: Pulse, stage: PostProcessStage, into: ResolvedPostProcessEntry[]): void {
    const effect = this.#lookup(pulse.id);

    if (effect === undefined || (pulse.stage ?? effect.defaultStage) !== stage) {
      return;
    }

    const intensity = PostProcessEntries.pulseIntensity(pulse.timing, pulse.age);
    into.push({ id: pulse.id, settings: PostProcessEntries.blend(effect.neutral, null, pulse.settings, intensity) });
  }

  /**
   * Computes the settings an entry shows at this moment of its fade.
   * @returns The settings.
   */
  #display(entry: StackEntry): Settings {
    if (entry.duration === 0 && entry.to !== null) {
      return entry.to;
    }

    const effect = this.#lookup(entry.id);
    const progress = entry.duration > 0 ? Math.min(entry.elapsed / entry.duration, 1) : 1;

    if (effect === undefined) {
      return entry.to ?? entry.from ?? {};
    }

    return PostProcessEntries.blend(effect.neutral, entry.from, entry.to, progress);
  }

  /**
   * Lets the effect complete the settings, or copies them when it is not registered (yet).
   * @returns The settings as the effect uses them.
   */
  #resolve(id: string, settings: object): Settings {
    const effect = this.#lookup(id);

    return { ...(effect !== undefined ? effect.resolveSettings(settings) : settings) } as Settings;
  }

  /**
   * Finds a channel, creating it, which fixes its place in the order the channels are composed in.
   * @returns The channel.
   */
  #channel(name: string = DEFAULT_CHANNEL): Channel {
    let channel = this.#channels.get(name);

    if (channel === undefined) {
      channel = { stack: [], pulses: [] };
      this.#channels.set(name, channel);
    }

    return channel;
  }

  /**
   * Names an entry of a stack for matching it against the previous stack: its key, or an effect id and how many
   * entries of that id came before, so that two entries of one effect do not collide.
   * @returns A name that is not used by an earlier entry of the same stack.
   */
  #uniqueMatchKey(descriptor: PostProcessEffectDescriptor, ordinals: Map<string, number>, taken: readonly StackEntry[]): string {
    let base: string;

    if (descriptor.key !== undefined) {
      base = `key:${descriptor.key}`;
    } else {
      const ordinal = ordinals.get(descriptor.id) ?? 0;
      ordinals.set(descriptor.id, ordinal + 1);
      base = `id:${descriptor.id}#${ordinal}`;
    }

    let candidate = base;

    for (let attempt = 1; taken.some((entry) => entry.matchKey === candidate); attempt++) {
      candidate = `${base}~${attempt}`;
    }

    return candidate;
  }
}

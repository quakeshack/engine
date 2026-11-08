import Cmd from '../common/Cmd.ts';
import Con from '../common/Console.ts';
import Cvar from '../common/Cvar.ts';
import { clientStaticState } from './ClientState.ts';
import BenchReport, { type BenchResult } from './BenchReport.ts';
import FrameProfiler, { type ProfileSection } from './FrameProfiler.ts';

/** One setting the benchmark measures: the cvars it changes from what the player has. */
interface BenchVariant {
  /** What the row is called. */
  readonly label: string;

  /** The cvars it sets, name and value; none for the settings as they are. */
  readonly changes: ReadonlyArray<readonly [string, string]>;
}

/** How often every variant is measured when `r_bench` is given no count, interleaved, so drift hits all alike. */
const DEFAULT_ROUNDS = 2;

/** The cvars that are switched off one at a time when `r_bench` names none. */
const DEFAULT_CVARS = ['gl_msaa', 'r_shadows', 'r_shadow_point', 'r_refraction', 'r_bloom'];

/** Drawn frames after a change before measuring starts: a changed `gl_msaa` builds new targets, GPU times lag. */
const SETTLE_FRAMES = 30;

/** Drawn frames measured per variant when `r_bench` is given no count. */
const DEFAULT_FRAMES = 120;

/**
 * `r_bench`: measures the frame with the player's settings and then with cvars switched off, one at a time and all
 * together, a fixed number of drawn frames each, and prints one table to compare them. Every variant first waits
 * {@link SETTLE_FRAMES} frames, so targets that a change rebuilds and GPU times that come in late do not count.
 * `r_speeds` is on while it runs; every cvar is put back afterwards, also when the bench is stopped or the game ends.
 *
 * Stand still while it runs: the numbers depend on what is in view.
 */
export default class FrameBenchmark {
  /** The results of every round of the last run, in the order they were measured. */
  static readonly results: BenchResult[] = [];

  static readonly #variants: BenchVariant[] = [];
  static readonly #saved = new Map<string, string>();
  static #index = -1;
  static #frame = 0;
  static #frames = DEFAULT_FRAMES;

  /** Registers `r_bench`. */
  static Init(): void {
    Cmd.AddCommand('r_bench', FrameBenchmark.Bench_f);
  }

  /**
   * Whether a run is going on.
   * @returns True between `r_bench` and its report.
   */
  static get running(): boolean {
    return FrameBenchmark.#index >= 0;
  }

  /**
   * `r_bench [frames] [rounds] [cvar ...]`, `r_bench stop`.
   * @param args How many frames to measure per variant, how many rounds, then the cvars to switch off (the defaults
   * when none).
   */
  static Bench_f(this: void, ...args: string[]): void {
    if (args[0] === 'stop') {
      if (FrameBenchmark.running) {
        FrameBenchmark.#abort('stopped');
      }
      return;
    }

    if (FrameBenchmark.running) {
      Con.Print('r_bench is already running, r_bench stop ends it.\n');
      return;
    }

    if (clientStaticState.signon !== 4) {
      Con.Print('r_bench needs a running game.\n');
      return;
    }

    const counts = args.slice(0, 2).filter((arg) => /^\d+$/.test(arg)).map(Number);
    const names = args.slice(counts.length);
    const frames = Math.max(10, counts[0] ?? DEFAULT_FRAMES);
    const rounds = Math.max(1, counts[1] ?? DEFAULT_ROUNDS);
    const variants = FrameBenchmark.#buildVariants(names.length > 0 ? names : DEFAULT_CVARS);

    if (variants === null) {
      return;
    }

    FrameBenchmark.#start(variants, frames, rounds);
  }

  /**
   * The variants for a list of cvars: the settings as they are, each cvar switched off, and all of them off. A cvar
   * that is off already is left out with a note.
   * @param names The cvars.
   * @returns The variants, `null` when a name is no cvar.
   */
  static #buildVariants(names: readonly string[]): BenchVariant[] | null {
    const variants: BenchVariant[] = [{ label: 'as set', changes: [] }];
    const all: Array<readonly [string, string]> = [];

    for (const name of names) {
      const cvar = Cvar.FindVar(name);

      if (cvar === null) {
        Con.PrintWarning(`r_bench: ${name} is no cvar\n`);
        return null;
      }

      if (cvar.value === 0) {
        Con.Print(`r_bench: ${name} is 0 already, left out\n`);
        continue;
      }

      variants.push({ label: `${name} 0`, changes: [[name, '0']] });
      all.push([name, '0']);
    }

    if (all.length > 1) {
      variants.push({ label: 'all of them 0', changes: all });
    }

    return variants;
  }

  /**
   * Starts a run.
   * @param variants What to measure, in order.
   * @param frames Drawn frames per variant.
   * @param rounds How often the variants are measured, one after the other each time.
   */
  static #start(variants: readonly BenchVariant[], frames: number, rounds: number): void {
    FrameBenchmark.results.length = 0;
    FrameBenchmark.#variants.length = 0;

    for (let round = 0; round < rounds; round++) {
      FrameBenchmark.#variants.push(...variants);
    }

    FrameBenchmark.#saved.clear();
    FrameBenchmark.#frames = frames;

    FrameBenchmark.#set('r_speeds', '1');
    FrameProfiler.holdWindow(true);

    Con.Print(`r_bench: ${variants.length} variants, ${rounds} rounds, ${frames} frames each, stand still\n`);
    FrameBenchmark.#enter(0);
  }

  /** Steps the run on; the screen calls it before every drawn frame. */
  static Frame(): void {
    if (!FrameBenchmark.running) {
      return;
    }

    if (clientStaticState.signon !== 4) {
      FrameBenchmark.#abort('the game ended');
      return;
    }

    FrameBenchmark.#frame++;

    if (FrameBenchmark.#frame === SETTLE_FRAMES) {
      // the frames with the change still settling are thrown away
      FrameProfiler.summarizeNow();
      return;
    }

    if (FrameBenchmark.#frame < SETTLE_FRAMES + FrameBenchmark.#frames) {
      return;
    }

    FrameProfiler.summarizeNow();
    FrameBenchmark.results.push(FrameBenchmark.#takeResult(FrameBenchmark.#variants[FrameBenchmark.#index].label));

    if (FrameBenchmark.#index + 1 < FrameBenchmark.#variants.length) {
      FrameBenchmark.#enter(FrameBenchmark.#index + 1);
      return;
    }

    FrameBenchmark.#finish();
    FrameBenchmark.#report();
  }

  /** Prints the report of the last run. */
  static #report(): void {
    for (const line of BenchReport.lines(FrameBenchmark.results)) {
      Con.Print(`${line}\n`);
    }
  }

  /**
   * Applies a variant: puts back what the one before changed, then sets its own cvars.
   * @param index The variant.
   */
  static #enter(index: number): void {
    FrameBenchmark.#restore(new Set(['r_speeds']));
    FrameBenchmark.#index = index;
    FrameBenchmark.#frame = 0;

    for (const [name, value] of FrameBenchmark.#variants[index].changes) {
      FrameBenchmark.#set(name, value);
    }
  }

  /**
   * Sets a cvar for the run, remembering what it was the first time.
   * @param name The cvar.
   * @param value What it is set to.
   */
  static #set(name: string, value: string): void {
    const cvar = Cvar.FindVar(name);

    if (cvar === null) {
      return;
    }

    if (!FrameBenchmark.#saved.has(name)) {
      FrameBenchmark.#saved.set(name, cvar.string);
    }

    Cvar.Set(name, value);
  }

  /**
   * Puts the saved cvars back.
   * @param keep Cvars that stay as the run set them.
   */
  static #restore(keep: ReadonlySet<string> = new Set()): void {
    for (const [name, value] of FrameBenchmark.#saved) {
      if (keep.has(name)) {
        continue;
      }

      Cvar.Set(name, value);
      FrameBenchmark.#saved.delete(name);
    }
  }

  /**
   * Reads what the profiler summarized for the variant.
   * @param label The variant.
   * @returns The result.
   */
  static #takeResult(label: string): BenchResult {
    const summary = FrameProfiler.summary;

    return {
      label,
      frameMs: summary.frameMs,
      maxFrameMs: summary.maxFrameMs,
      cpuMs: summary.cpuMs,
      gpuMs: summary.gpuMs,
      hasGpu: summary.hasGpu,
      sectionGpuMs: BenchReport.sections.map(([, path]) => FrameBenchmark.#inclusiveGpuMs(FrameBenchmark.#sectionAt(path))),
      ownGpuMs: FrameBenchmark.#collectOwnGpuMs(FrameProfiler.root, new Map()),
      gpuSpreadMs: 0,
    };
  }

  /**
   * Adds the own GPU time of every section below one that ran in the window to a map, by `parent > name`.
   * @param section Where to start.
   * @param into The map.
   * @returns The map.
   */
  static #collectOwnGpuMs(section: ProfileSection, into: Map<string, number>): Map<string, number> {
    for (const child of section.children.values()) {
      if (child.shownCalls > 0) {
        into.set(section === FrameProfiler.root ? child.name : `${section.name} > ${child.name}`, child.shownGpuMs);
      }

      FrameBenchmark.#collectOwnGpuMs(child, into);
    }

    return into;
  }

  /**
   * The GPU time of a section and of everything nested in it.
   * @param section The section, `null` when it did not run.
   * @returns Milliseconds per drawn frame.
   */
  static #inclusiveGpuMs(section: ProfileSection | null): number {
    if (section === null) {
      return 0;
    }

    let total = section.shownGpuMs;

    for (const child of section.children.values()) {
      total += FrameBenchmark.#inclusiveGpuMs(child);
    }

    return total;
  }

  /**
   * The section at a path below the root of the profiler.
   * @param path The names from the outermost section in.
   * @returns The section, `null` when it never ran.
   */
  static #sectionAt(path: readonly string[]): ProfileSection | null {
    let section: ProfileSection | undefined = FrameProfiler.root;

    for (const name of path) {
      section = section.children.get(name);

      if (section === undefined) {
        return null;
      }
    }

    return section;
  }

  /** Ends a run and puts every cvar back. */
  static #finish(): void {
    FrameProfiler.holdWindow(false);
    FrameBenchmark.#restore();
    FrameBenchmark.#index = -1;
    FrameBenchmark.#frame = 0;
  }

  /**
   * Ends a run early, keeping what was measured so far.
   * @param reason Why, for the console.
   */
  static #abort(reason: string): void {
    FrameBenchmark.#finish();
    Con.Print(`r_bench: ${reason}, settings restored\n`);
    FrameBenchmark.#report();
  }
}

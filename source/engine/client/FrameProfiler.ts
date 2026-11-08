import Cmd from '../common/Cmd.ts';
import Con from '../common/Console.ts';
import { eventBus } from '../common/EventBus.ts';
import GL from './GL.ts';
import Sys from './Sys.ts';
import rendererCvars from './renderer/resources/RendererCvars.ts';

let gl: WebGL2RenderingContext = null!;

/** What of `EXT_disjoint_timer_query_webgl2` is used; the DOM typings do not have it. */
interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: GLenum;
  readonly GPU_DISJOINT_EXT: GLenum;
}

/** How long the times are averaged over before the shown numbers change, in milliseconds. */
const WINDOW_MS = 500;

/** Timer queries that may wait for their result at once; more are not issued, a lost context never answers. */
const MAX_PENDING_QUERIES = 1024;

/** The totals of the last window, per drawn frame. */
export interface FrameSummary {
  /** Drawn frames in the window. */
  frames: number;

  /** Milliseconds from one drawn frame to the next, on average. */
  frameMs: number;

  /** The longest time from one drawn frame to the next. */
  maxFrameMs: number;

  /** CPU milliseconds of all sections. */
  cpuMs: number;

  /** GPU milliseconds of all sections, 0 without timer queries. */
  gpuMs: number;

  /** Whether any GPU time came in. */
  hasGpu: boolean;
}

/** A named section of the frame, with its time and the sections that were opened inside it. */
export class ProfileSection {
  /** What the section is called on screen. */
  readonly name: string;

  /** How many sections it is nested in. */
  readonly depth: number;

  /** The sections opened inside it, in the order they were first seen. */
  readonly children = new Map<string, ProfileSection>();

  /** CPU milliseconds spent in the section itself, children left out, in the current window. */
  cpuMs = 0;

  /** GPU milliseconds of the commands the section issued itself, children left out, in the current window. */
  gpuMs = 0;

  /** How often the section was entered in the current window. */
  calls = 0;

  /** CPU milliseconds of the section itself in the drawn frame that runs, with the host frames up to the next one. */
  frameCpuMs = 0;

  /** The most CPU time of the section itself in one drawn frame of the current window. */
  maxCpuMs = 0;

  /** CPU milliseconds per drawn frame of the last window. */
  shownCpuMs = 0;

  /** GPU milliseconds per drawn frame of the last window. */
  shownGpuMs = 0;

  /** Times the section was entered per drawn frame in the last window. */
  shownCalls = 0;

  /** The most CPU milliseconds of one drawn frame of the last window: a hitch that the average spreads out. */
  shownMaxCpuMs = 0;

  constructor(name: string, depth: number) {
    this.name = name;
    this.depth = depth;
  }

  /**
   * The child of that name, made when it was not seen before.
   * @param name The name of the child.
   * @returns The child.
   */
  child(name: string): ProfileSection {
    let section = this.children.get(name);

    if (section === undefined) {
      section = new ProfileSection(name, this.depth + 1);
      this.children.set(name, section);
    }

    return section;
  }
}

/**
 * Where a frame spends its time, by named sections, for `r_speeds`. A section is opened with {@link FrameProfiler.begin}
 * and closed with {@link FrameProfiler.end}; sections nest, and the time of a section is its own, the time of the
 * sections inside it left out, so the numbers of all sections add up to the frame.
 *
 * - The CPU time is wall-clock time on the main thread. The GL calls only queue commands, so a section that draws a
 *   lot can still be cheap on the CPU.
 * - The GPU time comes from `EXT_disjoint_timer_query_webgl2` timer queries, when the browser has it. Queries can not
 *   nest, so opening a section ends the query of the section around it and closing it starts a new one for the
 *   outer section. Results come in a few frames late and are added to the window they arrive in.
 *   `scripts/renderer-capture/gpu-bench.mjs` runs a query of its own around the scene, so leave `r_speeds` off
 *   while it measures: two timer queries can not run at once.
 * - `r_speeds 2` calls `gl.finish()` at every section border while drawing, so the CPU time of a section includes
 *   waiting for the GPU to finish its commands: a fallback for browsers without timer queries, which slows the frame
 *   down and leaves the GPU idle between sections.
 *
 * Sections outside of {@link FrameProfiler.beginFrame} and {@link FrameProfiler.endFrame} (the host frame, which runs
 * in its own task before the browser asks for the drawing) are measured on the CPU only. All numbers are averages
 * per drawn frame over half a second, except the worst column: the CPU time of a section in the drawn frame of the
 * window in which it took longest, so that a single hitch is not mistaken for a cost of every frame.
 *
 * Nothing is measured while `r_speeds` is 0; a section then costs a check of a flag.
 */
export default class FrameProfiler {
  /** The sections that are not inside another one. */
  static readonly root = new ProfileSection('frame', -1);

  /** The lines that `RenderStats` shows, built at the end of every window. */
  static readonly lines: string[] = [];

  /** The totals of the last window, next to the numbers of every section in {@link FrameProfiler.root}. */
  static readonly summary: FrameSummary = { frames: 0, frameMs: 0, maxFrameMs: 0, cpuMs: 0, gpuMs: 0, hasGpu: false };

  static #enabled = false;
  static #drawing = false;
  static #finishEach = false;
  static #timer: TimerQueryExtension | null = null;

  static readonly #stack: ProfileSection[] = [];
  static readonly #starts: number[] = [];
  static readonly #childMs: number[] = [];

  static #openQuery: WebGLQuery | null = null;
  static readonly #pendingQueries: WebGLQuery[] = [];
  static readonly #pendingSections: ProfileSection[] = [];
  static readonly #freeQueries: WebGLQuery[] = [];

  static #windowStart = 0;
  static #frameStart = 0;
  static #maxFrameMs = 0;
  static #frames = 0;
  static #hostFrames = 0;
  static #gpuResults = 0;
  static #held = false;

  /** Registers `r_profile`, which prints the numbers of the last window to the console. */
  static Init(): void {
    Cmd.AddCommand('r_profile', FrameProfiler.Print_f);
  }

  /**
   * Takes the GL context. The timer query extension is asked for when measuring starts.
   * @param context The context of the page.
   */
  static attach(context: WebGL2RenderingContext): void {
    gl = context;
  }

  /** Lets go of the GL context; its queries are gone with it, measuring starts over with the next context. */
  static detach(): void {
    FrameProfiler.#stop();
    FrameProfiler.#timer = null;
    gl = null!;
  }

  /**
   * Starts a drawn frame: decides from `r_speeds` whether this frame and the host frames up to the next one are
   * measured, collects the GPU times that came in, ends the window when it is over, and opens the `draw` section.
   */
  static beginFrame(): void {
    const mode = rendererCvars.speeds.value;

    if (mode === 0) {
      if (FrameProfiler.#enabled) {
        FrameProfiler.#stop();
      }
      return;
    }

    if (!FrameProfiler.#enabled) {
      FrameProfiler.#start();
    }

    // a host error can leave a section open
    console.assert(FrameProfiler.#stack.length === 0, 'FrameProfiler: sections were left open', FrameProfiler.#stack.map((section) => section.name));
    FrameProfiler.#stack.length = 0;
    FrameProfiler.#starts.length = 0;
    FrameProfiler.#childMs.length = 0;

    FrameProfiler.#finishEach = mode >= 2;
    FrameProfiler.#collectGpuResults();

    const now = Sys.FloatMilliTime();

    if (FrameProfiler.#frames > 0) {
      FrameProfiler.#closeDrawnFrame(now);

      if (!FrameProfiler.#held && now - FrameProfiler.#windowStart >= WINDOW_MS) {
        FrameProfiler.#summarize(now);
      }
    }

    FrameProfiler.#frameStart = now;

    FrameProfiler.#frames++;
    FrameProfiler.#drawing = true;
    FrameProfiler.begin('draw');
  }

  /**
   * Keeps the window open until {@link FrameProfiler.summarizeNow} ends it, instead of ending it every half second, so
   * a measurement covers the frames it asked for.
   * @param held True to hold the window, false to go back to half a second.
   */
  static holdWindow(held: boolean): void {
    FrameProfiler.#held = held;
  }

  /**
   * Ends the window now, between two drawn frames: the numbers of the frames since the last window are shown, and
   * the next window starts empty. GPU times that have not come in yet go to the next window.
   */
  static summarizeNow(): void {
    if (!FrameProfiler.#enabled || FrameProfiler.#frames === 0) {
      return;
    }

    const now = Sys.FloatMilliTime();

    FrameProfiler.#collectGpuResults();
    FrameProfiler.#closeDrawnFrame(now);
    FrameProfiler.#summarize(now);
  }

  /** Ends a drawn frame, closing the `draw` section. */
  static endFrame(): void {
    if (!FrameProfiler.#enabled) {
      return;
    }

    FrameProfiler.end();
    FrameProfiler.#switchQuery(null);
    FrameProfiler.#drawing = false;
  }

  /** Counts a host frame, so the summary can say how many ran per drawn frame. */
  static countHostFrame(): void {
    if (FrameProfiler.#enabled) {
      FrameProfiler.#hostFrames++;
    }
  }

  /**
   * Opens a section inside the one that is open. Every call has to be matched by {@link FrameProfiler.end} in the
   * same task.
   * @param name What the section is called; the same name inside the same section adds to the same numbers.
   */
  static begin(name: string): void {
    if (!FrameProfiler.#enabled) {
      return;
    }

    const stack = FrameProfiler.#stack;
    const parent = stack.length > 0 ? stack[stack.length - 1] : FrameProfiler.root;
    const section = parent.child(name);

    if (FrameProfiler.#drawing) {
      if (FrameProfiler.#finishEach) {
        gl.finish();
      }
      FrameProfiler.#switchQuery(section);
    }

    stack.push(section);
    FrameProfiler.#starts.push(Sys.FloatMilliTime());
    FrameProfiler.#childMs.push(0);
  }

  /** Closes the section that was opened last. */
  static end(): void {
    if (!FrameProfiler.#enabled) {
      return;
    }

    const stack = FrameProfiler.#stack;
    const top = stack.length - 1;

    if (top < 0) {
      // the stack was reset by beginFrame() after a host error left a section open
      return;
    }

    if (FrameProfiler.#drawing && FrameProfiler.#finishEach) {
      gl.finish();
    }

    const elapsed = Sys.FloatMilliTime() - FrameProfiler.#starts[top];
    const section = stack[top];

    const own = elapsed - FrameProfiler.#childMs[top];

    section.cpuMs += own;
    section.frameCpuMs += own;
    section.calls++;

    stack.length = top;
    FrameProfiler.#starts.length = top;
    FrameProfiler.#childMs.length = top;

    if (top > 0) {
      FrameProfiler.#childMs[top - 1] += elapsed;
    }

    if (FrameProfiler.#drawing) {
      FrameProfiler.#switchQuery(top > 0 ? stack[top - 1] : null);
    }
  }

  /** Prints the numbers of the last window to the console, to copy them out. */
  static Print_f(this: void): void {
    if (FrameProfiler.lines.length === 0) {
      Con.Print('Nothing measured yet, set r_speeds 1 and wait half a second.\n');
      return;
    }

    for (const line of FrameProfiler.lines) {
      Con.Print(`${line}\n`);
    }
  }

  /** Starts measuring with an empty window. */
  static #start(): void {
    FrameProfiler.#enabled = true;
    FrameProfiler.#timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null;
    FrameProfiler.#windowStart = Sys.FloatMilliTime();
    FrameProfiler.#maxFrameMs = 0;
    FrameProfiler.#frames = 0;
    FrameProfiler.#hostFrames = 0;
    FrameProfiler.#gpuResults = 0;
    FrameProfiler.#held = false;
    FrameProfiler.root.children.clear();
    FrameProfiler.lines.length = 0;
  }

  /** Stops measuring and gives the queries back. */
  static #stop(): void {
    FrameProfiler.#enabled = false;
    FrameProfiler.#drawing = false;
    FrameProfiler.#stack.length = 0;
    FrameProfiler.#starts.length = 0;
    FrameProfiler.#childMs.length = 0;
    FrameProfiler.#forgetQueries();
  }

  /**
   * Ends the timer query that runs and starts one for the section, so the GPU time between the two calls is
   * charged to the section that was open.
   * @param section The section to charge from now on, `null` for none.
   */
  static #switchQuery(section: ProfileSection | null): void {
    const timer = FrameProfiler.#timer;

    if (timer === null) {
      return;
    }

    if (FrameProfiler.#openQuery !== null) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      FrameProfiler.#openQuery = null;
    }

    if (section === null || FrameProfiler.#pendingQueries.length >= MAX_PENDING_QUERIES) {
      return;
    }

    const query = FrameProfiler.#freeQueries.pop() ?? gl.createQuery();

    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    FrameProfiler.#openQuery = query;
    FrameProfiler.#pendingQueries.push(query);
    FrameProfiler.#pendingSections.push(section);
  }

  /** Adds the results of the queries that finished to their sections, in the order they were issued. */
  static #collectGpuResults(): void {
    const timer = FrameProfiler.#timer;
    const queries = FrameProfiler.#pendingQueries;
    const sections = FrameProfiler.#pendingSections;

    if (timer === null || queries.length === 0) {
      return;
    }

    // a disjoint operation (a power state change, a context switch) makes the results of the running queries useless
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean;
    let done = 0;

    while (done < queries.length) {
      const query = queries[done];

      if (!(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean)) {
        break;
      }

      if (!disjoint) {
        sections[done].gpuMs += (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
        FrameProfiler.#gpuResults++;
      }

      FrameProfiler.#freeQueries.push(query);
      done++;
    }

    queries.copyWithin(0, done);
    sections.copyWithin(0, done);
    queries.length -= done;
    sections.length -= done;
  }

  /** Deletes every query, pending or free. */
  static #forgetQueries(): void {
    if (gl !== null && FrameProfiler.#timer !== null) {
      if (FrameProfiler.#openQuery !== null) {
        gl.endQuery(FrameProfiler.#timer.TIME_ELAPSED_EXT);
      }

      for (const query of FrameProfiler.#pendingQueries) {
        gl.deleteQuery(query);
      }

      for (const query of FrameProfiler.#freeQueries) {
        gl.deleteQuery(query);
      }
    }

    FrameProfiler.#openQuery = null;
    FrameProfiler.#pendingQueries.length = 0;
    FrameProfiler.#pendingSections.length = 0;
    FrameProfiler.#freeQueries.length = 0;
  }

  /**
   * Turns the window's sums into numbers per drawn frame, builds {@link FrameProfiler.lines} and starts the next window.
   * @param now The time the window ends.
   */
  static #summarize(now: number): void {
    const frames = FrameProfiler.#frames;
    const hasGpu = FrameProfiler.#gpuResults > 0;
    const lines = FrameProfiler.lines;
    const totals = { cpuMs: 0, gpuMs: 0, slowestCpu: FrameProfiler.root, slowestGpu: FrameProfiler.root };

    FrameProfiler.#settle(FrameProfiler.root, frames, totals);

    lines.length = 0;
    lines.push(`${'section'.padEnd(26)}${'cpu ms'.padStart(7)}${'worst'.padStart(7)}${'gpu ms'.padStart(7)}${'calls'.padStart(6)}`);
    FrameProfiler.#describe(FrameProfiler.root, hasGpu, lines);

    const gpuTotal = hasGpu ? totals.gpuMs.toFixed(2) : FrameProfiler.#timer === null ? 'n/a (try r_speeds 2)' : '-';
    const frameMs = (now - FrameProfiler.#windowStart) / frames;
    const summary = FrameProfiler.summary;

    summary.frames = frames;
    summary.frameMs = frameMs;
    summary.maxFrameMs = FrameProfiler.#maxFrameMs;
    summary.cpuMs = totals.cpuMs;
    summary.gpuMs = totals.gpuMs;
    summary.hasGpu = hasGpu;

    lines.push(`total cpu ${totals.cpuMs.toFixed(2)} ms, gpu ${gpuTotal} ms; ${frameMs.toFixed(2)} ms between frames (worst ${FrameProfiler.#maxFrameMs.toFixed(1)}), ${(FrameProfiler.#hostFrames / frames).toFixed(1)} host frames each`);
    lines.push(`most cpu: ${totals.slowestCpu.name} ${totals.slowestCpu.shownCpuMs.toFixed(2)} ms${hasGpu ? `, most gpu: ${totals.slowestGpu.name} ${totals.slowestGpu.shownGpuMs.toFixed(2)} ms` : ''}`);

    FrameProfiler.#windowStart = now;
    FrameProfiler.#maxFrameMs = 0;
    FrameProfiler.#frames = 0;
    FrameProfiler.#hostFrames = 0;
    FrameProfiler.#gpuResults = 0;
  }

  /**
   * Ends the drawn frame that began last, with the host frames after it: keeps the time to the next one and the CPU
   * time of every section when they are the worst of the window.
   * @param now The time the frame ends.
   */
  static #closeDrawnFrame(now: number): void {
    FrameProfiler.#maxFrameMs = Math.max(FrameProfiler.#maxFrameMs, now - FrameProfiler.#frameStart);
    FrameProfiler.#closeFrame(FrameProfiler.root);
  }

  /**
   * Ends the drawn frame for a section and its children: keeps the frame's CPU time when it is the worst of the
   * window, and starts the next frame at zero.
   * @param section The section.
   */
  static #closeFrame(section: ProfileSection): void {
    for (const child of section.children.values()) {
      child.maxCpuMs = Math.max(child.maxCpuMs, child.frameCpuMs);
      child.frameCpuMs = 0;
      FrameProfiler.#closeFrame(child);
    }
  }

  /**
   * Moves the sums of a section and its children into the shown numbers and adds them to the totals.
   * @param section The section.
   * @param frames Drawn frames in the window.
   * @param totals The totals and the slowest sections so far.
   * @param totals.cpuMs Sum of the CPU time of all sections.
   * @param totals.gpuMs Sum of the GPU time of all sections.
   * @param totals.slowestCpu The section with the most CPU time.
   * @param totals.slowestGpu The section with the most GPU time.
   */
  static #settle(section: ProfileSection, frames: number, totals: { cpuMs: number; gpuMs: number; slowestCpu: ProfileSection; slowestGpu: ProfileSection }): void {
    for (const child of section.children.values()) {
      child.shownCpuMs = child.cpuMs / frames;
      child.shownGpuMs = child.gpuMs / frames;
      child.shownCalls = child.calls / frames;
      child.shownMaxCpuMs = child.maxCpuMs;
      child.maxCpuMs = 0;
      child.cpuMs = 0;
      child.gpuMs = 0;
      child.calls = 0;

      totals.cpuMs += child.shownCpuMs;
      totals.gpuMs += child.shownGpuMs;

      if (child.shownCpuMs > totals.slowestCpu.shownCpuMs) {
        totals.slowestCpu = child;
      }

      if (child.shownGpuMs > totals.slowestGpu.shownGpuMs) {
        totals.slowestGpu = child;
      }

      FrameProfiler.#settle(child, frames, totals);
    }
  }

  /**
   * Adds a line for every child of the section that ran in the window, depth first.
   * @param section The section.
   * @param hasGpu Whether there are GPU times to show.
   * @param lines Where the lines go.
   */
  static #describe(section: ProfileSection, hasGpu: boolean, lines: string[]): void {
    for (const child of section.children.values()) {
      if (child.shownCalls === 0) {
        continue;
      }

      const name = `${'  '.repeat(child.depth)}${child.name}`.slice(0, 25).padEnd(26);
      const gpu = hasGpu ? child.shownGpuMs.toFixed(2) : '-';
      const calls = child.shownCalls.toFixed(1) === '1.0' ? '' : child.shownCalls.toFixed(1);

      lines.push(`${name}${child.shownCpuMs.toFixed(2).padStart(7)}${child.shownMaxCpuMs.toFixed(2).padStart(7)}${gpu.padStart(7)}${calls.padStart(6)}`);
      FrameProfiler.#describe(child, hasGpu, lines);
    }
  }
}

eventBus.subscribe('gl.ready', () => {
  FrameProfiler.attach(GL.gl);
});

eventBus.subscribe('gl.shutdown', () => {
  FrameProfiler.detach();
});

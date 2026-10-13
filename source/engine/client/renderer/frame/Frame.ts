import Cmd from '../../../common/Cmd.ts';
import Con from '../../../common/Console.ts';
import type { GLRenderTexture } from '../../GL.ts';
import RenderTarget from './RenderTarget.ts';

/** One pass of a frame as it was recorded. */
export interface FramePassRecord {
  /** The name the pass was opened with. */
  readonly name: string;

  /** How many passes were open when it started. */
  readonly depth: number;

  /** What it draws into: a target's name, `screen`, and `a -> b` when a resolve moved it. */
  output: string;

  /** The textures it samples, by the names their targets gave them. */
  readonly inputs: readonly string[];

  /** What was wrong with it, see {@link Frame.violations}. */
  readonly violations: string[];
}

/** A pass that has been opened and not yet closed. */
interface OpenPass {
  readonly name: string;
  output: RenderTarget | null;
  readonly record: FramePassRecord;
}

const NO_TEXTURES: readonly GLRenderTexture[] = [];

/**
 * What the frame does, pass by pass, and a check that it does not hurt itself. A pass is opened with the target it
 * draws into and the textures it samples, and closed when it is done; the frame knows from the targets themselves
 * which textures are attached to which framebuffer and which framebuffer is bound, so the declaration is the two
 * arguments and nothing else to keep in step.
 *
 * What is checked, in development builds only (every call below is a `console.assert`, which the production build
 * strips with its arguments, so a production build keeps no record and pays for nothing):
 *
 * - a pass samples a texture that is attached to the target it draws into (a feedback loop);
 * - a pass samples a texture of a target that nothing drew into this frame (a stale result, or a multisampled scene
 *   that was never resolved);
 * - a pass ends with another framebuffer bound than the one it was opened with;
 * - a pass is left open, or closed without having been opened.
 *
 * The record of the last frame is what the `r_framegraph` command prints.
 */
export default class Frame {
  /** What was wrong in the current frame, most recent last. */
  static readonly violations: string[] = [];

  static readonly #records: FramePassRecord[] = [];
  static readonly #open: OpenPass[] = [];
  static readonly #written = new Set<RenderTarget>();
  static #lastViolation = '';
  static #frameNumber = 0;
  static #recording = false;

  /** Registers `r_framegraph`. */
  static Init(): void {
    Cmd.AddCommand('r_framegraph', Frame.Dump_f);
  }

  /** Prints the passes of the last frame, indented by nesting, with what each one drew into and sampled. */
  static Dump_f(this: void): void {
    if (!Frame.#recording) {
      Con.Print('The frame is only recorded in development builds.\n');
      return;
    }

    Con.Print(`frame ${Frame.#frameNumber}: ${Frame.#records.length} passes, ${Frame.violations.length} violations\n`);

    for (const record of Frame.#records) {
      const reads = record.inputs.length > 0 ? record.inputs.join(', ') : '-';

      Con.Print(`${'  '.repeat(record.depth)}${record.name} -> ${record.output}  reads ${reads}\n`);

      for (const violation of record.violations) {
        Con.Print(`${'  '.repeat(record.depth)}  !! ${violation}\n`);
      }
    }
  }

  /** Starts the record of a frame. Passes still open from the previous one are a violation. */
  static beginFrame(): void {
    console.assert(Frame.#startFrame(), Frame.#lastViolation);
  }

  /**
   * Opens a pass. The framebuffer of its target has to be bound by the caller, as it was before.
   * @param name What the pass is called in the record.
   * @param output The target it draws into, `null` for the screen.
   * @param input The texture it is given to work on, `null` for a pass that has none.
   * @param extraInputs The other textures it samples, which the pass knows and the frame cannot. Kept apart from
   * `input` so that a call allocates nothing in a build that does not record.
   */
  static beginPass(name: string, output: RenderTarget | null, input: GLRenderTexture | null = null, extraInputs: readonly GLRenderTexture[] = NO_TEXTURES): void {
    console.assert(Frame.#enter(name, output, input, extraInputs), Frame.#lastViolation);
  }

  /**
   * Says that the pass that is open goes on drawing into another target: a multisampled scene that was resolved
   * continues in the resolved one.
   * @param output The target.
   */
  static continueIn(output: RenderTarget): void {
    console.assert(Frame.#redirect(output), Frame.#lastViolation);
  }

  /**
   * Says that this frame shows what an earlier frame drew into a target, because it drew nothing into it itself (a
   * map that is loading still presents the last picture). Without this, sampling the target would be reported as
   * the read of a result nothing produced.
   * @param target The target whose picture is shown again.
   */
  static reuse(target: RenderTarget): void {
    console.assert(Frame.#carryOver(target), Frame.#lastViolation);
  }

  /** Closes the pass that was opened last; the framebuffer bound now has to be the one of its target. */
  static endPass(): void {
    console.assert(Frame.#leave(), Frame.#lastViolation);
  }

  /**
   * The passes of the last frame.
   * @returns The records in the order the passes were opened.
   */
  static get records(): readonly FramePassRecord[] {
    return Frame.#records;
  }

  /**
   * Resets the record.
   * @returns False when passes were left open.
   */
  static #startFrame(): boolean {
    let clean = true;

    if (Frame.#open.length > 0) {
      Frame.#lastViolation = `passes were left open by the previous frame: ${Frame.#open.map((pass) => pass.name).join(', ')}`;
      clean = false;
    }

    Frame.#recording = true;
    Frame.#frameNumber++;
    Frame.#records.length = 0;
    Frame.#open.length = 0;
    Frame.#written.clear();
    Frame.violations.length = 0;

    if (!clean) {
      Frame.violations.push(Frame.#lastViolation);
    }

    return clean;
  }

  /**
   * Records the opening of a pass and checks its inputs.
   * @returns False when an input is a hazard.
   */
  static #enter(name: string, output: RenderTarget | null, input: GLRenderTexture | null, extraInputs: readonly GLRenderTexture[]): boolean {
    const inputs = input === null ? extraInputs : [input, ...extraInputs];
    const record: FramePassRecord = {
      name,
      depth: Frame.#open.length,
      output: output?.name ?? 'screen',
      inputs: inputs.map((texture) => RenderTarget.describeTexture(texture)),
      violations: [],
    };
    let clean = true;

    for (const texture of inputs) {
      const label = RenderTarget.describeTexture(texture);

      if (output !== null && output.isAttached(texture)) {
        Frame.#report(record, `${name} samples ${label}, which is attached to its own output ${output.name}`);
        clean = false;
      }

      const owner = RenderTarget.ownerOf(texture);

      if (owner !== null && !owner.persistent && !Frame.#written.has(owner)) {
        Frame.#report(record, `${name} samples ${label} before anything drew into ${owner.name} this frame`);
        clean = false;
      }
    }

    if (output !== null) {
      Frame.#written.add(output);
    }

    Frame.#records.push(record);
    Frame.#open.push({ name, output, record });

    return clean;
  }

  /**
   * Records that a target is shown again.
   * @returns True.
   */
  static #carryOver(target: RenderTarget): boolean {
    Frame.#written.add(target);
    Frame.#records.push({
      name: `${target.name} of an earlier frame`,
      depth: Frame.#open.length,
      output: target.name,
      inputs: [],
      violations: [],
    });

    return true;
  }

  /**
   * Moves the output of the open pass.
   * @returns False when no pass is open.
   */
  static #redirect(output: RenderTarget): boolean {
    const pass = Frame.#open[Frame.#open.length - 1];

    if (pass === undefined) {
      Frame.#report(null, `continueIn(${output.name}) outside of a pass`);
      return false;
    }

    pass.output = output;
    pass.record.output = `${pass.record.output} -> ${output.name}`;
    Frame.#written.add(output);

    return true;
  }

  /**
   * Closes the pass that is open and checks the binding it leaves.
   * @returns False when it left another framebuffer bound, or none was open.
   */
  static #leave(): boolean {
    const pass = Frame.#open.pop();

    if (pass === undefined) {
      Frame.#report(null, 'endPass without an open pass');
      return false;
    }

    const bound = RenderTarget.bound;

    if (bound !== pass.output) {
      Frame.#report(pass.record, `${pass.name} ended with ${bound?.name ?? 'the screen'} bound, it draws into ${pass.output?.name ?? 'the screen'}`);
      return false;
    }

    return true;
  }

  /**
   * Notes a violation on the record of the pass it belongs to.
   * @param record The pass, `null` for one that is not about a pass.
   * @param message What is wrong.
   */
  static #report(record: FramePassRecord | null, message: string): void {
    Frame.#lastViolation = message;
    Frame.violations.push(message);
    record?.violations.push(message);
  }
}

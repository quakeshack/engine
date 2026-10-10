import { MissingResourceError } from '../../../common/Errors.ts';
import { type ExpandedShader, ShaderPreprocessor } from './ShaderPreprocessor.ts';

/**
 * Both stages of a program, with their includes expanded.
 */
export interface BuiltShaderProgram {
  readonly vertex: ExpandedShader;
  readonly fragment: ExpandedShader;
}

type ShaderSources = Record<string, string>;

/**
 * The shader programs (`shaders/<identifier>.vert` and `.frag`) and the chunks they include
 * (`shaders/include/*.glsl`), ready to hand to `GL.CreateProgram`.
 *
 * It lives apart from `GL.ts` on purpose: the shader text is only needed by a page with a GL context, and `GL.ts` is
 * reachable from the server worker. The composition root of the page installs a library into `GL.shaderLibrary`.
 */
export class ShaderLibrary {
  readonly #programs: Readonly<ShaderSources>;
  readonly #preprocessor: ShaderPreprocessor;
  readonly #built = new Map<string, BuiltShaderProgram>();

  /**
   * @param programs Stage sources by file name (`alias.frag`).
   * @param chunks Chunk sources by file name (`shadow-entity.glsl`).
   */
  constructor(programs: Readonly<ShaderSources>, chunks: Readonly<ShaderSources>) {
    this.#programs = programs;
    this.#preprocessor = new ShaderPreprocessor(chunks);
  }

  /**
   * Collects all shader files the bundler found next to this module.
   * @returns A library over the bundled shader files.
   */
  static fromBundle(): ShaderLibrary {
    let programs: ShaderSources;
    let chunks: ShaderSources;

    try {
      // Vite rewrites these at build time; raw Node.js leaves them undefined and falls through to the catch.
      // @ts-ignore Vite-specific import.meta.glob
      programs = ShaderLibrary.#byFileName(import.meta.glob('../../shaders/*.{vert,frag}', { eager: true, import: 'default', query: '?raw' }) as ShaderSources);
      // @ts-ignore Vite-specific import.meta.glob
      chunks = ShaderLibrary.#byFileName(import.meta.glob('../../shaders/include/*.glsl', { eager: true, import: 'default', query: '?raw' }) as ShaderSources);
    } catch {
      throw new Error('Shader sources are unavailable in this runtime');
    }

    return new ShaderLibrary(programs, chunks);
  }

  static #byFileName(sources: ShaderSources): ShaderSources {
    const byName: ShaderSources = {};

    for (const [path, source] of Object.entries(sources)) {
      byName[path.substring(path.lastIndexOf('/') + 1)] = source;
    }

    return byName;
  }

  /**
   * Identifiers of all programs that have a vertex and a fragment stage.
   * @returns The identifiers, sorted.
   */
  get programIdentifiers(): string[] {
    return Object.keys(this.#programs)
      .filter((name) => name.endsWith('.vert') && Object.hasOwn(this.#programs, `${name.slice(0, -5)}.frag`))
      .map((name) => name.slice(0, -5))
      .sort();
  }

  /**
   * Names of all chunk files.
   * @returns The chunk names, sorted.
   */
  get chunkNames(): string[] {
    return this.#preprocessor.chunkNames;
  }

  /**
   * Expands both stages of a program. The result is cached for the life of the library.
   * @param identifier Program identifier, i.e. the file name without extension.
   * @returns The expanded stages.
   */
  build(identifier: string): BuiltShaderProgram {
    const cached = this.#built.get(identifier);

    if (cached !== undefined) {
      return cached;
    }

    const vertexName = `${identifier}.vert`;
    const fragmentName = `${identifier}.frag`;
    const vertexSource = Object.hasOwn(this.#programs, vertexName) ? this.#programs[vertexName] : undefined;
    const fragmentSource = Object.hasOwn(this.#programs, fragmentName) ? this.#programs[fragmentName] : undefined;

    if (vertexSource === undefined || fragmentSource === undefined) {
      const missing = [vertexSource === undefined ? vertexName : null, fragmentSource === undefined ? fragmentName : null].filter((name) => name !== null);

      throw new MissingResourceError(
        `shaders/${missing.join(', shaders/')}. If these shader files were added while the dev session was already running, restart the active Vite build/watch process so import.meta.glob rebuilds the shader manifest.`,
      );
    }

    const program: BuiltShaderProgram = {
      vertex: this.#preprocessor.expand(vertexName, vertexSource),
      fragment: this.#preprocessor.expand(fragmentName, fragmentSource),
    };

    this.#built.set(identifier, program);

    return program;
  }
}

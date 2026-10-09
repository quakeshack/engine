/**
 * Result of expanding the `#include` lines of one shader stage.
 *
 * `files[n]` names the file that GLSL source string number `n` stands for, `files[0]` is the stage itself.
 * The `#line` directives in `source` use these numbers, so the driver reports errors as `<n>:<line>`.
 */
export class ExpandedShader {
  readonly source: string;
  readonly files: readonly string[];

  constructor(source: string, files: readonly string[]) {
    this.source = source;
    this.files = files;
  }

  /**
   * Rewrites a driver info log so that `ERROR: 2:41:` reads `ERROR: shadow-entity.glsl:41:`.
   * Lines whose source string number is not known are left alone.
   * @param log The info log of a compiled shader.
   * @returns The log with file names instead of source string numbers.
   */
  mapInfoLog(log: string): string {
    return log.replace(/^(ERROR|WARNING): (\d+):(\d+):/gm, (match, severity: string, stringNumber: string, line: string) => {
      const file = this.files[Number(stringNumber)];
      return file === undefined ? match : `${severity}: ${file}:${line}:`;
    });
  }
}

interface Expansion {
  readonly stageName: string;
  readonly files: string[];
  readonly included: Set<string>;
  readonly stack: string[];
  readonly out: string[];
}

/**
 * Expands `#include "name.glsl"` lines, the one thing GLSL ES 3.00 lacks.
 *
 * It is a pure function over strings (no GL context, no file system), so it runs in Node tests as well as in the
 * browser. Rules:
 * - `#include "name.glsl"` has to be the only thing on its line. The name is flat, it is looked up among the chunks
 *   handed to the constructor, no path separators and no `..`.
 * - A chunk is expanded once per stage, like `#pragma once`: a later include of the same chunk is dropped. Chunks may
 *   include chunks. A cycle, an unknown chunk or a malformed line throws.
 * - `#version` stays in the stage, it has to be the first line of the final source. A chunk must not have one.
 * - Every expanded chunk is wrapped in `#line` directives, so line numbers in driver messages stay those of the
 *   file that holds the line (see {@link ExpandedShader.mapInfoLog}).
 */
export class ShaderPreprocessor {
  static readonly #includeKeyword = /^\s*#\s*include\b/;
  static readonly #includeLine = /^\s*#\s*include\s+"([^"]*)"\s*$/;
  static readonly #chunkName = /^[A-Za-z0-9][A-Za-z0-9._-]*\.glsl$/;

  readonly #chunks: Readonly<Record<string, string>>;

  /**
   * @param chunks Chunk sources by name (`shadow-entity.glsl`).
   */
  constructor(chunks: Readonly<Record<string, string>>) {
    this.#chunks = chunks;
  }

  /**
   * Names of all chunks this preprocessor can include.
   * @returns The chunk names, sorted.
   */
  get chunkNames(): string[] {
    return Object.keys(this.#chunks).sort();
  }

  /**
   * Expands all includes of one shader stage.
   * @param stageName Name of the stage for messages and the file table, e.g. `alias.frag`.
   * @param source Source of the stage.
   * @returns The expanded source and the file table. A stage without includes comes back unchanged.
   */
  expand(stageName: string, source: string): ExpandedShader {
    const expansion: Expansion = { stageName, files: [stageName], included: new Set(), stack: [], out: [] };

    this.#expandInto(expansion, stageName, ShaderPreprocessor.#splitLines(source), 0);

    if (expansion.files.length === 1) {
      return new ExpandedShader(source, expansion.files);
    }

    return new ExpandedShader(expansion.out.join('\n'), expansion.files);
  }

  /**
   * Splits text into lines, tolerating CRLF and dropping the empty element a final newline would leave.
   * @param text Source text.
   * @returns The lines without line terminators.
   */
  static #splitLines(text: string): string[] {
    const lines = text.split(/\r?\n/);

    if (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines;
  }

  #expandInto(expansion: Expansion, fileName: string, lines: readonly string[], stringNumber: number): void {
    const { stageName, files, included, stack, out } = expansion;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];

      if (stringNumber !== 0 && /^\s*#\s*version\b/.test(line)) {
        throw new Error(`${stageName}: ${fileName}:${index + 1}: a chunk must not declare #version`);
      }

      if (!ShaderPreprocessor.#includeKeyword.test(line)) {
        out.push(line);
        continue;
      }

      const name = ShaderPreprocessor.#includeLine.exec(line)?.[1];

      if (name === undefined || !ShaderPreprocessor.#chunkName.test(name)) {
        throw new Error(`${stageName}: ${fileName}:${index + 1}: malformed include, expected #include "name.glsl" alone on its line (got: ${line.trim()})`);
      }

      if (stack.includes(name)) {
        throw new Error(`${stageName}: ${fileName}:${index + 1}: include cycle ${[...stack, name].join(' -> ')}`);
      }

      const chunk = Object.hasOwn(this.#chunks, name) ? this.#chunks[name] : undefined;

      if (chunk === undefined) {
        throw new Error(`${stageName}: ${fileName}:${index + 1}: unknown chunk "${name}"`);
      }

      if (included.has(name)) {
        // Keeps the line numbers of what follows.
        out.push('');
        continue;
      }

      included.add(name);
      files.push(name);
      stack.push(name);
      out.push(`#line 1 ${files.length - 1}`);
      this.#expandInto(expansion, name, ShaderPreprocessor.#splitLines(chunk), files.length - 1);
      stack.pop();
      out.push(`#line ${index + 2} ${stringNumber}`);
    }
  }
}

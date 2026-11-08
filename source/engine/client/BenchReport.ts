/** What one round of a variant of `r_bench` measured, per drawn frame, or the rounds of a variant merged. */
export interface BenchResult {
  /** The variant. */
  readonly label: string;

  /** Milliseconds from one drawn frame to the next, on average. */
  readonly frameMs: number;

  /** The longest time from one drawn frame to the next. */
  readonly maxFrameMs: number;

  /** CPU milliseconds of all sections. */
  readonly cpuMs: number;

  /** GPU milliseconds of all sections. */
  readonly gpuMs: number;

  /** Whether GPU times came in; without, the GPU numbers are 0. */
  readonly hasGpu: boolean;

  /** GPU milliseconds of each of {@link BenchReport.sections}, the sections nested in it included. */
  readonly sectionGpuMs: readonly number[];

  /** GPU milliseconds of every section that ran, its own only, by `parent > name`. */
  readonly ownGpuMs: ReadonlyMap<string, number>;

  /** How far the GPU time of the rounds lay apart, 0 for one round: a difference below it is noise. */
  readonly gpuSpreadMs: number;
}

/** How many of the sections that changed most are listed per variant. */
const LISTED_CHANGES = 3;

/** Width of a number column. */
const COLUMN_WIDTH = 7;

/** Width of the column with the name of the variant. */
const LABEL_WIDTH = 22;

/**
 * What `r_bench` makes of its results: the rounds of each variant merged, the variants compared with the first, and
 * the table it prints.
 */
export default class BenchReport {
  /** The section columns of the table: a short title and the path of the section below the profiler's root. */
  static readonly sections: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['scene', ['draw', 'scene']],
    ['world', ['draw', 'scene', 'world']],
    ['transp', ['draw', 'scene', 'transparent']],
    ['sky', ['draw', 'scene', 'sky']],
    ['shadow', ['draw', 'scene', 'shadow maps']],
    ['post', ['draw', 'post-process']],
  ];

  /**
   * Merges the rounds of each variant: the mean of every number, the worst frame of all, and the spread of the GPU
   * time between the rounds.
   * @param results The results of every round, in the order they were measured.
   * @returns One result per variant, in the order they first appear.
   */
  static combine(results: readonly BenchResult[]): BenchResult[] {
    const byLabel = new Map<string, BenchResult[]>();

    for (const result of results) {
      const rounds = byLabel.get(result.label) ?? [];
      rounds.push(result);
      byLabel.set(result.label, rounds);
    }

    return [...byLabel.values()].map((rounds) => BenchReport.#merge(rounds));
  }

  /**
   * The sections whose own GPU time differs most between two results, either way.
   * @param base The result compared against.
   * @param result The result.
   * @returns `section +1.23` items, the biggest difference first.
   */
  static biggestChanges(base: BenchResult, result: BenchResult): string[] {
    const names = new Set([...base.ownGpuMs.keys(), ...result.ownGpuMs.keys()]);
    const changes: Array<readonly [string, number]> = [];

    for (const name of names) {
      changes.push([name, (result.ownGpuMs.get(name) ?? 0) - (base.ownGpuMs.get(name) ?? 0)]);
    }

    changes.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

    return changes.slice(0, LISTED_CHANGES).map(([name, delta]) => `${name} ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`);
  }

  /**
   * The lines of the report of a run: a table with one row per variant, its rounds merged, then the sections that
   * changed most against the first row.
   * @param results The results of every round, in the order they were measured.
   * @returns The lines, none when nothing was measured.
   */
  static lines(results: readonly BenchResult[]): string[] {
    const merged = BenchReport.combine(results);

    if (merged.length === 0) {
      return [];
    }

    const base = merged[0];
    const titles = ['frame', 'worst', 'cpu', 'gpu', 'spread', 'dgpu', ...BenchReport.sections.map(([title]) => title)];
    const lines = [
      'r_bench: ms per frame, mean of the rounds; spread is how far the gpu time of the rounds lay apart, a dgpu (gpu less the first row) below it is noise; section columns include what is nested in them',
      `${'variant'.padEnd(LABEL_WIDTH)}${titles.map((title) => title.padStart(COLUMN_WIDTH)).join('')}`,
    ];

    for (const result of merged) {
      const gpu = result.hasGpu
        ? [result.gpuMs, result.gpuSpreadMs, result.gpuMs - base.gpuMs, ...result.sectionGpuMs].map(BenchReport.#column).join('')
        : 'n/a'.padStart(COLUMN_WIDTH);

      lines.push(`${BenchReport.#label(result)}${[result.frameMs, result.maxFrameMs, result.cpuMs].map(BenchReport.#column).join('')}${gpu}`);
    }

    if (!base.hasGpu) {
      lines.push('r_bench: this browser has no GPU timer queries, only the frame times are measured');
      return lines;
    }

    lines.push('r_bench: the sections whose own gpu time changed most against the first row');

    for (const result of merged.slice(1)) {
      lines.push(`${BenchReport.#label(result)}${BenchReport.biggestChanges(base, result).join(', ')}`);
    }

    return lines;
  }

  /**
   * Merges the rounds of one variant.
   * @param rounds Its results, at least one.
   * @returns The merged result.
   */
  static #merge(rounds: readonly BenchResult[]): BenchResult {
    const mean = (pick: (result: BenchResult) => number): number => rounds.reduce((sum, result) => sum + pick(result), 0) / rounds.length;
    const gpu = rounds.map((result) => result.gpuMs);
    const ownGpuMs = new Map<string, number>();

    for (const name of new Set(rounds.flatMap((result) => [...result.ownGpuMs.keys()]))) {
      ownGpuMs.set(name, mean((result) => result.ownGpuMs.get(name) ?? 0));
    }

    return {
      label: rounds[0].label,
      frameMs: mean((result) => result.frameMs),
      maxFrameMs: Math.max(...rounds.map((result) => result.maxFrameMs)),
      cpuMs: mean((result) => result.cpuMs),
      gpuMs: mean((result) => result.gpuMs),
      hasGpu: rounds.every((result) => result.hasGpu),
      sectionGpuMs: rounds[0].sectionGpuMs.map((_ms, index) => mean((result) => result.sectionGpuMs[index])),
      ownGpuMs,
      gpuSpreadMs: Math.max(...gpu) - Math.min(...gpu),
    };
  }

  /**
   * The first column of a row.
   * @param result The variant.
   * @returns Its name, cut and padded to the column.
   */
  static #label(result: BenchResult): string {
    return result.label.slice(0, LABEL_WIDTH - 1).padEnd(LABEL_WIDTH);
  }

  /**
   * A number column.
   * @param value The number.
   * @returns The number with two decimals, padded on the left.
   */
  static #column(this: void, value: number): string {
    return value.toFixed(2).padStart(COLUMN_WIDTH);
  }
}

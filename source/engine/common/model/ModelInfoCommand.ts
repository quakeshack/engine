import { ConsoleCommand } from '../Cmd.ts';
import Con from '../Console.ts';
import Mod, { ModelType } from '../Mod.ts';
import type { BaseModel } from './BaseModel.ts';
import { SkeletalModel } from './SkeletalModel.ts';

/**
 * Describes what a loaded model is made of, for `modelinfo` and for anyone who wants to read it.
 */
export class ModelInfo {
  private constructor() {
    // Static-only helper class.
  }

  /**
   * Describes a model in lines of text.
   * @returns The lines, without line breaks.
   */
  static describe(model: BaseModel): string[] {
    const lines = [
      `${model.name}: ${model.type === null ? 'unknown type' : ModelType[model.type]} model`,
      `  bounds ${ModelInfo.#vector(model.mins)} to ${ModelInfo.#vector(model.maxs)}`,
      `  ${model._num_frames} frames, ${model._num_skins} skins, ${model._num_verts} vertices, ${model._num_tris} triangles`,
    ];

    if (model instanceof SkeletalModel) {
      lines.push(...ModelInfo.#describeSkeletal(model));
    }

    return lines;
  }

  static #vector(vector: ArrayLike<number>): string {
    return `(${Array.from(vector, (value) => value.toFixed(2)).join(' ')})`;
  }

  static #describeSkeletal(model: SkeletalModel): string[] {
    const lines = [`  ${model.formatName}, bounding radius ${model.boundingradius.toFixed(2)}`];
    const depths = new Int32Array(model.jointCount);

    lines.push(`  ${model.jointCount} joints (each one is a tag):`);

    for (let joint = 0; joint < model.jointCount; joint++) {
      const parent = model.jointParents[joint];

      depths[joint] = parent < 0 ? 0 : depths[parent] + 1;
      lines.push(`    ${String(joint).padStart(3)} ${'  '.repeat(depths[joint])}${model.jointNames[joint]}`);
    }

    lines.push(`  ${model.sequences.length} sequences${model.sequences.length === 0 ? ' (driven by frame number only)' : ':'}`);

    for (const [index, sequence] of model.sequences.entries()) {
      const last = sequence.firstFrame + sequence.frameCount - 1;
      lines.push(`    ${String(index).padStart(3)} ${sequence.name}: frames ${sequence.firstFrame}-${last}, ${sequence.framerate} fps${sequence.loop ? ', loops' : ''}`);
    }

    if (model.meshData === null) {
      lines.push('  no mesh data in this realm');
      return lines;
    }

    lines.push(`  ${model.materials.length} materials:`);

    for (const [index, material] of model.materials.entries()) {
      lines.push(`    ${String(index).padStart(3)} ${material.name}`);
    }

    lines.push(`  ${model.meshes.length} meshes:`);

    for (const mesh of model.meshes) {
      lines.push(`    ${mesh.name}: material ${mesh.materialIndex}, ${mesh.vertexCount} vertices, ${mesh.triangleCount} triangles`);
    }

    return lines;
  }
}

/**
 * `modelinfo <model>`: prints bounds, counts and, for a skeletal model, its joints, sequences and materials.
 * Loads the model when it is not loaded yet.
 */
export class ModelInfoCommand extends ConsoleCommand {
  override async run(name?: string): Promise<void> {
    if (name === undefined) {
      Con.Print(`Usage: ${this.command} <model>\n`);
      return;
    }

    const model = await Mod.ForNameAsync(name, false);

    if (model === null) {
      Con.PrintError(`${this.command}: ${name} could not be loaded\n`);
      return;
    }

    Con.Print(`${ModelInfo.describe(model).join('\n')}\n`);
  }
}

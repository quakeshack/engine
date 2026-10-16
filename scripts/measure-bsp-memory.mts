/**
 * Measures what a loaded BSP costs on the JS heap, by structure.
 *
 * Dev tool for `plans/bsp-flat-layout.md`, not wired into any npm script. Run it with a forced GC available:
 *
 *   node --expose-gc --import tsx scripts/measure-bsp-memory.mts data/hellwave/maps/hw_village.bsp [more.bsp ...]
 *
 * It loads each map the way a server does (`loadRenderData: false`), then drops one group of structures at a time and
 * forces a collection after each, so the numbers are the memory that group alone keeps alive. The order of the groups
 * matters where they reference each other (the hulls point at the planes and clipnodes), so the order is fixed and printed.
 * Finally it builds a `Pmove` world from the model to show what its private copy of the hulls costs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// Mod.ts has to be evaluated before BSP2Loader, see test/common/bsp29-loader.test.ts.
import '../source/engine/common/Mod.ts';
import { BSP29Loader } from '../source/engine/common/model/loaders/BSP29Loader.ts';
import { BSP2Loader } from '../source/engine/common/model/loaders/BSP2Loader.ts';
import { Pmove } from '../source/engine/common/Pmove.ts';
import type { BrushModel } from '../source/engine/common/model/BSP.ts';
import { createModelLoadContext } from '../test/support/modelContext.ts';

const gc = globalThis.gc;

if (typeof gc !== 'function') {
  console.error('Run with --expose-gc, the numbers are meaningless without a forced collection.');
  process.exit(1);
}

/**
 * Forces a collection and reads what the heap and the array buffers hold.
 * @returns Bytes in use.
 */
function heapBytes(): number {
  gc!();
  gc!();
  return process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
}

/**
 * Formats a byte count for the report.
 * @param bytes Byte count.
 * @returns The count in megabytes, right aligned.
 */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`.padStart(10);
}

/**
 * Loads a map the way a server does, without render data.
 * @param file Path of the BSP file.
 * @returns The model, the file size and the time the load took.
 */
async function loadModel(file: string): Promise<{ model: BrushModel; fileSize: number; loadMs: number }> {
  const data = await fs.readFile(file);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const magic = data.toString('latin1', 0, 4);
  const context = createModelLoadContext();
  const loader = magic === 'BSP2' || magic === '2PSB' ? new BSP2Loader(context) : new BSP29Loader(context);
  const started = performance.now();
  const model = await loader.load(buffer, `maps/${path.basename(file)}`) as BrushModel;

  return { model, fileSize: data.length, loadMs: performance.now() - started };
}

/** Groups of members that are dropped together, in the order they are dropped. */
const GROUPS: { name: string; members: (keyof BrushModel)[] }[] = [
  { name: 'submodels (views of the world arrays)', members: ['submodels'] },
  { name: 'hulls', members: ['hulls'] },
  { name: 'nodes + leafs', members: ['nodes', 'leafs'] },
  { name: 'clipnodes', members: ['clipnodes'] },
  { name: 'planes', members: ['planes'] },
  { name: 'faces', members: ['faces'] },
  { name: 'vertexes', members: ['vertexes'] },
  { name: 'edges + surfedges', members: ['edges', 'surfedges'] },
  { name: 'texinfo', members: ['texinfo'] },
  { name: 'marksurfaces', members: ['marksurfaces'] },
  { name: 'brushes + sides + leafbrushes', members: ['brushes', 'brushsides', 'leafbrushes'] },
  { name: 'visdata + phsdata + cluster offsets', members: ['visdata', 'phsdata', 'clusterPvsOffsets', 'clusterPhsOffsets'] },
  { name: 'lightdata (grayscale)', members: ['lightdata'] },
  { name: 'lightdata_rgb', members: ['lightdata_rgb'] },
  { name: 'deluxemap', members: ['deluxemap'] },
  { name: 'lightgrid (octree objects)', members: ['lightgrid'] },
  { name: 'entities + chains + portals', members: ['entities', 'chains', 'portalDefs', 'areaPortals', 'fogVolumes'] },
];

/**
 *
 */
function dropMembers(model: BrushModel, members: (keyof BrushModel)[]): void {
  const record = model as unknown as Record<string, unknown>;

  for (const member of members) {
    const value = record[member];

    if (Array.isArray(value)) {
      record[member] = [];
    } else {
      record[member] = null;
    }
  }
}

/**
 * Summarizes how many elements the model has.
 * @param model Loaded model.
 * @returns A one-line summary.
 */
function countOf(model: BrushModel): string {
  return [
    `${model.planes.length} planes`,
    `${model.nodes.length} nodes`,
    `${model.leafs.length} leafs`,
    `${model.clipnodes.length} clipnodes`,
    `${model.faces.length} faces`,
    `${model.vertexes.length} vertexes`,
    `${model.brushes?.length ?? 0} brushes`,
  ].join(', ');
}

/**
 *
 */
async function measure(file: string): Promise<void> {
  const before = heapBytes();
  const { model, fileSize, loadMs } = await loadModel(file);
  const loaded = heapBytes() - before;

  console.log(`\n${file}`);
  console.log(`  file ${megabytes(fileSize)}   heap ${megabytes(loaded)}   factor ${(loaded / fileSize).toFixed(1)}x   load ${loadMs.toFixed(0)} ms`);
  console.log(`  ${countOf(model)}`);

  // What Pmove copies, measured while the model is still whole.
  const beforePmove = heapBytes();
  const pmove = new Pmove();
  pmove.setWorldmodel(model);
  const pmoveCopy = heapBytes() - beforePmove;
  console.log(`  Pmove world built from the model (private hull copies) ${megabytes(pmoveCopy)}`);
  pmove.physents.length = 0;

  let remaining = heapBytes();

  for (const group of GROUPS) {
    dropMembers(model, group.members);
    const now = heapBytes();
    console.log(`  ${group.name.padEnd(42)} ${megabytes(remaining - now)}`);
    remaining = now;
  }

  console.log(`  ${'left after all groups'.padEnd(42)} ${megabytes(remaining - before)}`);
}

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: node --expose-gc --import tsx scripts/measure-bsp-memory.mts <map.bsp> [...]');
  process.exit(1);
}

for (const file of files) {
  await measure(file);
}

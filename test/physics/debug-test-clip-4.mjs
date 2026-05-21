import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BSP29Loader } from '../../source/engine/common/model/loaders/BSP29Loader.ts';
import { Mod } from '../../source/engine/common/Mod.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import Com from '../../source/engine/common/Com.ts';
import Console from '../../source/engine/common/Console.ts';
import Vector from '../../source/shared/Vector.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mapsDir = path.join(__dirname, '../../data/id1/maps');

registry.Con = Console;
registry.COM = Com;
registry.Mod = Mod;
registry.isDedicatedServer = true;

Com.LoadFile = async (name) => {
  try {
    const filepath = path.join(mapsDir, name);
    const data = await fs.promises.readFile(filepath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } catch (e) {
    console.error(`Failed to load ${name}: ${e.message}`);
    return null;
  }
};

Com.LoadTextFile = async (name) => {
  try {
    const filepath = path.join(mapsDir, name);
    return await fs.promises.readFile(filepath, 'utf8');
  } catch {
    return null;
  }
};

eventBus.publish('registry.frozen');
Mod.Init();

async function debugMap(mapName) {
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`Loading ${mapName}`);
  console.log('='.repeat(60));

  const model = await Mod.ForNameAsync(mapName, true);

  console.log(`Model: ${model.name}`);
  console.log(`Has brushes: ${model.brushes ? model.brushes.length > 0 : false}`);
  console.log(`Brushes count: ${model.brushes?.length ?? 0}`);
  console.log(`Has brushsides: ${model.brushsides ? model.brushsides.length > 0 : false}`);
  console.log(`Brushsides count: ${model.brushsides?.length ?? 0}`);
  console.log(`Has leafbrushes: ${model.leafbrushes ? model.leafbrushes.length > 0 : false}`);
  console.log(`Leafbrushes count: ${model.leafbrushes?.length ?? 0}`);
  console.log(`Leaves count: ${model.leafs ? model.leafs.length : 0}`);
  console.log(`Nodes count: ${model.nodes ? model.nodes.length : 0}`);
  console.log(`Hulls count: ${model.hulls ? model.hulls.length : 0}`);

  if (model.brushes && model.brushes.length > 0) {
    console.log(`\nFirst 3 brushes:`);
    for (let i = 0; i < Math.min(3, model.brushes.length); i++) {
      const brush = model.brushes[i];
      console.log(`  Brush ${i}: contents=${brush.contents}, numsides=${brush.numsides}, firstside=${brush.firstside}`);
      if (brush.mins && brush.maxs) {
        console.log(`    Bounds: ${brush.mins.join(', ')} to ${brush.maxs.join(', ')}`);
      }
    }
  }

  if (model.leafs && model.leafs.length > 0) {
    console.log(`\nFirst 5 leaves:`);
    for (let i = 0; i < Math.min(5, model.leafs.length); i++) {
      const leaf = model.leafs[i];
      console.log(`  Leaf ${i}: contents=${leaf.contents}, firstleafbrush=${leaf.firstleafbrush}, numleafbrushes=${leaf.numleafbrushes}`);
    }
  }

  // Count total brushes in leaves
  let totalBrushesInLeaves = 0;
  if (model.leafs) {
    for (const leaf of model.leafs) {
      totalBrushesInLeaves += leaf.numleafbrushes;
    }
  }
  console.log(`\nTotal brush references in leaves: ${totalBrushesInLeaves}`);

  // Test if the collision system recognizes brush data
  const hasBrushData = model.brushes?.length > 0 && model.brushsides?.length > 0 && model.leafbrushes?.length > 0;
  console.log(`hasBrushData: ${hasBrushData}`);

  return model;
}

try {
  const mapWithBrushlist = await debugMap('test_clip_4.bsp');
  const mapWithHullOnly = await debugMap('test_clip_4_hull.bsp');

  console.log(`\n\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`test_clip_4.bsp has brushdata: ${mapWithBrushlist.brushes?.length > 0}`);
  console.log(`test_clip_4_hull.bsp has brushdata: ${mapWithHullOnly.brushes?.length > 0}`);
} catch (e) {
  console.error('Error:', e);
  process.exit(1);
}

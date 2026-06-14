import Vector from '../../../shared/Vector.ts';
import { content } from '../../../shared/Defs.ts';
import type { BrushModel } from '../Mod.ts';

/* eslint-disable jsdoc/require-returns */

interface TraceLike {
  readonly fraction: number;
  readonly startsolid: boolean;
  readonly allsolid: boolean;
}

interface TraceMismatchOptions {
  readonly edictId: number | null;
  readonly model: BrushModel | null;
  readonly start: Vector;
  readonly end: Vector;
  readonly brushTrace: TraceLike;
  readonly hullTrace: TraceLike;
  readonly brushBlocks: boolean;
  readonly hullBlocks: boolean;
  readonly playerMins: Vector;
  readonly playerMaxs: Vector;
  readonly distEpsilon: number;
}

interface PositionMismatchOptions {
  readonly edictId: number | null;
  readonly model: BrushModel | null;
  readonly position: Vector;
  readonly brushResult: boolean;
  readonly hullResult: boolean;
  readonly playerMins: Vector;
  readonly playerMaxs: Vector;
  readonly distEpsilon: number;
}

interface NearbyBrushSideSummary {
  readonly distance: number;
  readonly summary: string;
}

interface NearbyBrushCandidate {
  readonly index: number;
  readonly contents: number;
  readonly numsides: number;
  readonly nearestPlaneDistance: number;
  touchingPlanes: number;
  readonly mins: Vector;
  readonly maxs: Vector;
  sideSummaries: string[];
}

/**
 * Legacy hull comparisons are only meaningful for axial contact planes.
 */
export function isAxialNormal(normal: Vector, distEpsilon: number): boolean {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);

  return (Math.abs(ax - 1.0) <= distEpsilon && ay <= distEpsilon && az <= distEpsilon)
    || (ax <= distEpsilon && Math.abs(ay - 1.0) <= distEpsilon && az <= distEpsilon)
    || (ax <= distEpsilon && ay <= distEpsilon && Math.abs(az - 1.0) <= distEpsilon);
}

/**
 * Emit trace mismatch diagnostics for brush-vs-hull comparisons.
 */
export function debugLogTraceMismatch(options: TraceMismatchOptions): void {
  console.warn(
    `[Pmove MISMATCH] edictId=${options.edictId} model=${options.model?.name ?? 'world'}`,
    `\n  brush: frac=${options.brushTrace.fraction.toFixed(4)} startsolid=${options.brushTrace.startsolid} allsolid=${options.brushTrace.allsolid}`,
    `\n  hull:  frac=${options.hullTrace.fraction.toFixed(4)} startsolid=${options.hullTrace.startsolid} allsolid=${options.hullTrace.allsolid}`,
    `\n  start=${options.start} end=${options.end}`,
    options.model ? `\n  brushRange: first=${options.model.firstBrush} num=${options.model.numBrushes}` : '',
  );

  if (!options.brushBlocks && options.hullBlocks) {
    logNearbyBlockingBrushes(options.model, options.start, 'start-nearby', options.playerMins, options.playerMaxs, options.distEpsilon);
    logNearbyBlockingBrushes(options.model, options.end, 'end-nearby', options.playerMins, options.playerMaxs, options.distEpsilon);
    return;
  }

  if (options.brushBlocks && !options.hullBlocks) {
    logNearbyBlockingBrushes(options.model, options.start, 'trace-start-nearby', options.playerMins, options.playerMaxs, options.distEpsilon);
    logNearbyBlockingBrushes(options.model, options.end, 'trace-end-nearby', options.playerMins, options.playerMaxs, options.distEpsilon);

    if (!options.model || !options.model.brushes) {
      return;
    }

    const last = options.model.firstBrush + options.model.numBrushes;

    for (let brushIndex = options.model.firstBrush; brushIndex < last; brushIndex++) {
      const brush = options.model.brushes[brushIndex];

      if (!brush || brush.numsides === 0) {
        continue;
      }

      console.warn(
        `  brush[${brushIndex}]: contents=${brush.contents} sides=${brush.numsides}`,
        `mins=${brush.mins} maxs=${brush.maxs}`,
      );
    }
  }
}

/**
 * Emit position mismatch diagnostics for brush-vs-hull comparisons.
 */
export function debugLogPositionMismatch(options: PositionMismatchOptions): void {
  console.warn(
    `[Pmove POS MISMATCH] edictId=${options.edictId} model=${options.model?.name ?? 'world'}`,
    `\n  brush says ${options.brushResult ? 'VALID' : 'IN SOLID'}`,
    `\n  hull  says ${options.hullResult ? 'VALID' : 'IN SOLID'}`,
    `\n  position=${options.position}`,
    options.model ? `\n  brushRange: first=${options.model.firstBrush} num=${options.model.numBrushes}` : '',
  );

  if (options.brushResult && !options.hullResult) {
    logNearbyBlockingBrushes(options.model, options.position, 'position-nearby', options.playerMins, options.playerMaxs, options.distEpsilon);
  }

  if (!options.brushResult && options.hullResult) {
    logPositionCulpritBrushes(options.model, options.position, options.playerMins, options.playerMaxs, options.distEpsilon);
  }
}

/**
 * Emit nearby blocking brushes around a debug position when brush and hull comparisons disagree.
 */
function logNearbyBlockingBrushes(
  model: BrushModel | null,
  position: Vector,
  label: string,
  playerMins: Vector,
  playerMaxs: Vector,
  distEpsilon: number,
): void {
  const brushes = model?.brushes;
  const planes = model?.planes;
  const brushsides = model?.brushsides;

  if (!model || !brushes || !planes || !brushsides) {
    return;
  }

  const firstBrush = model.firstBrush ?? 0;
  const lastBrush = firstBrush + (model.numBrushes ?? brushes.length);
  const candidates: NearbyBrushCandidate[] = [];

  for (let brushIndex = firstBrush; brushIndex < lastBrush; brushIndex++) {
    const brush = brushes[brushIndex];

    if (!brush || brush.numsides === 0) {
      continue;
    }
    if (brush.contents !== content.CONTENT_SOLID
      && brush.contents !== content.CONTENT_SKY
      && brush.contents !== content.CONTENT_CLIP) {
      continue;
    }

    const expandedMinX = brush.mins![0] - playerMaxs[0] - distEpsilon;
    const expandedMinY = brush.mins![1] - playerMaxs[1] - distEpsilon;
    const expandedMinZ = brush.mins![2] - playerMaxs[2] - distEpsilon;
    const expandedMaxX = brush.maxs![0] - playerMins[0] + distEpsilon;
    const expandedMaxY = brush.maxs![1] - playerMins[1] + distEpsilon;
    const expandedMaxZ = brush.maxs![2] - playerMins[2] + distEpsilon;

    if (position[0] < expandedMinX || position[0] > expandedMaxX
      || position[1] < expandedMinY || position[1] > expandedMaxY
      || position[2] < expandedMinZ || position[2] > expandedMaxZ) {
      continue;
    }

    let nearestPlaneDistance = Number.POSITIVE_INFINITY;
    let touchingPlanes = 0;
    const sideSummaries: NearbyBrushSideSummary[] = [];

    for (let sideIndex = 0; sideIndex < brush.numsides; sideIndex++) {
      const side = brushsides[brush.firstside + sideIndex];
      const plane = planes[side.planenum];
      let dist = plane.dist;

      for (let axis = 0; axis < 3; axis++) {
        dist -= (plane.normal[axis] < 0 ? playerMaxs[axis] : playerMins[axis]) * plane.normal[axis];
      }

      const planeDistance = plane.normal.dot(position) - dist;
      nearestPlaneDistance = Math.min(nearestPlaneDistance, Math.abs(planeDistance));
      if (Math.abs(planeDistance) <= distEpsilon) {
        touchingPlanes += 1;
      }

      sideSummaries.push({
        distance: Math.abs(planeDistance),
        summary: `side=${sideIndex} normal=(${plane.normal[0].toFixed(3)},${plane.normal[1].toFixed(3)},${plane.normal[2].toFixed(3)}) planeDist=${plane.dist.toFixed(3)} adjusted=${dist.toFixed(3)} delta=${planeDistance.toFixed(5)}`,
      });
    }

    sideSummaries.sort((left, right) => left.distance - right.distance);

    candidates.push({
      index: brushIndex,
      contents: brush.contents,
      numsides: brush.numsides,
      nearestPlaneDistance,
      touchingPlanes,
      mins: brush.mins!,
      maxs: brush.maxs!,
      sideSummaries: sideSummaries.slice(0, 4).map((entry) => entry.summary),
    });
  }

  candidates.sort((left, right) => left.nearestPlaneDistance - right.nearestPlaneDistance);

  if (candidates.length === 0) {
    console.warn(`  ${label}: no nearby solid/clip brushes in expanded bounds`);
    return;
  }

  for (const candidate of candidates.slice(0, 8)) {
    console.warn(
      `  ${label}: brush[${candidate.index}] contents=${candidate.contents}`,
      `numsides=${candidate.numsides}`,
      `nearestPlaneDistance=${candidate.nearestPlaneDistance.toFixed(5)}`,
      `touchingPlanes=${candidate.touchingPlanes}`,
      `mins=${candidate.mins} maxs=${candidate.maxs}`,
    );
    for (const sideSummary of candidate.sideSummaries) {
      console.warn(`    ${sideSummary}`);
    }
  }
}

/**
 * Emit brush-side culprits when brush test blocks a position that hull test allows.
 */
function logPositionCulpritBrushes(
  model: BrushModel | null,
  position: Vector,
  playerMins: Vector,
  playerMaxs: Vector,
  distEpsilon: number,
): void {
  if (!model || !model.brushes || !model.brushsides) {
    return;
  }

  const brushes = model.brushes;
  const planes = model.planes;
  const brushsides = model.brushsides;
  const last = model.firstBrush + model.numBrushes;

  for (let brushIndex = model.firstBrush; brushIndex < last; brushIndex++) {
    const brush = brushes[brushIndex];

    if (!brush || brush.numsides === 0) {
      continue;
    }
    if (brush.contents !== content.CONTENT_SOLID
      && brush.contents !== content.CONTENT_SKY
      && brush.contents !== content.CONTENT_CLIP) {
      continue;
    }

    let inside = true;
    for (let sideIndex = 0; sideIndex < brush.numsides; sideIndex++) {
      const side = brushsides[brush.firstside + sideIndex];
      const plane = planes[side.planenum];
      let dist = plane.dist;

      for (let axis = 0; axis < 3; axis++) {
        dist -= (plane.normal[axis] < 0 ? playerMaxs[axis] : playerMins[axis]) * plane.normal[axis];
      }

      const planeDistance = plane.normal.dot(position) - dist;
      if (planeDistance > distEpsilon) {
        inside = false;
        break;
      }
    }

    if (inside) {
      console.warn(
        `  CULPRIT brush[${brushIndex}]: contents=${brush.contents} sides=${brush.numsides}`,
        `mins=${brush.mins} maxs=${brush.maxs}`,
      );
    }
  }
}

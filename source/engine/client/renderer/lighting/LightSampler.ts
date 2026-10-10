import Vector from '../../../../shared/Vector.ts';
import { content } from '../../../../shared/Defs.ts';
import { type BrushTexInfo, type BrushTexVec, type LightgridPointSample, Node } from '../../../common/model/BSP.ts';
import type { Face } from '../../../common/model/BaseModel.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import Interpolation from '../scene/Interpolation.ts';
import LightStyles from './LightStyles.ts';

/** Light color (0-255 per channel) and the point lighting seems to come from, as the shaders take them. */
export type LightPointResult = [Vector, Vector];

type GridPosition = [number, number, number];

/**
 * Samples the baked light of the world at a point: the lightmap of the surface below it, the BSPX lightgrid and
 * the deluxemap direction, with the current lightstyles applied.
 */
export class LightSampler {
  /**
   * Converts a texture axis of a surface (s or t) to a vector.
   * @returns The axis as a vector, the offset in `[3]` is not part of it.
   */
  static TextureAxisToVector(texVec: BrushTexVec): Vector {
    return new Vector(texVec[0], texVec[1], texVec[2]);
  }

  static RecursiveLightPoint(node: Node, start: Vector, end: Vector): LightPointResult | null {
    if (node.contents < content.CONTENT_NONE) {
      return null;
    }

    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const plane = node.plane!;
    console.assert(plane !== null, 'node plane required');
    const normal = plane.normal;
    const front = start[0] * normal[0] + start[1] * normal[1] + start[2] * normal[2] - plane.dist;
    const back = end[0] * normal[0] + end[1] * normal[1] + end[2] * normal[2] - plane.dist;
    const side = front < 0;
    const frontChild = node.children[side ? 1 : 0] as Node;
    const backChild = node.children[side ? 0 : 1] as Node;
    console.assert(frontChild instanceof Node, `LightSampler.RecursiveLightPoint expected linked front child on node ${node.num}`);
    console.assert(backChild instanceof Node, `LightSampler.RecursiveLightPoint expected linked back child on node ${node.num}`);

    if ((back < 0) === side) {
      return LightSampler.RecursiveLightPoint(frontChild, start, end);
    }

    const frac = front / (front - back);
    const mid = new Vector(
      start[0] + (end[0] - start[0]) * frac,
      start[1] + (end[1] - start[1]) * frac,
      start[2] + (end[2] - start[2]) * frac,
    );

    const r = LightSampler.RecursiveLightPoint(frontChild, start, mid);

    if (r !== null) {
      return r;
    }

    if ((back < 0) === side) {
      return null;
    }

    for (const surf of node.facesIter()) {
      if (surf.sky) {
        continue;
      }

      const tex = worldmodel.texinfo[surf.texinfo];
      const s = mid.dot(LightSampler.TextureAxisToVector(tex.vecs[0])) + tex.vecs[0][3];
      const t = mid.dot(LightSampler.TextureAxisToVector(tex.vecs[1])) + tex.vecs[1][3];
      if ((s < surf.texturemins[0]) || (t < surf.texturemins[1])) {
        continue;
      }

      let ds = s - surf.texturemins[0];
      let dt = t - surf.texturemins[1];
      if ((ds > surf.extents[0]) || (dt > surf.extents[1])) {
        continue;
      }

      if (surf.styles.length === 0 || surf.lightofs < 0) {
        return [new Vector(), mid];
      }

      const lmshift = surf.lmshift!;
      console.assert(lmshift !== null, 'face lightmap shift required');

      ds >>= lmshift;
      dt >>= lmshift;

      const smax = (surf.extents[0] >> lmshift) + 1;
      const tmax = (surf.extents[1] >> lmshift) + 1;

      const r3 = new Vector();
      const haveRGB = worldmodel.lightdata_rgb !== null;
      const lightdata = (haveRGB ? worldmodel.lightdata_rgb : worldmodel.lightdata)!;
      console.assert(lightdata !== null, 'world lightdata required');
      const channels = haveRGB ? 3 : 1;
      const uInterpolation = Interpolation.Lightstyle();

      for (let k = 0; k < channels; k++) {
        let lightmap = surf.lightofs + dt * smax + ds;

        for (let maps = 0; maps < surf.styles.length; maps++) {
          const scale = (
            LightStyles.lightstylevalue_a[surf.styles[maps]] * (1 - uInterpolation) +
            LightStyles.lightstylevalue_b[surf.styles[maps]] * uInterpolation
          ) * 22.0;

          r3[k] += lightdata[lightmap * channels + k] * scale;

          lightmap += tmax * smax;
        }
      }

      if (!haveRGB) {
        // replicate for green and blue
        r3[1] = r3[0];
        r3[2] = r3[0];
      }

      r3[0] = r3[0] >> 8;
      r3[1] = r3[1] >> 8;
      r3[2] = r3[2] >> 8;

      const deluxeDirection = LightSampler.SampleDeluxemapDirection(surf, tex, smax, tmax, ds, dt, uInterpolation);

      // Without a deluxemap, assume the light comes mostly from directly
      // above rather than trusting the hit surface's own normal: a downward
      // trace grazing a slanted ramp or wall ledge can return a tilted
      // normal that doesn't represent the area's general lighting, and
      // top-down is what classic Quake always assumed here anyway. Use
      // #topDownFallbackDirection (a slight tilt) rather than a pure
      // (0, 0, 1): entities only ever yaw about world Z, and a perfectly
      // vertical light direction is invariant to rotation about that same
      // axis, so an entity spinning in place keeps an entirely unchanged
      // relationship between its own normals and a light directly
      // overhead — the diffuse/specular response would never change while
      // it turns, reading as the highlight being stuck to the mesh. The
      // slight tilt breaks that symmetry.
      return [
        r3,
        deluxeDirection !== null
          ? mid.add(deluxeDirection.multiply(LightSampler.#lightOriginProxyDistance))
          : mid.add(LightSampler.#topDownFallbackDirection.copy().multiply(LightSampler.#lightOriginProxyDistance)),
      ];
    }

    return LightSampler.RecursiveLightPoint(backChild, mid, end);
  }

  /**
   * Distance used to project a light direction — either deluxemap-derived or
   * the top-down fallback used when no deluxemap texel is available — into a
   * proxy light-origin point. Must dominate the sampled entity's height above
   * the surface (tens of units) so the true direction isn't swamped by that
   * gap; otherwise the proxy origin sits close enough to the model that the
   * light-to-vertex direction is driven by the model's own local geometry
   * instead of a consistent world-space direction, leaving specular
   * highlights fixed to the mesh instead of sweeping as the camera orbits.
   */
  static readonly #lightOriginProxyDistance = 512.0;

  /**
   * Unit direction toward the assumed light source when a face has no
   * deluxemap texel (see the fallback branch above). 30° off vertical at an
   * arbitrary azimuth: entities only ever rotate (yaw) about world Z, and a
   * direction with no horizontal component at all is invariant to that
   * rotation, so it can never be told apart from an entity-attached light —
   * an entity spinning in place would show no change whatsoever in its
   * diffuse or specular response. The tilt keeps this reading as mostly an
   * overhead light while still varying with an entity's facing.
   */
  static readonly #topDownFallbackDirection = new Vector(
    Math.sin(30.0 * Math.PI / 180.0) * Math.cos(45.0 * Math.PI / 180.0),
    Math.sin(30.0 * Math.PI / 180.0) * Math.sin(45.0 * Math.PI / 180.0),
    Math.cos(30.0 * Math.PI / 180.0),
  );

  /**
   * Samples the BSPX deluxemap (dominant light direction per lightmap texel,
   * written by ericw-tools' `LIGHTINGDIR` lump) at the given face texel and
   * decodes it into a world-space, entity-independent light direction.
   * Mirrors the RGB lightdata sampling loop above, blending across active
   * lightstyles with the same intensity weighting, and reconstructs the
   * tangent-space-encoded direction into world space via the face's texture
   * axes and normal, matching the encoding in ericw-tools' `WriteSingleLightmap`.
   * @returns Normalized world-space direction pointing from the surface
   * toward the light, or null when no deluxemap data is available for this face.
   */
  static SampleDeluxemapDirection(surf: Face, tex: BrushTexInfo, smax: number, tmax: number, ds: number, dt: number, uInterpolation: number): Vector | null {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    if (worldmodel.deluxemap === null) {
      return null;
    }

    const deluxemap = worldmodel.deluxemap;
    const tangentDir = new Vector();
    let totalWeight = 0.0;

    for (let k = 0; k < 3; k++) {
      let lightmap = surf.lightofs + dt * smax + ds;

      for (let maps = 0; maps < surf.styles.length; maps++) {
        const scale = (
          LightStyles.lightstylevalue_a[surf.styles[maps]] * (1 - uInterpolation) +
          LightStyles.lightstylevalue_b[surf.styles[maps]] * uInterpolation
        ) * 22.0;

        tangentDir[k] += (deluxemap[lightmap * 3 + k] / 128.0 - 1.0) * scale;

        if (k === 0) {
          totalWeight += scale;
        }

        lightmap += tmax * smax;
      }
    }

    if (totalWeight <= 0.0) {
      return null;
    }

    tangentDir.multiply(1.0 / totalWeight);

    const sAxis = LightSampler.TextureAxisToVector(tex.vecs[0]);
    sAxis.normalize();
    const tAxis = LightSampler.TextureAxisToVector(tex.vecs[1]);
    tAxis.normalize();
    tAxis.multiply(-1.0);

    const worldDir = new Vector(
      tangentDir[0] * sAxis[0] + tangentDir[1] * tAxis[0] + tangentDir[2] * surf.normal[0],
      tangentDir[0] * sAxis[1] + tangentDir[1] * tAxis[1] + tangentDir[2] * surf.normal[1],
      tangentDir[0] * sAxis[2] + tangentDir[1] * tAxis[2] + tangentDir[2] * surf.normal[2],
    );

    return worldDir.normalize() > 0.0001 ? worldDir : null;
  }

  static LightPoint(p: Vector): LightPointResult {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    if (worldmodel.lightdata === null && worldmodel.lightdata_rgb === null) {
      return [new Vector(255, 255, 255), new Vector(0, 0, 0)];
    }

    // Try lightgrid first if available
    if (worldmodel.lightgrid !== null) {
      const gridResult = LightSampler.LightPointFromGrid(p);
      if (gridResult !== null) {
        // Get a proper light origin from surface trace for directional shading.
        // The lightgrid provides correct color but has no surface information,
        // so we trace downward to find the surface below the entity.
        const surfaceTrace = LightSampler.RecursiveLightPoint(worldmodel.nodes[0], p, new Vector(p[0], p[1], p[2] - 2048.0));
        if (surfaceTrace !== null) {
          gridResult[1] = surfaceTrace[1];
        }
        return gridResult;
      }
    }

    const r = LightSampler.RecursiveLightPoint(worldmodel.nodes[0], p, new Vector(p[0], p[1], p[2] - 2048.0));

    if (r === null) {
      return [new Vector(0, 0, 0), new Vector(0, 0, 0)];
    }

    return r;
  }

  /**
   * Samples a single point from the lightgrid octree.
   * @returns Point data or null when the octree has no lighting sample there.
   */
  static SampleLightgridPoint(gridPos: GridPosition): LightgridPointSample | null {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const grid = worldmodel.lightgrid;

    if (grid === null) {
      return null;
    }

    const LGNODE_LEAF = 1 << 31;
    const LGNODE_MISSING = 1 << 30;

    // Walk the octree to find the leaf
    let nodeIndex = grid.rootnode;

    while (true) {
      // Check if we've hit a leaf or missing node
      if ((nodeIndex & LGNODE_LEAF) !== 0) {
        const leafIndex = nodeIndex & ~(LGNODE_LEAF | LGNODE_MISSING);

        if ((nodeIndex & LGNODE_MISSING) !== 0) {
          // Missing data at this point
          return null;
        }

        // Check if leaf index is valid
        if (leafIndex >= grid.leafs.length) {
          return null;
        }

        const leaf = grid.leafs[leafIndex];

        // Calculate index within the leaf
        const localX = gridPos[0] - leaf.mins[0];
        const localY = gridPos[1] - leaf.mins[1];
        const localZ = gridPos[2] - leaf.mins[2];

        // Check bounds
        if (localX < 0 || localX >= leaf.size[0] ||
            localY < 0 || localY >= leaf.size[1] ||
            localZ < 0 || localZ >= leaf.size[2]) {
          return null;
        }

        const pointIndex = localZ * leaf.size[0] * leaf.size[1] + localY * leaf.size[0] + localX;

        // Check if point index is valid
        if (pointIndex >= leaf.points.length) {
          return null;
        }

        const point = leaf.points[pointIndex];

        if (point.stylecount === 0xff) {
          // No data at this point
          return null;
        }

        return point;
      }

      // Internal node - traverse
      // Check if node index is valid
      if (nodeIndex >= grid.nodes.length) {
        return null;
      }

      const node = grid.nodes[nodeIndex];

      // Calculate child index: ((z>=mid[2])<<0) | ((y>=mid[1])<<1) | ((x>=mid[0])<<2)
      let childIdx = 0;
      if (gridPos[2] >= node.mid[2]) {
        childIdx |= 1;
      }
      if (gridPos[1] >= node.mid[1]) {
        childIdx |= 2;
      }
      if (gridPos[0] >= node.mid[0]) {
        childIdx |= 4;
      }

      nodeIndex = node.child[childIdx];
    }
  }

  /**
   * Samples lighting from the lightgrid octree with trilinear interpolation.
   * @returns Interpolated RGB light and origin, or null when no grid sample is available.
   */
  static LightPointFromGrid(pos: Vector): LightPointResult | null {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const grid = worldmodel.lightgrid;

    if (grid === null) {
      return null;
    }

    // Convert world position to grid space
    const gridPosFloat = [
      (pos[0] - grid.mins[0]) / grid.step[0],
      (pos[1] - grid.mins[1]) / grid.step[1],
      (pos[2] - grid.mins[2]) / grid.step[2],
    ];

    // Get the 8 surrounding grid points
    const baseX = Math.floor(gridPosFloat[0]);
    const baseY = Math.floor(gridPosFloat[1]);
    const baseZ = Math.floor(gridPosFloat[2]);

    // Calculate fractional part for interpolation
    const fracX = gridPosFloat[0] - baseX;
    const fracY = gridPosFloat[1] - baseY;
    const fracZ = gridPosFloat[2] - baseZ;

    // Sample the 8 corner points
    const samples = [];
    const weights = [];
    let totalWeight = 0;

    for (let dz = 0; dz <= 1; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const gridPos: GridPosition = [baseX + dx, baseY + dy, baseZ + dz];
          const sample = LightSampler.SampleLightgridPoint(gridPos);

          // Calculate trilinear weight
          const wx = dx === 0 ? (1 - fracX) : fracX;
          const wy = dy === 0 ? (1 - fracY) : fracY;
          const wz = dz === 0 ? (1 - fracZ) : fracZ;
          const weight = wx * wy * wz;

          if (sample !== null) {
            samples.push(sample);
            weights.push(weight);
            totalWeight += weight;
          }
        }
      }
    }

    // If no samples found, return null
    if (samples.length === 0) {
      return null;
    }

    // Compensate for missing samples by renormalizing weights
    if (totalWeight > 0) {
      for (let i = 0; i < weights.length; i++) {
        weights[i] /= totalWeight;
      }
    }

    // Accumulate weighted RGB values
    const r3 = new Vector(0, 0, 0);
    const uInterpolation = Interpolation.Lightstyle();

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const weight = weights[i];

      for (let s = 0; s < sample.styles.length; s++) {
        const style = sample.styles[s];
        const stylenum = style.stylenum;

        // Apply lightstyle animation (matches RecursiveLightPoint: lightstyle * 22.0 / 256.0)
        const scale = (
          LightStyles.lightstylevalue_a[stylenum] * (1 - uInterpolation) +
          LightStyles.lightstylevalue_b[stylenum] * uInterpolation
        ) * 0.0859375; // 22.0 / 256.0

        r3[0] += style.rgb[0] * scale * weight;
        r3[1] += style.rgb[1] * scale * weight;
        r3[2] += style.rgb[2] * scale * weight;
      }
    }

    return [r3, pos.copy()];
  }
}

export default LightSampler;

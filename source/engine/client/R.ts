import Vector from '../../shared/Vector.ts';
import Cvar from '../common/Cvar.ts';
import Cmd from '../common/Cmd.ts';
import * as Def from '../common/Def.ts';

import { eventBus, getClientRegistry, registry } from '../registry.ts';
import Chase from './Chase.ts';
import W from '../common/W.ts';
import VID from './VID.ts';
import GL, { ATTRIB_LOCATIONS, GLTexture } from './GL.ts';
import { content, effect, gameCapabilities } from '../../shared/Defs.ts';
import { modelRendererRegistry } from './renderer/ModelRendererRegistry.ts';
import { BrushModelRenderer, LIGHTMAP_BLOCK_HEIGHT, LIGHTMAP_BLOCK_SIZE } from './renderer/BrushModelRenderer.ts';
import { AliasModelRenderer } from './renderer/AliasModelRenderer.ts';
import { SpriteModelRenderer } from './renderer/SpriteModelRenderer.ts';
import { MeshModelRenderer } from './renderer/MeshModelRenderer.ts';
import Draw from './Draw.ts';
import { BrushModel, type BrushTexVec, type FogVolumeInfo, type LightgridPointSample, Node, type WorldTurbulentChainInfo, revealedVisibility } from '../common/model/BSP.ts';
import { type Face, Plane } from '../common/model/BaseModel.ts';
import PostProcess from './renderer/PostProcess.ts';
import BloomEffect from './renderer/BloomEffect.ts';
import WarpEffect from './renderer/WarpEffect.ts';
import ShadowMap from './renderer/ShadowMap.ts';
import { ClientDlight, ClientEdict } from './ClientEntities.ts';
import { avertexnormals } from '../common/model/loaders/AliasMDLLoader.ts';
import { SkyRenderer } from './renderer/Sky.ts';
import { ModelType } from '../common/Mod.ts';

let { CL, Host, SCR, SV, Sys, V } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Host, SCR, SV, Sys, V } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

interface SortKindDistance {
  readonly dist: number;
  readonly kind: number;
}

interface DynamicLightSurfaceImpact {
  readonly distanceToPlane: number;
  readonly impact: Vector;
}

interface FogAndTurbulentSortItem extends SortKindDistance {
  readonly data: WorldTurbulentChainInfo | FogVolumeInfo;
}

interface TransparentSortItem extends SortKindDistance {
  readonly data: Node | ClientEdict;
}

interface RefdefRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RefdefState {
  vrect: RefdefRect;
  vieworg: Vector;
  viewangles: Vector;
  fov_x: number;
  fov_y: number;
}

type LightPointResult = [Vector, Vector];
type EntityLightValues = [Vector, Vector, Vector, Vector, Vector];
type GridPosition = [number, number, number];
type Vec4 = [number, number, number, number];

export interface SerializedParticle {
  i: number;
  die: number;
  color: number;
  ramp: number;
  type: number;
  org: [number, number, number];
  vel: [number, number, number];
}

interface Particle {
  die: number;
  color: number;
  ramp: number;
  type: ParticleType;
  org: Vector;
  vel: Vector;
}

interface Decal {
  readonly texture: GLTexture;
  readonly verts: [Vector, Vector, Vector, Vector];
  readonly color: Vector;
  readonly die: number;
}

type AngularVelocity = [number, number, number];

enum ParticleType {
  tracer = 0,
  grav = 1,
  slowgrav = 2,
  fire = 3,
  explode = 4,
  explode2 = 5,
  blob = 6,
  blob2 = 7,
}



const FOG_TURBULENT_SORT_EPSILON = 0.0001;

/**
 * Compare mixed fog and turbulent items for the shared transparent pass.
 * Distances sort back-to-front. When a fog volume and a turbulent surface
 * begin at the same depth, fog must draw first so the nearer liquid can blend
 * over it instead of the fog overpainting the liquid.
 * @returns Sort comparator result.
 */
export function compareFogAndTurbulentItems(itemA: SortKindDistance, itemB: SortKindDistance): number {
  const distDelta = itemB.dist - itemA.dist;

  if (Math.abs(distDelta) > FOG_TURBULENT_SORT_EPSILON) {
    return distDelta;
  }

  return itemB.kind - itemA.kind;
}


class R {
  // light

  static dlightframecount = 0;

  static lightstylevalue_a = new Uint8Array(new ArrayBuffer(64));
  static lightstylevalue_b = new Uint8Array(new ArrayBuffer(64));

  static waterwarp: Cvar = null!;
  static fullbright: Cvar = null!;
  static drawentities: Cvar = null!;
  static drawviewmodel: Cvar = null!;
  static drawturbulents: Cvar = null!;
  static novis: Cvar = null!;
  static speeds: Cvar = null!;
  static polyblend: Cvar = null!;
  static flashblend: Cvar = null!;
  static nocolors: Cvar = null!;
  static bloom: Cvar = null!;
  static bloomStrength: Cvar = null!;
  static bloomSkyStrength: Cvar = null!;
  static bloomDlightStrength: Cvar = null!;
  static bloomSpecularStrength: Cvar = null!;
  static bloomDownsample: Cvar = null!;
  static bloomDebug: Cvar = null!;
  static interpolation: Cvar = null!;
  static fog_color: Cvar = null!;
  static fog_start: Cvar = null!;
  static fog_end: Cvar = null!;
  static fog_density: Cvar = null!;
  static fog_mode: Cvar = null!;

  static notexture: GLTexture = null!;
  static blacktexture: GLTexture = null!;
  static flatnormalmap: GLTexture = null!;
  static deluxemap_texture: WebGLTexture = null!;
  static lightmap_texture: WebGLTexture = null!;
  static dlightmap_rgba_texture: WebGLTexture = null!;
  static lightstyle_texture_a: WebGLTexture = null!;
  static lightstyle_texture_b: WebGLTexture = null!;
  static fullbright_texture: WebGLTexture = null!;
  static null_texture: WebGLTexture = null!;
  static normal_up_texture: WebGLTexture = null!;
  static shadow_textures: WebGLTexture[] = [];
  static shadow_texture: WebGLTexture | null = null;
  static point_shadow_texture: WebGLTexture | null = null;
  static world_depth_texture: WebGLTexture | null = null;
  static dlightvecs: WebGLBuffer = null!;
  static dlightVAO: WebGLVertexArrayObject = null!;

  static usePostProcess = false;
  static dowarp = false;
  static particles: Particle[] = [];
  static decals: Decal[] = [];
  static numparticles = 0;
  static avelocities: AngularVelocity[] = [];
  static allocated: number[] = [];
  static c_brush_verts = 0;
  static c_brush_tris = 0;
  static c_brush_draws = 0;
  static c_brush_draws_pbr = 0;
  static c_brush_vbos = 0;
  static c_brush_texture_binds = 0;
  static c_alias_polys = 0;

  private static _textureAxisToVector(texVec: BrushTexVec): Vector {
    return new Vector(texVec[0], texVec[1], texVec[2]);
  }

  private static _createDeadParticle(): Particle {
    return {
      die: -1.0,
      color: 0,
      ramp: 0.0,
      type: ParticleType.slowgrav,
      org: new Vector(),
      vel: new Vector(),
    };
  }

  static AnimateLight(): void {
    if (R.fullbright.value === 0) {
      const i = Math.floor(CL.state.time * 10.0);
      for (let j = 0; j < 64; j++) {
        const ls = CL.state.clientEntities.lightstyle[j];
        if (ls.length === 0) {
          R.lightstylevalue_a[j] = 12;
          R.lightstylevalue_b[j] = 12;
          continue;
        }
        R.lightstylevalue_a[j] = ls.charCodeAt(i % ls.length) - 97;
        R.lightstylevalue_b[j] = ls.charCodeAt((i + 1) % ls.length) - 97;
      }
    } else {
      for (let j = 0; j < 64; j++) {
        R.lightstylevalue_a[j] = 12;
        R.lightstylevalue_b[j] = 12;
      }
    }
    GL.Bind(0, R.lightstyle_texture_a);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.UNSIGNED_BYTE, R.lightstylevalue_a!);
    GL.Bind(0, R.lightstyle_texture_b);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.UNSIGNED_BYTE, R.lightstylevalue_b!);
  };

  static RenderDlights() {
    if (R.flashblend.value === 0) {
      return;
    }
    R.dlightframecount++;
    gl.enable(gl.BLEND);
    const program = GL.UseProgram('dlight')!; let a;
    console.assert(program !== null, 'dlight program required');
    GL.BindVAO(R.dlightVAO);
    for (let i = 0; i < Def.limits.dlights; i++) {
      const l = CL.state.clientEntities.dlights[i];
      if ((l.die < CL.state.time) || (l.radius === 0.0)) {
        continue;
      }
      if (l.origin.copy().subtract(R.refdef.vieworg).len() < (l.radius * 0.35)) {
        a = l.radius * 0.0003;
        V.blend[3] += a * (1.0 - V.blend[3]);
        a /= V.blend[3];
        V.blend[0] = V.blend[1] * (1.0 - a) + (255.0 * a);
        V.blend[1] = V.blend[1] * (1.0 - a) + (127.5 * a);
        V.blend[2] *= 1.0 - a;
        continue;
      }
      gl.uniform3fv(program.uOrigin!, l.origin);
      gl.uniform1f(program.uRadius!, l.radius);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 18);
    }
    GL.UnbindVAO();
    gl.disable(gl.BLEND);
  };

  /**
   * Returns a known point on the face plane for dynamic-light projection.
   * @returns A known point on the surface plane.
   */
  static GetDynamicLightSurfacePoint(surf: Face): Vector {
    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const surfedge = worldmodel.surfedges[surf.firstedge!];

    if (surfedge >= 0) {
      return worldmodel.vertexes[worldmodel.edges[surfedge][0]].copy();
    }

    return worldmodel.vertexes[worldmodel.edges[-surfedge][1]].copy();
  };

  /**
   * Projects a dynamic light onto a face plane when the light is in front of the surface.
   * @returns Surface-plane hit information when the light is in front of the face.
   */
  static GetDynamicLightSurfaceImpact(light: ClientDlight, surf: Face): DynamicLightSurfaceImpact | null {
    const faceNormal = surf.normal!.copy();
    const surfacePoint = R.GetDynamicLightSurfacePoint(surf);
    const distanceToPlane = light.origin.copy().subtract(surfacePoint).dot(faceNormal);

    if (distanceToPlane <= 0.0 || distanceToPlane >= light.radius) {
      return null;
    }

    const impact = light.origin.copy().subtract(faceNormal.copy().multiply(distanceToPlane));

    return { distanceToPlane, impact };
  };

  /**
   * Returns whether the light can see the face at the projected impact point.
   * @returns True when the light has line of sight to the surface.
   */
  static IsDynamicLightSurfaceVisible(light: ClientDlight, surf: Face, impact: Vector): boolean {
    const end = impact.copy().add(surf.normal!.copy().multiply(1.0));
    const trace = SV.collision.traceStaticWorldLine(light.origin, end);

    return !trace.startsolid && !trace.allsolid && trace.fraction === 1.0;
  };

  /**
   * Propagates a dynamic light through the BSP and marks touched faces.
   */
  static MarkLights(light: ClientDlight, bit: number, node: Node): void {
    if (node.contents < content.CONTENT_NONE) {
      return;
    }
    const plane = node.plane!;
    console.assert(plane !== null, 'node plane required');
    const normal = plane.normal;
    const dist = light.origin.dot(normal) - plane.dist;
    if (dist > light.radius) {
      const frontChild = node.children[0] as Node;
      console.assert(frontChild instanceof Node, `R.MarkLights expected linked BSP child 0 on node ${node.num}`);
      R.MarkLights(light, bit, frontChild);
      return;
    }
    if (dist < -light.radius) {
      const backChild = node.children[1] as Node;
      console.assert(backChild instanceof Node, `R.MarkLights expected linked BSP child 1 on node ${node.num}`);
      R.MarkLights(light, bit, backChild);
      return;
    }
    for (const surf of node.facesIter()) {
      if (surf.sky) {
        continue;
      }

      const lightImpact = R.GetDynamicLightSurfaceImpact(light, surf);

      if (lightImpact === null || !R.IsDynamicLightSurfaceVisible(light, surf, lightImpact.impact)) {
        continue;
      }

      if (surf.dlightframe !== (R.dlightframecount + 1)) {
        surf.dlightbits = 0;
        surf.dlightframe = R.dlightframecount + 1;
      }
      surf.dlightbits |= bit;
    }
    const frontChild = node.children[0] as Node;
    const backChild = node.children[1] as Node;
    console.assert(frontChild instanceof Node, `R.MarkLights expected linked BSP child 0 on node ${node.num}`);
    console.assert(backChild instanceof Node, `R.MarkLights expected linked BSP child 1 on node ${node.num}`);
    R.MarkLights(light, bit, frontChild);
    R.MarkLights(light, bit, backChild);
  };

  static PushDlights() {
    if (R.flashblend.value !== 0) {
      return;
    }

    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    for (let i = 0; i < LIGHTMAP_BLOCK_SIZE; i++) {
      R.lightmap_modified[i] = 0;
    }

    let bit = 1;

    for (let i = 0; i < Def.limits.dlights; i++) {
      const l = CL.state.clientEntities.dlights[i];

      if (!l.isFree()) {
        R.MarkLights(l, bit, worldmodel.nodes[0]);
        for (const ent of CL.state.clientEntities.getVisibleEntities()) {
          if (ent.model === null) {
            continue;
          }
          if (!(ent.model instanceof BrushModel) || !ent.model.submodel) {
            continue;
          }
          const firstClipNode = ent.model.hulls[0]?.firstclipnode;
          const submodelNode = firstClipNode !== undefined ? worldmodel.nodes[firstClipNode] : null;

          if (submodelNode !== undefined && submodelNode !== null) {
            R.MarkLights(l, bit, submodelNode);
          }
        }
      }
      bit += bit;
    }

    let surf;
    for (let i = 0; i < worldmodel.faces.length; i++) {
      surf = worldmodel.faces[i];
      if (surf.dlightframe === R.dlightframecount) {
        R.RemoveDynamicLights(surf);
      } else if (surf.dlightframe === (R.dlightframecount + 1)) {
        R.AddDynamicLights(surf);
      }
    }

    GL.Bind(0, R.dlightmap_rgba_texture);
    for (let i = 0; i < LIGHTMAP_BLOCK_SIZE; i++) {
      if (!R.lightmap_modified[i]) {
        continue;
      }
      for (let j = LIGHTMAP_BLOCK_SIZE - 1; j >= i; j--) {
        if (!R.lightmap_modified[j]) {
          continue;
        }
        const dlightmapsRgba = R.dlightmaps_rgba!;
        console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, i, LIGHTMAP_BLOCK_SIZE, j - i + 1, gl.RGBA, gl.UNSIGNED_BYTE, dlightmapsRgba.subarray(i * LIGHTMAP_BLOCK_SIZE * 4, (j + 1) * LIGHTMAP_BLOCK_SIZE * 4));
        break;
      }
      break;
    }

    R.dlightframecount++;
  };

  static RecursiveLightPoint(node: Node, start: Vector, end: Vector): LightPointResult | null {
    if (node.contents < content.CONTENT_NONE) {
      return null;
    }

    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const plane = node.plane!;
    console.assert(plane !== null, 'node plane required');
    const normal = plane.normal;
    const front = start[0] * normal[0] + start[1] * normal[1] + start[2] * normal[2] - plane.dist;
    const back = end[0] * normal[0] + end[1] * normal[1] + end[2] * normal[2] - plane.dist;
    const side = front < 0;
    const frontChild = node.children[side ? 1 : 0] as Node;
    const backChild = node.children[side ? 0 : 1] as Node;
    console.assert(frontChild instanceof Node, `R.RecursiveLightPoint expected linked front child on node ${node.num}`);
    console.assert(backChild instanceof Node, `R.RecursiveLightPoint expected linked back child on node ${node.num}`);

    if ((back < 0) === side) {
      return R.RecursiveLightPoint(frontChild, start, end);
    }

    const frac = front / (front - back);
    const mid = new Vector(
      start[0] + (end[0] - start[0]) * frac,
      start[1] + (end[1] - start[1]) * frac,
      start[2] + (end[2] - start[2]) * frac,
    );

    const r = R.RecursiveLightPoint(frontChild, start, mid);

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
      const s = mid.dot(R._textureAxisToVector(tex.vecs[0])) + tex.vecs[0][3];
      const t = mid.dot(R._textureAxisToVector(tex.vecs[1])) + tex.vecs[1][3];
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
      const uInterpolation = R.interpolation.value ? (CL.state.time % .2) / .2 : 0;

      for (let k = 0; k < channels; k++) {
        let lightmap = surf.lightofs + dt * smax + ds;

        for (let maps = 0; maps < surf.styles.length; maps++) {
          const scale = (
            R.lightstylevalue_a[surf.styles[maps]] * (1 - uInterpolation) +
            R.lightstylevalue_b[surf.styles[maps]] * uInterpolation
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

      return [
        r3,
        mid.add(surf.normal.copy().multiply(16.0)),
      ];
    }

    return R.RecursiveLightPoint(backChild, mid, end);
  };

  static LightPoint(p: Vector): LightPointResult {
    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    if (worldmodel.lightdata === null && worldmodel.lightdata_rgb === null) {
      return [new Vector(255, 255, 255), new Vector(0, 0, 0)];
    }

    // Try lightgrid first if available
    if (worldmodel.lightgrid !== null) {
      const gridResult = R.LightPointFromGrid(p);
      if (gridResult !== null) {
        // Get a proper light origin from surface trace for directional shading.
        // The lightgrid provides correct color but has no surface information,
        // so we trace downward to find the surface below the entity.
        const surfaceTrace = R.RecursiveLightPoint(worldmodel.nodes[0], p, new Vector(p[0], p[1], p[2] - 2048.0));
        if (surfaceTrace !== null) {
          gridResult[1] = surfaceTrace[1];
        }
        return gridResult;
      }
    }

    const r = R.RecursiveLightPoint(worldmodel.nodes[0], p, new Vector(p[0], p[1], p[2] - 2048.0));

    if (r === null) {
      return [new Vector(0, 0, 0), new Vector(0, 0, 0)];
    }

    return r;
  };

  /**
   * Samples a single point from the lightgrid octree.
   * @returns Point data or null when the octree has no lighting sample there.
   */
  static SampleLightgridPoint(gridPos: GridPosition): LightgridPointSample | null {
    const worldmodel = CL.state.worldmodel!;
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
  };

  /**
   * Samples lighting from the lightgrid octree with trilinear interpolation.
   * @returns Interpolated RGB light and origin, or null when no grid sample is available.
   */
  static LightPointFromGrid(pos: Vector): LightPointResult | null {
    const worldmodel = CL.state.worldmodel!;
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
          const sample = R.SampleLightgridPoint(gridPos);

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
    const uInterpolation = R.interpolation.value ? (CL.state.time % .2) / .2 : 0;

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const weight = weights[i];

      for (let s = 0; s < sample.styles.length; s++) {
        const style = sample.styles[s];
        const stylenum = style.stylenum;

        // Apply lightstyle animation (matches RecursiveLightPoint: lightstyle * 22.0 / 256.0)
        const scale = (
          R.lightstylevalue_a[stylenum] * (1 - uInterpolation) +
          R.lightstylevalue_b[stylenum] * uInterpolation
        ) * 0.0859375; // 22.0 / 256.0

        r3[0] += style.rgb[0] * scale * weight;
        r3[1] += style.rgb[1] * scale * weight;
        r3[2] += style.rgb[2] * scale * weight;
      }
    }

    return [r3, pos.copy()];
  };

  // main

  static visframecount = 0;

  static frustum: Plane[] = [
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
  ];

  static vup = new Vector();
  static vpn = new Vector();
  static vright = new Vector();

  static refdef: RefdefState = {
    vrect: {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    },
    vieworg: new Vector(),
    viewangles: new Vector(),
    fov_x: 0,
    fov_y: 0,
  };

  static oldviewleaf: Node | null = null;

  static CullBox(mins: Vector, maxs: Vector): boolean {
    if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[0]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[1]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[2]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[3]) === 2) {
      return true;
    }
    return false;
  };

  /**
   * Alias models in Quake sample static light slightly above their origin so
   * monsters are lit from torso height rather than foot height.
   * @returns World position used for static light sampling.
   */
  static GetEntityLightSamplePoint(entity: ClientEdict): Vector {
    const samplePoint = entity.lerp.origin.copy();

    if (entity.model !== null) {
      // samplePoint[2] -= entity.mins[2] + 24.0; // effectively +24.0u on alias models
      // CR: fun, that makes the boss in E1M7 pitch black
    }

    // console.log(`Sampling light for entity ${entity.num} at ${samplePoint}`, entity.model, entity.mins, entity.maxs);

    return samplePoint;
  };

  /**
   * Calculates static and dynamic lighting terms for a rendered entity.
   * @returns Ambient light, shade light, nearest light origin, dynamic shade light, and dynamic light origin.
   */
  static _CalculateLightValues(e: ClientEdict): EntityLightValues {
    const [ambientlight, lightOrigin] = R.LightPoint(R.GetEntityLightSamplePoint(e));
    const shadelight = ambientlight.copy();

    // never have a pitch black view model
    if (e === CL.state.viewent && ambientlight.average() < 24.0) {
      if (ambientlight.average() === 0) {
        ambientlight.setTo(1.0, 1.0, 1.0); // no color, set to white
      }
      ambientlight.multiply(24.0);
      shadelight.set(ambientlight);
    }

    const dynamicShadeLight = new Vector(0.0, 0.0, 0.0);
    const dynamicLightOrigin = new Vector(0.0, 0.0, 0.0);
    let maxAdd = 0.0;

    // add dynamic lights
    for (let i = 0; i < Def.limits.dlights; i++) {
      const dl = CL.state.clientEntities.dlights[i];

      if (dl.isFree()) {
        continue;
      }

      const add = dl.radius - e.lerp.origin.distanceTo(dl.origin);

      if (add > 0.0) {
        const color = dl.color.copy();
        const vadd = color.multiply(add);
        dynamicShadeLight.add(vadd);

        if (add > maxAdd) {
          maxAdd = add;
          dynamicLightOrigin.set(dl.origin);
        }
      }
    }

    // do not overbright
    const alavg = ambientlight.greatest();
    if (alavg > 128.0) {
      ambientlight.multiply(128.0 / alavg);
    }

    const slavg = shadelight.greatest();
    if (slavg > 128.0) {
      shadelight.multiply(128.0 / slavg);
    }

    const dlavg = dynamicShadeLight.greatest();
    if (dlavg > 128.0) {
      dynamicShadeLight.multiply(128.0 / dlavg);
    }

    if (e.effects & (effect.EF_FULLBRIGHT | effect.EF_MUZZLEFLASH)) {
      ambientlight.setTo(255.0, 255.0, 255.0);
      shadelight.set(ambientlight);
    } else if ((e.num >= 1 && e.num <= CL.state.maxclients && shadelight.greatest() < 8.0) || (e.effects & effect.EF_MINLIGHT)) {
      // never let players go totally dark either
      if (ambientlight.average() === 0) {
        ambientlight.setTo(1.0, 1.0, 1.0); // no color, set to white
      }
      ambientlight.multiply(8.0);
      shadelight[0] = Math.max(shadelight[0], ambientlight[0]);
      shadelight[1] = Math.max(shadelight[1], ambientlight[1]);
      shadelight[2] = Math.max(shadelight[2], ambientlight[2]);
    }

    ambientlight.multiply(0.0078125); // / 128.0
    shadelight.multiply(0.0078125); // / 128.0
    dynamicShadeLight.multiply(0.0078125);

    return [ ambientlight, shadelight, lightOrigin, dynamicShadeLight, dynamicLightOrigin ];
  };

  static DrawEntitiesOnList() {
    if (R.drawentities.value === 0) {
      return;
    }

    // Group entities by model type for batched rendering
    const entitiesByType = new Map<ModelType, ClientEdict[]>();

    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (entity.model === null || entity.alpha === 0.0) {
        continue;
      }

      const modelType = entity.model.type;
      if (modelType === null) {
        continue;
      }

      if (!entitiesByType.has(modelType)) {
        entitiesByType.set(modelType, []);
      }
      entitiesByType.get(modelType)!.push(entity);
    }

    // Pass 0: Opaque models (brush, alias)
    for (const [modelType, entities] of entitiesByType) {
      if (modelType === ModelType.sprite) {
        continue; // Sprites are drawn in pass 1
      }

      const renderer = modelRendererRegistry.getRenderer(modelType)!;
      console.assert(renderer !== null, `renderer required for model type ${modelType}`);

      renderer.setupRenderState(0);
      for (const entity of entities) {
        const model = entity.model!;
        console.assert(model !== null, 'entity model required for opaque pass');

        if (!renderer.rendersOpaquePass(model, entity)) {
          continue;
        }

        renderer.render(model, entity, 0);
      }
      renderer.cleanupRenderState(0);
    }
    GL.StreamFlush();

    // Pass 1: Transparent sprites with blending
    const spriteEntities = entitiesByType.get(ModelType.sprite);
    if (spriteEntities) {
      const renderer = modelRendererRegistry.getRenderer(ModelType.sprite)!;
      console.assert(renderer !== null, 'sprite renderer required');

      gl.enable(gl.BLEND);
      renderer.setupRenderState(1);
      for (const entity of spriteEntities) {
        const model = entity.model!;
        console.assert(model !== null, 'entity model required for sprite pass');
        renderer.render(model, entity, 1);
      }
      renderer.cleanupRenderState(1);
      GL.StreamFlush();
      gl.disable(gl.BLEND);
    }
  };

  /**
   * Render world turbulent surfaces and fog volumes in the correct order.
   *
   * Turbulent surfaces and fog volumes share the same transparency space, so
   * they must be composed from a single back-to-front list. Rendering them in
   * separate phases is incorrect when water and fog overlap or alternate in
   * depth, such as foggy water volumes or mist sitting above water.
   *
   * When no fog volumes exist (or post-process is unavailable), this falls
   * back to the simple sequential turbulent pass.
   */
  static _renderFogAndTurbulentsSorted(worldEntity: ClientEdict): void {
    if (!(worldEntity.model instanceof BrushModel)) {
      return;
    }

    const worldmodel = worldEntity.model;
  const brushRenderer = modelRendererRegistry.getRenderer(ModelType.brush)! as BrushModelRenderer;
    console.assert(brushRenderer !== null, 'brush renderer required');
    const hasFog = PostProcess.active
      && worldmodel.fogVolumes && worldmodel.fogVolumes.length > 0;
    const hasTurbulents = R.drawturbulents.value;

    // Fast path: no fog volumes — just render turbulents the simple way
    if (!hasFog) {
      if (hasTurbulents) {
        brushRenderer.render(worldmodel, worldEntity, 1);
      }
      return;
    }

    // Fast path: fog but no turbulents — just render fog volumes
    if (!hasTurbulents) {
      brushRenderer.renderFogVolumes(worldmodel);
      return;
    }

    const vieworg = R.refdef.vieworg;
    const items: FogAndTurbulentSortItem[] = [];

    const turbulentChains = brushRenderer.getWorldTurbulentChains(worldmodel, vieworg);
    for (let i = 0; i < turbulentChains.length; i++) {
      items.push({ dist: turbulentChains[i].dist, kind: 0, data: turbulentChains[i].chain });
    }

    const fogItems = brushRenderer.getFogVolumeItems(worldmodel, vieworg);
    for (let i = 0; i < fogItems.length; i++) {
      items.push({ dist: fogItems[i].dist, kind: 1, data: fogItems[i].fogVolume });
    }

    if (items.length === 0) {
      return;
    }

    items.sort(compareFogAndTurbulentItems);

    let activePass = -1;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.kind !== activePass) {
        if (activePass === 0) {
          brushRenderer.endWorldTurbulentPass();
        } else if (activePass === 1) {
          brushRenderer.endFogVolumePass();
        }

        if (item.kind === 0) {
          brushRenderer.beginWorldTurbulentPass(worldmodel);
        } else if (!brushRenderer.beginFogVolumePass(worldmodel)) {
          activePass = -1;
          continue;
        }

        activePass = item.kind;
      }

      if (item.kind === 0) {
        brushRenderer.renderWorldTurbulentChain(worldmodel, item.data as WorldTurbulentChainInfo);
        continue;
      }

      brushRenderer.renderSingleFogVolume(worldmodel, item.data as FogVolumeInfo);
    }

    if (activePass === 0) {
      brushRenderer.endWorldTurbulentPass();
    } else if (activePass === 1) {
      brushRenderer.endFogVolumePass();
    }
  };

  /**
   * Render all transparent geometry (world brush surfaces + entities) in
   * back-to-front sorted order with depth writes disabled.
   * This ensures transparent surfaces blend correctly regardless of type.
   */
  static _renderTransparentsSorted(worldEntity: ClientEdict): void {
    if (!(worldEntity.model instanceof BrushModel)) {
      return;
    }

    const worldmodel = worldEntity.model;

    const vieworg = R.refdef.vieworg;
    const items: TransparentSortItem[] = [];

    // Collect world transparent leaves with distances
    const brushRenderer = modelRendererRegistry.getRenderer(ModelType.brush)! as BrushModelRenderer;
    console.assert(brushRenderer !== null, 'brush renderer required');
    const worldLeaves = brushRenderer.getWorldTransparentLeaves(worldmodel, vieworg);
    for (let i = 0; i < worldLeaves.length; i++) {
      items.push({ dist: worldLeaves[i].dist, kind: 0, data: worldLeaves[i].leaf });
    }

    // Collect transparent entities with distances
    if (R.drawentities.value !== 0) {
      for (const entity of CL.state.clientEntities.getVisibleEntities()) {
        if (entity.model === null || entity.alpha === 0.0) {
          continue;
        }

        if (entity.model.type === null) {
          continue;
        }

        const renderer = modelRendererRegistry.getRenderer(entity.model.type)!;
        console.assert(renderer !== null, `renderer required for model type ${entity.model.type}`);
        if (!renderer.rendersTransparentPass(entity.model, entity)) {
          continue;
        }

        const dx = entity.origin[0] - vieworg[0];
        const dy = entity.origin[1] - vieworg[1];
        const dz = entity.origin[2] - vieworg[2];
        const dist = Math.hypot(dx, dy, dz);
        items.push({ dist, kind: 1, data: entity });
      }
    }

    if (items.length === 0) {
      return;
    }

    // Sort back-to-front (farthest first)
    items.sort((a, b) => b.dist - a.dist);

    // Render in sorted order with depth writes disabled
    gl.depthMask(false);
    let worldPassActive = false;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.kind === 0) {
        // World transparent leaf
        if (!worldPassActive) {
          brushRenderer.beginWorldTransparentPass(worldmodel);
          worldPassActive = true;
        }
        brushRenderer.renderWorldTransparentLeaf(worldmodel, item.data as Node);
      } else {
        // Transparent entity — end world pass if active (shader switch)
        if (worldPassActive) {
          brushRenderer.endWorldTransparentPass();
          GL.StreamFlush();
          worldPassActive = false;
        }
        const entity = item.data as ClientEdict;
        if (entity.model === null || entity.model.type === null) {
          continue;
        }

        const renderer = modelRendererRegistry.getRenderer(entity.model.type)!;
        console.assert(renderer !== null, `renderer required for model type ${entity.model.type}`);
        renderer.render(entity.model, entity, 2);
        GL.StreamFlush();
      }
    }

    if (worldPassActive) {
      brushRenderer.endWorldTransparentPass();
      GL.StreamFlush();
    }

    gl.depthMask(true);
  };

  static DrawViewModel() {
    if (R.drawviewmodel.value === 0) {
      return;
    }
    if (Chase.active.value !== 0) {
      return;
    }
    if (R.drawentities.value === 0) {
      return;
    }

    if (!CL.gameCapabilities.includes(gameCapabilities.CAP_VIEWMODEL_MANAGED)) {
      const viewent = CL.state.viewent!;
      console.assert(viewent !== null, 'view entity required');

      if ((CL.state.items & Def.it.invisibility) !== 0) { // Legacy
        return;
      }
      if (CL.state.stats[Def.stat.health] <= 0) { // Legacy
        return;
      }
      if (!viewent.model) {
        return;
      }
    } else if (CL.state.gameAPI) {
      const viewmodel = CL.state.gameAPI.viewmodel;

      if (viewmodel === null) {
        return;
      }

      if (!viewmodel.visible) {
        return; // game says to not draw the view model
      }

      if (!viewmodel.model) {
        return; // no model to draw
      }
    }

    gl.depthRange(0.0, 0.3);

    let ymax = 4.0 * Math.tan(SCR.fov.value * 0.82 * Math.PI / 360.0);
    R.perspective[0] = 4.0 / (ymax * R.refdef.vrect.width / R.refdef.vrect.height);
    R.perspective[5] = 4.0 / ymax;
    let program = GL.UseProgram('alias')!;
    console.assert(program !== null, 'alias program required');
    gl.uniformMatrix4fv(program.uPerspective!, false, R.perspective);

    const viewent = CL.state.viewent;
    if (viewent !== null && viewent.model !== null) {
      const aliasRenderer = modelRendererRegistry.getRenderer(ModelType.alias)!;
      console.assert(aliasRenderer !== null, 'alias renderer required');
      aliasRenderer.setupRenderState(0);
      aliasRenderer.render(viewent.model, viewent, 0);
      aliasRenderer.cleanupRenderState(0);
    }

    ymax = 4.0 * Math.tan(R.refdef.fov_y * Math.PI / 360.0);
    R.perspective[0] = 4.0 / (ymax * R.refdef.vrect.width / R.refdef.vrect.height);
    R.perspective[5] = 4.0 / ymax;
    program = GL.UseProgram('alias')!;
    console.assert(program !== null, 'alias program required');
    gl.uniformMatrix4fv(program.uPerspective!, false, R.perspective);

    gl.depthRange(0.0, 1.0);
  };

  static PolyBlend() {
    if (R.polyblend.value === 0) {
      return;
    }
    if (V.blend[3] === 0.0) {
      return;
    }
    GL.UseProgram('fill', true);
    const vrect = R.refdef.vrect;
    GL.StreamDrawColoredQuad(vrect.x, vrect.y, vrect.width, vrect.height, V.blend[0], V.blend[1], V.blend[2], V.blend[3] * 255.0);
  };

  static SetFrustum() {
    if (R.vup.isOrigin() || R.vright.isOrigin() || R.vpn.isOrigin()) { // can’t set frustum with these
      return;
    }
    R.frustum[0].normal = R.vup.rotatePointAroundVector(R.vpn, -(90.0 - R.refdef.fov_x * 0.5));
    R.frustum[1].normal = R.vup.rotatePointAroundVector(R.vpn, 90.0 - R.refdef.fov_x * 0.5);
    R.frustum[2].normal = R.vright.rotatePointAroundVector(R.vpn, 90.0 - R.refdef.fov_y * 0.5);
    R.frustum[3].normal = R.vright.rotatePointAroundVector(R.vpn, -(90.0 - R.refdef.fov_y * 0.5));
    for (let i = 0; i < 4; i++) {
      const out = R.frustum[i];
      out.type = 5;
      out.dist = R.refdef.vieworg.dot(out.normal);
      out.signbits = 0;
      if (out.normal[0] < 0.0) {
        out.signbits = 1;
      }
      if (out.normal[1] < 0.0) {
        out.signbits += 2;
      }
      if (out.normal[2] < 0.0) {
        out.signbits += 4;
      }
      if (out.normal[3] < 0.0) {
        out.signbits += 8;
      }
    }
  };

  static viewMatrix: number[] | null = null;
  static projectionMatrix: number[] | null = null;


  private static multiplyMatrixVec4(m: number[], v: Vec4): Vec4 {
    return [
      m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3],
      m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3],
      m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
      m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
    ];
  }

  /**
   * Convert a world-space position into screen coordinates.
   * @returns Screen coordinates or null when the point is off-screen.
   */
  static WorldToScreen(origin: Vector): Vector | null {
    const projectionMatrix = R.projectionMatrix;
    const viewMatrix = R.viewMatrix; // This is uViewAngles — rotation only

    if (projectionMatrix === null || viewMatrix === null) {
      return null;
    }

    // world-space delta from camera
    const delta = [
      origin[0] - R.refdef.vieworg[0],
      origin[1] - R.refdef.vieworg[1],
      origin[2] - R.refdef.vieworg[2],
    ];

    // Apply view rotation
    const x =
      viewMatrix[0] * delta[0] +
      viewMatrix[4] * delta[1] +
      viewMatrix[8] * delta[2];
    const y =
      viewMatrix[1] * delta[0] +
      viewMatrix[5] * delta[1] +
      viewMatrix[9] * delta[2];
    const z =
      viewMatrix[2] * delta[0] +
      viewMatrix[6] * delta[1] +
      viewMatrix[10] * delta[2];

    // Mimic gl_Position = projection * vec4(xz, -y, 1.0)
    const posVec = [x, z, -y, 1.0]; // Swizzle + flip Y

    const clip = R.multiplyMatrixVec4(projectionMatrix, posVec as Vec4);

    // If the clip space W coordinate is zero, we can't convert to NDC
    if (clip[3] === 0) {
      return null;
    }

    const ndc = [
      clip[0] / clip[3],
      clip[1] / clip[3],
      clip[2] / clip[3],
    ];

    if (clip[3] > 0 && ndc[0] >= -1 && ndc[0] <= 1 && ndc[1] >= -1 && ndc[1] <= 1 && ndc[2] >= 0 && ndc[2] <= 1) {
      return new Vector(
        R.refdef.vrect.x + (ndc[0] + 1) * 0.5 * R.refdef.vrect.width,
        R.refdef.vrect.y + (1 - ndc[1]) * 0.5 * R.refdef.vrect.height,
        ndc[2],
      );
    }

    return null;
  };

  static perspective = [
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, -65540.0 / 65532.0, -1.0,
    0.0, 0.0, -524288.0 / 65532.0, 0.0,
  ];

  static Perspective() {
    const viewangles = [
      R.refdef.viewangles[0] * Math.PI / 180.0,
      (R.refdef.viewangles[1] - 90.0) * Math.PI / -180.0,
      R.refdef.viewangles[2] * Math.PI / -180.0,
    ];
    const sp = Math.sin(viewangles[0]);
    const cp = Math.cos(viewangles[0]);
    const sy = Math.sin(viewangles[1]);
    const cy = Math.cos(viewangles[1]);
    const sr = Math.sin(viewangles[2]);
    const cr = Math.cos(viewangles[2]);
    const viewMatrix = [
      cr * cy + sr * sp * sy,		cp * sy,	-sr * cy + cr * sp * sy,
      cr * -sy + sr * sp * cy,	cp * cy,	-sr * -sy + cr * sp * cy,
      sr * cp,					-sp,		cr * cp,
    ];

    R.viewMatrix = [
      viewMatrix[0], viewMatrix[1], viewMatrix[2], 0.0,
      viewMatrix[3], viewMatrix[4], viewMatrix[5], 0.0,
      viewMatrix[6], viewMatrix[7], viewMatrix[8], 0.0,
      0.0,           0.0,           0.0,           1.0,
    ];

    R.projectionMatrix = R.perspective;

    if (V.gamma.value < 0.5) {
      V.gamma.set(0.5);
    } else if (V.gamma.value > 1.0) {
      V.gamma.set(1.0);
    }

    GL.UnbindProgram();
    for (let i = 0; i < GL.programs.length; i++) {
      const program = GL.programs[i];
      gl.useProgram(program.program);
      if (program.uViewOrigin !== undefined) {
        gl.uniform3fv(program.uViewOrigin, R.refdef.vieworg);
      }
      if (program.uViewAngles !== undefined) {
        gl.uniformMatrix3fv(program.uViewAngles, false, viewMatrix);
      }
      if (program.uPerspective !== undefined) {
        gl.uniformMatrix4fv(program.uPerspective, false, R.perspective);
      }
      if (program.uGamma !== undefined) {
        gl.uniform1f(program.uGamma, V.gamma.value);
      }
      // global fog uniforms (only set when shader declares them)
      if (program.uFogColor !== undefined) {
        const colParts = (R.fog_color.string || '128 128 128').split(/\s+/).map(Number);
        gl.uniform3fv(program.uFogColor, [(colParts[0]||128)/255.0, (colParts[1]||128)/255.0, (colParts[2]||128)/255.0]);
      }
      if (program.uFogParams !== undefined) {
        // uFogParams = vec4(start, end, density, mode)
        gl.uniform4f(program.uFogParams, R.fog_start.value, R.fog_end.value, R.fog_density.value, R.fog_mode.value);
      }
      // shadow mapping uniforms (set on all programs that declare them)
      if (program.uLightSpaceMatrix0 !== undefined) {
        gl.uniformMatrix4fv(program.uLightSpaceMatrix0, false, ShadowMap.lightSpaceMatrices[0]);
      }
      if (program.uLightSpaceMatrix1 !== undefined) {
        gl.uniformMatrix4fv(program.uLightSpaceMatrix1, false, ShadowMap.lightSpaceMatrices[1]);
      }
      if (program.uLightSpaceMatrix2 !== undefined) {
        gl.uniformMatrix4fv(program.uLightSpaceMatrix2, false, ShadowMap.lightSpaceMatrices[2]);
      }
      if (program.uShadowEnabled !== undefined) {
        gl.uniform1f(program.uShadowEnabled, ShadowMap.enabled!.value ? 1.0 : 0.0);
      }
      if (program.uShadowCount !== undefined) {
        gl.uniform1i(program.uShadowCount, ShadowMap.enabled!.value ? ShadowMap.localLightCount : 0);
      }
      if (program.uShadowDarkness !== undefined) {
        gl.uniform1f(program.uShadowDarkness, ShadowMap.darkness!.value);
      }
      if (program.uShadowMapSize !== undefined) {
        gl.uniform1f(program.uShadowMapSize, ShadowMap.size);
      }
      // Point light shadow uniforms
      if (program.uPointShadowEnabled !== undefined) {
        gl.uniform1f(program.uPointShadowEnabled, ShadowMap.pointLightActive ? 1.0 : 0.0);
      }
      if (program.uPointLightPos !== undefined) {
        gl.uniform3fv(program.uPointLightPos, ShadowMap.pointLightOrigin);
      }
      if (program.uPointLightRadius !== undefined) {
        gl.uniform1f(program.uPointLightRadius, ShadowMap.pointLightRadius);
      }
    }
  };

  static SetupGL() {
    const vrect = R.refdef.vrect;
    const pixelRatio = VID.pixelRatio;
    const w = (vrect.width * pixelRatio) >> 0;
    const h = (vrect.height * pixelRatio) >> 0;

    if (R.usePostProcess || PostProcess.hasActiveEffects()) {
      // Render the scene to the shared post-process capture FBO whenever a
      // screen-space effect needs to sample it. Depth-aware passes like fog
      // use the same capture path and sample the depth texture mid-frame.
      PostProcess.resize(w, h);
      PostProcess.begin();
      gl.viewport(0, 0, w, h);
    } else {
      gl.viewport((vrect.x * pixelRatio) >> 0, ((VID.height - vrect.height - vrect.y) * pixelRatio) >> 0, w, h);
    }
    R.Perspective();
    gl.enable(gl.DEPTH_TEST);
  };

  static viewleaf: Node | null = null;

  static PreRenderScene() {
    R.AnimateLight();
    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const {forward, right, up} = R.refdef.viewangles.angleVectors();
    [R.vpn, R.vright, R.vup] = [forward, right, up];
    R.viewleaf = worldmodel.getLeafForPoint(R.refdef.vieworg);
    V.SetContentsColor(R.viewleaf.contents);
    V.CalcBlend();
    R.dowarp = (R.waterwarp.value !== 0) && (R.viewleaf.contents <= content.CONTENT_WATER);

    // Update warp effect active state
    const warpEffect = PostProcess.getEffect('warp');
    if (warpEffect) {
      warpEffect.active = R.dowarp;
    }

    const bloomEffect = PostProcess.getEffect('bloom');
    if (bloomEffect) {
      bloomEffect.active = R.bloom.value !== 0;
    }

    // Activate depth-texture post-process when fog volumes exist.
    // Pipeline effects (warp, etc.) are resolved separately via PostProcess.resolve.
    R.usePostProcess = worldmodel.fogVolumes.length > 0;

    // Choose the shadow texture for this frame (real or dummy)
    R.shadow_textures = ShadowMap.getActiveTextures();
    R.shadow_texture = R.shadow_textures[0] ?? null;
    R.point_shadow_texture = ShadowMap.getActivePointTexture();
  };

  static RenderWorld() {
    // Render world and entities using the renderer registry
    const worldEntity = CL.state.clientEntities.getEntity(0);
    if (worldEntity && worldEntity.model) {
      const brushRenderer = modelRendererRegistry.getRenderer(ModelType.brush)!;
      console.assert(brushRenderer !== null, 'brush renderer required');
      // Pass 0: World opaque surfaces
      brushRenderer.render(worldEntity.model, worldEntity, 0);
    }

    // Draw all other entities (pass 0 for opaque, pass 1 for turbulent)
    R.DrawEntitiesOnList();

    // Fog volumes and turbulent surfaces must be interleaved back-to-front.
    // Without sorting, turbulents always draw over fog (or vice versa),
    // which is wrong when a fog volume is in front of a water surface.
    // We collect both into a single list, sort by distance from the camera,
    // and render farthest-first so nearer surfaces blend over farther ones.
    if (worldEntity && worldEntity.model) {
      R._renderFogAndTurbulentsSorted(worldEntity);
    }

    gl.disable(gl.CULL_FACE);
    R.RenderDlights();
    R.DrawDecals();
    R.DrawParticles();

    // Pass 2: All transparent geometry, sorted back-to-front with depthMask(false).
    // Without sorting, whichever draws last appears on top. By sorting farthest-first
    // and disabling depth writes, nearer transparent surfaces blend over farther ones.
    gl.enable(gl.CULL_FACE);
    R._renderTransparentsSorted(worldEntity);
    gl.disable(gl.CULL_FACE);
  };

  static RenderScene() {
    R.SetFrustum();
    console.assert(ShadowMap.enabled !== null, 'shadow toggle required');
    console.assert(ShadowMap.casterRadius !== null, 'shadow caster radius required');

    // Shadow depth pass — local entity shadow centered on the nearest visible
    // shadow caster. Static world shadowing remains authored by baked lightmaps.
    if (ShadowMap.enabled!.value) {
      ShadowMap.selectLocalLights(R.refdef.vieworg);
      ShadowMap.updateLightSpaceMatrices();
      R.shadow_textures = ShadowMap.getActiveTextures();
      R.shadow_texture = R.shadow_textures[0] ?? null;
      const localCasterRadius = ShadowMap.casterRadius!.value;
      const localCasterRadiusSq = localCasterRadius * localCasterRadius;

      for (let i = 0; i < ShadowMap.localLightCount; i++) {
        ShadowMap.begin(i);
        ShadowMap.renderEntitiesShadow(
          ShadowMap.lightSpaceMatrices[i],
          'shadow-brush',
          'shadow-alias',
          ShadowMap._shadowFocusPoint,
          localCasterRadiusSq,
        );
        ShadowMap.end();
      }
    }

    // Point light shadow pass — render world BSP into a cube depth map
    // from the strongest dlight's position.
    if (ShadowMap.selectPointLight(R.refdef.vieworg)) {
      ShadowMap.renderPointLightShadow();
    }
    // Update point shadow texture AFTER selectPointLight so the correct
    // texture (real or dummy) is bound for this frame. PreRenderScene
    // runs before selectPointLight updates pointLightActive, so its
    // assignment may be stale on the first frame a dlight appears.
    R.point_shadow_texture = ShadowMap.getActivePointTexture();

    R.SetupGL();
    R.MarkLeafs();
    gl.enable(gl.CULL_FACE);
    R.DrawSkyBox();
    R.DrawViewModel();
    R.RenderWorld();
  };

  static _speeds: string[] = [];

  static RenderView() {
    let time1 = 0;
    if (R.speeds.value !== 0) {
      gl.finish();
      time1 = Sys.FloatMilliTime();
    }
    R.c_brush_verts = 0;
    R.c_brush_tris = 0;
    R.c_brush_draws = 0;
    R.c_brush_draws_pbr = 0;  // Draw calls with PBR materials
    R.c_brush_vbos = 0;
    R.c_brush_texture_binds = 0;  // Track texture binding overhead
    R.c_alias_polys = 0;
    gl.clear(gl.COLOR_BUFFER_BIT + gl.DEPTH_BUFFER_BIT);
    R.RenderScene();
    if (R.speeds.value !== 0) {
      const c_brush_polys = R.c_brush_verts / 3;
      const c_alias_polys = R.c_alias_polys;
      const avgTrisPerDraw = (R.c_brush_tris / R.c_brush_draws).toFixed(1);

      R._speeds[0] = `${R.c_brush_draws.toFixed().padStart(5)} draw calls (${R.c_brush_draws_pbr} PBR)`;
      R._speeds[1] = `${R.c_brush_tris.toFixed().padStart(5)} tris, ${R.c_brush_verts.toFixed().padStart(5)} verts`;
      R._speeds[2] = `${R.c_brush_vbos.toFixed().padStart(5)} VBOs used, ${R.c_brush_texture_binds.toFixed().padStart(5)} texture binds`;
      R._speeds[3] = `${c_alias_polys.toFixed().padStart(5)} alias polys, ${c_brush_polys.toFixed().padStart(5)} brush polys`;
      R._speeds[4] = '';
      R._speeds[5] = `Avg ${avgTrisPerDraw} tris/draw, time: ${((Sys.FloatMilliTime() - time1)).toFixed(1)} msec`;
    }
  };

  static PrintSpeeds() {
    if (!R.speeds.value) {
      return;
    }

    Draw.String(16, 16, `${SCR.FPS.toFixed(1)} FPS`, 2.0);

    for (let i = 0; i < R._speeds.length; i++) {
      Draw.String(16, 40 + i * 8, R._speeds[i]);
    }
  };

  // misc

  static InitTextures() {
    if (registry.isDedicatedServer) {
      return;
    }

    // make a default texture (a red and black checkerboard)
    const data = new Uint8Array(new ArrayBuffer(256 * 4));
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        data[((i << 4) + j) * 4 + 0] = 255;
        data[((i << 4) + j) * 4 + 1] = 0;
        data[((i << 4) + j) * 4 + 2] = 0;
        data[((i << 4) + j) * 4 + 3] = 255;

        data[(136 + (i << 4) + j) * 4 + 0] = 255;
        data[(136 + (i << 4) + j) * 4 + 1] = 0;
        data[(136 + (i << 4) + j) * 4 + 2] = 0;
        data[(136 + (i << 4) + j) * 4 + 3] = 255;

        data[(8 + (i << 4) + j) * 4 + 0] = 0;
        data[(8 + (i << 4) + j) * 4 + 1] = 0;
        data[(8 + (i << 4) + j) * 4 + 2] = 0;
        data[(8 + (i << 4) + j) * 4 + 3] = 255;

        data[(128 + (i << 4) + j) * 4 + 0] = 0;
        data[(128 + (i << 4) + j) * 4 + 1] = 0;
        data[(128 + (i << 4) + j) * 4 + 2] = 0;
        data[(128 + (i << 4) + j) * 4 + 3] = 255;
      }
    }

    R.notexture = GLTexture.Allocate('r_notexture', 16, 16, data);
    R.blacktexture = GLTexture.Allocate('r_blacktexture', 1, 1, new Uint8Array([0, 0, 0, 255]));
    R.flatnormalmap = GLTexture.Allocate('r_flatnormalmap', 1, 1, new Uint8Array([128, 128, 255, 255]));

    R.deluxemap_texture = gl.createTexture();
    GL.BindArray(0, R.deluxemap_texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 3);

    R.lightmap_texture = gl.createTexture();
    GL.BindArray(0, R.lightmap_texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 3);

    R.dlightmap_rgba_texture = gl.createTexture();
    GL.Bind(0, R.dlightmap_rgba_texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE);

    R.lightstyle_texture_a = gl.createTexture();
    GL.Bind(0, R.lightstyle_texture_a);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 64, 1);

    R.lightstyle_texture_b = gl.createTexture();
    GL.Bind(0, R.lightstyle_texture_b);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 64, 1);

    R.fullbright_texture = gl.createTexture();
    GL.BindArray(0, R.fullbright_texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 3);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 3, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([
      255, 0, 0, 0, // layer 0 (R): lightstyle 0 at full
      255, 0, 0, 0, // layer 1 (G): lightstyle 0 at full
      255, 0, 0, 0, // layer 2 (B): lightstyle 0 at full
    ]));

    R.null_texture = gl.createTexture();
    GL.Bind(0, R.null_texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    R.normal_up_texture = gl.createTexture();
    GL.BindArray(0, R.normal_up_texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 3);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 3, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([
      128, 0, 0, 0, // layer 0 (X): neutral
      255, 0, 0, 0, // layer 1 (Y): full (up direction)
      128, 0, 0, 0, // layer 2 (Z): neutral
    ]));

    eventBus.publish('renderer.textures.initialized');
  };

  static async InitShaders(): Promise<void> {
    // rendering alias models
    await Promise.all([
      Promise.resolve(GL.CreateProgram('alias',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix0', 'uLightSpaceMatrix1', 'uLightSpaceMatrix2', 'uShadowEnabled', 'uShadowCount', 'uShadowDarkness', 'uPointLightPos', 'uPointLightRadius', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
        [
          ['aPositionA', gl.FLOAT, 3],
          ['aPositionB', gl.FLOAT, 3],
          ['aNormal', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
        ],
        ['tTexture', 'tLuminance', 'tShadowMap0', 'tShadowMap1', 'tShadowMap2', 'tPointShadowMap'])),

      // rendering mesh models (OBJ, IQM, GLTF)
      Promise.resolve(GL.CreateProgram('mesh',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix0', 'uLightSpaceMatrix1', 'uLightSpaceMatrix2', 'uShadowEnabled', 'uShadowCount', 'uShadowDarkness', 'uPointLightPos', 'uPointLightRadius', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
        [
          ['aPosition', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
          ['aNormal', gl.FLOAT, 3],
        ],
        ['tTexture', 'tShadowMap0', 'tShadowMap1', 'tShadowMap2', 'tPointShadowMap'])),

      // rendering brush models (water is down below)
      Promise.resolve(GL.CreateProgram('brush',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uHaveDeluxemap', 'uLightSpaceMatrix0', 'uLightSpaceMatrix1', 'uLightSpaceMatrix2', 'uShadowEnabled', 'uShadowCount', 'uShadowDarkness', 'uShadowMapSize', 'uPointLightPos', 'uPointLightRadius', 'uPointShadowEnabled', 'uBloomEmissiveScale', 'uBloomDlightScale', 'uBloomSpecularScale'],
          [
            ['aPosition', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 4],
            ['aLightStyle', gl.FLOAT, 4],
            ['aNormal', gl.FLOAT, 3],
            ['aTangent', gl.FLOAT, 3],
            ['aBitangent', gl.FLOAT, 3],
          ],
          ['tTextureA', 'tTextureB', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB', 'tLuminance', 'tSpecular', 'tNormal', 'tDeluxemap', 'tShadowMap0', 'tShadowMap1', 'tShadowMap2', 'tPointShadowMap'])),

      // rendering dynamic lights
      Promise.resolve(GL.CreateProgram('dlight',
          ['uOrigin', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uRadius', 'uGamma'],
          [['aPosition', gl.FLOAT, 3]],
          [])),

      // rendering the player model (similar to alias model but with custom colors)
      Promise.resolve(GL.CreateProgram('player',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uTime', 'uTop', 'uBottom', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix0', 'uLightSpaceMatrix1', 'uLightSpaceMatrix2', 'uShadowEnabled', 'uShadowCount', 'uShadowDarkness', 'uPointLightPos', 'uPointLightRadius', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
          [
            ['aPositionA', gl.FLOAT, 3],
            ['aPositionB', gl.FLOAT, 3],
            ['aNormal', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 2],
          ],
          ['tTexture', 'tLuminance', 'tPlayer', 'tShadowMap0', 'tShadowMap1', 'tShadowMap2', 'tPointShadowMap'])),

      // for rendering sprites (usually effects)
      Promise.resolve(GL.CreateProgram('sprite',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams', 'uInterpolation', 'uAlpha', 'uBloomEmissiveScale'],
          [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2]],
          ['tTexture'])),

      // for rendering decals
      Promise.resolve(GL.CreateProgram('decal',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams'],
          [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2], ['aColor', gl.UNSIGNED_BYTE, 3, true]],
          ['tTexture'])),

      // for rendering particles (colored round dots)
      Promise.resolve(GL.CreateProgram('particle',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams'],
          [['aOrigin', gl.FLOAT, 3], ['aCoord', gl.FLOAT, 2], ['aScale', gl.FLOAT, 1], ['aColor', gl.UNSIGNED_BYTE, 3, true]],
          [])),

      // rendering water brushes
      Promise.resolve(GL.CreateProgram('turbulent',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uTime', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uAlpha', 'uBloomEmissiveScale', 'uBloomDlightScale'],
          [
            ['aPosition', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 4],
            ['aLightStyle', gl.FLOAT, 4],
            ['aNormal', gl.FLOAT, 3],
            // ['aTangent', gl.FLOAT, 3],
            // ['aBitangent', gl.FLOAT, 3],
          ],
          ['tTexture', 'tLuminance', 'tLightmap', 'tDlight', 'tLightStyle', 'tDeluxemap'])),

      // warp overlay effect
      Promise.resolve(GL.CreateProgram('warp',
          ['uOrtho', 'uTime'],
          [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
          ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-extract',
        ['uOrtho'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-blur',
        ['uOrtho', 'uTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-composite',
        ['uOrtho', 'uStrength'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tScene', 'tBloom'])),

      Promise.resolve(GL.CreateProgram('sky',
        ['uViewAngles', 'uPerspective', 'uScale', 'uGamma', 'uTime', 'uFogColor', 'uFogParams', 'uBloomEmissiveScale'],
        [['aPosition', gl.FLOAT, 3]],
        ['tSolid', 'tAlpha'])),

      Promise.resolve(GL.CreateProgram('sky-chain',
        ['uViewOrigin', 'uViewAngles', 'uPerspective'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // rendering volumetric fog brush volumes
      Promise.resolve(GL.CreateProgram('fog-volume',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma',
         'uFogVolumeColor', 'uFogVolumeDensity', 'uFogVolumeMaxOpacity',
         'uFogVolumeMins', 'uFogVolumeMaxs', 'uScreenSize',
         'uDlightCount',
         'uDlightPos[0]', 'uDlightPos[1]', 'uDlightPos[2]', 'uDlightPos[3]',
         'uDlightPos[4]', 'uDlightPos[5]', 'uDlightPos[6]', 'uDlightPos[7]',
         'uDlightColor[0]', 'uDlightColor[1]', 'uDlightColor[2]', 'uDlightColor[3]',
         'uDlightColor[4]', 'uDlightColor[5]', 'uDlightColor[6]', 'uDlightColor[7]'],
        [['aPosition', gl.FLOAT, 3]],
        ['tDepth', 'tLightProbe'])),

      // shadow depth pass for directional shadow mapping
      Promise.resolve(GL.CreateProgram('shadow-brush',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // shadow depth pass for point light cube shadow mapping
      Promise.resolve(GL.CreateProgram('shadow-point',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uLightPos', 'uLightRadius', 'uNormalBias'],
        [['aPosition', gl.FLOAT, 3], ['aNormal', gl.FLOAT, 3]],
        [])),

      // shadow depth pass for alias models (frame interpolation)
      Promise.resolve(GL.CreateProgram('shadow-alias',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uInterpolation'],
        [['aPositionA', gl.FLOAT, 3], ['aPositionB', gl.FLOAT, 3]],
        [])),

      // point shadow depth pass for alias models (frame interpolation)
      Promise.resolve(GL.CreateProgram('shadow-alias-point',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uInterpolation', 'uLightPos', 'uLightRadius', 'uNormalBias'],
        [['aPositionA', gl.FLOAT, 3], ['aPositionB', gl.FLOAT, 3], ['aNormalA', gl.FLOAT, 3], ['aNormalB', gl.FLOAT, 3]],
        [])),
    ]);

    eventBus.publish('renderer.shaders.initialized');
  };

  static async Init() {
    if (registry.isDedicatedServer) {
      console.assert(false, 'R.Init called on dedicated server');
      return;
    }

    R.waterwarp = new Cvar('r_waterwarp', '1');
    R.fullbright = new Cvar('r_fullbright', '0', Cvar.FLAG.CHEAT);
    R.drawentities = new Cvar('r_drawentities', '1', Cvar.FLAG.CHEAT);
    R.drawviewmodel = new Cvar('r_drawviewmodel', '1');
    R.drawturbulents = new Cvar('r_drawturbulents', '1', Cvar.FLAG.CHEAT);
    R.novis = new Cvar('r_novis', '0', Cvar.FLAG.CHEAT);
    R.speeds = new Cvar('r_speeds', '0');
    R.polyblend = new Cvar('gl_polyblend', '1');
    R.flashblend = new Cvar('gl_flashblend', '0');
    R.nocolors = new Cvar('gl_nocolors', '0');
    R.bloom = new Cvar('r_bloom', '0', Cvar.FLAG.NONE, 'Screen-space bloom post-process, 0 = off, 1 = on.');
    R.bloomStrength = new Cvar('r_bloom_strength', '0.8', Cvar.FLAG.NONE, 'Additive bloom intensity.');
    R.bloomSkyStrength = new Cvar('r_bloom_sky_strength', '0.33', Cvar.FLAG.NONE, 'Sky contribution added to the bloom emissive target. Lower than 1 keeps the sky glow subtle.');
    R.bloomDlightStrength = new Cvar('r_bloom_dlight_strength', '0.33', Cvar.FLAG.NONE, 'Dynamic-light surface contribution added to the bloom emissive target. Set to 0 to disable.');
    R.bloomSpecularStrength = new Cvar('r_bloom_specular_strength', '0.33', Cvar.FLAG.NONE, 'Specular reflection contribution added to the bloom emissive target. Set to 0 to disable.');
    R.bloomDownsample = new Cvar('r_bloom_downsample', '4', Cvar.FLAG.NONE, 'Bloom buffer downsample divisor, clamped to 1-8.');
    R.bloomDebug = new Cvar('r_bloom_debug', '0', Cvar.FLAG.NONE, 'Bloom debug preview: 0 = off, 1 = emissive, 2 = extract, 3 = blur, 4 = all.');
    R.interpolation = new Cvar('r_interpolation', '1', Cvar.FLAG.NONE, 'Interpolation of textures and animation groups, 0 - off, 1 - on');
    // fog controls (TODO: make that a cheat, but resetting cvar to default is done after R.NewMapFog, so need to rethink the order of operations)
    R.fog_color = new Cvar('r_fog_color', '128 128 128', Cvar.FLAG.NONE, 'Fog color: R G B (0-255)');
    R.fog_start = new Cvar('r_fog_start', '128', Cvar.FLAG.NONE, 'Fog start distance (linear)');
    R.fog_end = new Cvar('r_fog_end', '4096', Cvar.FLAG.NONE, 'Fog end distance (linear)');
    R.fog_density = new Cvar('r_fog_density', '0.01', Cvar.FLAG.NONE, 'Fog density (for exp/exp2)');
    R.fog_mode = new Cvar('r_fog_mode', '-1', Cvar.FLAG.NONE, 'Fog mode: 0=linear, 1=exp, 2=exp2, -1=disable');

    R.InitTextures();
    R.InitParticles();
    R.InitDecals();
    await R.InitShaders();

    // Register model renderers
    modelRendererRegistry.register(new BrushModelRenderer());
    modelRendererRegistry.register(new AliasModelRenderer());
    modelRendererRegistry.register(new SpriteModelRenderer());
    modelRendererRegistry.register(new MeshModelRenderer());

    // Initialize post-process infrastructure (scene FBO with depth texture)
    // and register screen-space effects that resolve from that capture.
    PostProcess.init();
    PostProcess.addEffect(new BloomEffect());
    PostProcess.addEffect(new WarpEffect());

    // Initialize shadow mapping (depth-only FBO + sun light)
    ShadowMap.init();

    const dlightvecs = gl.createBuffer();
    console.assert(dlightvecs !== null, 'Expected a dynamic light vertex buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, dlightvecs);
    gl.bufferData(gl.ARRAY_BUFFER, (() => {
      const positions = [];

      // 1) The "down" vector
      positions.push(0, -1, 0);

      // 2) 16 equally spaced vectors around the circle in y=0 plane
      const numSegments = 16;
      for (let i = 0; i <= numSegments; i++) {
        // Angle in radians
        const angle = (2 * Math.PI * i) / numSegments;
        // Match the pattern: x = -sin(angle), z = cos(angle)
        positions.push(-Math.sin(angle), 0, Math.cos(angle));
      }

      return new Float32Array(positions);
    })(), gl.STATIC_DRAW);

    const dlightVAO = GL.CreateVAO(dlightvecs, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride: 0, offset: 0 },
    ]);

    Object.assign(R, { dlightvecs, dlightVAO });

    R.ClearAll();
  };

  static NewMapFog() {
    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel must be loaded before InitFog');

    const fogInfo = worldmodel.worldspawnInfo.fog;

    if (!fogInfo) {
      R.fog_mode.set(-1);
      return;
    }

    const [exp, r, g, b] = fogInfo.split(' ').map(Number);

    // CR: I took that calculation from Ironwail’s Fog_SetupFrame:
    const ExpAdjustment = 1.20112241; // sqrt(log2(e))
    const SphericalCorrection = 0.85; // compensate higher perceived density with spherical fog
    const DensityScale = ExpAdjustment * SphericalCorrection / 64.0;

    R.fog_density.set(exp / DensityScale);
    R.fog_color.set(`${r * 255} ${g * 255} ${b * 255}`);
    R.fog_mode.set(1);
  };

  static NewMap() {
    R.BuildLightmaps();

    const dlightmapsRgba = R.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');

    for (let i = 0; i < dlightmapsRgba.length; i++) {
      dlightmapsRgba[i] = 0;
    }

    GL.Bind(0, R.dlightmap_rgba_texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, dlightmapsRgba);

    R.NewMapFog();
    R.MakeSky();
  };

  static ClearAll() {
    if (R.particles) {
      R.particles.length = 0;
    }

    for (let i = 0; i < 64; i++) {
      R.lightstylevalue_a[i] = 12;
      R.lightstylevalue_b[i] = 12;
    }

    R.oldviewleaf = null;
    R.viewleaf = null;

    R.deluxemap = null;
    R.lightmaps_rgb = null;
    R.dlightmaps_rgba = null;

    R.allocated = [];

    R.shadow_textures = [];
    R.shadow_texture = null;
    R.point_shadow_texture = null;
    R.world_depth_texture = null;

    R.ClearParticles();
    R.ClearDecals();
    R.ClearSky();
  };

  // part

  static readonly ptype = ParticleType;

  static ramp1 = [0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61];
  static ramp2 = [0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66];
  static ramp3 = [0x6d, 0x6b, 6, 5, 4, 3];

  static InitParticles() {
    R.numparticles = 32786;
    R.avelocities = [];
    for (let i = 0; i <= 161; i++) {
      R.avelocities[i] = [Math.random() * 2.56, Math.random() * 2.56, Math.random() * 2.56];
    }
  };

  static SerializeParticles(): SerializedParticle[] {
    const data = [];
    const round = (num: number): number => Math.round(num * 10) / 10; // we do not need a high precision here
    const roundVector = (vector: Vector): [number, number, number] => [
      round(vector[0]),
      round(vector[1]),
      round(vector[2]),
    ];

    for (let i = 0; i < R.numparticles; i++) {
      const p = R.particles[i];

      if (p.die < CL.state.time) {
        continue;
      }

      data.push({
        i: i,
        die: round(p.die - CL.state.time),
        color: p.color,
        ramp: round(p.ramp),
        type: round(p.type),
        org: roundVector(p.org),
        vel: roundVector(p.vel),
      });
    }

    return data;
  };

  static DeserializeParticles(data: SerializedParticle[]): void {
    for (const p of data) {
      console.assert(p.i >= 0 && p.i < R.particles.length, 'valid particle index', p.i);
      R.particles[p.i] = {
        die: p.die + CL.state.time,
        color: p.color,
        ramp: p.ramp,
        type: p.type,
        org: new Vector(...p.org),
        vel: new Vector(...p.vel),
      };
    }
  };

  static EntityParticles(ent: ClientEdict): void {
    const allocated = R.AllocParticles(162);

    for (let i = 0; i < allocated.length; i++) {
      const angleP = CL.state.time * R.avelocities[i][0];
      const sp = Math.sin(angleP);
      const cp = Math.cos(angleP);
      const angleY = CL.state.time * R.avelocities[i][1];
      const sy = Math.sin(angleY);
      const cy = Math.cos(angleY);

      R.particles[allocated[i]] = { // TODO: Particle Class
        die: CL.state.time + 0.01,
        color: 0x6f,
        ramp: 0.0,
        type: R.ptype.explode,
        org: new Vector(
          ent.origin[0] + avertexnormals[i * 3 + 0] * 64.0 + cp * cy * 16.0,
          ent.origin[1] + avertexnormals[i * 3 + 1] * 64.0 + cp * sy * 16.0,
          ent.origin[2] + avertexnormals[i * 3 + 2] * 64.0 + sp * -16.0,
        ),
        vel: new Vector(),
      };
    }
  };

  static ClearParticles() {
    R.particles = [];
    for (let i = 0; i < R.numparticles; i++) {
      R.particles[i] = R._createDeadParticle();
    }
  };

  static ParticleExplosion(org: Vector): void {
    const allocated = R.AllocParticles(1024);
    for (let i = 0; i < allocated.length; i++) {
      R.particles[allocated[i]] = {
        die: CL.state.time + 5.0,
        color: R.ramp1[0],
        ramp: Math.floor(Math.random() * 4.0),
        type: ((i & 1) !== 0) ? R.ptype.explode : R.ptype.explode2,
        org: new Vector(
          org[0] + Math.random() * 32.0 - 16.0,
          org[1] + Math.random() * 32.0 - 16.0,
          org[2] + Math.random() * 32.0 - 16.0,
        ),
        vel: new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0),
      };
    }
  };

  static ParticleExplosion2(org: Vector, colorStart: number, colorLength: number): void {
    const allocated = R.AllocParticles(512);
    let colorMod = 0;
    for (let i = 0; i < allocated.length; i++) {
      R.particles[allocated[i]] = {
        die: CL.state.time + 0.3,
        color: colorStart + (colorMod++ % colorLength),
        ramp: 0.0,
        type: R.ptype.blob,
        org: new Vector(
          org[0] + Math.random() * 32.0 - 16.0,
          org[1] + Math.random() * 32.0 - 16.0,
          org[2] + Math.random() * 32.0 - 16.0,
        ),
        vel: new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0),
      };
    }
  };

  static BlobExplosion(org: Vector): void {
    const allocated = R.AllocParticles(1024);
    for (let i = 0; i < allocated.length; i++) {
      const p = R.particles[allocated[i]];
      p.die = CL.state.time + 1.0 + Math.random() * 0.4;
      if ((i & 1) !== 0) {
        p.type = R.ptype.blob;
        p.color = 66 + Math.floor(Math.random() * 7.0);
      } else {
        p.type = R.ptype.blob2;
        p.color = 150 + Math.floor(Math.random() * 7.0);
      }
      p.org = new Vector(
        org[0] + Math.random() * 32.0 - 16.0,
        org[1] + Math.random() * 32.0 - 16.0,
        org[2] + Math.random() * 32.0 - 16.0,
      );
      p.vel = new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0);
    }
  };

  static RunParticleEffect(org: Vector, dir: Vector, color: number, count: number): void {
    const allocated = R.AllocParticles(count); let i;
    for (i = 0; i < allocated.length; i++) {
      R.particles[allocated[i]] = {
        die: CL.state.time + 0.6 * Math.random(),
        color: (color & 0xf8) + Math.floor(Math.random() * 8.0),
        ramp: 0.0,
        type: R.ptype.slowgrav,
        org: new Vector(
          org[0] + Math.random() * 16.0 - 8.0,
          org[1] + Math.random() * 16.0 - 8.0,
          org[2] + Math.random() * 16.0 - 8.0,
        ),
        vel: dir.copy().multiply(15.0),
      };
    }
  };

  static LavaSplash(org: Vector): void {
    const allocated = R.AllocParticles(1024);
    let k = 0;
    for (let i = -16; i <= 15; i++) {
      for (let j = -16; j <= 15; j++) {
        if (k >= allocated.length) {
          return;
        }
        const p = R.particles[allocated[k++]];
        p.die = CL.state.time + 2.0 + Math.random() * 0.64;
        p.color = 224 + Math.floor(Math.random() * 8.0);
        p.type = R.ptype.slowgrav;
        const dir = new Vector((j + Math.random()) * 8.0, (i + Math.random()) * 8.0, 256.0);
        p.org = new Vector(org[0] + dir[0], org[1] + dir[1], org[2] + Math.random() * 64.0);
        dir.normalize();
        p.vel = dir.multiply(50.0 + Math.random() * 64.0);
      }
    }
  };

  static TeleportSplash(org: Vector): void {
    const allocated = R.AllocParticles(896);
    let l = 0;
    for (let i = -16; i <= 15; i += 4) {
      for (let j = -16; j <= 15; j += 4) {
        for (let k = -24; k <= 31; k += 4) {
          if (l >= allocated.length) {
            return;
          }
          const p = R.particles[allocated[l++]];
          p.die = CL.state.time + 0.2 + Math.random() * 0.16;
          p.color = 7 + Math.floor(Math.random() * 8.0);
          p.type = R.ptype.slowgrav;
          const dir = new Vector(j * 8.0, i * 8.0, k * 8.0);
          p.org = new Vector(
            org[0] + i + Math.random() * 4.0,
            org[1] + j + Math.random() * 4.0,
            org[2] + k + Math.random() * 4.0,
          );
          dir.normalize();
          p.vel = dir.multiply(50.0 + Math.random() * 64.0);
        }
      }
    }
  };

  static tracercount = 0;
  static RocketTrail(start: Vector, end: Vector, type: number): void {
    let vec = end.copy().subtract(start);

    const len = vec.len();

    if (len === 0.0 || !isFinite(len)) {
      return;
    }

    vec.normalize();

    let allocated;
    if (type === 4) {
      allocated = R.AllocParticles(Math.floor(len / 6.0));
    } else {
      allocated = R.AllocParticles(Math.floor(len / 3.0));
    }

    for (let i = 0; i < allocated.length; i++) {
      const p = R.particles[allocated[i]];
      p.vel = new Vector();
      p.die = CL.state.time + 2.0;
      switch (type) {
        case 7:
          type = 1;
          p.die += 8.0;
        // eslint-disable-next-line no-fallthrough
        case 0:
        case 1:
          p.ramp = Math.floor(Math.random() * 4.0) + (type << 1);
          p.color = R.ramp3[p.ramp];
          p.type = R.ptype.fire;
          p.org = new Vector(
            start[0] + Math.random() * 6.0 - 3.0,
            start[1] + Math.random() * 6.0 - 3.0,
            start[2] + Math.random() * 6.0 - 3.0,
          );
          break;
        case 2:
          p.type = R.ptype.grav;
          p.color = 67 + Math.floor(Math.random() * 4.0);
          p.org = new Vector(
            start[0] + Math.random() * 6.0 - 3.0,
            start[1] + Math.random() * 6.0 - 3.0,
            start[2] + Math.random() * 6.0 - 3.0,
          );
          break;
        case 3:
        case 5:
          p.die = CL.state.time + 0.5;
          p.type = R.ptype.tracer;
          if (type === 3) {
            p.color = 52 + ((R.tracercount++ & 4) << 1);
          } else {
            p.color = 230 + ((R.tracercount++ & 4) << 1);
          }
          p.org = new Vector(start[0], start[1], start[2]);
          if ((R.tracercount & 1) !== 0) {
            p.vel[0] = 30.0 * vec[1];
            p.vel[2] = -30.0 * vec[0];
          } else {
            p.vel[0] = -30.0 * vec[1];
            p.vel[2] = 30.0 * vec[0];
          }
          break;
        case 4:
          p.type = R.ptype.grav;
          p.color = 67 + Math.floor(Math.random() * 4.0);
          p.org = new Vector(
            start[0] + Math.random() * 6.0 - 3.0,
            start[1] + Math.random() * 6.0 - 3.0,
            start[2] + Math.random() * 6.0 - 3.0,
          );
          break;
        case 6:
          p.color = 152 + Math.floor(Math.random() * 4.0);
          p.type = R.ptype.tracer;
          p.die = CL.state.time + 0.3;
          p.org = new Vector(
            start[0] + Math.random() * 16.0 - 8.0,
            start[1] + Math.random() * 16.0 - 8.0,
            start[2] + Math.random() * 16.0 - 8.0,
          );
          break;
        default:
          console.assert(false, 'Unknown particle type: ' + type);
      }
      start.add(vec);
    }
  };

  static InitDecals() {
    R.decals = [];

    Cmd.AddCommand('test_decal', async () => {
      const start = R.refdef.vieworg;
      const vectors = CL.state.viewangles.angleVectors();
      const forward = vectors.forward;
      const end = start.copy().add(forward.copy().multiply(8192));
      const trace = SV.collision.traceStaticWorldLine(start, end);

      if (trace.allsolid || trace.startsolid || trace.fraction === 1.0) {
        return;
      }

      // Use a particle texture for testing if no bullet texture exists
      R.PlaceDecal(trace.endpos, trace.plane.normal, await Draw.LoadPicFromLump('box_tl'));
    });
  };

  static ClearDecals() {
    R.decals = [];
  };

  static PlaceDecal(origin: Vector, normal: Vector, texture: GLTexture | null): void {
    if (!texture) {
      return;
    }

    // Calculate basis vectors for the decal quad
    const up = new Vector(0, 0, 1);

    if (Math.abs(normal.dot(up)) > 0.99) {
      up.setTo(1, 0, 0);
    }

    const right = normal.cross(up);
    right.normalize();
    up.set(right.cross(normal));
    up.normalize();

    const size = 4.0; // Decal size

    const verts: [Vector, Vector, Vector, Vector] = [
      origin.copy().add(right.copy().multiply(-size)).add(up.copy().multiply(size)),
      origin.copy().add(right.copy().multiply(size)).add(up.copy().multiply(size)),
      origin.copy().add(right.copy().multiply(size)).add(up.copy().multiply(-size)),
      origin.copy().add(right.copy().multiply(-size)).add(up.copy().multiply(-size)),
    ];

    // Apply polygon offset
    const offset = normal.copy().multiply(0.5);
    for (let i = 0; i < 4; i++) {
      verts[i].add(offset);
    }

    // Calculate lighting
    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const lightStart = origin.copy().add(normal.copy().multiply(4.0));
    const lightEnd = origin.copy().subtract(normal.copy().multiply(4.0));
    const lightResult = R.RecursiveLightPoint(worldmodel.nodes[0], lightStart, lightEnd);

    let color = new Vector(255, 255, 255); // Default to white
    if (lightResult) {
      const r = Math.min(255, Math.max(0, Math.floor(lightResult[0][0])));
      const g = Math.min(255, Math.max(0, Math.floor(lightResult[0][1])));
      const b = Math.min(255, Math.max(0, Math.floor(lightResult[0][2])));
      color.setTo(r, g, b);
    }

    R.decals.push({
      texture,
      verts,
      color,
      die: CL.state.time + 10.0, // Lasts 10 seconds
    });
  };

  static DrawDecals() {
    if (!R.decals || R.decals.length === 0) {
      return;
    }

    // Remove dead decals
    R.decals = R.decals.filter((d) => d.die > CL.state.time);

    if (R.decals.length === 0) {
      return;
    }

    GL.StreamFlush();

    const program = GL.UseProgram('decal')!;
    console.assert(program !== null, 'decal program required');
    gl.depthMask(false);
    gl.enable(gl.BLEND);

    gl.uniform1f(program.uAlpha!, 1.0);

    let currentTexture = null;

    for (let i = 0; i < R.decals.length; i++) {
      const decal = R.decals[i];

      if (decal.texture !== currentTexture) {
        GL.StreamFlush();
        decal.texture.bind(program.tTexture!);
        currentTexture = decal.texture;
      }

      GL.StreamGetSpace(6);

      // Quad vertices: 0, 1, 2, 0, 2, 3
      const v = decal.verts;
      const c = decal.color;
      const r = c[0];
      const g = c[1];
      const b = c[2];

      GL.StreamWriteFloat3(v[0][0], v[0][1], v[0][2]); GL.StreamWriteFloat2(0, 0); GL.StreamWriteUByte4(r, g, b, 255);
      GL.StreamWriteFloat3(v[1][0], v[1][1], v[1][2]); GL.StreamWriteFloat2(1, 0); GL.StreamWriteUByte4(r, g, b, 255);
      GL.StreamWriteFloat3(v[2][0], v[2][1], v[2][2]); GL.StreamWriteFloat2(1, 1); GL.StreamWriteUByte4(r, g, b, 255);

      GL.StreamWriteFloat3(v[0][0], v[0][1], v[0][2]); GL.StreamWriteFloat2(0, 0); GL.StreamWriteUByte4(r, g, b, 255);
      GL.StreamWriteFloat3(v[2][0], v[2][1], v[2][2]); GL.StreamWriteFloat2(1, 1); GL.StreamWriteUByte4(r, g, b, 255);
      GL.StreamWriteFloat3(v[3][0], v[3][1], v[3][2]); GL.StreamWriteFloat2(0, 1); GL.StreamWriteUByte4(r, g, b, 255);
    }

    GL.StreamFlush();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  };

  static DrawParticles() {
    GL.StreamFlush();

    GL.UseProgram('particle');
    gl.depthMask(false);
    gl.enable(gl.BLEND);

    const frametime = Host.frametime;
    console.assert(SV.gravity !== null, 'server gravity cvar required');
    const grav = frametime * SV.gravity!.value * 0.05;
    const dvel = frametime * 4.0;
    let scale;

    const coords = [-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
    for (let i = 0; i < R.numparticles; i++) {
      const p = R.particles[i];
      if (p.die < CL.state.time) {
        continue;
      }

      const color = W.d_8to24table[p.color];
      scale = (p.org[0] - R.refdef.vieworg[0]) * R.vpn[0] + (p.org[1] - R.refdef.vieworg[1]) * R.vpn[1] + (p.org[2] - R.refdef.vieworg[2]) * R.vpn[2];
      if (scale < 20.0) {
        scale = 0.375;
      } else {
        scale = 0.375 + scale * 0.0015;
      }

      GL.StreamGetSpace(6);
      for (let j = 0; j < 6; j++) {
        GL.StreamWriteFloat3(p.org[0], p.org[1], p.org[2]);
        GL.StreamWriteFloat2(coords[j * 2], coords[j * 2 + 1]);
        GL.StreamWriteFloat(scale);
        GL.StreamWriteUByte4(color & 0xff, (color >> 8) & 0xff, color >> 16, 255);
      }

      p.org[0] += p.vel[0] * frametime;
      p.org[1] += p.vel[1] * frametime;
      p.org[2] += p.vel[2] * frametime;

      switch (p.type) {
        case R.ptype.fire:
          p.ramp += frametime * 5.0;
          if (p.ramp >= 6.0) {
            p.die = -1.0;
          } else {
            p.color = R.ramp3[Math.floor(p.ramp)];
          }
          p.vel[2] += grav;
          continue;
        case R.ptype.explode:
          p.ramp += frametime * 10.0;
          if (p.ramp >= 8.0) {
            p.die = -1.0;
          } else {
            p.color = R.ramp1[Math.floor(p.ramp)];
          }
          p.vel[0] += p.vel[0] * dvel;
          p.vel[1] += p.vel[1] * dvel;
          p.vel[2] += p.vel[2] * dvel - grav;
          continue;
        case R.ptype.explode2:
          p.ramp += frametime * 15.0;
          if (p.ramp >= 8.0) {
            p.die = -1.0;
          } else {
            p.color = R.ramp2[Math.floor(p.ramp)];
          }
          p.vel[0] -= p.vel[0] * frametime;
          p.vel[1] -= p.vel[1] * frametime;
          p.vel[2] -= p.vel[2] * frametime + grav;
          continue;
        case R.ptype.blob:
          p.vel[0] += p.vel[0] * dvel;
          p.vel[1] += p.vel[1] * dvel;
          p.vel[2] += p.vel[2] * dvel - grav;
          continue;
        case R.ptype.blob2:
          p.vel[0] += p.vel[0] * dvel;
          p.vel[1] += p.vel[1] * dvel;
          p.vel[2] -= grav;
          continue;
        case R.ptype.grav:
        case R.ptype.slowgrav:
          p.vel[2] -= grav;
      }
    }

    GL.StreamFlush();

    gl.disable(gl.BLEND);
    gl.depthMask(true);
  };

  static AllocParticles(count: number): number[] {
    const allocated = new Array<number>(count);
    for (let i = 0, j = 0; i < R.numparticles; i++) {
      if (count === 0) {
        return allocated;
      }
      if (R.particles[i].die < CL.state.time) {
        allocated[j++] = i;
        count--;
      }
    }
    allocated.length = allocated.length - count;
    return allocated;
  };

  // surf

  static lightmap_modified = new Uint8Array(LIGHTMAP_BLOCK_SIZE);
  static lightmaps_rgb: Uint8Array | null = null; // allocated on demand
  static dlightmaps_rgba: Uint8Array | null = null; // allocated on demand
  static deluxemap: Uint8Array | null = null; // allocated on demand

  static AddDynamicLights(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const dlightmapsRgba = R.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;
    const size = smax * tmax;

    const blocklights: number[] = [];
    for (let i = 0; i < size * 3; i++) {
      blocklights[i] = 0;
    }

    for (let i = 0; i < Def.limits.dlights; i++) {
      if (((surf.dlightbits >>> i) & 1) === 0) {
        continue;
      }
      const light = CL.state.clientEntities.dlights[i];
      const lightImpact = R.GetDynamicLightSurfaceImpact(light, surf);

      if (lightImpact === null) {
        continue;
      }
      let dist = lightImpact.distanceToPlane;
      const rad = light.radius - dist;
      let minlight = light.minlight;
      if (rad < minlight) {
        continue;
      }
      minlight = rad - minlight;
      const impact = lightImpact.impact;
      const tex = worldmodel.texinfo[surf.texinfo];
      const local = [
        impact.dot(R._textureAxisToVector(tex.vecs[0])) + tex.vecs[0][3] - surf.texturemins[0],
        impact.dot(R._textureAxisToVector(tex.vecs[1])) + tex.vecs[1][3] - surf.texturemins[1],
      ];
      for (let t = 0; t < tmax; t++) {
        let td = local[1] - (t << lmshift);
        if (td < 0.0) {
          td = -td;
        }
        td = Math.floor(td);
        for (let s = 0; s < smax; s++) {
          let sd = local[0] - (s << lmshift);
          if (sd < 0) {
            sd = -sd;
          }
          sd = Math.floor(sd);
          if (sd > td) {
            dist = sd + (td >> 1);
          } else {
            dist = td + (sd >> 1);
          }
          if (dist < minlight) {
            const bl = Math.floor((rad - dist) * 256.0);
            const pos = (t * smax + s) * 3;
            for (let i = 0; i < 3; i++) {
              blocklights[pos + i] += bl * light.color[i];
            }
          }
        }
      }
    }

    for (let t = 0, i = 0; t < tmax; t++) {
      R.lightmap_modified[surf.light_t + t] = 1;
      const dest = ((surf.light_t + t) * LIGHTMAP_BLOCK_SIZE) + surf.light_s;
      for (let s = 0; s < smax; s++) {
        const dldest = (dest + s) * 4;
        const blrgb = [
          Math.min(Math.floor(blocklights[i * 3] / 128), 255),
          Math.min(Math.floor(blocklights[i * 3 + 1] / 128), 255),
          Math.min(Math.floor(blocklights[i * 3 + 2] / 128), 255),
        ];
        // console.log(blrgb);
        i++;
        for (let i = 0; i < 3; i++) {
          dlightmapsRgba[dldest + i] = blrgb[i];
        }
      }
    }
  };

  static RemoveDynamicLights(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const dlightmapsRgba = R.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;
    for (let t = 0; t < tmax; t++) {
      R.lightmap_modified[surf.light_t + t] = 1;
      const dest = ((surf.light_t + t) * LIGHTMAP_BLOCK_SIZE) + surf.light_s;
      for (let s = 0; s < smax; s++) {
        const dldest = (dest + s) * 4;
        for (let i = 0; i < 3; i++) {
          dlightmapsRgba[dldest + i] = 0;
        }
        dlightmapsRgba[dldest + 3] = 255; // fully opaque
      }
    }
  };

  static BuildLightMap(currentmodel: BrushModel, surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const lightmapsRgb = R.lightmaps_rgb!;
    console.assert(lightmapsRgb !== null, 'lightmap buffer required');
    const lightdata = currentmodel.lightdata!;
    console.assert(lightdata !== null, 'brush lightdata required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;

    for (let k = 0; k < 3; k++) {
      const offset = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * k;
      let lightmap = surf.lightofs;
      let maps;

      for (maps = 0; maps < surf.styles.length; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = lightdata[lightmap + j];
          }
          lightmap += smax;
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }

      for (; maps < 4; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = 0;
          }
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }
    }
  };

  static BuildLightMapEx(currentmodel: BrushModel, surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const lightmapsRgb = R.lightmaps_rgb!;
    console.assert(lightmapsRgb !== null, 'lightmap buffer required');
    const lightdataRgb = currentmodel.lightdata_rgb!;
    console.assert(lightdataRgb !== null, 'brush rgb lightdata required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;

    if (currentmodel.deluxemap && !R.deluxemap) {
      R.deluxemap = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * 3));
    }

    for (let k = 0; k < 3; k++) {
      const offset = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * k;
      let lightmap = surf.lightofs * 3;
      let maps;

      for (maps = 0; maps < surf.styles.length; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = lightdataRgb[(lightmap + j * 3) + k];

            if (currentmodel.deluxemap) {
              R.deluxemap![dest + (j << 2) + offset] = currentmodel.deluxemap[(lightmap + j * 3) + k];
            }
          }
          lightmap += smax * 3;
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }

      for (; maps < 4; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = 0;

            if (currentmodel.deluxemap) {
              R.deluxemap![dest + (j << 2) + offset] = 0;
            }
          }
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }
    }
  };

  static RecursiveWorldNode(node: Node): void {
    if (node.contents === content.CONTENT_SOLID) {
      return;
    }
    if (node.contents < content.CONTENT_NONE) {
      if (node.markvisframe !== R.visframecount) {
        return;
      }
      node.visframe = R.visframecount;
      if (node.skychain !== node.waterchain) {
        R.drawsky = true;
      }
      return;
    }
    const frontChild = node.children[0] as Node;
    const backChild = node.children[1] as Node;
    console.assert(frontChild instanceof Node, `R.RecursiveWorldNode expected linked BSP child 0 on node ${node.num}`);
    console.assert(backChild instanceof Node, `R.RecursiveWorldNode expected linked BSP child 1 on node ${node.num}`);
    R.RecursiveWorldNode(frontChild);
    R.RecursiveWorldNode(backChild);
  };

  static MarkLeafs() {
    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    if ((R.oldviewleaf === R.viewleaf) && (R.novis.value === 0)) {
      return;
    }
    R.visframecount++;
    R.oldviewleaf = R.viewleaf;
    const vis = (R.novis.value === 1 || R.viewleaf === null || R.viewleaf.num === 0) ? revealedVisibility : (
      R.novis.value === 2 ?
        worldmodel.getPhsByLeaf(R.viewleaf) :
        worldmodel.getPvsByLeaf(R.viewleaf)
    );
    for (let i = 1; i < worldmodel.leafs.length; i++) {
      if (!vis.isRevealed(i)) {
        continue;
      }
      if (CL.areaportals.value > 0 && R.viewleaf && !worldmodel.areaPortals.leafsConnected(R.viewleaf, worldmodel.leafs[i])) {
        continue;
      }
      for (let node: Node | null = worldmodel.leafs[i]; node !== null; node = node.parent) {
        if (node.markvisframe === R.visframecount) {
          break;
        }
        node.markvisframe = R.visframecount;
      }
    }
    do {
      if (R.novis.value !== 0 || R.viewleaf === null) {
        break;
      }
      const p = R.refdef.vieworg.copy();
      let leaf: Node;
      if (R.viewleaf.contents <= content.CONTENT_WATER) {
        leaf = worldmodel.getLeafForPoint(p.add(new Vector(0, 0, 16.0)));
        if (leaf.contents <= content.CONTENT_WATER) {
          break;
        }
      } else {
        leaf = worldmodel.getLeafForPoint(p.add(new Vector(0, 0, -16.0)));
        if (leaf.contents > content.CONTENT_WATER) {
          break;
        }
      }
      if (leaf === R.viewleaf) {
        break;
      }
      const vis = worldmodel.getPvsByLeaf(leaf);
      for (let i = 1; i < worldmodel.leafs.length; i++) {
        if (!vis.isRevealed(i)) {
          continue;
        }
        if (CL.areaportals.value > 0 && !worldmodel.areaPortals.leafsConnected(R.viewleaf, worldmodel.leafs[i])) {
          continue;
        }
        for (let node: Node | null = worldmodel.leafs[i]; node !== null; node = node.parent) {
          if (node.markvisframe === R.visframecount) {
            break;
          }
          node.markvisframe = R.visframecount;
        }
      }
    // eslint-disable-next-line no-constant-condition
    } while (false);
    R.drawsky = false;
    R.RecursiveWorldNode(worldmodel.nodes[0]);
  };

  static AllocBlock(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const w = (surf.extents[0] >> lmshift) + 1;
    const h = (surf.extents[1] >> lmshift) + 1;
    let x = 0; let y = 0; let i; let j; let best = LIGHTMAP_BLOCK_SIZE; let best2;
    for (i = 0; i < (LIGHTMAP_BLOCK_SIZE - w); i++) {
      best2 = 0;
      for (j = 0; j < w; j++) {
        if (R.allocated[i + j] >= best) {
          break;
        }
        if (R.allocated[i + j] > best2) {
          best2 = R.allocated[i + j];
        }
      }
      if (j === w) {
        x = i;
        y = best = best2;
      }
    }
    best += h;
    if (best > LIGHTMAP_BLOCK_SIZE) {
      throw new Error('R.AllocBlock: full');
    }
    for (i = 0; i < w; i++) {
      R.allocated[x + i] = best;
    }
    surf.light_s = x;
    surf.light_t = y;
  };

  static BuildLightmaps() {
    R.allocated = (new Array(LIGHTMAP_BLOCK_SIZE)).fill(0);

    R.lightmaps_rgb = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * 3));
    R.dlightmaps_rgba = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_SIZE * 4));

    const brushRenderer = modelRendererRegistry.getRenderer(ModelType.brush)!;
    const meshRenderer = modelRendererRegistry.getRenderer(ModelType.mesh)!;
    console.assert(brushRenderer !== null, 'brush renderer required');
    console.assert(meshRenderer !== null, 'mesh renderer required');

    for (let i = 1; i < CL.state.model_precache.length; i++) {
      const currentmodel = CL.state.model_precache[i];

      // Handle brush models (BSP maps)
      if (currentmodel instanceof BrushModel) {
        if (currentmodel.name[0] !== '*') { // skip submodels
          for (let j = 0; j < currentmodel.faces.length; j++) {
            const surf = currentmodel.faces[j];
            if (!surf.sky) {
              R.AllocBlock(surf);
              if (currentmodel.lightdata_rgb !== null) {
                R.BuildLightMapEx(currentmodel, surf);
              } else if (currentmodel.lightdata !== null) {
                R.BuildLightMap(currentmodel, surf);
              }
            }
          }
        }
        // Use the brush renderer to prepare the model
        // Only model index 1 is the world model, all others are entity models
        brushRenderer.prepareModel(currentmodel, i === 1);
      }

      // Handle mesh models (OBJ, IQM, etc.)
      if (currentmodel.type === ModelType.mesh) {
        meshRenderer.prepareModel(currentmodel);
      }
    }

    const layerBytes = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_SIZE * 4;
    GL.BindArray(0, R.lightmap_texture);
    for (let k = 0; k < 3; k++) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, R.lightmaps_rgb.subarray(k * layerBytes, (k + 1) * layerBytes));
    }

    GL.BindArray(0, R.deluxemap_texture);
    if (R.deluxemap) {
      for (let k = 0; k < 3; k++) {
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, R.deluxemap.subarray(k * layerBytes, (k + 1) * layerBytes));
      }
    }
  };

  // warp

  static skyrenderer: SkyRenderer | null = null;
  static drawsky = true;

  static DrawSkyBox() {
    if (!R.drawsky || !R.skyrenderer) {
      return;
    }

    R.skyrenderer.render();
  };

  static MakeSky() {
    // make sure we always free the old skyrenderer
    if (R.skyrenderer) {
      R.skyrenderer.shutdown();
    }

    const worldmodel = CL.state.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    R.skyrenderer = worldmodel.newSkyRenderer();

    if (!R.skyrenderer) {
      return;
    }

    R.skyrenderer.init();
  };

  static ClearSky() {
    if (!R.skyrenderer) {
      return;
    }

    R.skyrenderer.shutdown();
    R.skyrenderer = null;
  };


}

export default R;


eventBus.subscribe('client.disconnected', () => {
  R.ClearAll();
});

eventBus.subscribe('areaportals.changed', () => {
  R.oldviewleaf = null;
});

eventBus.subscribe('cvar.changed', (cvarName) => {
  switch (cvarName) {
    case 'r_novis':
    case 'cl_areaportals':
      R.oldviewleaf = null;
      break;
  }
});


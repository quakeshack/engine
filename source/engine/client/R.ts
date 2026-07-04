import Vector from '../../shared/Vector.ts';
import Cvar from '../common/Cvar.ts';
import Cmd from '../common/Cmd.ts';
import * as Def from '../common/Def.ts';

import { eventBus, getClientRegistry, registry } from '../registry.ts';
import Chase from './Chase.ts';
import W from '../common/W.ts';
import VID from './VID.ts';
import GL, { ATTRIB_LOCATIONS, GLTexture } from './GL.ts';
import { content, effect } from '../../shared/Defs.ts';
import { modelRendererRegistry } from './renderer/ModelRendererRegistry.ts';
import type { ModelRenderer } from './renderer/ModelRenderer.ts';
import { BrushModelRenderer, LIGHTMAP_BLOCK_HEIGHT, LIGHTMAP_BLOCK_SIZE } from './renderer/BrushModelRenderer.ts';
import { AliasModelRenderer } from './renderer/AliasModelRenderer.ts';
import { SpriteModelRenderer } from './renderer/SpriteModelRenderer.ts';
import { MeshModelRenderer } from './renderer/MeshModelRenderer.ts';
import Draw from './Draw.ts';
import { BrushModel, type BrushTexInfo, type BrushTexVec, type FogVolumeInfo, type LightgridPointSample, Node, type WorldTurbulentChainInfo, revealedVisibility } from '../common/model/BSP.ts';
import { MeshModel } from '../common/model/MeshModel.ts';
import { SpriteModel } from '../common/model/SpriteModel.ts';
import { type Face, Plane } from '../common/model/BaseModel.ts';
import PostProcess from './renderer/PostProcess.ts';
import BloomEffect from './renderer/BloomEffect.ts';
import ColorGradeEffect from './renderer/ColorGradeEffect.ts';
import BlurEffect from './renderer/BlurEffect.ts';
import WarpEffect from './renderer/WarpEffect.ts';
import UnderwaterFogEffect from './renderer/UnderwaterFogEffect.ts';
import ShadowMap from './renderer/ShadowMap.ts';
import { ClientDlight, ClientEdict } from './ClientEntities.ts';
import { avertexnormals } from '../common/model/loaders/AliasMDLLoader.ts';
import { SkyRenderer } from './renderer/Sky.ts';

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
  readonly kind: TransparentKind;
}

const enum TransparentKind {
  WorldLeaf = 0,
  Turbulent = 1,
  FogVolume = 2,
  Entity = 3,
  Sprite = 4,
  Decal = 5,
  Particle = 6,
}

interface DynamicLightSurfaceImpact {
  readonly distanceToPlane: number;
  readonly impact: Vector;
}

interface TransparentItem extends SortKindDistance {
  readonly data: Node | WorldTurbulentChainInfo | FogVolumeInfo | ClientEdict | Particle | Decal;
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
  readonly origin: Vector;
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
 * Resolve deterministic tie-break priority for transparent item kinds.
 * @returns Higher values are sorted earlier on near-equal depth.
 */
function getTransparentKindPriority(kind: TransparentKind): number {
  switch (kind) {
  case TransparentKind.FogVolume:
    return 7;
  case TransparentKind.Turbulent:
    return 6;
  case TransparentKind.WorldLeaf:
    return 5;
  case TransparentKind.Entity:
    return 4;
  case TransparentKind.Sprite:
    return 3;
  case TransparentKind.Decal:
    return 2;
  case TransparentKind.Particle:
    return 1;
  default:
    return 0;
  }
}

/**
 * Compare unified transparent items for a single back-to-front pass.
 * Distances sort far-to-near. Near ties use deterministic kind priority,
 * with fog volumes before turbulent surfaces so liquid can blend over fog.
 * @returns Sort comparator result.
 */
export function compareTransparentItems(itemA: SortKindDistance, itemB: SortKindDistance): number {
  const distDelta = itemB.dist - itemA.dist;

  if (Math.abs(distDelta) > FOG_TURBULENT_SORT_EPSILON) {
    return distDelta;
  }

  return getTransparentKindPriority(itemB.kind) - getTransparentKindPriority(itemA.kind);
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
  static underwater_fog_density: Cvar = null!;
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
  static shadow_texture: WebGLTexture | null = null;
  static point_shadow_textures: WebGLTexture[] = [];
  static world_depth_texture: WebGLTexture | null = null;
  static dlightvecs: WebGLBuffer = null!;
  static dlightVAO: WebGLVertexArrayObject = null!;

  static usePostProcess = false;
  static dowarp = false;

  /** RGB fog color used by the underwater fog effect this frame (0-1 range). */
  static underwaterFogColor: [number, number, number] = [0.05, 0.15, 0.2];

  /** Fog density exponent used by the underwater fog effect this frame. */
  static underwaterFogDensity = 0.05;
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

  /**
   * Emit one decal quad into the stream buffer.
   */
  private static _emitDecalQuad(decal: Decal): void {
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

  /**
   * Emit one particle billboard and advance its simulation by one frame.
   */
  private static _renderAndAdvanceParticle(particle: Particle, coords: number[], frameTime: number, grav: number, dvel: number): void {
    const color = W.d_8to24table[particle.color];
    let scale = (particle.org[0] - R.refdef.vieworg[0]) * R.vpn[0]
      + (particle.org[1] - R.refdef.vieworg[1]) * R.vpn[1]
      + (particle.org[2] - R.refdef.vieworg[2]) * R.vpn[2];
    if (scale < 20.0) {
      scale = 0.375;
    } else {
      scale = 0.375 + scale * 0.0015;
    }

    GL.StreamGetSpace(6);
    for (let j = 0; j < 6; j++) {
      GL.StreamWriteFloat3(particle.org[0], particle.org[1], particle.org[2]);
      GL.StreamWriteFloat2(coords[j * 2], coords[j * 2 + 1]);
      GL.StreamWriteFloat(scale);
      GL.StreamWriteUByte4(color & 0xff, (color >> 8) & 0xff, color >> 16, 255);
    }

    particle.org[0] += particle.vel[0] * frameTime;
    particle.org[1] += particle.vel[1] * frameTime;
    particle.org[2] += particle.vel[2] * frameTime;

    switch (particle.type) {
    case R.ptype.fire:
      particle.ramp += frameTime * 5.0;
      if (particle.ramp >= 6.0) {
        particle.die = -1.0;
      } else {
        particle.color = R.ramp3[Math.floor(particle.ramp)];
      }
      particle.vel[2] += grav;
      return;
    case R.ptype.explode:
      particle.ramp += frameTime * 10.0;
      if (particle.ramp >= 8.0) {
        particle.die = -1.0;
      } else {
        particle.color = R.ramp1[Math.floor(particle.ramp)];
      }
      particle.vel[0] += particle.vel[0] * dvel;
      particle.vel[1] += particle.vel[1] * dvel;
      particle.vel[2] += particle.vel[2] * dvel - grav;
      return;
    case R.ptype.explode2:
      particle.ramp += frameTime * 15.0;
      if (particle.ramp >= 8.0) {
        particle.die = -1.0;
      } else {
        particle.color = R.ramp2[Math.floor(particle.ramp)];
      }
      particle.vel[0] -= particle.vel[0] * frameTime;
      particle.vel[1] -= particle.vel[1] * frameTime;
      particle.vel[2] -= particle.vel[2] * frameTime + grav;
      return;
    case R.ptype.blob:
      particle.vel[0] += particle.vel[0] * dvel;
      particle.vel[1] += particle.vel[1] * dvel;
      particle.vel[2] += particle.vel[2] * dvel - grav;
      return;
    case R.ptype.blob2:
      particle.vel[0] += particle.vel[0] * dvel;
      particle.vel[1] += particle.vel[1] * dvel;
      particle.vel[2] -= grav;
      return;
    case R.ptype.grav:
    case R.ptype.slowgrav:
      particle.vel[2] -= grav;
      return;
    default:
      return;
    }
  }

  /**
   * Returns interpolation for animated texture/material groups.
   * @returns The 0..1 interpolation factor for animated textures.
   */
  static GetTextureInterpolation(): number {
    if (R.interpolation.value === 0) {
      return 0.0;
    }

    return (CL.state.time % 0.2) / 0.2;
  }

  /**
   * Returns smoothed interpolation for 10 Hz lightstyle animation.
   * @returns The smoothed 0..1 lightstyle interpolation factor.
   */
  static GetLightstyleInterpolation(): number {
    if (R.interpolation.value === 0) {
      return 0.0;
    }

    const linear = (CL.state.time * 10.0) % 1.0;

    return linear * linear * (3.0 - 2.0 * linear);
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
      const uInterpolation = R.GetLightstyleInterpolation();

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

      const deluxeDirection = R._SampleDeluxemapDirection(surf, tex, smax, tmax, ds, dt, uInterpolation);

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
          ? mid.add(deluxeDirection.multiply(R.#lightOriginProxyDistance))
          : mid.add(R.#topDownFallbackDirection.copy().multiply(R.#lightOriginProxyDistance)),
      ];
    }

    return R.RecursiveLightPoint(backChild, mid, end);
  };

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
  static _SampleDeluxemapDirection(surf: Face, tex: BrushTexInfo, smax: number, tmax: number, ds: number, dt: number, uInterpolation: number): Vector | null {
    const worldmodel = CL.state.worldmodel!;
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
          R.lightstylevalue_a[surf.styles[maps]] * (1 - uInterpolation) +
          R.lightstylevalue_b[surf.styles[maps]] * uInterpolation
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

    const sAxis = R._textureAxisToVector(tex.vecs[0]);
    sAxis.normalize();
    const tAxis = R._textureAxisToVector(tex.vecs[1]);
    tAxis.normalize();
    tAxis.multiply(-1.0);

    const worldDir = new Vector(
      tangentDir[0] * sAxis[0] + tangentDir[1] * tAxis[0] + tangentDir[2] * surf.normal[0],
      tangentDir[0] * sAxis[1] + tangentDir[1] * tAxis[1] + tangentDir[2] * surf.normal[1],
      tangentDir[0] * sAxis[2] + tangentDir[1] * tAxis[2] + tangentDir[2] * surf.normal[2],
    );

    return worldDir.normalize() > 0.0001 ? worldDir : null;
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
    const uInterpolation = R.GetLightstyleInterpolation();

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

    return R._SmoothLightValues(e, ambientlight, shadelight, lightOrigin, dynamicShadeLight, dynamicLightOrigin);
  };

  /**
   * How quickly smoothed lighting eases towards a freshly sampled value; see
   * `V.SmoothValue` for the exponential-decay formula this drives. Chosen to
   * be slow enough to hide lightmap-boundary popping but still track normal
   * movement speeds without feeling laggy.
   */
  static readonly #lightSmoothingSharpness = 10.0;

  /**
   * A freshly sampled light origin this far from the entity's previously
   * smoothed origin is treated as a teleport or edict-slot reuse (a
   * `ClientEdict` is recycled by number for unrelated game objects) rather
   * than normal movement, and snaps instead of easing in.
   */
  static readonly #lightTeleportDistance = 500.0;

  /**
   * Blends freshly sampled lighting terms into the entity's persisted
   * smoothed state, easing across lightmap boundaries instead of snapping.
   * Snaps immediately on first sample or when the light origin jumps far
   * enough to indicate a teleport or a recycled edict slot.
   * @returns The entity's smoothed ambient/shade/dynamic lighting terms.
   */
  static _SmoothLightValues(e: ClientEdict, ambientlight: Vector, shadelight: Vector, lightOrigin: Vector, dynamicShadeLight: Vector, dynamicLightOrigin: Vector): EntityLightValues {
    const teleported = e.smoothedLightOrigin !== null && lightOrigin.distanceTo(e.smoothedLightOrigin) > R.#lightTeleportDistance;

    if (e.smoothedAmbientLight === null || teleported) {
      e.smoothedAmbientLight = ambientlight.copy();
      e.smoothedShadeLight = shadelight.copy();
      e.smoothedLightOrigin = lightOrigin.copy();
      e.smoothedDynamicShadeLight = dynamicShadeLight.copy();
      e.smoothedDynamicLightOrigin = dynamicLightOrigin.copy();

      return [ e.smoothedAmbientLight, e.smoothedShadeLight, e.smoothedLightOrigin, e.smoothedDynamicShadeLight, e.smoothedDynamicLightOrigin ];
    }

    const deltaTime = Host.frametime;

    R._SmoothVectorTowards(e.smoothedAmbientLight, ambientlight, deltaTime);
    R._SmoothVectorTowards(e.smoothedShadeLight!, shadelight, deltaTime);
    R._SmoothVectorTowards(e.smoothedLightOrigin!, lightOrigin, deltaTime);
    R._SmoothVectorTowards(e.smoothedDynamicShadeLight!, dynamicShadeLight, deltaTime);
    R._SmoothVectorTowards(e.smoothedDynamicLightOrigin!, dynamicLightOrigin, deltaTime);

    return [ e.smoothedAmbientLight, e.smoothedShadeLight!, e.smoothedLightOrigin!, e.smoothedDynamicShadeLight!, e.smoothedDynamicLightOrigin! ];
  };

  /**
   * Eases `current` towards `target` component-wise in place, using
   * `#lightSmoothingSharpness` as the exponential decay rate.
   */
  static _SmoothVectorTowards(current: Vector, target: Vector, deltaTime: number): void {
    current[0] = V.SmoothValue(current[0], target[0], R.#lightSmoothingSharpness, deltaTime);
    current[1] = V.SmoothValue(current[1], target[1], R.#lightSmoothingSharpness, deltaTime);
    current[2] = V.SmoothValue(current[2], target[2], R.#lightSmoothingSharpness, deltaTime);
  };

  static DrawEntitiesOnList() {
    if (R.drawentities.value === 0) {
      return;
    }

    // Group entities by renderer for batched rendering without numeric type dispatch.
    const entitiesByRenderer = new Map<ModelRenderer, ClientEdict[]>();

    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (entity.model === null || entity.alpha === 0.0) {
        continue;
      }

      const renderer = modelRendererRegistry.getRendererForModel(entity.model);
      if (renderer === null) {
        continue;
      }

      if (!entitiesByRenderer.has(renderer)) {
        entitiesByRenderer.set(renderer, []);
      }
      entitiesByRenderer.get(renderer)!.push(entity);
    }

    // Pass 0: Opaque models.
    for (const [renderer, entities] of entitiesByRenderer) {
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
  };

  /**
   * Linear nearest-neighbor search over pre-built liquid fog anchors.
   * Returns the fog tint of the closest anchor to `vieworg`, or null if none exist.
   * @returns Fog tint in 0–1 RGB range, or null.
   */
  static #nearestLiquidFogTint(worldmodel: BrushModel, vieworg: Vector): [number, number, number] | null {
    const anchors = worldmodel.liquidFogAnchors;
    if (anchors.length === 0) {
      return null;
    }

    let bestTint = anchors[0].fogTint;
    let bestDist = Number.MAX_VALUE;

    for (let i = 0; i < anchors.length; i++) {
      const c = anchors[i].center;
      const dx = c[0] - vieworg[0];
      const dy = c[1] - vieworg[1];
      const dz = c[2] - vieworg[2];
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestTint = anchors[i].fogTint;
      }
    }

    return bestTint;
  }

  /**
   * Compute transparent sort distance for an entity.
   * We currently sort entities by origin distance for consistency with prior
   * behavior and because model bounds are not uniformly available here.
   * @returns Euclidean distance from view origin to entity origin.
   */
  private static _getEntityTransparentDistance(entity: ClientEdict, vieworg: Vector): number {
    const dx = entity.origin[0] - vieworg[0];
    const dy = entity.origin[1] - vieworg[1];
    const dz = entity.origin[2] - vieworg[2];

    return Math.hypot(dx, dy, dz);
  }

  /**
   * Render all blended geometry in a single back-to-front sorted pass.
   */
  static _renderTransparentsUnified(worldEntity: ClientEdict): void {
    const worldmodel = worldEntity.model instanceof BrushModel ? worldEntity.model : null;
    const vieworg = R.refdef.vieworg;
    const items: TransparentItem[] = [];

    const brushRenderer = worldmodel !== null
      ? modelRendererRegistry.getRendererForModelClass(BrushModel) as BrushModelRenderer
      : null;
    if (worldmodel !== null) {
      console.assert(brushRenderer !== null, 'brush renderer required');

      const worldLeaves = brushRenderer!.getWorldTransparentLeaves(worldmodel, vieworg);
      for (let i = 0; i < worldLeaves.length; i++) {
        items.push({ dist: worldLeaves[i].dist, kind: TransparentKind.WorldLeaf, data: worldLeaves[i].leaf });
      }

      if (R.drawturbulents.value !== 0) {
        const turbulentChains = brushRenderer!.getWorldTurbulentChains(worldmodel, vieworg);
        for (let i = 0; i < turbulentChains.length; i++) {
          items.push({ dist: turbulentChains[i].dist, kind: TransparentKind.Turbulent, data: turbulentChains[i].chain });
        }
      }

      if (PostProcess.active && worldmodel.fogVolumes && worldmodel.fogVolumes.length > 0) {
        const fogItems = brushRenderer!.getFogVolumeItems(worldmodel, vieworg);
        for (let i = 0; i < fogItems.length; i++) {
          items.push({ dist: fogItems[i].dist, kind: TransparentKind.FogVolume, data: fogItems[i].fogVolume });
        }
      }
    }

    R.decals = R.decals.filter((decal) => decal.die > CL.state.time);
    for (let i = 0; i < R.decals.length; i++) {
      const decal = R.decals[i];
      const dx = decal.origin[0] - vieworg[0];
      const dy = decal.origin[1] - vieworg[1];
      const dz = decal.origin[2] - vieworg[2];
      items.push({
        dist: Math.hypot(dx, dy, dz),
        kind: TransparentKind.Decal,
        data: decal,
      });
    }

    for (let i = 0; i < R.numparticles; i++) {
      const particle = R.particles[i];
      if (particle.die < CL.state.time) {
        continue;
      }

      const dx = particle.org[0] - vieworg[0];
      const dy = particle.org[1] - vieworg[1];
      const dz = particle.org[2] - vieworg[2];
      items.push({
        dist: Math.hypot(dx, dy, dz),
        kind: TransparentKind.Particle,
        data: particle,
      });
    }

    if (R.drawentities.value !== 0) {
      const spriteRenderer = modelRendererRegistry.getRendererForModelClass(SpriteModel);

      for (const entity of CL.state.clientEntities.getVisibleEntities()) {
        if (entity.model === null || entity.alpha === 0.0) {
          continue;
        }

        const renderer = modelRendererRegistry.getRendererForModel(entity.model);
        console.assert(renderer !== null, `renderer required for ${entity.model.constructor.name}`);

        if (renderer === spriteRenderer) {
          items.push({
            dist: R._getEntityTransparentDistance(entity, vieworg),
            kind: TransparentKind.Sprite,
            data: entity,
          });
          continue;
        }

        if (!renderer!.rendersTransparentPass(entity.model, entity)) {
          continue;
        }

        items.push({
          dist: R._getEntityTransparentDistance(entity, vieworg),
          kind: TransparentKind.Entity,
          data: entity,
        });
      }
    }

    if (items.length === 0) {
      return;
    }

    items.sort(compareTransparentItems);

    gl.depthMask(false);

    const spriteRenderer = modelRendererRegistry.getRendererForModelClass(SpriteModel);
    let currentDecalTexture: GLTexture | null = null;
    const particleCoords = [-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
    const particleFrameTime = Host.frametime;
    const particleGravity = +CL.cls.serverInfo.sv_gravity || 800;
    const particleGrav = particleFrameTime * particleGravity * 0.05;
    const particleDvel = particleFrameTime * 4.0;
    let activeKind: TransparentKind | -1 = -1;

    const endActivePass = (): void => {
      switch (activeKind) {
      case TransparentKind.WorldLeaf:
        brushRenderer?.endWorldTransparentPass();
        GL.StreamFlush();
        break;
      case TransparentKind.Turbulent:
        brushRenderer?.endWorldTurbulentPass();
        break;
      case TransparentKind.FogVolume:
        brushRenderer?.endFogVolumePass();
        break;
      case TransparentKind.Entity:
        GL.StreamFlush();
        break;
      case TransparentKind.Sprite:
        if (spriteRenderer !== null) {
          spriteRenderer.cleanupRenderState(1);
        }
        GL.StreamFlush();
        break;
      case TransparentKind.Decal:
        GL.StreamFlush();
        break;
      case TransparentKind.Particle:
        GL.StreamFlush();
        break;
      default:
        break;
      }

      activeKind = -1;
    };

    const beginKindPass = (kind: TransparentKind): boolean => {
      gl.enable(gl.BLEND);
      gl.depthMask(false);

      switch (kind) {
      case TransparentKind.WorldLeaf:
        if (brushRenderer === null || worldmodel === null) {
          return false;
        }
        gl.enable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        brushRenderer.beginWorldTransparentPass(worldmodel);
        return true;
      case TransparentKind.Turbulent:
        if (brushRenderer === null || worldmodel === null) {
          return false;
        }
        gl.enable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        brushRenderer.beginWorldTurbulentPass(worldmodel);
        return true;
      case TransparentKind.FogVolume:
        if (brushRenderer === null || worldmodel === null) {
          return false;
        }
        if (!brushRenderer.beginFogVolumePass(worldmodel)) {
          gl.enable(gl.CULL_FACE);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          return false;
        }
        return true;
      case TransparentKind.Entity:
        gl.enable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        return true;
      case TransparentKind.Sprite:
        gl.enable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        if (spriteRenderer !== null) {
          spriteRenderer.setupRenderState(1);
          return true;
        }
        return false;
      case TransparentKind.Decal: {
        gl.disable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        const program = GL.UseProgram('decal')!;
        console.assert(program !== null, 'decal program required');
        gl.uniform1f(program.uAlpha!, 1.0);
        currentDecalTexture = null;
        return true;
      }
      case TransparentKind.Particle:
        gl.disable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        GL.UseProgram('particle');
        return true;
      default:
        return false;
      }
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.kind !== activeKind) {
        endActivePass();
        if (!beginKindPass(item.kind)) {
          continue;
        }
        activeKind = item.kind;
      }

      switch (item.kind) {
      case TransparentKind.WorldLeaf:
        if (brushRenderer === null || worldmodel === null) {
          break;
        }
        brushRenderer.renderWorldTransparentLeaf(worldmodel, item.data as Node);
        break;
      case TransparentKind.Turbulent:
        if (brushRenderer === null || worldmodel === null) {
          break;
        }
        brushRenderer.renderWorldTurbulentChain(worldmodel, item.data as WorldTurbulentChainInfo);
        break;
      case TransparentKind.FogVolume:
        if (brushRenderer === null || worldmodel === null) {
          break;
        }
        brushRenderer.renderSingleFogVolume(worldmodel, item.data as FogVolumeInfo);
        break;
      case TransparentKind.Entity: {
        const entity = item.data as ClientEdict;
        if (entity.model === null) {
          break;
        }

        const renderer = modelRendererRegistry.getRendererForModel(entity.model);
        console.assert(renderer !== null, `renderer required for ${entity.model.constructor.name}`);

        renderer!.setupRenderState(2);
        renderer!.render(entity.model, entity, 2);
        renderer!.cleanupRenderState(2);
        GL.StreamFlush();
        break;
      }
      case TransparentKind.Sprite: {
        const entity = item.data as ClientEdict;
        if (entity.model === null || spriteRenderer === null) {
          break;
        }

        spriteRenderer.render(entity.model, entity, 1);
        break;
      }
      case TransparentKind.Decal: {
        const decal = item.data as Decal;
        const program = GL.UseProgram('decal')!;
        console.assert(program !== null, 'decal program required');

        if (decal.texture !== currentDecalTexture) {
          GL.StreamFlush();
          decal.texture.bind(program.tTexture!);
          currentDecalTexture = decal.texture;
        }

        R._emitDecalQuad(decal);
        break;
      }
      case TransparentKind.Particle: {
        const particle = item.data as Particle;
        if (particle.die < CL.state.time) {
          break;
        }

        R._renderAndAdvanceParticle(particle, particleCoords, particleFrameTime, particleGrav, particleDvel);

        break;
      }
      default:
        break;
      }
    }

    endActivePass();
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
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

    const viewmodel = CL.state.gameAPI?.viewmodel ?? null;

    if (viewmodel === null) {
      return;
    }

    if (!viewmodel.visible) {
      return; // game says to not draw the view model
    }

    if (!viewmodel.model) {
      return; // no model to draw
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
      const aliasRenderer = modelRendererRegistry.getRendererForModel(viewent.model);
      console.assert(aliasRenderer !== null, 'alias renderer required');
      aliasRenderer!.setupRenderState(0);
      aliasRenderer!.render(viewent.model, viewent, 0);
      aliasRenderer!.cleanupRenderState(0);
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
      if (program.uLightSpaceMatrix !== undefined) {
        gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, ShadowMap.topdownMatrix);
      }
      if (program.uShadowEnabled !== undefined) {
        gl.uniform1f(program.uShadowEnabled, ShadowMap.enabled!.value ? 1.0 : 0.0);
      }
      if (program.uShadowDarkness !== undefined) {
        gl.uniform1f(program.uShadowDarkness, ShadowMap.darkness!.value);
      }
      if (program.uShadowMapSize !== undefined) {
        gl.uniform1f(program.uShadowMapSize, ShadowMap.size);
      }
      if (program.uShadowMaxDepthNDC !== undefined) {
        // Convert the world-unit max-depth cvar into the top-down shadow
        // map's normalized [0,1] depth space (which spans 2 * range world
        // units — see ShadowMap.updateTopDownMatrix's near/far planes).
        gl.uniform1f(program.uShadowMaxDepthNDC, ShadowMap.maxDepth!.value / (2.0 * ShadowMap.range!.value));
      }
      if (program.uShadowLightDir !== undefined) {
        gl.uniform3fv(program.uShadowLightDir, ShadowMap.lightDir);
      }
      // Point light shadow uniforms
      if (program.uPointShadowEnabled !== undefined) {
        gl.uniform1f(program.uPointShadowEnabled, ShadowMap.pointLightActiveCount > 0 ? 1.0 : 0.0);
      }
      if (program.uPointLightPos0 !== undefined) {
        gl.uniform3fv(program.uPointLightPos0, ShadowMap.pointLightOrigins[0]);
      }
      if (program.uPointLightRadius0 !== undefined) {
        gl.uniform1f(program.uPointLightRadius0, ShadowMap.pointLightRadii[0]);
      }
      if (program.uPointLightColor0 !== undefined) {
        gl.uniform3fv(program.uPointLightColor0, ShadowMap.pointLightColors[0]);
      }
      if (program.uPointLightPos1 !== undefined) {
        gl.uniform3fv(program.uPointLightPos1, ShadowMap.pointLightOrigins[1]);
      }
      if (program.uPointLightRadius1 !== undefined) {
        gl.uniform1f(program.uPointLightRadius1, ShadowMap.pointLightRadii[1]);
      }
      if (program.uPointLightColor1 !== undefined) {
        gl.uniform3fv(program.uPointLightColor1, ShadowMap.pointLightColors[1]);
      }
      if (program.uPointLightPos2 !== undefined) {
        gl.uniform3fv(program.uPointLightPos2, ShadowMap.pointLightOrigins[2]);
      }
      if (program.uPointLightRadius2 !== undefined) {
        gl.uniform1f(program.uPointLightRadius2, ShadowMap.pointLightRadii[2]);
      }
      if (program.uPointLightColor2 !== undefined) {
        gl.uniform3fv(program.uPointLightColor2, ShadowMap.pointLightColors[2]);
      }
      if (program.uPointShadowBias !== undefined) {
        gl.uniform1f(program.uPointShadowBias, ShadowMap.pointBias!.value);
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

    const bloomEnabled = R.bloom.value !== 0;
    const bloomEffect = PostProcess.getEffect('bloom');
    if (!bloomEnabled) {
      BloomEffect.invalidateHistory();
    }
    if (bloomEffect) {
      bloomEffect.active = bloomEnabled;
    }

    // Configure underwater fog when the camera is inside a liquid.
    // Opt-in per map: worldspawn key _qs_waterfog must be "1" to enable.
    const waterfogEnabled = worldmodel.worldspawnInfo._qs_waterfog === '1';
    const isUnderwater = R.viewleaf.contents <= content.CONTENT_WATER;
    const underwaterFogEffect = PostProcess.getEffect('underwater-fog');
    if (underwaterFogEffect) {
      underwaterFogEffect.active = waterfogEnabled && isUnderwater && R.drawturbulents.value !== 0;
    }
    if (isUnderwater) {
      // Look up fog tint in priority order:
      //   1. First turbulent chain visible from the viewleaf (direct hit).
      //   2. Nearest spatial anchor built at load time — covers narrow passages
      //      where no surface is in view, and correctly distinguishes between
      //      multiple distinct liquid bodies of the same content type.
      //   3. Hardcoded content-type defaults as a last resort.
      const firstChain = R.viewleaf.turbulentChains[0];
      const material = firstChain !== undefined
        ? worldmodel.textures[firstChain.texture]
        : undefined;

      let fogTint = material?.fogTint ?? null;

      if (fogTint === null) {
        fogTint = R.#nearestLiquidFogTint(worldmodel, R.refdef.vieworg);
      }

      if (fogTint !== null) {
        R.underwaterFogColor = fogTint;
      } else if (R.viewleaf.contents <= content.CONTENT_LAVA) {
        R.underwaterFogColor = [0.25, 0.05, 0.0];
      } else if (R.viewleaf.contents <= content.CONTENT_SLIME) {
        R.underwaterFogColor = [0.02, 0.12, 0.0];
      } else {
        R.underwaterFogColor = [0.05, 0.15, 0.2];
      }
      R.underwaterFogDensity = R.underwater_fog_density.value;
    }

    // Enable post-process FBO (and thus depth texture) whenever turbulents, fog
    // volumes, or underwater fog are active so shaders can sample scene depth.
    R.usePostProcess = R.drawturbulents.value !== 0 || worldmodel.fogVolumes.length > 0
      || (waterfogEnabled && isUnderwater && R.drawturbulents.value !== 0);

    // Choose the shadow textures for this frame (real or dummy)
    R.shadow_texture = ShadowMap.getActiveTopDownTexture();
    R.point_shadow_textures = ShadowMap.getActivePointTextures();
  };

  static RenderWorld() {
    // Render world and entities using the renderer registry
    const worldEntity = CL.state.clientEntities.getEntity(0);
    if (worldEntity && worldEntity.model) {
      const brushRenderer = modelRendererRegistry.getRendererForModelClass(BrushModel);
      console.assert(brushRenderer !== null, 'brush renderer required');
      // Pass 0: World opaque surfaces
      brushRenderer!.render(worldEntity.model, worldEntity, 0);
    }

    // Draw all other entities (pass 0 opaque only).
    R.DrawEntitiesOnList();

    gl.disable(gl.CULL_FACE);
    R.RenderDlights();

    if (worldEntity && worldEntity.model) {
      gl.enable(gl.CULL_FACE);
      R._renderTransparentsUnified(worldEntity);
      gl.disable(gl.CULL_FACE);
    } else {
      R.DrawDecals();
      R.DrawParticles();
    }
  };

  static RenderScene() {
    R.SetFrustum();
    console.assert(ShadowMap.enabled !== null, 'shadow toggle required');

    // Top-down shadow pass — a single fixed-direction directional shadow,
    // centered on the camera. World and entities both cast into it.
    if (ShadowMap.enabled!.value) {
      ShadowMap.renderTopDownShadow(R.refdef.vieworg);
    }
    R.shadow_texture = ShadowMap.getActiveTopDownTexture();

    // Point light shadow pass — render world BSP into a cube depth map per
    // active point-light slot, from the strongest nearby dlights' positions.
    if (ShadowMap.selectPointLights(R.refdef.vieworg) > 0) {
      ShadowMap.renderPointLightShadow();
    }
    // Update point shadow textures AFTER selectPointLights so the correct
    // textures (real or dummy) are bound for this frame. PreRenderScene
    // runs before selectPointLights updates pointLightActiveCount, so its
    // assignment may be stale on the first frame a dlight appears.
    R.point_shadow_textures = ShadowMap.getActivePointTextures();

    R.SetupGL();
    R.MarkLeafs();

    // Turbulent boundary depth pre-pass — capture turbulent surface depths so the
    // underwater fog effect knows where the water boundary is per pixel.
    if (PostProcess.getEffect('underwater-fog')?.active && PostProcess.active) {
      const worldEntity = CL.state.clientEntities.getEntity(0);
      const worldmodel = worldEntity?.model instanceof BrushModel ? worldEntity.model : null;
      const brushRenderer = worldmodel !== null
        ? modelRendererRegistry.getRendererForModelClass(BrushModel) as BrushModelRenderer | null
        : null;
      if (brushRenderer !== null && worldmodel !== null) {
        PostProcess.beginTurbulentBoundaryPass();
        brushRenderer.renderWorldTurbulentsBoundaryDepth(worldmodel);
        PostProcess.endTurbulentBoundaryPass();
      }
    }

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
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
        [
          ['aPositionA', gl.FLOAT, 3],
          ['aPositionB', gl.FLOAT, 3],
          ['aNormal', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
        ],
        ['tTexture', 'tLuminance', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering mesh models (OBJ, IQM, GLTF)
      Promise.resolve(GL.CreateProgram('mesh',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
        [
          ['aPosition', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
          ['aNormal', gl.FLOAT, 3],
        ],
        ['tTexture', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering brush models (water is down below)
      Promise.resolve(GL.CreateProgram('brush',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uLightstyleInterpolation', 'uAlpha', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uHaveDeluxemap', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMapSize', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightColor0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightColor1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointLightColor2', 'uPointShadowEnabled', 'uBloomEmissiveScale', 'uBloomDlightScale', 'uBloomSpecularScale'],
          [
            ['aPosition', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 4],
            ['aLightStyle', gl.FLOAT, 4],
            ['aNormal', gl.FLOAT, 3],
            ['aTangent', gl.FLOAT, 3],
            ['aBitangent', gl.FLOAT, 3],
          ],
          ['tTextureA', 'tTextureB', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB', 'tLuminance', 'tSpecular', 'tNormal', 'tDeluxemap', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering dynamic lights
      Promise.resolve(GL.CreateProgram('dlight',
          ['uOrigin', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uRadius', 'uGamma'],
          [['aPosition', gl.FLOAT, 3]],
          [])),

      // rendering the player model (similar to alias model but with custom colors)
      Promise.resolve(GL.CreateProgram('player',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uTime', 'uTop', 'uBottom', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
          [
            ['aPositionA', gl.FLOAT, 3],
            ['aPositionB', gl.FLOAT, 3],
            ['aNormal', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 2],
          ],
          ['tTexture', 'tLuminance', 'tPlayer', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

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
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uTime', 'uInterpolation', 'uLightstyleInterpolation', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uAlpha', 'uBloomEmissiveScale', 'uBloomDlightScale', 'uScreenSize', 'uWaterFogDensity', 'uCameraInside'],
          [
            ['aPosition', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 4],
            ['aLightStyle', gl.FLOAT, 4],
            ['aNormal', gl.FLOAT, 3],
            // ['aTangent', gl.FLOAT, 3],
            // ['aBitangent', gl.FLOAT, 3],
          ],
          ['tTexture', 'tLuminance', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB', 'tDeluxemap', 'tDepth'])),

      // depth-only pre-pass for turbulent surface boundary (underwater fog)
      Promise.resolve(GL.CreateProgram('turbulent-depth',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uTime'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // underwater fog post-process effect
      Promise.resolve(GL.CreateProgram('underwater-fog',
        ['uOrtho', 'uFogColor', 'uFogDensity', 'uPerspective'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tScene', 'tDepth', 'tBoundaryDepth'])),

      // warp overlay effect
      Promise.resolve(GL.CreateProgram('warp',
          ['uOrtho', 'uTime'],
          [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
          ['tTexture'])),

      Promise.resolve(GL.CreateProgram('color-grade',
        ['uOrtho', 'uTime', 'uSaturation', 'uContrast', 'uExposure', 'uTintColor', 'uTintStrength', 'uPulseStrength', 'uPulsePeriod'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('blur',
        ['uOrtho', 'uDirection', 'uRadius'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-extract',
        ['uOrtho', 'uTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-blur',
        ['uOrtho', 'uTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-metric',
        ['uOrtho', 'uCoverageThreshold'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-adapt',
        ['uOrtho', 'uFrameTime', 'uSettleRate', 'uRecoverRate', 'uFirstFrame', 'uMinMultiplier', 'uBrightnessStart', 'uBrightnessEnd', 'uCoverageStart', 'uCoverageEnd'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tMetric', 'tPrevious'])),

      Promise.resolve(GL.CreateProgram('bloom-composite',
        ['uOrtho', 'uStrength', 'uBloomTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tScene', 'tBloom', 'tAdaptation'])),

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

      // shadow depth pass for the top-down directional shadow
      Promise.resolve(GL.CreateProgram('shadow-brush',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uCasterFade'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // shadow depth pass for point light cube shadow mapping
      Promise.resolve(GL.CreateProgram('shadow-point',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uLightPos', 'uLightRadius', 'uNormalBias', 'uCasterFade'],
        [['aPosition', gl.FLOAT, 3], ['aNormal', gl.FLOAT, 3]],
        [])),

      // shadow depth pass for alias models (frame interpolation)
      Promise.resolve(GL.CreateProgram('shadow-alias',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uInterpolation', 'uCasterFade'],
        [['aPositionA', gl.FLOAT, 3], ['aPositionB', gl.FLOAT, 3]],
        [])),

      // point shadow depth pass for alias models (frame interpolation)
      Promise.resolve(GL.CreateProgram('shadow-alias-point',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uInterpolation', 'uLightPos', 'uLightRadius', 'uNormalBias', 'uCasterFade'],
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

    // fog controls for underwater fog effect (post-process)
    R.underwater_fog_density = new Cvar('r_underwater_fog_density', '0.01', Cvar.FLAG.CHEAT, 'Fog density exponent for the underwater fog effect.');

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
    PostProcess.addEffect(new UnderwaterFogEffect());
    PostProcess.addEffect(new WarpEffect());
    PostProcess.addEffect(new ColorGradeEffect());
    PostProcess.addEffect(new BlurEffect());

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

    const [exp, r, g, b] = fogInfo.split(/\s+/).map(Number);

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

    // Reset the viewleafs so that the renderer will recalculate them on the next frame.
    R.viewleaf = null;
    R.oldviewleaf = null;

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

    R.shadow_texture = null;
    R.point_shadow_textures = [];
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
      origin: origin.copy(),
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

      R._emitDecalQuad(decal);
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
    const gravity = +CL.cls.serverInfo.sv_gravity || 800;
    const grav = frametime * gravity * 0.05;
    const dvel = frametime * 4.0;

    const coords = [-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
    for (let i = 0; i < R.numparticles; i++) {
      const p = R.particles[i];
      if (p.die < CL.state.time) {
        continue;
      }

      R._renderAndAdvanceParticle(p, coords, frametime, grav, dvel);
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
      // Lights promoted to a point-shadow slot are excluded from this baked
      // sum — their contribution is instead computed analytically per-fragment
      // in the scene shaders and occluded by their own cube depth map, so
      // multiple nearby dlights correctly shadow each other independently
      // instead of only the single strongest one darkening the combined sum.
      if (ShadowMap.pointLightDlightIndices.includes(i)) {
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

    const brushRenderer = modelRendererRegistry.getRendererForModelClass(BrushModel);
    const meshRenderer = modelRendererRegistry.getRendererForModelClass(MeshModel);
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
        brushRenderer!.prepareModel(currentmodel, i === 1);
      }

      // Handle mesh models (OBJ, IQM, etc.)
      if (currentmodel instanceof MeshModel) {
        meshRenderer!.prepareModel(currentmodel);
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


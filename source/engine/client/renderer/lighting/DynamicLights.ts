import Vector from '../../../../shared/Vector.ts';
import { content } from '../../../../shared/Defs.ts';
import * as Def from '../../../common/Def.ts';
import { eventBus } from '../../../common/EventBus.ts';
import { BrushModel, Node } from '../../../common/model/BSP.ts';
import type { Face } from '../../../common/model/BaseModel.ts';
import GL, { ATTRIB_LOCATIONS } from '../../GL.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import { clientCollision } from '../../ClientPhysics.ts';
import type { ClientDlight } from '../../ClientEntities.ts';
import R from '../../R.ts';
import V from '../../V.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import LightSampler from './LightSampler.ts';
import Lightmaps from './Lightmaps.ts';
import ShadowMap from './ShadowMap.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

interface DynamicLightSurfaceImpact {
  readonly distanceToPlane: number;
  readonly impact: Vector;
}

/**
 * Dynamic lights on world surfaces: finds the faces a light touches, adds their light to the dynamic lightmap
 * (`Lightmaps`) and draws the coronas of `gl_flashblend`.
 */
export class DynamicLights {
  /**
   * Counts frames in which dynamic lights were marked; a face whose `dlightframe` is the current count (or the
   * one after it) has been touched in the last two frames and needs its dynamic lightmap added or cleared.
   */
  static dlightframecount = 0;

  /** The unit disc of a corona as a triangle fan, with the origin and radius given by uniforms. */
  static dlightVAO: WebGLVertexArrayObject = null!;

  /**
   * Creates the corona geometry. Needs a GL context.
   */
  static Init(): void {
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

    DynamicLights.dlightVAO = GL.CreateVAO(dlightvecs, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride: 0, offset: 0 },
    ]);
  }

  static RenderCoronas(): void {
    if (rendererCvars.flashblend.value === 0) {
      return;
    }
    DynamicLights.dlightframecount++;
    gl.enable(gl.BLEND);
    const program = GL.UseProgram('dlight')!; let a;
    console.assert(program !== null, 'dlight program required');
    GL.BindVAO(DynamicLights.dlightVAO);
    for (let i = 0; i < Def.limits.dlights; i++) {
      const l = clientRuntimeState.clientEntities.dlights[i];
      if ((l.die < clientRuntimeState.time) || (l.radius === 0.0)) {
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
  }

  /**
   * Returns a known point on the face plane for dynamic-light projection.
   * @returns A known point on the surface plane.
   */
  static GetDynamicLightSurfacePoint(surf: Face): Vector {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const surfedge = worldmodel.surfedges[surf.firstedge!];

    if (surfedge >= 0) {
      return worldmodel.vertexes[worldmodel.edges[surfedge][0]].copy();
    }

    return worldmodel.vertexes[worldmodel.edges[-surfedge][1]].copy();
  }

  /**
   * Projects a dynamic light onto a face plane when the light is in front of the surface.
   * @returns Surface-plane hit information when the light is in front of the face.
   */
  static GetDynamicLightSurfaceImpact(light: ClientDlight, surf: Face): DynamicLightSurfaceImpact | null {
    const faceNormal = surf.normal!.copy();
    const surfacePoint = DynamicLights.GetDynamicLightSurfacePoint(surf);
    const distanceToPlane = light.origin.copy().subtract(surfacePoint).dot(faceNormal);

    if (distanceToPlane <= 0.0 || distanceToPlane >= light.radius) {
      return null;
    }

    const impact = light.origin.copy().subtract(faceNormal.copy().multiply(distanceToPlane));

    return { distanceToPlane, impact };
  }

  /**
   * Returns whether the light can see the face at the projected impact point.
   * @returns True when the light has line of sight to the surface.
   */
  static IsDynamicLightSurfaceVisible(light: ClientDlight, surf: Face, impact: Vector): boolean {
    const end = impact.copy().add(surf.normal!.copy().multiply(1.0));
    const trace = clientCollision.traceStaticWorldLine(light.origin, end);

    return !trace.startsolid && !trace.allsolid && trace.fraction === 1.0;
  }

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
      console.assert(frontChild instanceof Node, `DynamicLights.MarkLights expected linked BSP child 0 on node ${node.num}`);
      DynamicLights.MarkLights(light, bit, frontChild);
      return;
    }
    if (dist < -light.radius) {
      const backChild = node.children[1] as Node;
      console.assert(backChild instanceof Node, `DynamicLights.MarkLights expected linked BSP child 1 on node ${node.num}`);
      DynamicLights.MarkLights(light, bit, backChild);
      return;
    }
    for (const surf of node.facesIter()) {
      if (surf.sky) {
        continue;
      }

      const lightImpact = DynamicLights.GetDynamicLightSurfaceImpact(light, surf);

      if (lightImpact === null || !DynamicLights.IsDynamicLightSurfaceVisible(light, surf, lightImpact.impact)) {
        continue;
      }

      if (surf.dlightframe !== (DynamicLights.dlightframecount + 1)) {
        surf.dlightbits = 0;
        surf.dlightframe = DynamicLights.dlightframecount + 1;
      }
      surf.dlightbits |= bit;
    }
    const frontChild = node.children[0] as Node;
    const backChild = node.children[1] as Node;
    console.assert(frontChild instanceof Node, `DynamicLights.MarkLights expected linked BSP child 0 on node ${node.num}`);
    console.assert(backChild instanceof Node, `DynamicLights.MarkLights expected linked BSP child 1 on node ${node.num}`);
    DynamicLights.MarkLights(light, bit, frontChild);
    DynamicLights.MarkLights(light, bit, backChild);
  }

  static Push(): void {
    if (rendererCvars.flashblend.value !== 0) {
      return;
    }

    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    Lightmaps.ResetModifiedRows();

    let bit = 1;

    for (let i = 0; i < Def.limits.dlights; i++) {
      const l = clientRuntimeState.clientEntities.dlights[i];

      if (!l.isFree()) {
        DynamicLights.MarkLights(l, bit, worldmodel.nodes[0]);
        for (const ent of clientRuntimeState.clientEntities.getVisibleEntities()) {
          if (ent.model === null) {
            continue;
          }
          if (!(ent.model instanceof BrushModel) || !ent.model.submodel) {
            continue;
          }
          const firstClipNode = ent.model.hulls[0]?.firstclipnode;
          const submodelNode = firstClipNode !== undefined ? worldmodel.nodes[firstClipNode] : null;

          if (submodelNode !== undefined && submodelNode !== null) {
            DynamicLights.MarkLights(l, bit, submodelNode);
          }
        }
      }
      bit += bit;
    }

    let surf;
    for (let i = 0; i < worldmodel.faces.length; i++) {
      surf = worldmodel.faces[i];
      if (surf.dlightframe === DynamicLights.dlightframecount) {
        DynamicLights.RemoveDynamicLights(surf);
      } else if (surf.dlightframe === (DynamicLights.dlightframecount + 1)) {
        DynamicLights.AddDynamicLights(surf);
      }
    }

    Lightmaps.UploadDynamic();

    DynamicLights.dlightframecount++;
  }

  static AddDynamicLights(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
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
      const light = clientRuntimeState.clientEntities.dlights[i];
      const lightImpact = DynamicLights.GetDynamicLightSurfaceImpact(light, surf);

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
        impact.dot(LightSampler.TextureAxisToVector(tex.vecs[0])) + tex.vecs[0][3] - surf.texturemins[0],
        impact.dot(LightSampler.TextureAxisToVector(tex.vecs[1])) + tex.vecs[1][3] - surf.texturemins[1],
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

    Lightmaps.WriteDynamicBlock(surf, smax, tmax, blocklights);
  }

  static RemoveDynamicLights(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;

    Lightmaps.ClearDynamicBlock(surf, smax, tmax);
  }
}

export default DynamicLights;

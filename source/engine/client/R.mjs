import Vector from '../../shared/Vector.mjs';
import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import Q from '../common/Q.mjs';
import * as Def from '../common/Def.mjs';

import { eventBus, registry } from '../registry.mjs';
import Chase from './Chase.mjs';
import MSG from '../network/MSG.mjs';
import W, { translateIndexToRGBA } from '../common/W.mjs';
import VID from './VID.mjs';
import GL, { GLTexture } from './GL.mjs';
import { effect, gameCapabilities } from '../../shared/Defs.mjs';
import { ClientEdict } from './ClientEntities.mjs';

let { CL, COM, Con, Host, Mod, SCR, SV, Sys, V  } = registry;

/**
 * @typedef {{
    name: string;
    width: number;
    height: number;
    glt: import('./GL.mjs').GLTexture;
    sky: boolean;
    turbulent: boolean;
}} BrushModelTexture
 */

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  Mod = registry.Mod;
  SCR = registry.SCR;
  SV = registry.SV;
  Sys = registry.Sys;
  V = registry.V;
});

/** @type {WebGL2RenderingContext} */
let gl = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

const R = {};

export default R;

// efrag

R.SplitEntityOnNode = function(node) {
  if (node.contents === Mod.contents.solid) {
    return;
  }
  if (node.contents < 0) {
    R.currententity.leafs[R.currententity.leafs.length] = node.num - 1;
    return;
  }
  const sides = Vector.boxOnPlaneSide(R.emins, R.emaxs, node.plane);
  if ((sides & 1) !== 0) {
    R.SplitEntityOnNode(node.children[0]);
  }
  if ((sides & 2) !== 0) {
    R.SplitEntityOnNode(node.children[1]);
  }
};

// light

R.dlightframecount = 0;

R.lightstylevalue_a = new Uint8Array(new ArrayBuffer(64));
R.lightstylevalue_b = new Uint8Array(new ArrayBuffer(64));

R.AnimateLight = function() {
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
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, 64, 1, 0, gl.ALPHA, gl.UNSIGNED_BYTE, R.lightstylevalue_a);
  GL.Bind(0, R.lightstyle_texture_b);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, 64, 1, 0, gl.ALPHA, gl.UNSIGNED_BYTE, R.lightstylevalue_b);
};

R.RenderDlights = function() {
  if (R.flashblend.value === 0) {
    return;
  }
  ++R.dlightframecount;
  gl.enable(gl.BLEND);
  const program = GL.UseProgram('dlight'); let a;
  gl.bindBuffer(gl.ARRAY_BUFFER, R.dlightvecs);
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 0, 0);
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
    gl.uniform3fv(program.uOrigin, l.origin);
    gl.uniform1f(program.uRadius, l.radius);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 18);
  }
  gl.disable(gl.BLEND);
};

R.MarkLights = function(light, bit, node) {
  if (node.contents < 0) {
    return;
  }
  const normal = node.plane.normal;
  const dist = light.origin[0] * normal[0] + light.origin[1] * normal[1] + light.origin[2] * normal[2] - node.plane.dist;
  if (dist > light.radius) {
    R.MarkLights(light, bit, node.children[0]);
    return;
  }
  if (dist < -light.radius) {
    R.MarkLights(light, bit, node.children[1]);
    return;
  }
  let i; let surf;
  for (i = 0; i < node.numfaces; i++) {
    surf = CL.state.worldmodel.faces[node.firstface + i];
    if ((surf.sky === true) || (surf.turbulent === true)) {
      continue;
    }
    if (surf.dlightframe !== (R.dlightframecount + 1)) {
      surf.dlightbits = 0;
      surf.dlightframe = R.dlightframecount + 1;
    }
    surf.dlightbits += bit;
  }
  R.MarkLights(light, bit, node.children[0]);
  R.MarkLights(light, bit, node.children[1]);
};

R.PushDlights = function() {
  if (R.flashblend.value !== 0) {
    return;
  }
  for (let i = 0; i <= 1023; i++) {
    R.lightmap_modified[i] = false;
  }

  let bit = 1; let j;

  for (let i = 0; i < Def.limits.dlights; i++) {
    const l = CL.state.clientEntities.dlights[i];

    if (!l.isFree()) {
      R.MarkLights(l, bit, CL.state.worldmodel.nodes[0]);
      for (const ent of CL.state.clientEntities.getVisibleEntities()) {
        if (ent.model === null) {
          continue;
        }
        if ((ent.model.type !== Mod.type.brush) || (ent.model.submodel !== true)) {
          continue;
        }
        R.MarkLights(l, bit, CL.state.worldmodel.nodes[ent.model.hulls[0].firstclipnode]);
      }
    }
    bit += bit;
  }

  let surf;
  for (let i = 0; i < CL.state.worldmodel.faces.length; i++) {
    surf = CL.state.worldmodel.faces[i];
    if (surf.dlightframe === R.dlightframecount) {
      R.RemoveDynamicLights(surf);
    } else if (surf.dlightframe === (R.dlightframecount + 1)) {
      R.AddDynamicLights(surf);
    }
  }

  GL.Bind(0, R.dlightmap_rgba_texture);
  for (let i = 0; i <= 1023; i++) {
    if (R.lightmap_modified[i] !== true) {
      continue;
    }
    for (j = 1023; j >= i; --j) {
      if (R.lightmap_modified[j] !== true) {
        continue;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, i, 1024, j - i + 1, gl.RGBA, gl.UNSIGNED_BYTE, R.dlightmaps_rgba.subarray(i * 1024 * 4, (j + 1) * 1024 * 4));
      break;
    }
    break;
  }

  ++R.dlightframecount;
};

R.RecursiveLightPoint = function(node, start, end) {
  if (node.contents < 0) {
    return -1;
  }

  const normal = node.plane.normal;
  const front = start[0] * normal[0] + start[1] * normal[1] + start[2] * normal[2] - node.plane.dist;
  const back = end[0] * normal[0] + end[1] * normal[1] + end[2] * normal[2] - node.plane.dist;
  const side = front < 0;

  if ((back < 0) === side) {
    return R.RecursiveLightPoint(node.children[side === true ? 1 : 0], start, end);
  }

  const frac = front / (front - back);
  const mid = new Vector(
    start[0] + (end[0] - start[0]) * frac,
    start[1] + (end[1] - start[1]) * frac,
    start[2] + (end[2] - start[2]) * frac,
  );

  let r = R.RecursiveLightPoint(node.children[side === true ? 1 : 0], start, mid);
  if (r >= 0) {
    return r;
  }

  if ((back < 0) === side) {
    return -1;
  }

  let i; let surf; let tex; let s; let t; let ds; let dt; let lightmap; let size; let maps;
  for (i = 0; i < node.numfaces; i++) {
    surf = CL.state.worldmodel.faces[node.firstface + i];
    if ((surf.sky === true) || (surf.turbulent === true)) {
      continue;
    }

    tex = CL.state.worldmodel.texinfo[surf.texinfo];
    s = mid.dot(new Vector(...tex.vecs[0])) + tex.vecs[0][3];
    t = mid.dot(new Vector(...tex.vecs[1])) + tex.vecs[1][3];
    if ((s < surf.texturemins[0]) || (t < surf.texturemins[1])) {
      continue;
    }

    ds = s - surf.texturemins[0];
    dt = t - surf.texturemins[1];
    if ((ds > surf.extents[0]) || (dt > surf.extents[1])) {
      continue;
    }

    if (surf.lightofs === 0) {
      return 0;
    }

    ds >>= 4;
    dt >>= 4;

    lightmap = surf.lightofs;
    if (lightmap === 0) {
      return 0;
    }

    lightmap += dt * ((surf.extents[0] >> 4) + 1) + ds;
    r = 0;
    size = ((surf.extents[0] >> 4) + 1) * ((surf.extents[1] >> 4) + 1);
    const uAlpha = R.interpolation.value ? (CL.state.time % .2) / .2 : 0;
    for (maps = 0; maps < surf.styles.length; ++maps) {
      r += CL.state.worldmodel.lightdata[lightmap] * (
        R.lightstylevalue_a[surf.styles[maps]] * (1 - uAlpha) +
        R.lightstylevalue_b[surf.styles[maps]] * uAlpha
      ) * 22;
      lightmap += size;
    }
    return r >> 8;
  }
  return R.RecursiveLightPoint(node.children[side !== true ? 1 : 0], mid, end);
};

R.LightPoint = function(p) {
  if (CL.state.worldmodel.lightdata == null) {
    return 255;
  }
  const r = R.RecursiveLightPoint(CL.state.worldmodel.nodes[0], p, new Vector(p[0], p[1], p[2] - 2048.0));
  if (r === -1) {
    return 0;
  }
  return r;
};

// main

R.visframecount = 0;

R.frustum = [{}, {}, {}, {}];

R.vup = new Vector();
R.vpn = new Vector();
R.vright = new Vector();

R.refdef = {
  vrect: {
    width: 0,
    height: 0,
  },
  vieworg: new Vector(),
  viewangles: new Vector(),
};

R.CullBox = function(mins, maxs) {
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

R.DrawSpriteModel = function(e) {
  const program = GL.UseProgram('sprite', true);
  let num = e.frame;
  if ((num >= e.model.numframes) || (num < 0)) {
    Con.DPrint('R.DrawSpriteModel: no such frame ' + num + '\n');
    num = 0;
  }
  let frame = e.model.frames[num];
  if (frame.group === true) {
    let i;
    const time = CL.state.time + e.syncbase;
    num = frame.frames.length - 1;
    const fullinterval = frame.frames[num].interval;
    const targettime = time - Math.floor(time / fullinterval) * fullinterval;
    for (i = 0; i < num; i++) {
      if (frame.frames[i].interval > targettime) {
        break;
      }
    }
    frame = frame.frames[i];
  }

  GL.Bind(program.tTexture, frame.texturenum, true);

  let r, u;

  if (e.model.oriented === true) {
    r = [];
    u = [];
    const {right, up} = e.angles.angleVectors();
    [r, u] = [right, up];
  } else {
    r = R.vright;
    u = R.vup;
  }
  const p = e.origin;
  const x1 = frame.origin[0]; const y1 = frame.origin[1]; const x2 = x1 + frame.width; const y2 = y1 + frame.height;

  GL.StreamGetSpace(6);
  GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y1 * u[0],
      p[1] + x1 * r[1] + y1 * u[1],
      p[2] + x1 * r[2] + y1 * u[2]);
  GL.StreamWriteFloat2(0.0, 1.0);
  GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y2 * u[0],
      p[1] + x1 * r[1] + y2 * u[1],
      p[2] + x1 * r[2] + y2 * u[2]);
  GL.StreamWriteFloat2(0.0, 0.0);
  GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y1 * u[0],
      p[1] + x2 * r[1] + y1 * u[1],
      p[2] + x2 * r[2] + y1 * u[2]);
  GL.StreamWriteFloat2(1.0, 1.0);
  GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y1 * u[0],
      p[1] + x2 * r[1] + y1 * u[1],
      p[2] + x2 * r[2] + y1 * u[2]);
  GL.StreamWriteFloat2(1.0, 1.0);
  GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y2 * u[0],
      p[1] + x1 * r[1] + y2 * u[1],
      p[2] + x1 * r[2] + y2 * u[2]);
  GL.StreamWriteFloat2(0.0, 0.0);
  GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y2 * u[0],
      p[1] + x2 * r[1] + y2 * u[1],
      p[2] + x2 * r[2] + y2 * u[2]);
  GL.StreamWriteFloat2(1.0, 0.0);
};

R.avertexnormals = [
  new Vector(-0.525731, 0.0, 0.850651),
  new Vector(-0.442863, 0.238856, 0.864188),
  new Vector(-0.295242, 0.0, 0.955423),
  new Vector(-0.309017, 0.5, 0.809017),
  new Vector(-0.16246, 0.262866, 0.951056),
  new Vector(0.0, 0.0, 1.0),
  new Vector(0.0, 0.850651, 0.525731),
  new Vector(-0.147621, 0.716567, 0.681718),
  new Vector(0.147621, 0.716567, 0.681718),
  new Vector(0.0, 0.525731, 0.850651),
  new Vector(0.309017, 0.5, 0.809017),
  new Vector(0.525731, 0.0, 0.850651),
  new Vector(0.295242, 0.0, 0.955423),
  new Vector(0.442863, 0.238856, 0.864188),
  new Vector(0.16246, 0.262866, 0.951056),
  new Vector(-0.681718, 0.147621, 0.716567),
  new Vector(-0.809017, 0.309017, 0.5),
  new Vector(-0.587785, 0.425325, 0.688191),
  new Vector(-0.850651, 0.525731, 0.0),
  new Vector(-0.864188, 0.442863, 0.238856),
  new Vector(-0.716567, 0.681718, 0.147621),
  new Vector(-0.688191, 0.587785, 0.425325),
  new Vector(-0.5, 0.809017, 0.309017),
  new Vector(-0.238856, 0.864188, 0.442863),
  new Vector(-0.425325, 0.688191, 0.587785),
  new Vector(-0.716567, 0.681718, -0.147621),
  new Vector(-0.5, 0.809017, -0.309017),
  new Vector(-0.525731, 0.850651, 0.0),
  new Vector(0.0, 0.850651, -0.525731),
  new Vector(-0.238856, 0.864188, -0.442863),
  new Vector(0.0, 0.955423, -0.295242),
  new Vector(-0.262866, 0.951056, -0.16246),
  new Vector(0.0, 1.0, 0.0),
  new Vector(0.0, 0.955423, 0.295242),
  new Vector(-0.262866, 0.951056, 0.16246),
  new Vector(0.238856, 0.864188, 0.442863),
  new Vector(0.262866, 0.951056, 0.16246),
  new Vector(0.5, 0.809017, 0.309017),
  new Vector(0.238856, 0.864188, -0.442863),
  new Vector(0.262866, 0.951056, -0.16246),
  new Vector(0.5, 0.809017, -0.309017),
  new Vector(0.850651, 0.525731, 0.0),
  new Vector(0.716567, 0.681718, 0.147621),
  new Vector(0.716567, 0.681718, -0.147621),
  new Vector(0.525731, 0.850651, 0.0),
  new Vector(0.425325, 0.688191, 0.587785),
  new Vector(0.864188, 0.442863, 0.238856),
  new Vector(0.688191, 0.587785, 0.425325),
  new Vector(0.809017, 0.309017, 0.5),
  new Vector(0.681718, 0.147621, 0.716567),
  new Vector(0.587785, 0.425325, 0.688191),
  new Vector(0.955423, 0.295242, 0.0),
  new Vector(1.0, 0.0, 0.0),
  new Vector(0.951056, 0.16246, 0.262866),
  new Vector(0.850651, -0.525731, 0.0),
  new Vector(0.955423, -0.295242, 0.0),
  new Vector(0.864188, -0.442863, 0.238856),
  new Vector(0.951056, -0.16246, 0.262866),
  new Vector(0.809017, -0.309017, 0.5),
  new Vector(0.681718, -0.147621, 0.716567),
  new Vector(0.850651, 0.0, 0.525731),
  new Vector(0.864188, 0.442863, -0.238856),
  new Vector(0.809017, 0.309017, -0.5),
  new Vector(0.951056, 0.16246, -0.262866),
  new Vector(0.525731, 0.0, -0.850651),
  new Vector(0.681718, 0.147621, -0.716567),
  new Vector(0.681718, -0.147621, -0.716567),
  new Vector(0.850651, 0.0, -0.525731),
  new Vector(0.809017, -0.309017, -0.5),
  new Vector(0.864188, -0.442863, -0.238856),
  new Vector(0.951056, -0.16246, -0.262866),
  new Vector(0.147621, 0.716567, -0.681718),
  new Vector(0.309017, 0.5, -0.809017),
  new Vector(0.425325, 0.688191, -0.587785),
  new Vector(0.442863, 0.238856, -0.864188),
  new Vector(0.587785, 0.425325, -0.688191),
  new Vector(0.688191, 0.587785, -0.425325),
  new Vector(-0.147621, 0.716567, -0.681718),
  new Vector(-0.309017, 0.5, -0.809017),
  new Vector(0.0, 0.525731, -0.850651),
  new Vector(-0.525731, 0.0, -0.850651),
  new Vector(-0.442863, 0.238856, -0.864188),
  new Vector(-0.295242, 0.0, -0.955423),
  new Vector(-0.16246, 0.262866, -0.951056),
  new Vector(0.0, 0.0, -1.0),
  new Vector(0.295242, 0.0, -0.955423),
  new Vector(0.16246, 0.262866, -0.951056),
  new Vector(-0.442863, -0.238856, -0.864188),
  new Vector(-0.309017, -0.5, -0.809017),
  new Vector(-0.16246, -0.262866, -0.951056),
  new Vector(0.0, -0.850651, -0.525731),
  new Vector(-0.147621, -0.716567, -0.681718),
  new Vector(0.147621, -0.716567, -0.681718),
  new Vector(0.0, -0.525731, -0.850651),
  new Vector(0.309017, -0.5, -0.809017),
  new Vector(0.442863, -0.238856, -0.864188),
  new Vector(0.16246, -0.262866, -0.951056),
  new Vector(0.238856, -0.864188, -0.442863),
  new Vector(0.5, -0.809017, -0.309017),
  new Vector(0.425325, -0.688191, -0.587785),
  new Vector(0.716567, -0.681718, -0.147621),
  new Vector(0.688191, -0.587785, -0.425325),
  new Vector(0.587785, -0.425325, -0.688191),
  new Vector(0.0, -0.955423, -0.295242),
  new Vector(0.0, -1.0, 0.0),
  new Vector(0.262866, -0.951056, -0.16246),
  new Vector(0.0, -0.850651, 0.525731),
  new Vector(0.0, -0.955423, 0.295242),
  new Vector(0.238856, -0.864188, 0.442863),
  new Vector(0.262866, -0.951056, 0.16246),
  new Vector(0.5, -0.809017, 0.309017),
  new Vector(0.716567, -0.681718, 0.147621),
  new Vector(0.525731, -0.850651, 0.0),
  new Vector(-0.238856, -0.864188, -0.442863),
  new Vector(-0.5, -0.809017, -0.309017),
  new Vector(-0.262866, -0.951056, -0.16246),
  new Vector(-0.850651, -0.525731, 0.0),
  new Vector(-0.716567, -0.681718, -0.147621),
  new Vector(-0.716567, -0.681718, 0.147621),
  new Vector(-0.525731, -0.850651, 0.0),
  new Vector(-0.5, -0.809017, 0.309017),
  new Vector(-0.238856, -0.864188, 0.442863),
  new Vector(-0.262866, -0.951056, 0.16246),
  new Vector(-0.864188, -0.442863, 0.238856),
  new Vector(-0.809017, -0.309017, 0.5),
  new Vector(-0.688191, -0.587785, 0.425325),
  new Vector(-0.681718, -0.147621, 0.716567),
  new Vector(-0.442863, -0.238856, 0.864188),
  new Vector(-0.587785, -0.425325, 0.688191),
  new Vector(-0.309017, -0.5, 0.809017),
  new Vector(-0.147621, -0.716567, 0.681718),
  new Vector(-0.425325, -0.688191, 0.587785),
  new Vector(-0.16246, -0.262866, 0.951056),
  new Vector(0.442863, -0.238856, 0.864188),
  new Vector(0.16246, -0.262866, 0.951056),
  new Vector(0.309017, -0.5, 0.809017),
  new Vector(0.147621, -0.716567, 0.681718),
  new Vector(0.0, -0.525731, 0.850651),
  new Vector(0.425325, -0.688191, 0.587785),
  new Vector(0.587785, -0.425325, 0.688191),
  new Vector(0.688191, -0.587785, 0.425325),
  new Vector(-0.955423, 0.295242, 0.0),
  new Vector(-0.951056, 0.16246, 0.262866),
  new Vector(-1.0, 0.0, 0.0),
  new Vector(-0.850651, 0.0, 0.525731),
  new Vector(-0.955423, -0.295242, 0.0),
  new Vector(-0.951056, -0.16246, 0.262866),
  new Vector(-0.864188, 0.442863, -0.238856),
  new Vector(-0.951056, 0.16246, -0.262866),
  new Vector(-0.809017, 0.309017, -0.5),
  new Vector(-0.864188, -0.442863, -0.238856),
  new Vector(-0.951056, -0.16246, -0.262866),
  new Vector(-0.809017, -0.309017, -0.5),
  new Vector(-0.681718, 0.147621, -0.716567),
  new Vector(-0.681718, -0.147621, -0.716567),
  new Vector(-0.850651, 0.0, -0.525731),
  new Vector(-0.688191, 0.587785, -0.425325),
  new Vector(-0.587785, 0.425325, -0.688191),
  new Vector(-0.425325, 0.688191, -0.587785),
  new Vector(-0.425325, -0.688191, -0.587785),
  new Vector(-0.587785, -0.425325, -0.688191),
  new Vector(-0.688191, -0.587785, -0.425325),
];

/**
 *
 * @param {ClientEdict} e entity
 */
R.DrawAliasModel = function(e) {
  const clmodel = e.model;

  if (R.CullBox(
      new Vector(
        e.origin[0] - clmodel.boundingradius,
        e.origin[1] - clmodel.boundingradius,
        e.origin[2] - clmodel.boundingradius,
      ),
      new Vector(
        e.origin[0] + clmodel.boundingradius,
        e.origin[1] + clmodel.boundingradius,
        e.origin[2] + clmodel.boundingradius,
  )) === true) {
    return;
  }

  let program;
  if ((e.colormap !== 0) && (clmodel.player === true) && (R.nocolors.value === 0)) {
    program = GL.UseProgram('player');
    let top = (CL.state.scores[e.colormap - 1].colors & 0xf0) + 4;
    let bottom = ((CL.state.scores[e.colormap - 1].colors & 0xf) << 4) + 4;
    if (top <= 127) {
      top += 7;
    }
    if (bottom <= 127) {
      bottom += 7;
    }
    top = W.d_8to24table[top];
    bottom = W.d_8to24table[bottom];
    gl.uniform3f(program.uTop, top & 0xff, (top >> 8) & 0xff, top >> 16);
    gl.uniform3f(program.uBottom, bottom & 0xff, (bottom >> 8) & 0xff, bottom >> 16);
  } else {
    program = GL.UseProgram('alias');
  }
  gl.uniform3fv(program.uOrigin, e.lerp.origin);
  gl.uniformMatrix3fv(program.uAngles, false, e.lerp.angles.toRotationMatrix());

  let ambientlight = R.LightPoint(e.lerp.origin);
  let shadelight = ambientlight;
  if ((e === CL.state.viewent) && (ambientlight < 24.0)) {
    ambientlight = shadelight = 24.0;
  }
  let i; let add;

  for (let i = 0; i < Def.limits.dlights; i++) {
    const dl = CL.state.clientEntities.dlights[i];

    if (dl.isFree()) {
      continue;
    }
    // add = dl.radius - (new Vector(e.origin[0] - dl.origin[0], e.origin[1] - dl.origin[1], e.origin[1] - dl.origin[1])).len(); // [x, y, y]
    add = dl.radius - e.lerp.origin.distanceTo(dl.origin);
    if (add > 0.0) {
      ambientlight += add;
      shadelight += add;
    }
  }
  if (ambientlight > 128.0) {
    ambientlight = 128.0;
  }
  if ((ambientlight + shadelight) > 192.0) {
    shadelight = 192.0 - ambientlight;
  }
  if ((e.num >= 1) && (e.num <= CL.state.maxclients) && (ambientlight < 8.0)) {
    ambientlight = shadelight = 8.0;
  }

  if (e.effects & effect.EF_FULLBRIGHT) {
    ambientlight = 255.0;
    shadelight = 255.0;
  }

  gl.uniform1f(program.uAmbientLight, ambientlight * 0.0078125);
  gl.uniform1f(program.uShadeLight, shadelight * 0.0078125);

  const {forward, right, up} = e.angles.angleVectors();
  const v = new Vector(-1.0, 0.0, 0.0);

  gl.uniform3fv(program.uLightVec, [
    forward.dot(v),
    -right.dot(v),
    up.dot(v),
  ]);

  R.c_alias_polys += clmodel._num_tris; // FIXME: private property access

  let num; let fullinterval; let targettime = 0;
  const time = CL.state.time + e.syncbase;
  num = e.frame;
  if ((num >= clmodel.frames.length) || (num < 0)) {
    Con.DPrint('R.DrawAliasModel: no such frame ' + num + '\n');
    num = 0;
  }
  let frame = clmodel.frames[num];
  let frameA = frame, frameB = frame;
  if (frame.group === true) {
    num = frame.frames.length - 1;
    fullinterval = frame.frames[num].interval;
    frameA = frame.frames[0];
    frameB = frame.frames[1 % frame.frames.length];
    targettime = time - Math.floor(time / fullinterval) * fullinterval;
    for (i = 0; i < num; i++) {
      if (frame.frames[i].interval > targettime) {
        frameA = frame.frames[i];
        frameB = frame.frames[(i + 1) % frame.frames.length];
        break;
      }
    }
  }
  gl.uniform1f(program.uAlpha, R.interpolation.value ? Math.min(1, Math.max(0, targettime)) : 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
  gl.vertexAttribPointer(program.aPositionA.location, 3, gl.FLOAT, false, 24, frameA.cmdofs);
  if (program.aPositionB) {
    gl.vertexAttribPointer(program.aPositionB.location, 3, gl.FLOAT, false, 24, frameB.cmdofs);
  }
  gl.vertexAttribPointer(program.aNormal.location, 3, gl.FLOAT, false, 24, frameA.cmdofs + 12);
  gl.vertexAttribPointer(program.aTexCoord.location, 2, gl.FLOAT, false, 0, 0);

  num = e.skinnum;
  if ((num >= clmodel.skins.length) || (num < 0)) {
    Con.DPrint('R.DrawAliasModel: no such skin # ' + num + '\n');
    num = 0;
  }
  let skin = clmodel.skins[num];
  if (skin.group === true) {
    num = skin.skins.length - 1;
    fullinterval = skin.skins[num].interval;
    targettime = time - Math.floor(time / fullinterval) * fullinterval;
    for (i = 0; i < num; i++) {
      if (skin.skins[i].interval > targettime) {
        break;
      }
    }
    skin = skin.skins[i];
  }
  skin.texturenum.bind(program.tTexture);
  if (clmodel.player === true) {
    skin.playertexture.bind(program.tPlayer);
  }

  gl.drawArrays(gl.TRIANGLES, 0, clmodel._num_tris * 3); // FIXME: private property access
};

R.DrawEntitiesOnList = function() {
  if (R.drawentities.value === 0) {
    return;
  }
  for (const currententity of CL.state.clientEntities.getVisibleEntities()) {
    R.currententity = currententity;
    if (R.currententity.model === null) {
      continue;
    }
    switch (R.currententity.model.type) {
      case Mod.type.alias:
        R.DrawAliasModel(R.currententity);
        continue;
      case Mod.type.brush:
        R.DrawBrushModel(R.currententity);
    }
  }
  GL.StreamFlush();
  gl.depthMask(false);
  gl.enable(gl.BLEND);
  for (const currententity of CL.state.clientEntities.getVisibleEntities()) {
    R.currententity = currententity;
    if (R.currententity.model === null) {
      continue;
    }
    if (R.currententity.model.type === Mod.type.sprite) {
      R.DrawSpriteModel(R.currententity);
    }
  }
  GL.StreamFlush();
  gl.disable(gl.BLEND);
  gl.depthMask(true);
};

R.DrawViewModel = function() {
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
    if ((CL.state.items & Def.it.invisibility) !== 0) { // Legacy
      return;
    }
    if (CL.state.stats[Def.stat.health] <= 0) { // Legacy
      return;
    }
    if (!CL.state.viewent.model) {
      return;
    }
  } else if (CL.state.gameAPI) {
    const viewmodel = CL.state.gameAPI.viewmodel;

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
  let program = GL.UseProgram('alias');
  gl.uniformMatrix4fv(program.uPerspective, false, R.perspective);

  R.DrawAliasModel(CL.state.viewent);

  ymax = 4.0 * Math.tan(R.refdef.fov_y * Math.PI / 360.0);
  R.perspective[0] = 4.0 / (ymax * R.refdef.vrect.width / R.refdef.vrect.height);
  R.perspective[5] = 4.0 / ymax;
  program = GL.UseProgram('alias');
  gl.uniformMatrix4fv(program.uPerspective, false, R.perspective);

  gl.depthRange(0.0, 1.0);
};

R.PolyBlend = function() {
  if (R.polyblend.value === 0) {
    return;
  }
  if (V.blend[3] === 0.0) {
    return;
  }
  GL.UseProgram('fill', true);
  const vrect = R.refdef.vrect;
  GL.StreamDrawColoredQuad(vrect.x, vrect.y, vrect.width, vrect.height,
      V.blend[0], V.blend[1], V.blend[2], V.blend[3] * 255.0);
};

R.SetFrustum = function() {
  R.frustum[0].normal = R.vup.rotatePointAroundVector(R.vpn, -(90.0 - R.refdef.fov_x * 0.5));
  R.frustum[1].normal = R.vup.rotatePointAroundVector(R.vpn, 90.0 - R.refdef.fov_x * 0.5);
  R.frustum[2].normal = R.vright.rotatePointAroundVector(R.vpn, 90.0 - R.refdef.fov_y * 0.5);
  R.frustum[3].normal = R.vright.rotatePointAroundVector(R.vpn, -(90.0 - R.refdef.fov_y * 0.5));
  let i; let out;
  for (i = 0; i <= 3; i++) {
    out = R.frustum[i];
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

R.viewMatrix = null;
R.projectionMatrix = null;

// eslint-disable-next-line jsdoc/require-jsdoc
function multiplyMatrixVec4(m, v) {
  return [
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3],
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3],
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
    m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
  ];
}

/**
 *
 * @param {Vector} origin position in the world
 * @returns {{x: number, y: number, z: number, visible: boolean}|null} screen coordinates and visibility
 */
R.WorldToScreen = function(origin) {
  const result = { x: 0, y: 0, z: 0, visible: false };
  const projectionMatrix = R.projectionMatrix;
  const viewMatrix = R.viewMatrix; // This is uViewAngles — rotation only

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

  const clip = multiplyMatrixVec4(projectionMatrix, posVec);

  // If the clip space W coordinate is zero, we can't convert to NDC
  if (clip[3] === 0) {
    return result;
  }

  const ndc = [
    clip[0] / clip[3],
    clip[1] / clip[3],
    clip[2] / clip[3],
  ];

  result.x = R.refdef.vrect.x + (ndc[0] + 1) * 0.5 * R.refdef.vrect.width;
  result.y = R.refdef.vrect.y + (1 - ndc[1]) * 0.5 * R.refdef.vrect.height;
  result.z = ndc[2];
  result.visible = clip[3] > 0 && ndc[0] >= -1 && ndc[0] <= 1 && ndc[1] >= -1 && ndc[1] <= 1 && ndc[2] >= 0 && ndc[2] <= 1;

  return result;
};

R.perspective = [
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, -65540.0 / 65532.0, -1.0,
  0.0, 0.0, -524288.0 / 65532.0, 0.0,
];

R.Perspective = function() {
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
    if (program.uViewOrigin != null) {
      gl.uniform3fv(program.uViewOrigin, R.refdef.vieworg);
    }
    if (program.uViewAngles != null) {
      gl.uniformMatrix3fv(program.uViewAngles, false, viewMatrix);
    }
    if (program.uPerspective != null) {
      gl.uniformMatrix4fv(program.uPerspective, false, R.perspective);
    }
    if (program.uGamma != null) {
      gl.uniform1f(program.uGamma, V.gamma.value);
    }
  }
};

R.SetupGL = function() {
  if (R.dowarp === true) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.warpbuffer);
    gl.clear(gl.COLOR_BUFFER_BIT + gl.DEPTH_BUFFER_BIT);
    gl.viewport(0, 0, R.warpwidth, R.warpheight);
  } else {
    const vrect = R.refdef.vrect;
    const pixelRatio = VID.pixelRatio;
    gl.viewport((vrect.x * pixelRatio) >> 0, ((VID.height - vrect.height - vrect.y) * pixelRatio) >> 0, (vrect.width * pixelRatio) >> 0, (vrect.height * pixelRatio) >> 0);
  }
  R.Perspective();
  gl.enable(gl.DEPTH_TEST);
};

R.viewleaf = null;

R.RenderScene = function() {
  R.AnimateLight();
  const {forward, right, up} = R.refdef.viewangles.angleVectors();
  [R.vpn, R.vright, R.vup] = [forward, right, up];
  R.viewleaf = Mod.PointInLeaf(R.refdef.vieworg, CL.state.worldmodel);
  V.SetContentsColor(R.viewleaf.contents);
  V.CalcBlend();
  R.dowarp = (R.waterwarp.value !== 0) && (R.viewleaf.contents <= Mod.contents.water);

  R.SetFrustum();
  R.SetupGL();
  R.MarkLeaves();
  gl.enable(gl.CULL_FACE);
  R.DrawSkyBox();
  R.DrawViewModel();
  R.DrawWorld();
  R.DrawEntitiesOnList();
  R.DrawWorldTurbolents();
  gl.disable(gl.CULL_FACE);
  R.RenderDlights();
  R.DrawParticles();
};

R.RenderView = function() {
  gl.finish();
  let time1;
  if (R.speeds.value !== 0) {
    time1 = Sys.FloatTime();
  }
  R.c_brush_verts = 0;
  R.c_alias_polys = 0;
  gl.clear(gl.COLOR_BUFFER_BIT + gl.DEPTH_BUFFER_BIT);
  R.RenderScene();
  if (R.speeds.value !== 0) {
    const time2 = Math.floor((Sys.FloatTime() - time1) * 1000.0);
    const c_brush_polys = R.c_brush_verts / 3;
    const c_alias_polys = R.c_alias_polys;
    let msg = ((time2 >= 100) ? '' : ((time2 >= 10) ? ' ' : '  ')) + time2 + ' ms  ';
    msg += ((c_brush_polys >= 1000) ? '' : ((c_brush_polys >= 100) ? ' ' : ((c_brush_polys >= 10) ? '  ' : '   '))) + c_brush_polys + ' wpoly ';
    msg += ((c_alias_polys >= 1000) ? '' : ((c_alias_polys >= 100) ? ' ' : ((c_alias_polys >= 10) ? '  ' : '   '))) + c_alias_polys + ' epoly\n';
    Con.Print(msg);
  }
};

// mesh

R.MakeBrushModelDisplayLists = function(m) {
  if (m.cmds != null) {
    gl.deleteBuffer(m.cmds);
  }
  let i; let j; let k;
  const cmds = [];
  let texture; let chain; let surf; let vert; const styles = [0.0, 0.0, 0.0, 0.0];
  let verts = 0;
  m.chains = [];
  for (i = 0; i < m.textures.length; i++) {
    texture = m.textures[i];
    if ((texture.sky === true) || (texture.turbulent === true)) {
      continue;
    }
    chain = [i, verts, 0];
    for (j = 0; j < m.numfaces; j++) {
      surf = m.faces[m.firstface + j];
      if (surf.texture !== i) {
        continue;
      }
      styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
      for (let l = 0; l < surf.styles.length; l++) {
        styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
      }
      chain[2] += surf.verts.length;
      for (k = 0; k < surf.verts.length; k++) {
        vert = surf.verts[k];
        cmds[cmds.length] = vert[0];
        cmds[cmds.length] = vert[1];
        cmds[cmds.length] = vert[2];
        cmds[cmds.length] = vert[3];
        cmds[cmds.length] = vert[4];
        cmds[cmds.length] = vert[5];
        cmds[cmds.length] = vert[6];
        cmds[cmds.length] = styles[0];
        cmds[cmds.length] = styles[1];
        cmds[cmds.length] = styles[2];
        cmds[cmds.length] = styles[3];
      }
    }
    if (chain[2] !== 0) {
      m.chains[m.chains.length] = chain;
      verts += chain[2];
    }
  }
  m.waterchain = verts * 44;
  verts = 0;
  for (i = 0; i < m.textures.length; i++) {
    texture = m.textures[i];
    if (texture.turbulent !== true) {
      continue;
    }
    chain = [i, verts, 0];
    for (j = 0; j < m.numfaces; j++) {
      surf = m.faces[m.firstface + j];
      if (surf.texture !== i) {
        continue;
      }
      chain[2] += surf.verts.length;
      for (k = 0; k < surf.verts.length; k++) {
        vert = surf.verts[k];
        cmds[cmds.length] = vert[0];
        cmds[cmds.length] = vert[1];
        cmds[cmds.length] = vert[2];
        cmds[cmds.length] = vert[3];
        cmds[cmds.length] = vert[4];
      }
    }
    if (chain[2] !== 0) {
      m.chains[m.chains.length] = chain;
      verts += chain[2];
    }
  }
  m.cmds = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);
};

R.MakeWorldModelDisplayLists = function(m) {
  if (m.cmds != null) {
    return;
  }
  let i; let j; let k; let l;
  const cmds = [];
  let texture; let leaf; let chain; let surf; let vert; const styles = [0.0, 0.0, 0.0, 0.0];
  let verts = 0;
  for (i = 0; i < m.textures.length; i++) {
    texture = m.textures[i];
    if ((texture.sky === true) || (texture.turbulent === true)) {
      continue;
    }
    for (j = 0; j < m.leafs.length; j++) {
      leaf = m.leafs[j];
      chain = [i, verts, 0];
      for (k = 0; k < leaf.nummarksurfaces; k++) {
        surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
        if (surf.texture !== i) {
          continue;
        }
        styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
        for (let l = 0; l < surf.styles.length; l++) {
          styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
        }
        chain[2] += surf.verts.length;
        for (l = 0; l < surf.verts.length; l++) {
          vert = surf.verts[l];
          cmds[cmds.length] = vert[0];
          cmds[cmds.length] = vert[1];
          cmds[cmds.length] = vert[2];
          cmds[cmds.length] = vert[3];
          cmds[cmds.length] = vert[4];
          cmds[cmds.length] = vert[5];
          cmds[cmds.length] = vert[6];
          cmds[cmds.length] = styles[0];
          cmds[cmds.length] = styles[1];
          cmds[cmds.length] = styles[2];
          cmds[cmds.length] = styles[3];
        }
      }
      if (chain[2] !== 0) {
        leaf.cmds[leaf.cmds.length] = chain;
        leaf.skychain++;
        leaf.waterchain++;
        verts += chain[2];
      }
    }
  }
  m.skychain = verts * 44;
  verts = 0;
  for (i = 0; i < m.textures.length; i++) {
    texture = m.textures[i];
    if (texture.sky !== true) {
      continue;
    }
    for (j = 0; j < m.leafs.length; j++) {
      leaf = m.leafs[j];
      chain = [verts, 0];
      for (k = 0; k < leaf.nummarksurfaces; k++) {
        surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
        if (surf.texture !== i) {
          continue;
        }
        chain[1] += surf.verts.length;
        for (l = 0; l < surf.verts.length; l++) {
          vert = surf.verts[l];
          cmds[cmds.length] = vert[0];
          cmds[cmds.length] = vert[1];
          cmds[cmds.length] = vert[2];
        }
      }
      if (chain[1] !== 0) {
        leaf.cmds[leaf.cmds.length] = chain;
        leaf.waterchain++;
        verts += chain[1];
      }
    }
  }
  m.waterchain = m.skychain + verts * 12;
  verts = 0;
  for (i = 0; i < m.textures.length; i++) {
    texture = m.textures[i];
    if (texture.turbulent !== true) {
      continue;
    }
    for (j = 0; j < m.leafs.length; j++) {
      leaf = m.leafs[j];
      chain = [i, verts, 0];
      for (k = 0; k < leaf.nummarksurfaces; k++) {
        surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
        if (surf.texture !== i) {
          continue;
        }
        chain[2] += surf.verts.length;
        for (l = 0; l < surf.verts.length; l++) {
          vert = surf.verts[l];
          cmds[cmds.length] = vert[0];
          cmds[cmds.length] = vert[1];
          cmds[cmds.length] = vert[2];
          cmds[cmds.length] = vert[3];
          cmds[cmds.length] = vert[4];
        }
      }
      if (chain[2] !== 0) {
        leaf.cmds[leaf.cmds.length] = chain;
        verts += chain[2];
      }
    }
  }
  m.cmds = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);
};

// misc

const solidskytexture = new GLTexture('r_solidsky', 128, 128);
const alphaskytexture = new GLTexture('r_alphasky', 128, 128);

R.InitTextures = function() {
  R.notexture_mip = {name: 'notexture', width: 16, height: 16, texturenum: null};

  if (Host.dedicated.value) {
    return;
  }

  const data = new Uint8Array(new ArrayBuffer(256));

  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      data[(i << 4) + j] = data[136 + (i << 4) + j] = 255;
      data[8 + (i << 4) + j] = data[128 + (i << 4) + j] = 0;
    }
  }

  const notexture = GLTexture.Allocate('r_notexture', 16, 16, translateIndexToRGBA(data, 16, 16));

  R.notexture_mip.texturenum = notexture.texnum;

  // CR: this combination of texture modes make the sky look more crisp
  alphaskytexture.lockTextureMode('GL_NEAREST');
  solidskytexture.lockTextureMode('GL_LINEAR');

  R.lightmap_texture = gl.createTexture();
  GL.Bind(0, R.lightmap_texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  R.dlightmap_texture = gl.createTexture();
  GL.Bind(0, R.dlightmap_texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  R.dlightmap_rgba_texture = gl.createTexture();
  GL.Bind(0, R.dlightmap_rgba_texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  R.lightstyle_texture_a = gl.createTexture();
  GL.Bind(0, R.lightstyle_texture_a);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  R.lightstyle_texture_b = gl.createTexture();
  GL.Bind(0, R.lightstyle_texture_b);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  R.fullbright_texture = gl.createTexture();
  GL.Bind(0, R.fullbright_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  R.null_texture = gl.createTexture();
  GL.Bind(0, R.null_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
};

R.Init = async function() {
  R.InitTextures();

  if (registry.isDedicatedServer) {
    console.assert(false, 'R.Init called on dedicated server');
    return;
  }

  Cmd.AddCommand('timerefresh', R.TimeRefresh_f);
  Cmd.AddCommand('pointfile', R.ReadPointFile_f);

  R.waterwarp = new Cvar('r_waterwarp', '1');
  R.fullbright = new Cvar('r_fullbright', '0', Cvar.FLAG.CHEAT);
  R.drawentities = new Cvar('r_drawentities', '1', Cvar.FLAG.CHEAT);
  R.drawviewmodel = new Cvar('r_drawviewmodel', '1');
  R.drawturbolents = new Cvar('r_drawturbolents', '1', Cvar.FLAG.CHEAT);
  R.novis = new Cvar('r_novis', '0', Cvar.FLAG.CHEAT);
  R.speeds = new Cvar('r_speeds', '0');
  R.polyblend = new Cvar('gl_polyblend', '1');
  R.flashblend = new Cvar('gl_flashblend', '0');
  R.nocolors = new Cvar('gl_nocolors', '0');
  R.interpolation = new Cvar('r_interpolation', '0', Cvar.FLAG.ARCHIVE, 'Interpolation of textures and animation groups, 0 - off, 1 - on');

  await R.InitParticles();

  await Promise.all([
    GL.CreateProgram('alias',
      ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uAlpha'],
      [
        ['aPositionA', gl.FLOAT, 3],
        ['aPositionB', gl.FLOAT, 3],
        ['aNormal', gl.FLOAT, 3],
        ['aTexCoord', gl.FLOAT, 2],
      ],
      ['tTexture']),
  GL.CreateProgram('brush',
      ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uAlpha'],
      [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 4], ['aLightStyle', gl.FLOAT, 4]],
      ['tTextureA', 'tTextureB', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB']),
  GL.CreateProgram('dlight',
      ['uOrigin', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uRadius', 'uGamma'],
      [['aPosition', gl.FLOAT, 3]],
      []),
  GL.CreateProgram('player',
      ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uTop', 'uBottom'],
      [['aPositionA', gl.FLOAT, 3], ['aNormal', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2]],
      ['tTexture', 'tPlayer']),
  GL.CreateProgram('sprite',
      ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma'],
      [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2]],
      ['tTexture']),
  GL.CreateProgram('turbulent',
      ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uTime'],
      [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2]],
      ['tTexture']),
  GL.CreateProgram('warp',
      ['uOrtho', 'uTime'],
      [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
      ['tTexture']),
  ]);

  R.warpbuffer = gl.createFramebuffer();
  R.warptexture = gl.createTexture();
  GL.Bind(0, R.warptexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); // FIXME: mipmap
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); // FIXME: mipmap
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  R.warprenderbuffer = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, R.warprenderbuffer);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 0, 0);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, R.warpbuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, R.warptexture, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, R.warprenderbuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  R.dlightvecs = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, R.dlightvecs);
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

  await R.MakeSky();
};

R.NewMap = function() {
  for (let i = 0; i < 64; i++) {
    R.lightstylevalue_a[i] = 12;
    R.lightstylevalue_b[i] = 12;
  }

  R.ClearParticles();
  R.BuildLightmaps();

  for (let i = 0; i <= R.dlightmaps_rgba.length; i++) {
    R.dlightmaps_rgba[i] = 0;
  }

  GL.Bind(0, R.dlightmap_rgba_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 1024, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
};

R.TimeRefresh_f = function() {
  gl.finish();
  let i;
  const start = Sys.FloatTime();
  for (i = 0; i <= 127; i++) {
    R.refdef.viewangles[1] = i * 2.8125;
    R.RenderView();
  }
  gl.finish();
  const time = Sys.FloatTime() - start;
  Con.Print(time.toFixed(6) + ' seconds (' + (128.0 / time).toFixed(6) + ' fps)\n');
};

// part

R.ptype = {
  tracer: 0,
  grav: 1,
  slowgrav: 2,
  fire: 3,
  explode: 4,
  explode2: 5,
  blob: 6,
  blob2: 7,
};

R.ramp1 = [0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61];
R.ramp2 = [0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66];
R.ramp3 = [0x6d, 0x6b, 6, 5, 4, 3];

R.InitParticles = async function() {
  // let i = COM.CheckParm('-particles');
  // if (i != null) {
  //   R.numparticles = Q.atoi(COM.argv[i + 1]);
  //   if (R.numparticles < 512) {
  //     R.numparticles = 512;
  //   }
  // } else {
    R.numparticles = 2048;
  // }

  R.avelocities = [];
  for (let i = 0; i <= 161; i++) {
    R.avelocities[i] = [Math.random() * 2.56, Math.random() * 2.56, Math.random() * 2.56];
  }

  await GL.CreateProgram('particle',
      ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma'],
      [['aOrigin', gl.FLOAT, 3], ['aCoord', gl.FLOAT, 2], ['aScale', gl.FLOAT, 1], ['aColor', gl.UNSIGNED_BYTE, 3, true]],
      []);
};

R.EntityParticles = function(ent) {
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
      org: [
        ent.origin[0] + R.avertexnormals[i][0] * 64.0 + cp * cy * 16.0,
        ent.origin[1] + R.avertexnormals[i][1] * 64.0 + cp * sy * 16.0,
        ent.origin[2] + R.avertexnormals[i][2] * 64.0 + sp * -16.0,
      ],
      vel: new Vector(),
    };
  }
};

R.ClearParticles = function() {
  R.particles = [];
  for (let i = 0; i < R.numparticles; i++) {
    R.particles[i] = {die: -1.0};
  }
};

R.ReadPointFile_f = function() {
  if (SV.server.active !== true) {
    return;
  }
  const name = 'maps/' + SV.server.gameAPI.mapname + '.pts';
  let f = COM.LoadTextFile(name);
  if (f == null) {
    Con.Print('couldn\'t open ' + name + '\n');
    return;
  }
  Con.Print('Reading ' + name + '...\n');
  f = f.split('\n');
  let c; let org; let p;
  for (c = 0; c < f.length; ) {
    org = f[c].split(' ');
    if (org.length !== 3) {
      break;
    }
    ++c;
    p = R.AllocParticles(1);
    if (p.length === 0) {
      Con.Print('Not enough free particles\n');
      break;
    }
    R.particles[p[0]] = {
      die: 99999.0,
      color: -c & 15,
      type: R.ptype.tracer,
      vel: new Vector(),
      org: new Vector(Q.atof(org[0]), Q.atof(org[1]), Q.atof(org[2])),
    };
  }
  Con.Print(c + ' points read\n');
};

R.ParseParticleEffect = function() {
  const org = new Vector(MSG.ReadCoord(), MSG.ReadCoord(), MSG.ReadCoord());
  const dir = new Vector(MSG.ReadChar() * 0.0625, MSG.ReadChar() * 0.0625, MSG.ReadChar() * 0.0625);
  const msgcount = MSG.ReadByte();
  const color = MSG.ReadByte();
  if (msgcount === 255) {
    R.ParticleExplosion(org);
  } else {
    R.RunParticleEffect(org, dir, color, msgcount);
  }
};

R.ParticleExplosion = function(org) {
  const allocated = R.AllocParticles(1024);
  for (let i = 0; i < allocated.length; i++) {
    R.particles[allocated[i]] = {
      die: CL.state.time + 5.0,
      color: R.ramp1[0],
      ramp: Math.floor(Math.random() * 4.0),
      type: ((i & 1) !== 0) ? R.ptype.explode : R.ptype.explode2,
      org: [
        org[0] + Math.random() * 32.0 - 16.0,
        org[1] + Math.random() * 32.0 - 16.0,
        org[2] + Math.random() * 32.0 - 16.0,
      ],
      vel: new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0),
    };
  }
};

R.ParticleExplosion2 = function(org, colorStart, colorLength) {
  const allocated = R.AllocParticles(512);
  let colorMod = 0;
  for (let i = 0; i < allocated.length; i++) {
    R.particles[allocated[i]] = {
      die: CL.state.time + 0.3,
      color: colorStart + (colorMod++ % colorLength),
      type: R.ptype.blob,
      org: [
        org[0] + Math.random() * 32.0 - 16.0,
        org[1] + Math.random() * 32.0 - 16.0,
        org[2] + Math.random() * 32.0 - 16.0,
      ],
      vel: new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0),
    };
  }
};

R.BlobExplosion = function(org) {
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
    p.org = [
      org[0] + Math.random() * 32.0 - 16.0,
      org[1] + Math.random() * 32.0 - 16.0,
      org[2] + Math.random() * 32.0 - 16.0,
    ];
    p.vel = new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0);
  }
};

R.RunParticleEffect = function(org, dir, color, count) {
  const allocated = R.AllocParticles(count); let i;
  for (i = 0; i < allocated.length; i++) {
    R.particles[allocated[i]] = {
      die: CL.state.time + 0.6 * Math.random(),
      color: (color & 0xf8) + Math.floor(Math.random() * 8.0),
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

R.LavaSplash = function(org) {
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

R.TeleportSplash = function(org) {
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

R.tracercount = 0;
R.RocketTrail = function(start, end, type) {
  let vec = end.copy().subtract(start);

  const len = vec.len();

  if (len === 0.0) {
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

R.DrawParticles = function() {
  GL.StreamFlush();

  GL.UseProgram('particle');
  gl.depthMask(false);
  gl.enable(gl.BLEND);

  const frametime = Host.frametime;
  const grav = frametime * SV.gravity.value * 0.05;
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

R.AllocParticles = function(count) {
  const allocated = []; let i;
  for (i = 0; i < R.numparticles; i++) {
    if (count === 0) {
      return allocated;
    }
    if (R.particles[i].die < CL.state.time) {
      allocated[allocated.length] = i;
      --count;
    }
  }
  return allocated;
};

// surf

R.lightmap_modified = [];
R.lightmaps = new Uint8Array(new ArrayBuffer(4194304));
R.dlightmaps_rgba = new Uint8Array(new ArrayBuffer(1048576 * 4));

R.AddDynamicLights = function(surf) {
  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const size = smax * tmax;

  const blocklights = [];
  for (let i = 0; i < size * 3; i++) {
    blocklights[i] = 0;
  }

  for (let i = 0; i < Def.limits.dlights; i++) {
    if (((surf.dlightbits >>> i) & 1) === 0) {
      continue;
    }
    const light = CL.state.clientEntities.dlights[i];
    let dist = light.origin.dot(surf.plane.normal) - surf.plane.dist;
    const rad = light.radius - Math.abs(dist);
    let minlight = light.minlight;
    if (rad < minlight) {
      continue;
    }
    minlight = rad - minlight;
    const impact = light.origin.copy().subtract(surf.plane.normal.copy().multiply(dist));
    const tex = CL.state.worldmodel.texinfo[surf.texinfo];
    const local = [
      impact.dot(new Vector(...tex.vecs[0])) + tex.vecs[0][3] - surf.texturemins[0],
      impact.dot(new Vector(...tex.vecs[1])) + tex.vecs[1][3] - surf.texturemins[1],
    ];
    for (let t = 0; t < tmax; ++t) {
      let td = local[1] - (t << 4);
      if (td < 0.0) {
        td = -td;
      }
      td = Math.floor(td);
      for (let s = 0; s < smax; ++s) {
        let sd = local[0] - (s << 4);
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

  for (let t = 0, i = 0; t < tmax; ++t) {
    R.lightmap_modified[surf.light_t + t] = true;
    const dest = ((surf.light_t + t) << 10) + surf.light_s;
    for (let s = 0; s < smax; ++s) {
      const dldest = (dest + s) * 4;
      const blrgb = [
        Math.min(Math.floor(blocklights[i * 3] / 128), 255),
        Math.min(Math.floor(blocklights[i * 3 + 1] / 128), 255),
        Math.min(Math.floor(blocklights[i * 3 + 2] / 128), 255),
      ];
      // console.log(blrgb);
      i++;
      for (let i = 0; i < 3; i++) {
        R.dlightmaps_rgba[dldest + i] = blrgb[i];
      }
    }
  }
};

R.RemoveDynamicLights = function(surf) {
  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  for (let t = 0; t < tmax; ++t) {
    R.lightmap_modified[surf.light_t + t] = true;
    const dest = ((surf.light_t + t) << 10) + surf.light_s;
    for (let s = 0; s < smax; ++s) {
      const dldest = (dest + s) * 4;
      for (let i = 0; i < 3; i++) {
        R.dlightmaps_rgba[dldest + i] = 0;
      }
      R.dlightmaps_rgba[dldest + 3] = 255; // fully opaque
    }
  }
};

R.BuildLightMap = function(surf) {
  let dest;
  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  let i; let j;
  let lightmap = surf.lightofs;
  let maps;
  for (maps = 0; maps < surf.styles.length; ++maps) {
    dest = (surf.light_t << 12) + (surf.light_s << 2) + maps;
    for (i = 0; i < tmax; i++) {
      for (j = 0; j < smax; j++) {
        R.lightmaps[dest + (j << 2)] = R.currentmodel.lightdata[lightmap + j];
      }
      lightmap += smax;
      dest += 4096;
    }
  }
  for (; maps <= 3; ++maps) {
    dest = (surf.light_t << 12) + (surf.light_s << 2) + maps;
    for (i = 0; i < tmax; i++) {
      for (j = 0; j < smax; j++) {
        R.lightmaps[dest + (j << 2)] = 0;
      }
      dest += 4096;
    }
  }
};

/**
 * @param base
 * @returns {[BrushModelTexture, BrushModelTexture]}
 */
R.TextureAnimation = function(base) {
  let frame = 0;
  if (base.anim_base != null) {
    frame = base.anim_frame;
    base = R.currententity.model.textures[base.anim_base];
  }
  let anims = base.anims;
  if (anims == null) {
    return [base, base];
  }
  if ((R.currententity.frame !== 0) && (base.alternate_anims.length !== 0)) {
    anims = base.alternate_anims;
  }
  return [
    R.currententity.model.textures[anims[(Math.floor(CL.state.time * 5.0) + frame) % anims.length]],
    R.currententity.model.textures[anims[(Math.floor(CL.state.time * 5.0) + frame + 1) % anims.length]],
  ];
};

R.DrawBrushModel = function(e) {
  const clmodel = e.model;

  if (clmodel.submodel === true) {
    if (R.CullBox(
        new Vector(
          e.origin[0] + clmodel.mins[0],
          e.origin[1] + clmodel.mins[1],
          e.origin[2] + clmodel.mins[2],
        ),
        new Vector(
          e.origin[0] + clmodel.maxs[0],
          e.origin[1] + clmodel.maxs[1],
          e.origin[2] + clmodel.maxs[2],
        )) === true) {
      return;
    }
  } else {
    if (R.CullBox(
        new Vector(
          e.origin[0] - clmodel.radius,
          e.origin[1] - clmodel.radius,
          e.origin[2] - clmodel.radius,
        ),
        new Vector(
          e.origin[0] + clmodel.radius,
          e.origin[1] + clmodel.radius,
          e.origin[2] + clmodel.radius,
        )) === true) {
      return;
    }
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
  const viewMatrix = e.angles.toRotationMatrix();

  let program = GL.UseProgram('brush');
  gl.uniform3fv(program.uOrigin, e.origin);
  gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 44, 0);
  gl.vertexAttribPointer(program.aTexCoord.location, 4, gl.FLOAT, false, 44, 12);
  gl.vertexAttribPointer(program.aLightStyle.location, 4, gl.FLOAT, false, 44, 28);
  gl.uniform1f(program.uAlpha, R.interpolation.value ? (CL.state.time % .2) / .2 : 0);
  if ((R.fullbright.value !== 0) || (clmodel.lightdata == null)) {
    GL.Bind(program.tLightmap, R.fullbright_texture);
  } else {
    GL.Bind(program.tLightmap, R.lightmap_texture);
  }
  GL.Bind(program.tDlight, ((R.flashblend.value === 0) && (clmodel.submodel === true)) ? R.dlightmap_rgba_texture : R.null_texture);
  GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
  GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
  for (let i = 0; i < clmodel.chains.length; i++) {
    const chain = clmodel.chains[i];
    const [textureA, textureB] = R.TextureAnimation(clmodel.textures[chain[0]]);
    if (textureA.turbulent === true) {
      continue;
    }
    R.c_brush_verts += chain[2];
    textureA.glt.bind(program.tTextureA);
    textureB.glt.bind(program.tTextureB);
    gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
  }

  if (!R.drawturbolents.value) {
    return;
  }

  program = GL.UseProgram('turbulent');
  gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
  gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);
  gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 20, e.model.waterchain);
  gl.vertexAttribPointer(program.aTexCoord.location, 2, gl.FLOAT, false, 20, e.model.waterchain + 12);
  for (let i = 0; i < clmodel.chains.length; i++) {
    const chain = clmodel.chains[i];
    const texture = clmodel.textures[chain[0]];
    if (texture.turbulent !== true) {
      continue;
    }
    R.c_brush_verts += chain[2];
    GL.Bind(program.tTexture, texture.texturenum);
    gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
  }
};

R.RecursiveWorldNode = function(node) {
  if (node.contents === Mod.contents.solid) {
    return;
  }
  if (node.contents < 0) {
    if (node.markvisframe !== R.visframecount) {
      return;
    }
    node.visframe = R.visframecount;
    if (node.skychain !== node.waterchain) {
      R.drawsky = true;
    }
    return;
  }
  R.RecursiveWorldNode(node.children[0]);
  R.RecursiveWorldNode(node.children[1]);
};

R.DrawWorld = function() {
  const clmodel = CL.state.worldmodel;
  R.currententity = CL.state.clientEntities.getEntity(0);
  gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);

  let program = GL.UseProgram('brush');
  gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
  gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 44, 0);
  gl.vertexAttribPointer(program.aTexCoord.location, 4, gl.FLOAT, false, 44, 12);
  gl.vertexAttribPointer(program.aLightStyle.location, 4, gl.FLOAT, false, 44, 28);
  if ((R.fullbright.value !== 0) || (clmodel.lightdata == null)) {
    GL.Bind(program.tLightmap, R.fullbright_texture);
  } else {
    GL.Bind(program.tLightmap, R.lightmap_texture);
  }
  if (R.flashblend.value === 0) {
    GL.Bind(program.tDlight, R.dlightmap_rgba_texture);
  } else {
    GL.Bind(program.tDlight, R.null_texture);
  }
  GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
  GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
  let i; let j; let leaf; let cmds;
  for (i = 0; i < clmodel.leafs.length; i++) {
    leaf = clmodel.leafs[i];
    if ((leaf.visframe !== R.visframecount) || (leaf.skychain === 0)) {
      continue;
    }
    if (R.CullBox(leaf.mins, leaf.maxs) === true) {
      continue;
    }
    for (j = 0; j < leaf.skychain; j++) {
      cmds = leaf.cmds[j];
      R.c_brush_verts += cmds[2];
      const [textureA, textureB] = R.TextureAnimation(clmodel.textures[cmds[0]]);
      gl.uniform1f(program.uAlpha, R.interpolation.value ? (CL.state.time % .2) / .2 : 0);
      textureA.glt.bind(program.tTextureA);
      textureB.glt.bind(program.tTextureB);
      gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
    }
  }
};

R.DrawWorldTurbolents = function() {
  if (R.drawturbolents.value === 0) {
    return;
  }

  const clmodel = CL.state.worldmodel;
  R.currententity = CL.state.clientEntities.getEntity(0);
  gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);

  gl.enable(gl.BLEND);
  const program = GL.UseProgram('turbulent');
  gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
  gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
  gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 20, clmodel.waterchain);
  gl.vertexAttribPointer(program.aTexCoord.location, 2, gl.FLOAT, false, 20, clmodel.waterchain + 12);
  for (let i = 0; i < clmodel.leafs.length; i++) {
    const leaf = clmodel.leafs[i];
    if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
      continue;
    }
    if (R.CullBox(leaf.mins, leaf.maxs) === true) {
      continue;
    }
    for (let j = leaf.waterchain; j < leaf.cmds.length; j++) {
      const cmds = leaf.cmds[j];
      R.c_brush_verts += cmds[2];
      clmodel.textures[cmds[0]].glt.bind(program.tTexture);
      gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
    }
  }
  gl.disable(gl.BLEND);
};

R.MarkLeaves = function() {
  if ((R.oldviewleaf === R.viewleaf) && (R.novis.value === 0)) {
    return;
  }
  ++R.visframecount;
  R.oldviewleaf = R.viewleaf;
  let vis = (R.novis.value !== 0) ? Mod.novis : Mod.LeafPVS(R.viewleaf, CL.state.worldmodel);
  let i; let node;
  for (i = 0; i < CL.state.worldmodel.leafs.length; i++) {
    if ((vis[i >> 3] & (1 << (i & 7))) === 0) {
      continue;
    }
    for (node = CL.state.worldmodel.leafs[i + 1]; node != null; node = node.parent) {
      if (node.markvisframe === R.visframecount) {
        break;
      }
      node.markvisframe = R.visframecount;
    }
  }
  do {
    if (R.novis.value !== 0) {
      break;
    }
    // const p = [R.refdef.vieworg[0], R.refdef.vieworg[1], R.refdef.vieworg[2]];
    let leaf;
    if (R.viewleaf.contents <= Mod.contents.water) {
      leaf = Mod.PointInLeaf([R.refdef.vieworg[0], R.refdef.vieworg[1], R.refdef.vieworg[2] + 16.0], CL.state.worldmodel);
      if (leaf.contents <= Mod.contents.water) {
        break;
      }
    } else {
      leaf = Mod.PointInLeaf([R.refdef.vieworg[0], R.refdef.vieworg[1], R.refdef.vieworg[2] - 16.0], CL.state.worldmodel);
      if (leaf.contents > Mod.contents.water) {
        break;
      }
    }
    if (leaf === R.viewleaf) {
      break;
    }
    vis = Mod.LeafPVS(leaf, CL.state.worldmodel);
    for (i = 0; i < CL.state.worldmodel.leafs.length; i++) {
      if ((vis[i >> 3] & (1 << (i & 7))) === 0) {
        continue;
      }
      for (node = CL.state.worldmodel.leafs[i + 1]; node != null; node = node.parent) {
        if (node.markvisframe === R.visframecount) {
          break;
        }
        node.markvisframe = R.visframecount;
      }
    }
  // eslint-disable-next-line no-constant-condition
  } while (false);
  R.drawsky = false;
  R.RecursiveWorldNode(CL.state.worldmodel.nodes[0]);
};

R.AllocBlock = function(surf) {
  const w = (surf.extents[0] >> 4) + 1; const h = (surf.extents[1] >> 4) + 1;
  let x; let y; let i; let j; let best = 1024; let best2;
  for (i = 0; i < (1024 - w); i++) {
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
  if (best > 1024) {
    throw new Error('R.AllocBlock: full');
  }
  for (i = 0; i < w; i++) {
    R.allocated[x + i] = best;
  }
  surf.light_s = x;
  surf.light_t = y;
};

// Based on Quake 2 polygon generation algorithm by Toji - http://blog.tojicode.com/2010/06/quake-2-bsp-quite-possibly-worst-format.html
R.BuildSurfaceDisplayList = function(fa) {
  fa.verts = [];
  if (fa.numedges <= 2) {
    return;
  }
  let i; let index; let vec; let vert; let s; let t;
  const texinfo = R.currentmodel.texinfo[fa.texinfo];
  const texture = R.currentmodel.textures[texinfo.texture];
  for (i = 0; i < fa.numedges; i++) {
    index = R.currentmodel.surfedges[fa.firstedge + i];
    if (index > 0) {
      vec = R.currentmodel.vertexes[R.currentmodel.edges[index][0]];
    } else {
      vec = R.currentmodel.vertexes[R.currentmodel.edges[-index][1]];
    }
    vert = [vec[0], vec[1], vec[2]];
    if (fa.sky !== true) {
      s = vec.dot(new Vector(...texinfo.vecs[0])) + texinfo.vecs[0][3];
      t = vec.dot(new Vector(...texinfo.vecs[1])) + texinfo.vecs[1][3];
      vert[3] = s / texture.width;
      vert[4] = t / texture.height;
      if (fa.turbulent !== true) {
        vert[5] = (s - fa.texturemins[0] + (fa.light_s << 4) + 8.0) / 16384.0;
        vert[6] = (t - fa.texturemins[1] + (fa.light_t << 4) + 8.0) / 16384.0;
      }
    }
    if (i >= 3) {
      fa.verts[fa.verts.length] = fa.verts[0];
      fa.verts[fa.verts.length] = fa.verts[fa.verts.length - 2];
    }
    fa.verts[fa.verts.length] = vert;
  }
};

R.BuildLightmaps = function() {
  let i; let j;

  R.allocated = [];
  for (i = 0; i < 1024; i++) {
    R.allocated[i] = 0;
  }

  let surf;
  for (i = 1; i < CL.state.model_precache.length; i++) {
    R.currentmodel = CL.state.model_precache[i];
    if (R.currentmodel.type !== Mod.type.brush) {
      continue;
    }
    if (R.currentmodel.name[0] !== '*') {
      for (j = 0; j < R.currentmodel.faces.length; j++) {
        surf = R.currentmodel.faces[j];
        if ((surf.sky !== true) && (surf.turbulent !== true)) {
          R.AllocBlock(surf);
          if (R.currentmodel.lightdata != null) {
            R.BuildLightMap(surf);
          }
        }
        R.BuildSurfaceDisplayList(surf);
      }
    }
    if (i === 1) {
      R.MakeWorldModelDisplayLists(R.currentmodel);
    } else {
      R.MakeBrushModelDisplayLists(R.currentmodel);
    }
  }

  GL.Bind(0, R.lightmap_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 1024, 0, gl.RGBA, gl.UNSIGNED_BYTE, R.lightmaps);
};

// scan

R.WarpScreen = function() {
  GL.StreamFlush();
  gl.finish();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  const program = GL.UseProgram('warp');
  GL.Bind(program.tTexture, R.warptexture);
  gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));
  const vrect = R.refdef.vrect;
  GL.StreamDrawTexturedQuad(vrect.x, vrect.y, vrect.width, vrect.height, 0.0, 1.0, 1.0, 0.0);
  GL.StreamFlush();
};

// warp

R.MakeSky = async function() {
  const sin = Array.from({ length: 9 }, (_, i) =>
    Number(Math.sin(i * Math.PI / 16).toFixed(6)),
  );
  let vecs = []; let i; let j;

  for (i = 0; i < 7; i += 2) {
    vecs = vecs.concat(
        [
          0.0, 0.0, 1.0,
          sin[i + 2] * sin[1], sin[6 - i] * sin[1], sin[7],
          sin[i] * sin[1], sin[8 - i] * sin[1], sin[7],
        ]);
    for (j = 0; j < 7; j++) {
      vecs = vecs.concat(
          [
            sin[i] * sin[8 - j], sin[8 - i] * sin[8 - j], sin[j],
            sin[i] * sin[7 - j], sin[8 - i] * sin[7 - j], sin[j + 1],
            sin[i + 2] * sin[7 - j], sin[6 - i] * sin[7 - j], sin[j + 1],

            sin[i] * sin[8 - j], sin[8 - i] * sin[8 - j], sin[j],
            sin[i + 2] * sin[7 - j], sin[6 - i] * sin[7 - j], sin[j + 1],
            sin[i + 2] * sin[8 - j], sin[6 - i] * sin[8 - j], sin[j],
          ]);
    }
  }

  await Promise.all([
    GL.CreateProgram('sky',
      ['uViewAngles', 'uPerspective', 'uScale', 'uGamma', 'uTime'],
      [['aPosition', gl.FLOAT, 3]],
      ['tSolid', 'tAlpha']),
    GL.CreateProgram('sky-chain',
      ['uViewOrigin', 'uViewAngles', 'uPerspective'],
      [['aPosition', gl.FLOAT, 3]],
      []),
  ]);

  R.skyvecs = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, R.skyvecs);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vecs), gl.STATIC_DRAW);
};

R.DrawSkyBox = function() {
  if (R.drawsky !== true) {
    return;
  }

  gl.colorMask(false, false, false, false);
  const clmodel = CL.state.worldmodel;
  let program = GL.UseProgram('sky-chain');
  gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 12, clmodel.skychain);
  let i; let j; let leaf; let cmds;
  for (i = 0; i < clmodel.leafs.length; i++) {
    leaf = clmodel.leafs[i];
    if ((leaf.visframe !== R.visframecount) || (leaf.skychain === leaf.waterchain)) {
      continue;
    }
    if (R.CullBox(leaf.mins, leaf.maxs) === true) {
      continue;
    }
    for (j = leaf.skychain; j < leaf.waterchain; j++) {
      cmds = leaf.cmds[j];
      gl.drawArrays(gl.TRIANGLES, cmds[0], cmds[1]);
    }
  }
  gl.colorMask(true, true, true, true);

  gl.depthFunc(gl.GREATER);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);

  program = GL.UseProgram('sky');
  gl.uniform2f(program.uTime, (Host.realtime * 0.125) % 1.0, (Host.realtime * 0.03125) % 1.0);
  solidskytexture.bind(program.tSolid);
  alphaskytexture.bind(program.tAlpha);
  gl.bindBuffer(gl.ARRAY_BUFFER, R.skyvecs);
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 12, 0);

  gl.uniform3f(program.uScale, 2.0, -2.0, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);
  gl.uniform3f(program.uScale, 2.0, -2.0, -1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);

  gl.uniform3f(program.uScale, 2.0, 2.0, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);
  gl.uniform3f(program.uScale, 2.0, 2.0, -1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);

  gl.uniform3f(program.uScale, -2.0, -2.0, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);
  gl.uniform3f(program.uScale, -2.0, -2.0, -1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);

  gl.uniform3f(program.uScale, -2.0, 2.0, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);
  gl.uniform3f(program.uScale, -2.0, 2.0, -1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);

  gl.enable(gl.CULL_FACE);
  gl.depthMask(true);
  gl.depthFunc(gl.LESS);
};

R.InitSky = function(src) {
  const trans = new ArrayBuffer(65536);
  const trans32 = new Uint32Array(trans);

  for (let i = 0; i < 128; i++) {
    for (let j = 0; j < 128; j++) {
      trans32[(i << 7) + j] = COM.LittleLong(W.d_8to24table[src[(i << 8) + j + 128]] + 0xff000000);
    }
  }

  solidskytexture.upload(new Uint8Array(trans));

  for (let i = 0; i < 128; i++) {
    for (let j = 0; j < 128; j++) {
      const p = (i << 8) + j;
      if (src[p] !== 0) {
        trans32[(i << 7) + j] = COM.LittleLong(W.d_8to24table[src[p]] + 0xff000000);
      } else {
        trans32[(i << 7) + j] = 0;
      }
    }
  }

  alphaskytexture.upload(new Uint8Array(trans));
};

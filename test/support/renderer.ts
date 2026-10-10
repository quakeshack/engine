import R from '../../source/engine/client/R.ts';
import DefaultTextures from '../../source/engine/client/renderer/resources/DefaultTextures.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import Fog from '../../source/engine/client/renderer/scene/Fog.ts';
import RenderStats from '../../source/engine/client/renderer/scene/RenderStats.ts';
import Visibility from '../../source/engine/client/renderer/scene/Visibility.ts';
import { patchMembers } from './clientState.ts';

/** Members that were on the renderer and now live on `Camera`. */
const CAMERA_MEMBERS = new Set([
  'refdef', 'vpn', 'vup', 'vright', 'frustum', 'viewMatrix', 'projectionMatrix', 'perspective', 'CullBox', 'WorldToScreen',
]);

/** Members that were on the renderer and now live on `Visibility`, under the name they have there. */
const VISIBILITY_MEMBERS: Record<string, string> = {
  visframecount: 'visframecount',
  viewleaf: 'viewleaf',
  oldviewleaf: 'oldviewleaf',
  drawsky: 'skyVisible',
};

/** Console variables that were on the renderer and now live in `rendererCvars`. */
const CVAR_MEMBERS = new Set([
  'novis', 'fog_color', 'fog_start', 'fog_end', 'fog_density', 'fog_mode',
  'waterwarp', 'drawentities', 'drawviewmodel', 'drawturbulents', 'underwater_fog_density', 'speeds', 'polyblend',
  'nocolors', 'bloom', 'bloomStrength', 'bloomSkyStrength', 'bloomDlightStrength', 'bloomSpecularStrength',
  'bloomDownsample', 'bloomDebug', 'interpolation',
]);

/** Members that were on the renderer and now live on `DefaultTextures`. */
const TEXTURE_MEMBERS = new Set(['notexture', 'blacktexture', 'flatnormalmap', 'fullbright_texture', 'null_texture', 'normal_up_texture']);

/** Members that were on the renderer and now live on `Fog`. */
const FOG_MEMBERS = new Set(['underwaterFogColor', 'underwaterFogDensity']);

/** The frame counters that were on the renderer and now live on `RenderStats`. */
const STATS_MEMBERS = new Set(['c_brush_verts', 'c_brush_tris', 'c_brush_draws', 'c_brush_vbos', 'c_brush_texture_binds', 'c_alias_polys']);

/**
 * Sorts the members of a renderer mock by where the real ones live now.
 * @param mockedRenderer What the test mocked.
 * @returns One object per owner, `undefined` where the mock has nothing for it.
 */
function splitRendererMock(mockedRenderer: object | null | undefined): Record<'camera' | 'visibility' | 'cvars' | 'textures' | 'fog' | 'stats' | 'renderer', object | undefined> {
  if (mockedRenderer === null || mockedRenderer === undefined) {
    return { camera: undefined, visibility: undefined, cvars: undefined, textures: undefined, fog: undefined, stats: undefined, renderer: undefined };
  }

  const camera: Record<string, unknown> = {};
  const visibility: Record<string, unknown> = {};
  const cvars: Record<string, unknown> = {};
  const textures: Record<string, unknown> = {};
  const fog: Record<string, unknown> = {};
  const stats: Record<string, unknown> = {};
  const renderer: Record<string, unknown> = {};

  for (const name of Object.getOwnPropertyNames(mockedRenderer)) {
    const descriptor = Object.getOwnPropertyDescriptor(mockedRenderer, name)!;
    const value: unknown = 'value' in descriptor ? descriptor.value : (mockedRenderer as Record<string, unknown>)[name];

    if (CAMERA_MEMBERS.has(name)) {
      camera[name] = value;
    } else if (name in VISIBILITY_MEMBERS) {
      visibility[VISIBILITY_MEMBERS[name]] = value;
    } else if (CVAR_MEMBERS.has(name)) {
      cvars[name] = value;
    } else if (TEXTURE_MEMBERS.has(name)) {
      textures[name] = value;
    } else if (FOG_MEMBERS.has(name)) {
      fog[name] = value;
    } else if (STATS_MEMBERS.has(name)) {
      stats[name] = value;
    } else {
      renderer[name] = value;
    }
  }

  return { camera, visibility, cvars, textures, fog, stats, renderer };
}

/**
 * Makes the engine's real renderer look like what a test mocked as `engineMocks.R`: the parts of the client that
 * use the renderer import it directly, so a test that wants other values or methods sets them on the real one.
 * Members that moved out of `R` are set where they live now (`Camera`, `Visibility`, `rendererCvars`,
 * `DefaultTextures`, `Fog`, `RenderStats`), so a mock written in terms of the old facade keeps working.
 * @param mockedRenderer What the test installed as `engineMocks.R`; `null` or `undefined` changes nothing.
 * @returns A function that puts the real renderer back.
 */
export function useRendererOf(mockedRenderer: object | null | undefined): () => void {
  const parts = splitRendererMock(mockedRenderer);
  const restores = [
    patchMembers(R, parts.renderer),
    patchMembers(Camera, parts.camera),
    patchMembers(Visibility, parts.visibility),
    patchMembers(rendererCvars, parts.cvars),
    patchMembers(DefaultTextures, parts.textures),
    patchMembers(Fog, parts.fog),
    patchMembers(RenderStats, parts.stats),
  ];

  return () => {
    for (const restore of restores.reverse()) {
      restore();
    }
  };
}

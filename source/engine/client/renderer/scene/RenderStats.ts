import Draw from '../../Draw.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import FrameProfiler from '../../FrameProfiler.ts';

/**
 * Counters of what the renderer drew this frame and the `r_speeds` text built from them. The model renderers
 * add to the counters while they draw, `R.RenderView` resets them in front of the scene and summarizes them after.
 * The times below the counters come from {@link FrameProfiler}.
 */
class RenderStats {
  static c_brush_verts = 0;
  static c_brush_tris = 0;
  static c_brush_draws = 0;
  static c_brush_vbos = 0;
  static c_brush_texture_binds = 0;
  static c_alias_polys = 0;

  /** Entities drawn in the opaque pass, the world left out. */
  static c_entities = 0;

  /** Items of the transparent pass: translucent and turbulent surfaces, sprites, decals, particles. */
  static c_transparent_items = 0;

  /** Copies of the scene color taken for refraction. */
  static c_scene_color_copies = 0;

  /** Copies of the scene depth taken for passes that sample it. */
  static c_scene_depth_copies = 0;

  /** Point lights that got a shadow cube map. */
  static c_point_shadows = 0;

  /** The `r_speeds` lines of the last frame that was summarized. */
  static readonly lines: string[] = [];

  /**
   * Starts a frame with all counters at zero.
   */
  static Reset(): void {
    RenderStats.c_brush_verts = 0;
    RenderStats.c_brush_tris = 0;
    RenderStats.c_brush_draws = 0;
    RenderStats.c_brush_vbos = 0;
    RenderStats.c_brush_texture_binds = 0; // Track texture binding overhead
    RenderStats.c_alias_polys = 0;
    RenderStats.c_entities = 0;
    RenderStats.c_transparent_items = 0;
    RenderStats.c_scene_color_copies = 0;
    RenderStats.c_scene_depth_copies = 0;
    RenderStats.c_point_shadows = 0;
  }

  /**
   * Builds the `r_speeds` lines from the counters of the finished frame.
   */
  static Summarize(): void {
    const c_brush_polys = RenderStats.c_brush_verts / 3;
    const avgTrisPerDraw = RenderStats.c_brush_draws > 0 ? (RenderStats.c_brush_tris / RenderStats.c_brush_draws).toFixed(1) : '0';

    RenderStats.lines[0] = `${RenderStats.c_brush_draws.toFixed().padStart(5)} draw calls, avg ${avgTrisPerDraw} tris/draw`;
    RenderStats.lines[1] = `${RenderStats.c_brush_tris.toFixed().padStart(5)} tris, ${RenderStats.c_brush_verts.toFixed().padStart(5)} verts`;
    RenderStats.lines[2] = `${RenderStats.c_brush_vbos.toFixed().padStart(5)} VBOs used, ${RenderStats.c_brush_texture_binds.toFixed().padStart(5)} texture binds`;
    RenderStats.lines[3] = `${RenderStats.c_alias_polys.toFixed().padStart(5)} alias polys, ${c_brush_polys.toFixed().padStart(5)} brush polys`;
    RenderStats.lines[4] = `${RenderStats.c_entities.toFixed().padStart(5)} entities, ${RenderStats.c_transparent_items.toFixed().padStart(5)} transparent items`;
    RenderStats.lines[5] = `${RenderStats.c_scene_color_copies.toFixed().padStart(5)} color copies, ${RenderStats.c_scene_depth_copies.toFixed().padStart(5)} depth copies, ${RenderStats.c_point_shadows.toFixed()} point shadows`;
  }

  /**
   * Draws the frame rate, the `r_speeds` counters and the times of the frame's sections when `r_speeds` is on.
   * @param fps Frames per second to show.
   */
  static Print(fps: number): void {
    if (!rendererCvars.speeds.value) {
      return;
    }

    Draw.String(16, 16, `${fps.toFixed(1)} FPS`, 2.0);

    let y = 40;

    for (const line of RenderStats.lines) {
      Draw.String(16, y, line);
      y += 8;
    }

    y += 8;

    for (const line of FrameProfiler.lines) {
      Draw.String(16, y, line);
      y += 8;
    }
  }
}

export default RenderStats;

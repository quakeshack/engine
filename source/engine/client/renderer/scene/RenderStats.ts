import Draw from '../../Draw.ts';
import Sys from '../../Sys.ts';
import rendererCvars from '../resources/RendererCvars.ts';

/**
 * Counters of what the renderer drew this frame and the `r_speeds` text built from them. The model renderers
 * add to the counters while they draw, `R.RenderView` resets them in front of the scene and summarizes them after.
 */
class RenderStats {
  static c_brush_verts = 0;
  static c_brush_tris = 0;
  static c_brush_draws = 0;
  static c_brush_vbos = 0;
  static c_brush_texture_binds = 0;
  static c_alias_polys = 0;

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
  }

  /**
   * Builds the `r_speeds` lines from the counters of the finished frame.
   * @param frameStartMs `Sys.FloatMilliTime()` taken when the frame started.
   */
  static Summarize(frameStartMs: number): void {
    const c_brush_polys = RenderStats.c_brush_verts / 3;
    const c_alias_polys = RenderStats.c_alias_polys;
    const avgTrisPerDraw = (RenderStats.c_brush_tris / RenderStats.c_brush_draws).toFixed(1);

    RenderStats.lines[0] = `${RenderStats.c_brush_draws.toFixed().padStart(5)} draw calls`;
    RenderStats.lines[1] = `${RenderStats.c_brush_tris.toFixed().padStart(5)} tris, ${RenderStats.c_brush_verts.toFixed().padStart(5)} verts`;
    RenderStats.lines[2] = `${RenderStats.c_brush_vbos.toFixed().padStart(5)} VBOs used, ${RenderStats.c_brush_texture_binds.toFixed().padStart(5)} texture binds`;
    RenderStats.lines[3] = `${c_alias_polys.toFixed().padStart(5)} alias polys, ${c_brush_polys.toFixed().padStart(5)} brush polys`;
    RenderStats.lines[4] = '';
    RenderStats.lines[5] = `Avg ${avgTrisPerDraw} tris/draw, time: ${((Sys.FloatMilliTime() - frameStartMs)).toFixed(1)} msec`;
  }

  /**
   * Draws the frame rate and the `r_speeds` lines when `r_speeds` is on.
   * @param fps Frames per second to show.
   */
  static Print(fps: number): void {
    if (!rendererCvars.speeds.value) {
      return;
    }

    Draw.String(16, 16, `${fps.toFixed(1)} FPS`, 2.0);

    for (let i = 0; i < RenderStats.lines.length; i++) {
      Draw.String(16, 40 + i * 8, RenderStats.lines[i]);
    }
  }
}

export default RenderStats;

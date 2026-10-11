/* eslint-disable @typescript-eslint/unbound-method -- handing the methods of the new classes to a test is the point of this file */
import ConsoleOverlay from '../../source/engine/client/ConsoleOverlay.ts';
import ScreenFrame from '../../source/engine/client/screen/ScreenFrame.ts';
import Screenshots from '../../source/engine/client/screen/Screenshots.ts';
import Viewport from '../../source/engine/client/view/Viewport.ts';
import viewCvars from '../../source/engine/client/view/ViewCvars.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';

/**
 * What a test that was written against the screen as one facade can still set and read, mapped to the classes the
 * screen is made of now: the frame, the viewport, the console slide, the center print and the screenshots. The
 * engine's own parts import those classes directly; this is how `engineMocks.SCR = {...}` finds them.
 */
export const screenFacade = {
  get UpdateScreen(): () => void {
    return ScreenFrame.Update;
  },
  set UpdateScreen(value: () => void) {
    ScreenFrame.Update = value;
  },

  get BeginLoadingPlaque(): () => void {
    return ScreenFrame.BeginLoadingPlaque;
  },
  set BeginLoadingPlaque(value: () => void) {
    ScreenFrame.BeginLoadingPlaque = value;
  },

  get EndLoadingPlaque(): () => void {
    return ScreenFrame.EndLoadingPlaque;
  },
  set EndLoadingPlaque(value: () => void) {
    ScreenFrame.EndLoadingPlaque = value;
  },

  get con_current(): number {
    return ConsoleOverlay.current;
  },
  set con_current(value: number) {
    ConsoleOverlay.current = value;
  },

  get recalc_refdef(): boolean {
    return Viewport.invalidated;
  },
  set recalc_refdef(value: boolean) {
    Viewport.invalidated = value;
  },

  get viewsize(): Cvar {
    return viewCvars.viewsize;
  },
  set viewsize(value: Cvar) {
    viewCvars.viewsize = value;
  },

  get fov(): Cvar {
    return viewCvars.fov;
  },
  set fov(value: Cvar) {
    viewCvars.fov = value;
  },

  get screenshotClean(): boolean {
    return Screenshots.cleanRequested;
  },
  set screenshotClean(value: boolean) {
    Screenshots.cleanRequested = value;
  },
};

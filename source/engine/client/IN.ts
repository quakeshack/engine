import { K } from '../../shared/Keys.ts';
import Cvar from '../common/Cvar.ts';
import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import { kbutton, kbuttons } from './ClientInput.ts';
import { KeyDestination } from './Key.ts';
import VID from './VID.ts';

/** Browser-derived signals used to decide whether mobile play needs external input devices. */
export interface MobileInputEnvironment {
  readonly userAgent?: string | null;
  readonly userAgentDataMobile?: boolean | null;
  readonly maxTouchPoints?: number | null;
  readonly matchMedia?: ((query: string) => { readonly matches: boolean } | MediaQueryList | null) | null;
}

/** Snapshot of the current mobile input support state. */
export interface MobileInputSupportState {
  readonly isMobileDevice: boolean;
  readonly hasTouchInput: boolean;
  readonly hasFinePointer: boolean;
  readonly hasKeyboardActivity: boolean;
  readonly hasMouseActivity: boolean;
}

/**
 * Safely evaluates a media query from the provided browser-like environment.
 * @returns True when the query matches.
 */
function matchesMediaQuery(environment: MobileInputEnvironment, query: string): boolean {
  const matchMedia = environment.matchMedia;

  if (matchMedia === undefined || matchMedia === null) {
    return false;
  }

  const result = matchMedia(query);
  return result !== null && result.matches;
}

/**
 * Detects mobile user agents that should receive the external-input warning.
 * @returns True when the user agent looks mobile.
 */
function isMobileUserAgent(userAgent: string | null | undefined): boolean {
  if (userAgent === undefined || userAgent === null) {
    return false;
  }

  return /android|iphone|ipad|ipod|mobile/i.test(userAgent);
}

/**
 * Detect whether the browser identifies itself as a mobile device.
 * @returns True when the environment is mobile.
 */
function detectMobileDevice(environment: MobileInputEnvironment): boolean {
  if (environment.userAgentDataMobile === true) {
    return true;
  }

  return isMobileUserAgent(environment.userAgent);
}

/**
 * Detect whether touch-first input is available.
 * @returns True when touch input is present.
 */
function detectTouchInput(environment: MobileInputEnvironment): boolean {
  return (environment.maxTouchPoints ?? 0) > 0
    || matchesMediaQuery(environment, '(any-pointer: coarse)')
    || matchesMediaQuery(environment, '(pointer: coarse)');
}

/**
 * Detect whether a fine pointer such as a mouse is available.
 * @returns True when a fine pointer is present.
 */
function detectFinePointer(environment: MobileInputEnvironment): boolean {
  return matchesMediaQuery(environment, '(any-pointer: fine)')
    || matchesMediaQuery(environment, '(pointer: fine)');
}

/**
 * Collect the current browser input signals needed for mobile input support checks.
 * @returns The current browser input environment.
 */
function getBrowserMobileInputEnvironment(): MobileInputEnvironment {
  const navigatorValue = globalThis.navigator as (Navigator & {
    readonly userAgentData?: {
      readonly mobile?: boolean;
    };
  }) | undefined;

  return {
    userAgent: navigatorValue?.userAgent ?? null,
    userAgentDataMobile: typeof navigatorValue?.userAgentData?.mobile === 'boolean'
      ? navigatorValue.userAgentData.mobile
      : null,
    maxTouchPoints: navigatorValue?.maxTouchPoints ?? null,
    matchMedia: typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia.bind(globalThis)
      : null,
  };
}

/**
 * Build the initial mobile input support snapshot from browser signals.
 * @returns Initial support state.
 */
export function createMobileInputSupportState(environment: MobileInputEnvironment): MobileInputSupportState {
  return {
    isMobileDevice: detectMobileDevice(environment),
    hasTouchInput: detectTouchInput(environment),
    hasFinePointer: detectFinePointer(environment),
    hasKeyboardActivity: false,
    hasMouseActivity: false,
  };
}

/**
 * Refresh browser-derived input capabilities while preserving observed activity.
 * @returns Updated support state.
 */
export function refreshMobileInputSupportState(
  state: MobileInputSupportState,
  environment: MobileInputEnvironment,
): MobileInputSupportState {
  return {
    ...state,
    isMobileDevice: detectMobileDevice(environment),
    hasTouchInput: detectTouchInput(environment),
    hasFinePointer: detectFinePointer(environment),
  };
}

/**
 * Record that the user has provided keyboard input.
 * @returns Updated support state.
 */
export function markKeyboardActivity(state: MobileInputSupportState): MobileInputSupportState {
  if (state.hasKeyboardActivity) {
    return state;
  }

  return {
    ...state,
    hasKeyboardActivity: true,
  };
}

/**
 * Record that the user has provided mouse movement.
 * @returns Updated support state.
 */
export function markMouseActivity(state: MobileInputSupportState): MobileInputSupportState {
  if (state.hasMouseActivity) {
    return state;
  }

  return {
    ...state,
    hasMouseActivity: true,
  };
}

/**
 * Determine whether the current state has usable mouse support.
 * @returns True when mouse support is available.
 */
export function hasMouseSupport(state: MobileInputSupportState): boolean {
  return state.hasFinePointer || state.hasMouseActivity;
}

/**
 * Decide whether the mobile external-input warning should currently be shown.
 * @returns True when the warning should be visible.
 */
export function shouldShowMobileExternalInputWarning(state: MobileInputSupportState): boolean {
  if (!state.isMobileDevice || !state.hasTouchInput) {
    return false;
  }

  return !state.hasKeyboardActivity || !hasMouseSupport(state);
}

let { CL, COM, Con, Host, Key, M, V } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Con, Host, Key, M, V } = getClientRegistry());
});

export default class IN {
  static mouse_x = 0.0;
  static mouse_y = 0.0;
  static old_mouse_x = 0.0;
  static old_mouse_y = 0.0;
  static m_filter: Cvar;
  static mouse_avail = false;
  static mobileInputSupport: MobileInputSupportState | null = null;
  static #mobileInputCapabilitySubscriptions: Array<() => void> = [];

  /**
   * True while a `document.exitPointerLock()` call below is in flight -- the resulting
   * `pointerlockchange` event fires asynchronously, after this has already returned, so
   * `onpointerlockchange` needs a way to tell "we asked for this" apart from an unrelated loss of
   * lock (physical Escape, tab switch) it needs to compensate for. See its comment for why that
   * distinction matters.
   */
  static #voluntaryUnlock = false;

  static readonly #mobileUnsupportedNoticeId = 'mobile-external-input';
  static readonly #mobileUnsupportedNotice = [
    'Playing on a mobile phone without a keyboard',
    'and mouse is currently not supported.',
    '',
    'Connect a keyboard and mouse to your phone',
    'to play QuakeShack.',
  ].join('\n');
  static readonly #mobileInputMediaQueries = Object.freeze([
    '(any-pointer: coarse)',
    '(pointer: coarse)',
    '(any-pointer: fine)',
    '(pointer: fine)',
  ] as const);

  static StartupMouse(): void {
    IN.m_filter = new Cvar('m_filter', '1', Cvar.FLAG.ARCHIVE);
    if (COM.CheckParm('-nomouse')) {
      return;
    }
    if (!VID.mainwindow.requestPointerLock) {
      Con.PrintWarning('IN.StartupMouse: Pointer Lock API (requestPointerLock) not available, cannot make use of mouse movement\n');
      return;
    }

    VID.mainwindow.addEventListener('click', IN.onclick);
    document.addEventListener('mousemove', IN.onmousemove);
    document.addEventListener('pointerlockchange', IN.onpointerlockchange);
    IN.mouse_avail = true;
  }

  static Init(): void {
    IN.StartupMouse();
    IN.#subscribeToMobileInputCapabilityChanges();
    IN.#refreshMobileInputSupportFromEnvironment();
  }

  static Shutdown(): void {
    M.ClearOverlayNotice(IN.#mobileUnsupportedNoticeId);
    IN.mobileInputSupport = null;
    IN.#clearMobileInputCapabilitySubscriptions();

    if (!IN.mouse_avail) {
      return;
    }

    VID.mainwindow.removeEventListener('click', IN.onclick);
    document.removeEventListener('mousemove', IN.onmousemove);
    document.removeEventListener('pointerlockchange', IN.onpointerlockchange);
  }

  static MouseMove(): void {
    if (!IN.mouse_avail) {
      return;
    }

    let mouseX: number;
    let mouseY: number;
    if (IN.m_filter.value !== 0) {
      mouseX = (IN.mouse_x + IN.old_mouse_x) * 0.5;
      mouseY = (IN.mouse_y + IN.old_mouse_y) * 0.5;
    } else {
      mouseX = IN.mouse_x;
      mouseY = IN.mouse_y;
    }
    IN.old_mouse_x = IN.mouse_x;
    IN.old_mouse_y = IN.mouse_y;
    mouseX *= CL.sensitivity.value;
    mouseY *= CL.sensitivity.value;

    const strafe = kbuttons[kbutton.strafe].state & 1;
    const mlook = kbuttons[kbutton.mlook].state & 1;
    const angles = CL.state.viewangles;

    if (strafe !== 0 || (CL.lookstrafe.value !== 0 && mlook !== 0)) {
      CL.state.cmd.sidemove += CL.m_side.value * mouseX;
    } else {
      angles[1] -= CL.m_yaw.value * mouseX;
    }

    if (mlook !== 0) {
      V.StopPitchDrift();
    }

    if (mlook !== 0 && strafe === 0) {
      angles[0] += CL.m_pitch.value * mouseY;
      if (angles[0] > 80.0) {
        angles[0] = 80.0;
      } else if (angles[0] < -70.0) {
        angles[0] = -70.0;
      }
    } else if (strafe !== 0 && Host.noclip_anglehack) {
      CL.state.cmd.upmove -= CL.m_forward.value * mouseY;
    } else {
      CL.state.cmd.forwardmove -= CL.m_forward.value * mouseY;
    }

    IN.mouse_x = 0;
    IN.mouse_y = 0;
  }

  static Move(): void {
    // do not interpret input during demo playback
    if (CL.cls.demoplayback) {
      return;
    }

    IN.MouseMove();
  }

  static onclick(this: void): void {
    // Only capture the pointer for mouselook during actual, connected gameplay — clicking the
    // canvas to interact with the menu, message input, or the drop-down console (which can be
    // open on top of gameplay) must not lock/hide the cursor. `Key.destination` alone isn't
    // enough here: it also reads `game` while disconnected with no menu open (e.g. right after
    // closing it), which shouldn't capture the mouse either.
    if (Key.destination === KeyDestination.game && !Con.isOpen
      && CL.cls.state === clientConnectionState.connected
      && document.pointerLockElement !== VID.mainwindow) {
      void VID.mainwindow.requestPointerLock();
    }
  }

  /** Releases the pointer lock, if held, so mouselook doesn't fight for input focus with a UI overlay. */
  static ReleasePointerLock(): void {
    if (document.pointerLockElement === VID.mainwindow) {
      IN.#voluntaryUnlock = true;
      document.exitPointerLock();
    }
  }

  static onmousemove(this: void, event: MouseEvent): void {
    if (document.pointerLockElement !== VID.mainwindow) {
      return;
    }

    IN.NoteMouseActivity();
    IN.mouse_x += event.movementX;
    IN.mouse_y += event.movementY;
  }

  static onpointerlockchange(this: void): void {
    if (document.pointerLockElement === VID.mainwindow) {
      return;
    }

    // Losing pointer lock because we ourselves called ReleasePointerLock() (e.g. opening a menu)
    // is not a physical Escape press to compensate for -- synthesizing one here would immediately
    // close whatever we just opened, since Key.destination has already moved on to it by the time
    // this (necessarily async) event fires.
    if (IN.#voluntaryUnlock) {
      IN.#voluntaryUnlock = false;
      return;
    }

    Key.Event(K.ESCAPE, true);
    Key.Event(K.ESCAPE, false);
  }

  static NoteKeyboardActivity(): void {
    IN.#updateMobileInputSupport(markKeyboardActivity);
  }

  static NoteMouseActivity(): void {
    IN.#updateMobileInputSupport(markMouseActivity);
  }

  static #updateMobileInputSupport(
    update: (state: MobileInputSupportState) => MobileInputSupportState,
  ): void {
    const currentState = IN.mobileInputSupport ?? createMobileInputSupportState(getBrowserMobileInputEnvironment());
    IN.mobileInputSupport = update(currentState);
    IN.#refreshMobileInputSupportFromEnvironment();
  }

  /**
   * Refresh browser-derived input capabilities while preserving observed activity.
   */
  static #refreshMobileInputSupportFromEnvironment(): void {
    const environment = getBrowserMobileInputEnvironment();

    IN.mobileInputSupport = IN.mobileInputSupport === null
      ? createMobileInputSupportState(environment)
      : refreshMobileInputSupportState(IN.mobileInputSupport, environment);
    IN.#syncMobileInputWarning();
  }

  /**
   * Subscribe to pointer-capability media queries so newly attached mice update the warning state.
   */
  static #subscribeToMobileInputCapabilityChanges(): void {
    IN.#clearMobileInputCapabilitySubscriptions();

    if (typeof globalThis.matchMedia !== 'function') {
      return;
    }

    for (const query of IN.#mobileInputMediaQueries) {
      const mediaQueryList = globalThis.matchMedia(query);
      const handleChange = (): void => {
        IN.#refreshMobileInputSupportFromEnvironment();
      };

      if (typeof mediaQueryList.addEventListener === 'function') {
        mediaQueryList.addEventListener('change', handleChange);
        IN.#mobileInputCapabilitySubscriptions.push(() => {
          mediaQueryList.removeEventListener('change', handleChange);
        });
        continue;
      }

      const legacyMediaQueryList = mediaQueryList as MediaQueryList & {
        addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
        removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      };

      if (
        typeof legacyMediaQueryList.addListener === 'function'
        && typeof legacyMediaQueryList.removeListener === 'function'
      ) {
        legacyMediaQueryList.addListener(handleChange);
        IN.#mobileInputCapabilitySubscriptions.push(() => {
          legacyMediaQueryList.removeListener!(handleChange);
        });
      }
    }
  }

  /**
   * Remove any media-query listeners registered for mobile input capability changes.
   */
  static #clearMobileInputCapabilitySubscriptions(): void {
    for (const unsubscribe of IN.#mobileInputCapabilitySubscriptions) {
      unsubscribe();
    }

    IN.#mobileInputCapabilitySubscriptions.length = 0;
  }

  static #syncMobileInputWarning(): void {
    if (IN.mobileInputSupport !== null && shouldShowMobileExternalInputWarning(IN.mobileInputSupport)) {
      M.SetOverlayNotice(IN.#mobileUnsupportedNoticeId, IN.#mobileUnsupportedNotice);
      return;
    }

    M.ClearOverlayNotice(IN.#mobileUnsupportedNoticeId);
  }
}

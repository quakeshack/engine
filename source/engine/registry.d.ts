import type WebSocketClass from 'ws';
import type _Con from './common/Console.mjs';
import type _Com from './common/Com.mjs';
import type _Sys from './common/Sys.mjs';
import type _Host from './common/Host.mjs';
import type _V from './client/V.mjs';
import type _NET from './network/Network.mjs';
import type _SV from './server/Server.mjs';
import type _PF from './server/ProgsAPI.mjs';
import type _PR from './server/Progs.mjs';
import type _Mod from './common/Mod.mjs';
import type _CL from './client/CL.mjs';
import type _SCR from './client/SCR.mjs';
import type _R from './client/R.mjs';
import type _Draw from './client/Draw.mjs';
import type _Key from './client/Key.mjs';
import type _Sbar from './client/Sbar.mjs';
import type _S from './client/Sound.mjs';
import type _M from './client/Menu.mjs';
import type _IN from './client/IN.mjs';

type Con = typeof _Con;
type Com = typeof _Com;
type Sys = typeof _Sys;
type Host = typeof _Host;
type V = typeof _V;
type NET = typeof _NET;
type SV = typeof _SV;
type PF = typeof _PF;
type PR = typeof _PR;
type Mod = typeof _Mod;
type CL = typeof _CL;
type SCR = typeof _SCR;
type R = typeof _R;
type Draw = typeof _Draw;
type Key = typeof _Key;
type Sbar = typeof _Sbar;
type S = typeof _S;
type M = typeof _M;
type IN = typeof _IN;
type WebSocket = typeof WebSocketClass;

interface Registry {
  isDedicatedServer: boolean | null;

  COM: Com | null;
  Con: Con | null;
  Host: Host | null;
  Sys: Sys | null;
  V: V | null;
  SV: SV | null;
  PR: PR | null;
  NET: NET | null;
  Mod: Mod | null;
  PF: PF | null;
  CL: CL | null;
  SCR: SCR | null;
  R: R | null;
  Draw: Draw | null;
  Key: Key | null;
  IN: IN | null;
  Sbar: Sbar | null;
  S: S | null;
  M: M | null;

  WebSocket: WebSocket | null;
};

export const registry: Registry;

import type ConClass from './common/Console.mjs';
import type ComClass from './common/Com.mjs';
import type CmdClass from './common/Cmd.mjs';
import type SysClass from './common/Sys.mjs';
import type HostClass from './common/Host.mjs';
import type VClass from './frontend/V.mjs';
import type NETClass from './network/Network.mjs';
import type SVClass from './network/Server.mjs';
import type PRClass from './server/Progs.mjs';
import type ModClass from './common/Mod.mjs';

import type WebSocketClass from 'ws';

type Con = typeof ConClass;
type Com = typeof ComClass;
type Cmd = typeof CmdClass;
type Sys = typeof SysClass;
type Host = typeof HostClass;
type V = typeof VClass;
type NET = typeof NETClass;
type SV = typeof SVClass;
type PR = typeof PRClass;
type Mod = typeof ModClass;
type WebSocket = typeof WebSocketClass;

interface Registry {
  COM: Com | null;
  Con: Con | null;
  Host: Host | null;
  Cmd: Cmd | null;
  Sys: Sys | null;
  V: V | null;
  CL: any;
  SV: SV | null;
  PR: PR | null;
  NET: NET | null;
  Mod: Mod | null;
  Draw: any;
  isDedicatedServer: boolean | null;
  WebSocket: WebSocket | null;
}

export const registry: Registry;

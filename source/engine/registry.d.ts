import type ConClass from './common/Console.mjs';
import type ComClass from './common/Com.mjs';
import type CmdClass from './common/Cmd.mjs';
import type SysClass from './common/Sys.mjs';
import type HostClass from './common/Host.mjs';
import type VClass from './frontend/V.mjs';
import type NETClass from './network/Network.mjs';
import type SVClass from './network/Server.mjs';

type Con = typeof ConClass;
type Com = typeof ComClass;
type Cmd = typeof CmdClass;
type Sys = typeof SysClass;
type Host = typeof HostClass;
type V = typeof VClass;
type NET = typeof NETClass;
type SV = typeof SVClass;

interface Registry {
  COM: Com | null;
  Con: Con | null;
  Host: Host | null;
  Cmd: Cmd | null;
  Sys: Sys | null;
  V: V | null;
  CL: any;
  SV: SV | null;
  NET: NET | null;
  Draw: any;
  Mod: any;
  isDedicatedServer: boolean | null;
}

export const registry: Registry;

import { eventBus, registry } from './registry.mjs';

// eslint-disable-next-line no-unused-vars
let { CDAudio, CL, COM, Chase, Con, Draw, Host, IN, Key, M, Mod, NET, PR, R, S, SCR, SV, Sbar, Sys, V } = registry;

eventBus.subscribe('registry.frozen', () => {
  CDAudio = registry.CDAudio;
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Draw = registry.Draw;
  Host = registry.Host;
  IN = registry.IN;
  Key = registry.Key;
  M = registry.M;
  Mod = registry.Mod;
  NET = registry.NET;
  PR = registry.PR;
  R = registry.R;
  S = registry.S;
  SCR = registry.SCR;
  SV = registry.SV;
  Sbar = registry.Sbar;
  Sys = registry.Sys;
  V = registry.V;
});

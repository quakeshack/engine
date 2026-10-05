# Bring CL.ts in line with current coding standards

## Status

✅ Done. All 9 findings addressed: dead code and the `active`/`cshift` aliases removed,
`IdentityCvars` deduplicated, `PredictUsercmd`'s redundant JSDoc removed, self-reference style
converted to `CL.` (the 7 remaining `this.` usages are legitimate `ConsoleCommand` instance
properties — `this.client`/`this.args` — not the static self-reference this item targeted),
`Rcon_f` renamed to `RconCommand`, and `SetUpPlayerPrediction` test coverage added
(`test/client/cl.test.mjs`). Item 9 (`padStart(0, ...)` no-op) went further than planned — fixed
outright as `padStart(3, ' ')` rather than left as a `// TODO`. Verified via grep against the
current tree; no outstanding diff.

## Context

`source/engine/client/CL.ts` (620 lines) is already shaped the way we want facade classes to
look: it's a thin static class that delegates to purpose-built collaborators
(`ClientConnection`, `ClientLifecycle`, `ClientDemos`, `clientRuntimeState`/`clientStaticState`)
rather than being a god-object. `eslint` is clean on the file and there's existing test coverage
in `test/client/cl.test.mjs` for the trickiest logic (`PredictMove`, `PredictUsercmd`). The
overall architecture doesn't need to change.

What's drifted is smaller, file-local hygiene — mostly things called out explicitly in
`.github/instructions/code-style-guide.instructions.md` and
`.github/instructions/typescript-port.instructions.md` that were fine when written but didn't
get swept up as newer conventions solidified elsewhere in the client (`V.ts`, `SCR.ts`,
`ClientConnection.ts`).

### Findings (verified against the current tree)

1. **Dead commented-out code** (style guide: "Do NOT use for: ... commented-out code").
   - `CL.ts:16` — a commented-out import of `materialFlags, PBRMaterial, QuakeMaterial`.
   - `CL.ts:347-359` — a ~13-line commented-out experiment in `ClientFrame()` (render-to-texture
     playground code), tagged `// CR: playing around with rendering into textures`.
   - `CL.ts:317` — a commented-out `Draw.String(x0, y0, 'Connecting', 2.0);` call in `Draw()`.
2. **Dead `@deprecated` alias**: `static active = Def.clientConnectionState;` (line 29) has zero
   references anywhere in `source/` outside its own declaration. It should just be deleted.
3. **Unfinished `@deprecated` migration**: `static cshift = Def.contentShift;` (line 26) is
   tagged `@deprecated – use Def.contentShift`, but `CL.cshift` is still the *only* form used —
   16+ call sites in `V.ts` (`CL.cshift.damage`, `.bonus`, `.powerup`, `.user1`, `.contents`)
   all go through the deprecated alias. The deprecation was never followed through anywhere.
4. **Redundant JSDoc block**: `PredictUsercmd`'s JSDoc (lines 541-546) is a `@param {Type} name`
   list that only restates the already-explicit TS parameter types, with no added description —
   exactly what typescript-port checklist item 3 says to remove.
5. **Duplicated type instead of a shared import**: `ConfigureConnectionIdentity` (line 132)
   declares its parameter as an inline object-literal type
   `{ name: Cvar | null; color: Cvar | null; rcon_password: Cvar | null }`, which is a verbatim
   duplicate of `IdentityCvars`, already defined and exported-worthy in `ClientConnection.ts:14`.
   CL.ts should import and reuse that type instead of re-declaring the shape.
6. **Inconsistent self-reference style within the same file**. Most of `CL.ts` refers to its own
   static members via `CL.foo` (matching `V.ts` and `SCR.ts`, which use the class name
   exclusively — zero `this.` usages in either file). But the newer prediction-related block
   (`Draw`, `DrawHUD`, `ClientFrame`, `PredictMove`, `PredictUsercmd`, `SetUpPlayerPrediction`,
   `#setupPredictionPhysents`) exclusively uses `this.foo`. Both work at runtime (static context),
   but the split reads as two authors/eras in one file. Worth standardizing on `CL.` to match the
   rest of the file and its sibling facade classes.
7. **Anonymous class breaks a local naming convention**: 7 of the 8 `ConsoleCommand` subclasses
   assigned to static fields (`Stop_f`, `Record_f`, `StartDemos_f`, `Demos_f`, `StopDemo_f`,
   `PlayDemo_f`, `TimeDemo_f`) are named class expressions (`class StopRecordingCommand extends
   ConsoleCommand`). `Rcon_f` (line 281) is the odd one out — an anonymous `class extends
   ConsoleCommand`. Should be named `RconCommand` for consistency and clearer stack traces.
8. **Untested branches**: `SetUpPlayerPrediction()` (and the physents setup it calls,
   `#setupPredictionPhysents()`) has no test coverage at all, despite being physics-adjacent
   logic in the same family as `PredictMove`/`PredictUsercmd` (which *are* tested) and having sat
   near recent jitter-fix commits. `ConfigureConnectionIdentity`, `ServerInfo_f`, and
   `MoveAround_f` are also untested, though lower priority — they're thin console-facing wrappers.
9. **Minor correctness nit spotted in passing** (not a structure issue, flagging since we'll be
   in the neighborhood): `Draw()` line 322 does `p.toFixed(0).padStart(0, ' ')` — `padStart(0, …)`
   is a permanent no-op (target length 0 is never greater than the string's own length). Looks
   like a leftover from an intended fixed-width percentage display. Will leave as a `// TODO`
   comment rather than guess the intended width, unless the user confirms one.

### Non-issues (checked, but not worth touching)

- `Cvar = null!` field declarations (17 of them) — this matches the established pattern used
  throughout `V.ts` and other facade classes for cvars registered later during `Init()`. Not a
  deviation.
- The `ConsoleCommand`-subclass pattern for `Stop_f`/`Record_f`/etc. vs. the plain-static-function
  pattern used by `V.cshift_f` — both are legitimate; `Cmd.AddCommand` supports either, and CL's
  commands need `this.client`/`this.args` from `ConsoleCommand`, which the plain-function form
  doesn't get.
- The static method `Draw()` sharing a name with the module-level `Draw` import — reads oddly out
  of context but mirrors original Quake's `CL_Draw` calling into the separate `Draw_*` subsystem;
  long-standing and consistent with how the rest of the engine names things.

## Goals

- Remove dead/commented-out code (items 1-2).
- Finish the `cshift` deprecation: point `V.ts` at `Def.contentShift` directly, then delete the
  `CL.cshift` alias (item 3).
- Clean up the redundant JSDoc and the duplicated `IdentityCvars` shape (items 4-5).
- Standardize self-reference style on `CL.` across the whole file (item 6).
- Name the `Rcon_f` class expression (item 7).
- Add unit tests for `SetUpPlayerPrediction` covering its guard branches: `nopred`/`demoplayback`
  short-circuit, no `playerentity`, and the worldmodel-not-yet-set path (item 8).
- Leave a `// TODO` on the `padStart(0, ...)` no-op rather than silently changing behavior (item 9).

## Non-goals

- No behavior changes to prediction, networking, or demo playback — this is a hygiene pass, not a
  refactor of what `CL.ts` does.
- Not touching `ClientConnection.ts`'s `IdentityCvars` beyond exporting it (it's also declared as
  a `type` rather than an `interface`, which is a similar-flavor nit, but converting it and
  auditing that whole file is a separate, larger piece of follow-up work — out of scope here).
- Not chasing the `this.` vs. `ClassName.` inconsistency into other files (`Host.ts` mixes both
  extensively). Scoped to `CL.ts` only, since that's what was asked about.

## Plan

1. Delete the two commented-out code blocks and the dead `active` alias.
2. Grep every `CL.cshift` call site (all in `V.ts`), switch them to `Def.contentShift`, delete the
   `cshift` alias from `CL.ts`, drop the now-unused `Def` import if nothing else in `CL.ts` needs it.
3. Export `IdentityCvars` from `ClientConnection.ts` and import it in `CL.ts` for
   `ConfigureConnectionIdentity`'s parameter type; delete the inline duplicate.
4. Remove the redundant JSDoc block on `PredictUsercmd`.
5. Sweep `Draw`, `DrawHUD`, `ClientFrame`, `PredictMove`, `PredictUsercmd`,
   `SetUpPlayerPrediction`, `#setupPredictionPhysents` to use `CL.` instead of `this.`.
6. Rename the `Rcon_f` anonymous class expression to `RconCommand`.
7. Add a `// TODO` comment on the `padStart(0, ...)` call explaining it's currently a no-op.
8. Add `describe('CL.SetUpPlayerPrediction', ...)` tests in `test/client/cl.test.mjs` for the
   guard branches listed above.
9. Run `npx eslint --fix source/engine/client/CL.ts source/engine/client/V.ts
   source/engine/client/ClientConnection.ts`, then `npm run test:common` (or the narrower
   `node --test test/client/cl.test.mjs test/client/client-connection.test.mjs`) and confirm green.

## Testing

- No UI/browser verification needed — this touches no rendering behavior, only internal
  structure, dead code removal, and one alias migration. Existing + new `node --test` coverage
  is sufficient.

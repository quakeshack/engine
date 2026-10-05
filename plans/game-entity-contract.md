# One compiler-checked contract for entities between the engine and game modules

Status: stub. Not started. It follows [game-module-contract.md](game-module-contract.md), which made
the game API classes compiler-checked and left the entity side out on purpose. Nothing here is a
decision yet; it records what was found so the design starts from facts.

## Context

Researched 2026-09-19 while writing `game-module-contract.md`.

- The engine reaches a game's entities through `ServerEdict.entity`, typed as a hand-written
  `BaseEntity` interface in [Edict.ts](../source/engine/server/Edict.ts). It carries a
  `FIXME: we should improve this interface and make the actual BaseEntity implement it`.
- The game's own `BaseEntity` class ([id1 BaseEntity.ts](../source/game/id1/entity/BaseEntity.ts))
  declares no `implements`. The two are bridged by casts: `ServerGameAPI.prepareEntity` in
  [id1 GameAPI.ts](../source/game/id1/GameAPI.ts) uses `edict.entity as unknown as BaseEntity`
  and `edict as unknown as MutableServerEdict`.
- The type graph leaks in both directions (type-only imports):
  - engine → game: `Edict.ts` imports `WorldspawnEntity` from `game/id1/entity/Worldspawn.ts`, so
    the engine names a concrete game. What the engine actually reads from the worldspawn entity is
    small (`ServerMessages.ts` declares a local `WorldspawnMessageEntity` with `message` and
    `sounds`).
  - game → engine: `id1/entity/BaseEntity.ts` imports `ServerEdict` from `engine/server/Edict.ts`
    and casts `this.edict! as RuntimeServerEdict` at several call sites.
- The engine calls into entities (`think`, `touch`, `use`, `blocked`, `spawn`, ...) and reads or
  writes plain fields (`origin`, `velocity`, `movetype`, `solid`, ...). That is what the engine-side
  interface declares, without documenting who writes what or when.
- Not yet looked at: whether the client-side entity handlers (`BaseClientEdictHandler`) have the
  same kind of gap.

## Goals (draft)

1. What the engine expects of an entity lives in one shared interface under `source/shared/`,
   with JSDoc saying who reads or writes each member and when.
2. The game's `BaseEntity` declares `implements` on it, so `npm run typecheck` reports drift.
3. No `as unknown as` at the boundary, no engine import of a concrete game's type, and no game
   import of an engine file for edict types.

## Non-goals (draft)

- Redesigning the entity classes, changing runtime behavior, or touching the savegame format.

## Open questions

- Where does the shared entity interface live: in `GameInterfaces.ts` or a file of its own?
- How is `ServerEdict.entity` typed so both sides agree without the engine naming a game: a shared
  interface, or a generic edict type?
- Which of the optional hooks (`think?`, `touch?`, `use?`, `blocked?`) stay optional, and which
  members does the engine really write?
- Does the client-side entity handler boundary get the same treatment in this plan or its own?

## Phasing

To be written once the open questions are answered, following the `plan-first-workflow` skill.

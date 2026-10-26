## Event Bus

`eventBus` carries lifecycle and business-logic events between modules that must not import each other and across workers; not direct calls, return values or hot paths. Buses, lifetimes and every event: `docs/events.md`.

- **Every event is documented** (engine: `docs/events.md`, a game's own: `source/game/<mod>/docs/events.md`) and engine events are typed in `source/shared/EngineEvents.ts`. When an event changes, follow `event-bus-docs-sync`.
- **Per-connection buses are wiped** (`unsubscribeAll()` on every disconnect and map load, no exceptions); game code relies on it. Use `moduleEventBus` only for a listener set up once in `Init()` that must survive reconnects or maps.

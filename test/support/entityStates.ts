import type BaseEntity from '../../source/game/id1/entity/BaseEntity.ts';
import type { EntityStateDefinition } from '../../source/game/id1/entity/BaseEntity.ts';

/**
 * The animation states an entity class defined in `_initStates()`.
 * @param entityClass The class, after its `_initStates()` ran.
 * @returns The state table, by state name.
 */
export function statesOf(entityClass: abstract new (...args: never[]) => BaseEntity): Readonly<Record<string, EntityStateDefinition>> {
  // `_states` is private static storage of BaseEntity with no public reader; the tests check the graph a class defined.
  return (entityClass as unknown as { _states: Record<string, EntityStateDefinition> })._states;
}

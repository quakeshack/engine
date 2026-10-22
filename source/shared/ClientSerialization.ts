import Vector from './Vector.ts';
import type { SerializedData, SerializedPrimitive, SerializedValue } from './GameInterfaces.ts';

/**
 * A plain value a `BaseClientEdictHandler.serialize()` override may return: the same shapes
 * {@link SerializedValue} can tag, expressed as ordinary JS values instead of `[tag, payload]`
 * tuples.
 */
export type ClientSerializableValue =
  | SerializedPrimitive
  | Vector
  | ClientSerializableValue[]
  | { readonly [key: string]: ClientSerializableValue };

/**
 * Converts plain values to and from the engine's shared `SerializedValue`/`SerializedData` tagged
 * format (`source/shared/GameInterfaces.ts`), for `BaseClientEdictHandler.serialize()`/
 * `deserialize()` overrides. Reuses that same tagged-union wire shape as `BaseEntity`'s
 * server-side `Serializer<T>` so client-only handler state (a die time, a sequence key, nested
 * physics/sequence extras) isn't a third, incompatible save format -- but deliberately supports
 * only the primitive/array/vector/nested-object tags (`'P'`/`'A'`/`'V'`/`'S'`), not all of
 * `SerializedValue`:
 *
 * - No `'E'` (entity reference): a client-only cosmetic handler has no `ServerEdict` to
 *   reference, and resolving a reference to another `ClientEdict` would need an id-indexed pool
 *   plus a two-pass restore (create-all-instances, then deserialize-all) like
 *   `applySavegameEdicts()` provides server-side -- infrastructure nothing here needs yet.
 * - No `'F'` (function-via-`toString()`): this repo's own porting guide already flags
 *   `ScheduledThink.callback`'s `toString()`/`new Function()` round-trip as "a security
 *   concern... fragile... unnecessary" -- the same reasoning applies here, so it's not carried
 *   over.
 * - No `'I'` (signed `Infinity`) or `'X'` (skip marker for `undefined`): a handler's saved extras
 *   (die times, sequence state) are always finite, and an `undefined` value is simply omitted
 *   from the output object rather than round-tripped as a marker.
 *
 * Unlike `BaseEntity`'s `Serializer<T>`, this has no per-instance state and no decorator-driven
 * field collection -- handlers hand-write their `serialize()`/`deserialize()` overrides (see
 * `Particles.SerializeParticles()`'s equally manual style), and only need converting the resulting plain
 * object to and from the wire format.
 */
export default class ClientSerialization {
  /**
   * Converts one plain value into its tagged {@link SerializedValue} form.
   * @returns The tagged value.
   */
  static serializeValue(value: ClientSerializableValue): SerializedValue {
    if (value instanceof Vector) {
      return ['V', value[0], value[1], value[2]];
    }

    if (Array.isArray(value)) {
      return ['A', value.map((item: ClientSerializableValue) => ClientSerialization.serializeValue(item))];
    }

    if (value !== null && typeof value === 'object') {
      return ['S', ClientSerialization.serialize(value)];
    }

    return ['P', value as SerializedPrimitive];
  }

  /**
   * Converts a plain object into a flat, JSON-safe {@link SerializedData} snapshot. Keys whose
   * value is `undefined` are omitted rather than round-tripped as a skip marker.
   * @returns The tagged snapshot.
   */
  static serialize(data: { readonly [key: string]: ClientSerializableValue | undefined }): SerializedData {
    const result: SerializedData = {};

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) {
        continue;
      }

      result[key] = ClientSerialization.serializeValue(value);
    }

    return result;
  }

  /**
   * Converts one tagged {@link SerializedValue} back into a plain value.
   * @returns The plain value.
   */
  static deserializeValue(value: SerializedValue): ClientSerializableValue {
    switch (value[0]) {
    case 'P':
      return value[1];
    case 'A':
      return value[1].map((item) => ClientSerialization.deserializeValue(item));
    case 'V':
      return new Vector(value[1], value[2], value[3]);
    case 'S':
      return ClientSerialization.deserialize(value[1]);
    default:
      console.assert(false, `ClientSerialization does not support the '${value[0]}' tag client-side`);
      return null;
    }
  }

  /**
   * Converts a {@link SerializedData} snapshot back into a plain object.
   * @returns The plain object.
   */
  static deserialize(data: SerializedData): { [key: string]: ClientSerializableValue } {
    const result: { [key: string]: ClientSerializableValue } = {};

    for (const [key, value] of Object.entries(data)) {
      result[key] = ClientSerialization.deserializeValue(value);
    }

    return result;
  }
}

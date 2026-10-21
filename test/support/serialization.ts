/**
 * The field names a class registered with `@serializableObject`, as the decorator left them on the constructor.
 * @param constructor The class.
 * @returns The names, or `undefined` when the class has none of its own.
 */
export function serializableFieldsOf(constructor: abstract new (...args: never[]) => object): readonly string[] | undefined {
  // The decorator defines the property at run time; the game declares the shape in a private interface of its own.
  return (constructor as { serializableFields?: readonly string[] }).serializableFields;
}

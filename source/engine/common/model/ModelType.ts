/**
 * The kind of a model, which decides who draws it and what the game can ask of it. In a file of its own, without imports, so
 * that a model class can name it without pulling in `Mod` and the loaders that import the model classes back.
 */
export enum ModelType {
  brush = 0,
  sprite = 1,
  alias = 2,
  mesh = 3,
  /** Posed by a joint hierarchy and skinned on the CPU: Inter-Quake models. */
  skeletal = 4,
}

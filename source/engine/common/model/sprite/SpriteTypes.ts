/** How a sprite is turned towards the viewer. The numbers are the `type` of a Quake SPR header. */
export enum SpriteOrientation {
  /** Faces the view plane, rotated by the entity's roll. */
  parallelUpright = 0,
  /** Turns around the world's Z axis only, towards the viewer's position. */
  facingUpright = 1,
  /** Faces the view plane, like a particle. */
  parallel = 2,
  /** Uses the entity's own angles and stays where it was put. */
  oriented = 3,
  /** Faces the view plane, rotated by the entity's roll around the view axis. */
  parallelOriented = 4,
}

/** Which pixels of a sprite are drawn and how they are combined with what is behind them. */
export enum SpriteBlend {
  /** Pixels below a quarter alpha are skipped, the rest are opaque (scaled by the entity's alpha). */
  alphaTest = 'alphaTest',
  /** Regular alpha blending. */
  alpha = 'alpha',
  /** Adds the color to what is behind the sprite. */
  additive = 'additive',
}

/** How a sprite's texture is sampled. Without one the sprite follows `gl_texturemode` like other textures. */
export enum SpriteFilter {
  /** Smooth, with mip levels. */
  linear = 'linear',
  /** Hard pixels, for pixel art. */
  nearest = 'nearest',
}

/** In which order a sequence shows its images. */
export enum SpriteDirection {
  forward = 'forward',
  reverse = 'reverse',
  /** Forward, then back again without repeating the end images. */
  pingpong = 'pingpong',
  pingpongReverse = 'pingpongReverse',
}

/** Which clock a sequence follows. */
export enum SpritePhase {
  /** All instances of a model show the same image at the same time. */
  global = 'global',
  /** Each entity gets a random offset when its model is set. */
  random = 'random',
  /** The sequence starts when the entity's model or frame is set. */
  spawn = 'spawn',
}

/** One picture of a sprite, a layer of the sprite's array texture. */
export interface SpriteImage {
  /** Layer in the asset's array texture. */
  readonly layer: number;
  /** Offset of the lower left corner from the entity's origin, in world units. */
  readonly origin: readonly [number, number];
  /** Width in world units (the file's pixels times the sidecar's `scale`). */
  readonly width: number;
  /** Height in world units. */
  readonly height: number;
  /** Width in the pixels of the file, which a {@link SpriteRegion} is counted in. */
  readonly pixelWidth: number;
  /** Height in the pixels of the file. */
  readonly pixelHeight: number;
  /** Share of the layer the image covers, below 1 where it is padded to the size of the largest image. */
  readonly uvScale: readonly [number, number];
}

/** A named rectangle of an image, in the pixels of the file, for drawing a part of a sprite sheet. */
export interface SpriteRegion {
  /** Pixels from the left edge. */
  readonly x: number;
  /** Pixels from the top edge. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Images shown one after the other. */
export interface SpriteSequence {
  /** Empty for sequences that have no name (SPR groups, untagged images). */
  readonly name: string;
  readonly images: readonly SpriteImage[];
  /** Seconds from the start of one play to the end of each image, like the `interval`s of an SPR group. */
  readonly endTimes: Float32Array;
  readonly direction: SpriteDirection;
  /** Number of plays, 0 for forever. A finished sequence holds its final image. */
  readonly repeat: number;
}

/** What an entity's `frame` selects: a single picture or a sequence. */
export type SpriteFrame = SpriteImage | SpriteSequence;

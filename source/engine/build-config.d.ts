/**
 * Build-time environment configuration
 */
export interface BuildConfig {
  /** Build mode (development/production) */
  mode: string;
  /** Build timestamp */
  timestamp: string;
  /** Git commit hash during build */
  commitHash: string | null;

  /** Default game directory override for single-game builds. */
  gameDir: string | null;

  /** Default base directory override used when no `-basedir` argument is set. */
  baseDir: string | null;
};

/**
 * Runtime URL functions that can be passed to the engine
 */
export interface URLs {
  /** Signaling server URL */
  signalingURL?: string;
  /** CDN URL for a file */
  cdnURL?: string;
};

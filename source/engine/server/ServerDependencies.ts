import type { ConsoleCapture, ConsoleOutput, SystemServices } from '../common/Services.ts';
import type { GameEdition } from '../common/GameApiSupport.ts';
import type Vector from '../../shared/Vector.ts';
import type CollisionModelSource from '../common/CollisionModelSource.ts';
import type Mod from '../common/Mod.ts';
import type NET from '../network/Network.ts';

/** The part of the network layer a server talks to: its listening sockets and the sockets of its clients. */
export type ServerNetwork = Pick<NET,
  | 'message'
  | 'time'
  | 'activeconnections'
  | 'listening'
  | 'hostname'
  | 'CheckNewConnections'
  | 'SendMessage'
  | 'SendUnreliableMessage'
  | 'CanSendMessage'
  | 'GetMessage'
  | 'Close'
  | 'GetListenAddress'>;

/** The model cache the server loads its map and models through. */
export type ModelCache = Pick<typeof Mod, 'known' | 'ForName' | 'ForNameAsync' | 'ClearAll'>;

/** What the server needs to know about how a player's view is presented. */
export interface PlayerView {
  /** Roll angle of the view for a player moving sideways. */
  CalcRoll(angles: Vector, velocity: Vector): number;
}

/** Everything a `Server` depends on, handed to it by whoever builds it. */
export interface ServerDependencies {
  readonly con: ConsoleOutput & ConsoleCapture;
  readonly sys: SystemServices;
  readonly net: ServerNetwork;
  readonly mod: ModelCache;
  readonly view: PlayerView;
  /** Resolves models for collision, shared with whoever else needs to see the world. */
  readonly collisionModelSource: CollisionModelSource;
  /** Engine version shown to clients, e.g. `1.2.2+abc123`. */
  readonly engineVersion: () => string;
  /** Where navigation meshes are read from and written to. */
  readonly files: {
    LoadFile(filename: string): Promise<ArrayBuffer | null>;
    WriteFile(filename: string, data: ArrayLike<number>, len: number): Promise<boolean>;
  };
  /** Which edition of the game data is in use, read when a game asks. */
  readonly gameEdition: () => GameEdition;
  /** Whether this is a dedicated server, with no local player. */
  readonly dedicated: boolean;
}

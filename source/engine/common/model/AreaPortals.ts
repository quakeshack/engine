import type { Node } from './BSP.ts';

import { eventBus } from '../../registry.mjs';

export interface PortalDefinition {
  readonly area0: number;
  readonly area1: number;
  readonly group?: number;
}

interface PortalConnection {
  readonly area0: number;
  readonly area1: number;
  readonly group: number;
}

interface AreaAdjacencyEdge {
  readonly target: number;
  readonly group: number;
}

/**
 * Tracks area portal connectivity for brush worlds.
 *
 * Q2-style area portals assign each leaf to an area and use portals to
 * connect pairs of areas. Closing a portal, such as when a door shuts,
 * disconnects the affected areas and blocks sound propagation even when
 * PVS or PHS alone would still relate them.
 *
 * For BSP29 and BSP2 maps that lack explicit area data, every leaf falls
 * into area 0 and connectivity becomes trivially open.
 *
 * A portal can connect one or more area pairs through a shared group id so a
 * single physical door can open or close multiple logical connections.
 */
export class AreaPortals {
  /** Total number of areas in the loaded map. */
  #numAreas = 0;

  /**
   * Per-group open reference count.
   * A group is effectively open whenever its count is greater than zero.
   */
  #portalOpen: number[] = [];

  /** Number of physical portal groups. */
  #numPortals = 0;

  /** Portal connections between area pairs. */
  #connections: PortalConnection[] = [];

  /** Flood-fill reachability signature for each area. */
  #floodNum: number[] = [];

  /** Current flood generation counter. */
  #floodGeneration = 0;

  /** Adjacency list used for flood-fill traversal. */
  #adjacency: AreaAdjacencyEdge[][] = [];

  /**
   * Initializes the area portal graph for a map.
   *
   * Each portal entry can optionally provide a `group` field identifying the
   * physical portal it belongs to. When omitted, the entry gets its own group,
   * matching the older BSP38 behavior.
   */
  init(numAreas: number, portals: PortalDefinition[], numGroups?: number): void {
    this.#numAreas = numAreas;
    this.#connections = [];
    this.#adjacency = Array.from({ length: numAreas }, () => []);

    let calculatedMaxGroup = -1;

    for (let index = 0; index < portals.length; index++) {
      const portal = portals[index];
      const group = portal.group !== undefined ? portal.group : index;

      this.#connections.push({
        area0: portal.area0,
        area1: portal.area1,
        group,
      });

      if (portal.area0 >= 0 && portal.area0 < numAreas && portal.area1 >= 0 && portal.area1 < numAreas) {
        this.#adjacency[portal.area0].push({ target: portal.area1, group });
        this.#adjacency[portal.area1].push({ target: portal.area0, group });
      }

      if (group > calculatedMaxGroup) {
        calculatedMaxGroup = group;
      }
    }

    this.#numPortals = numGroups !== undefined ? numGroups : calculatedMaxGroup + 1;
    this.#portalOpen = new Array(this.#numPortals).fill(0);
    this.#floodNum = new Array(numAreas).fill(0);
    this.#floodGeneration = 0;

    // The server will publish the real state during signon.
    this.closeAll();
  }

  /**
   * Opens every physical portal group.
   */
  openAll(): void {
    this.#portalOpen.fill(1);
    this.#floodAreas();
  }

  /**
   * Closes every physical portal group.
   */
  closeAll(): void {
    this.#portalOpen.fill(0);
    this.#floodAreas();
  }

  /**
   * Updates the open state of a portal group using reference counting.
   * Multiple entities can hold the same physical portal open at once.
   */
  setPortalState(portalNum: number, open: boolean): void {
    if (portalNum < 0 || portalNum >= this.#numPortals) {
      return;
    }

    const wasOpen = this.#portalOpen[portalNum] > 0;

    if (open) {
      this.#portalOpen[portalNum]++;
    } else {
      this.#portalOpen[portalNum] = Math.max(0, this.#portalOpen[portalNum] - 1);
    }

    const isOpen = this.#portalOpen[portalNum] > 0;

    if (wasOpen !== isOpen) {
      this.#floodAreas();
    }
  }

  /**
   * Returns true when two areas are connected through open portals.
   *
   * Area 0 is treated as connected to everything to avoid culling bugs when
   * the camera or entities clip into invalid space.
   * @returns True when the two areas are mutually reachable.
   */
  areasConnected(area0: number, area1: number): boolean {
    if (area0 === area1) {
      return true;
    }

    // Area 0 (outside/solid) remains connected to everything to avoid culling
    // glitches when the camera or entities clip into invalid space.
    if (area0 <= 0 || area0 >= this.#numAreas || area1 <= 0 || area1 >= this.#numAreas) {
      return true;
    }

    const flood0 = this.#floodNum[area0];
    const flood1 = this.#floodNum[area1];
    return flood0 > 0 && flood1 > 0 && flood0 === flood1;
  }

  /**
   * Convenience wrapper that checks connectivity by leaf area ids.
   * @returns True when the two leaf areas are mutually reachable.
   */
  leafsConnected(leaf0: Node, leaf1: Node): boolean {
    return this.areasConnected(leaf0.area, leaf1.area);
  }

  /**
   * Returns true when the portal group is currently open.
   * @returns True when the portal group's open count is above zero.
   */
  isPortalOpen(portalNum: number): boolean {
    if (portalNum < 0 || portalNum >= this.#numPortals) {
      return false;
    }

    return this.#portalOpen[portalNum] > 0;
  }

  get numAreas(): number {
    return this.#numAreas;
  }

  get numPortals(): number {
    return this.#numPortals;
  }

  /**
   * Recomputes reachability by flooding through currently open portal groups.
   * Uses breadth-first traversal to avoid recursion depth issues.
   */
  #floodAreas(): void {
    this.#floodGeneration = 0;
    this.#floodNum.fill(0);

    const queue: number[] = [];

    for (let startArea = 1; startArea < this.#numAreas; startArea++) {
      if (this.#floodNum[startArea] !== 0) {
        continue;
      }

      this.#floodGeneration++;
      const currentFloodId = this.#floodGeneration;
      this.#floodNum[startArea] = currentFloodId;
      queue.push(startArea);

      while (queue.length > 0) {
        const area = queue.shift();

        if (area === undefined) {
          break;
        }

        const neighbors = this.#adjacency[area];

        if (!neighbors) {
          continue;
        }

        for (const edge of neighbors) {
          const isOpen = !(edge.group >= 0 && (edge.group >= this.#numPortals || this.#portalOpen[edge.group] <= 0));

          if (!isOpen) {
            continue;
          }

          if (this.#floodNum[edge.target] !== 0) {
            continue;
          }

          this.#floodNum[edge.target] = currentFloodId;
          queue.push(edge.target);
        }
      }
    }

    this.#emitChangeEvent();
  }

  #emitChangeEvent(): void {
    eventBus.publish('areaportals.changed');
  }
}

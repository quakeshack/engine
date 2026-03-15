import { eventBus } from '../../registry.mjs';

/**
 * Manages area portal state and area connectivity for a BrushModel.
 *
 * Q2-style area portals: each leaf belongs to an area, and portals
 * connect pairs of areas. When a portal is closed (e.g. a door shuts),
 * the two areas become disconnected, blocking sound propagation and
 * optionally visibility even if PVS/PHS say otherwise.
 *
 * For BSP29/BSP2 maps (which lack area data), all leafs are in area 0
 * and everything is trivially connected.
 *
 * Portal groups: a single physical portal (e.g. a door) may separate
 * multiple area pairs when the map has more than one portal. Each
 * connection stores a `group` number identifying its physical portal.
 * The open/close state is tracked per group, so opening one physical
 * portal opens all its connections at once.
 *
 * Usage:
 *   if (phs.isRevealed(leafIndex) && areaPortals.areasConnected(srcArea, dstArea)) { ... }
 */
export class AreaPortals {
  /** @type {number} total number of areas in the map */
  #numAreas = 0;

  /**
   * Per-group open reference count. A group is open when its count > 0.
   * Index = group number (physical portal number).
   * Multiple entities can hold the same portal open.
   * @type {number[]}
   */
  #portalOpen = [];

  /** @type {number} number of groups (physical portals) */
  #numPortals = 0;

  /**
   * Portal connections: each entry connects two areas and belongs to a group.
   * Multiple connections can share the same group (physical portal).
   * @type {{ area0: number, area1: number, group: number }[]}
   */
  #connections = [];

  /**
   * Flood-fill reachability: floodnum[area] after flood.
   * Two areas are connected iff they have the same floodnum and it is > 0.
   * @type {number[]}
   */
  #floodNum = [];

  /** @type {number} current flood generation counter */
  #floodGeneration = 0;

  /**
   * Initialize the area portal system for a given map.
   *
   * Each portal entry may include an optional `group` field identifying
   * the physical portal it belongs to. When omitted, each entry is
   * treated as its own group (backward compatible with BSP38).
   * @param {number} numAreas number of areas (from BSP areas lump or 1 for Q1)
   * @param {{ area0: number, area1: number, group?: number }[]} portals portal definitions
   * @param {number} [numGroups] number of physical portal groups (defaults to portals.length)
   */
  /**
   * Adjacency list for fast graph traversal.
   * Index = area number.
   * Value = array of edges { target: number, group: number }.
   * @type {Array<{ target: number, group: number }[]>}
   */
  #adjacency = [];

  /**
   * Initialize the area portal system for a given map.
   *
   * Each portal entry may include an optional `group` field identifying
   * the physical portal it belongs to. When omitted, each entry is
   * treated as its own group (backward compatible with BSP38).
   * @param {number} numAreas number of areas (from BSP areas lump or 1 for Q1)
   * @param {{ area0: number, area1: number, group?: number }[]} portals portal definitions
   * @param {number} [numGroups] number of physical portal groups (defaults to portals.length)
   */
  init(numAreas, portals, numGroups) {
    this.#numAreas = numAreas;

    // Normalize connections and determine max group
    this.#connections = [];
    let calculatedMaxGroup = -1;

    // Build adjacency list immediately for O(1) edge lookups
    this.#adjacency = Array.from({ length: numAreas }, () => []);

    for (let i = 0; i < portals.length; i++) {
      const p = portals[i];
      const area0 = p.area0;
      const area1 = p.area1;
      const group = p.group !== undefined ? p.group : i; // Default to unique group

      // Store normalized connection (optional, purely for debug/serialization if needed)
      this.#connections.push({ area0, area1, group });

      // Populate adjacency graph (undirected)
      if (area0 >= 0 && area0 < numAreas && area1 >= 0 && area1 < numAreas) {
        this.#adjacency[area0].push({ target: area1, group });
        this.#adjacency[area1].push({ target: area0, group });
      }

      if (group > calculatedMaxGroup) {
        calculatedMaxGroup = group;
      }
    }

    // Determine number of physical portal groups
    this.#numPortals = numGroups !== undefined ? numGroups : (calculatedMaxGroup + 1);

    this.#portalOpen = new Array(this.#numPortals).fill(0);
    this.#floodNum = new Array(numAreas).fill(0);
    this.#floodGeneration = 0;

    // Initially all portals are closed (doors start closed).
    // The server will send the correct state to clients during signon.
    this.closeAll();
  }

  /**
   * Open all portals (reset to fully connected state).
   * This is the default after map load.
   */
  openAll() {
    this.#portalOpen.fill(1);
    this.#floodAreas();
  }

  /**
   * Close all portals (fully disconnected).
   */
  closeAll() {
    this.#portalOpen.fill(0);
    this.#floodAreas();
  }

  /**
   * Set a portal's open state. Uses reference counting so multiple
   * entities can hold the same portal open.
   * @param {number} portalNum portal index
   * @param {boolean} open true to increment open count, false to decrement
   */
  setPortalState(portalNum, open) {
    if (portalNum < 0 || portalNum >= this.#numPortals) {
      return;
    }

    const oldState = this.#portalOpen[portalNum] > 0;

    if (open) {
      this.#portalOpen[portalNum]++;
    } else {
      this.#portalOpen[portalNum] = Math.max(0, this.#portalOpen[portalNum] - 1);
    }

    const newState = this.#portalOpen[portalNum] > 0;

    // Only reflood if the effective open/closed state actually changed
    if (oldState !== newState) {
      this.#floodAreas();
    }
  }

  /**
   * Check whether two areas are connected through open portals.
   * @param {number} area0 first area index
   * @param {number} area1 second area index
   * @returns {boolean} true if the areas are connected
   */
  areasConnected(area0, area1) {
    // Same area is always connected
    if (area0 === area1) {
      return true;
    }

    // Area 0 (outside/solid) is considered connected to everything to avoid
    // culling bugs when camera/entities clip into void.
    // Also bounds check handles invalid areas gracefully.
    if (area0 <= 0 || area0 >= this.#numAreas || area1 <= 0 || area1 >= this.#numAreas) {
      return true;
    }

    // Connected if they share the same non-zero flood signature
    const f0 = this.#floodNum[area0];
    const f1 = this.#floodNum[area1];
    return f0 > 0 && f1 > 0 && f0 === f1;
  }

  /**
   * Check whether two leafs are connected through area portals.
   * Convenience method that takes leaf nodes directly.
   * @param {import('./BSP.mjs').Node} leaf0 first leaf
   * @param {import('./BSP.mjs').Node} leaf1 second leaf
   * @returns {boolean} true if the leafs' areas are connected
   */
  leafsConnected(leaf0, leaf1) {
    return this.areasConnected(leaf0.area, leaf1.area);
  }

  /**
   * Check whether a specific portal is currently open.
   * @param {number} portalNum portal index
   * @returns {boolean} true if the portal's open count is > 0
   */
  isPortalOpen(portalNum) {
    if (portalNum < 0 || portalNum >= this.#numPortals) {
      return false;
    }

    return this.#portalOpen[portalNum] > 0;
  }

  /**
   * Get the number of areas.
   * @returns {number} area count
   */
  get numAreas() {
    return this.#numAreas;
  }

  /**
   * Get the number of portals.
   * @returns {number} portal count
   */
  get numPortals() {
    return this.#numPortals;
  }

  /**
   * Flood-fill areas through open portals to compute reachability.
   * Two areas with the same non-zero floodNum are mutually reachable.
   * Uses BFS to avoid recursion depth limits.
   */
  #floodAreas() {
    this.#floodGeneration = 0;
    this.#floodNum.fill(0);

    // Reusable queue to avoid allocation in loop
    // Note: In extremely large maps, a dedicated Queue class might be faster than Array.push/shift
    // but for typical area counts (hundreds), array is fine.
    const queue = [];

    for (let startArea = 1; startArea < this.#numAreas; startArea++) {
      // If area already visited by a previous flood, skip it
      if (this.#floodNum[startArea] !== 0) {
        continue;
      }

      this.#floodGeneration++;
      const currentFloodId = this.#floodGeneration;

      // Start BFS
      this.#floodNum[startArea] = currentFloodId;
      queue.push(startArea);

      while (queue.length > 0) {
        const u = queue.shift();
        const neighbors = this.#adjacency[u];

        // neighbors might be undefined if area index is weird, but we init all valid areas
        if (!neighbors) {
          continue;
        }

        for (const edge of neighbors) {
          // Check if portal is blocked (group >= 0 means it's a switchable door)
          // If group is out of bounds, treat it as a closed door
          const isOpen = !(edge.group >= 0 && (edge.group >= this.#numPortals || this.#portalOpen[edge.group] <= 0));

          if (!isOpen) {
            continue; // Door is effectively closed
          }

          const v = edge.target;
          if (this.#floodNum[v] === 0) {
            this.#floodNum[v] = currentFloodId;
            queue.push(v);
          }
        }
      }
    }

    this.#emitChangeEvent();
  }

  #emitChangeEvent() {
    eventBus.publish('areaportals.changed');
  }
}

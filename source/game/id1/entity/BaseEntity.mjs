/* global Vector */

export default class BaseEntity {
  constructor(edict, gameAPI) {
    // hooking up the edict and the entity
    this.edict = edict;
    this.edict.api = this;

    // base settings per Entity
    this.origin = new Vector();
    this.oldorigin = new Vector();
    this.angles = new Vector();
    this.mins = new Vector();
    this.maxs = new Vector();
    this.absmins = new Vector();
    this.absmax = new Vector();
    this.velocity = new Vector();
    this.avelocity = new Vector();
    this.movetype = 0;

    // player related (TODO: maybe put these somewhere else)
    this.view_ofs = new Vector();
    this.punchangle = new Vector();
    this.v_angle = new Vector();

    this.engine = gameAPI.engine;
    this.game = gameAPI;

    // this is used to prepopulate fields from ED.LoadFromFile and SV.SpawnServer
    if (!this.engine.IsLoading()) {
      this.spawn();
    }
  }

  /**
   * tries to cast all initialData values (which are strings) to their corresponding types
   * @param {Object} initialData
   */
  assignInitialData(initialData) {
    for (const [key, value] of Object.entries(initialData)) {
      switch (true) {
        case this[key] instanceof Vector:
          this[key] = new Vector(...value.split(' ').map((n) => parseFloat(n)));
          break;

        case typeof(this[key]) === 'number':
          this[key] = parseFloat(value);
          break;

        default:
          this[key] = value;
      }
    }
  }

  setOrigin(origin) {
    this.edict.setOrigin(origin);
  }

  setModel(modelname) {
    if (this.engine.IsLoading()) {
      this.engine.PrecacheModel (modelname);
    }

    this.edict.setModel (modelname);
  }

  setSize(mins, maxs) {
    this.edict.setMinMaxSize(mins, maxs);
  }

  equals(otherEntity) {
    return otherEntity ? this.edict.equals(otherEntity.edict) : false;
  }

  /**
   * Moves self in the given direction. Returns success as a boolean.
   * @param {number} yaw
   * @param {number} dist
   */
  walkMove(yaw, dist) {
    return this.edict.walkMove(yaw, dist);
  }

  /**
   * Makes sure the entity is settled on the ground.
   * @param {number} [z=-2048.0] maximum distance to look down to check
   * @returns whether the dropping succeeded
   */
  dropToFloor(z = -2048.0) {
    return this.edict.dropToFloor(z);
  }

  /**
   * Checks if the entity is standing on the ground.
   */
  isOnTheFloor() {
    return this.edict.isOnTheFloor();
  }

  /**
   * makes this entity static and frees underlying edict
   * NOTE: once this entity has been made static, there’s no interaction possible anymore
   */
  makeStatic() {
    this.edict.makeStatic();
  }

  spawnAmbientSound(sfxName, volume, attn) {
    this.engine.PrecacheSound (sfxName);
    this.engine.SpawnAmbientSound (this.origin, sfxName, volume, attn);
  }

  /**
   * releases this entity and frees underlying edict
   */
  remove() {
    this.edict.freeEdict();
  }

  clear() {
  }

  spawn() {
  }

  think() {

  }
};

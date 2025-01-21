/* global Vector */

export default class BaseEntity {
  constructor(edict, gameAPI) {
    // hooking up the edict and the entity
    this.edict = edict;
    this.edict.api = this;

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

    // player related
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

  spawnAmbientSound(sfxName, volume, attn) {
    this.engine.PrecacheSound (sfxName);
    this.engine.SpawnAmbientSound (this.origin, sfxName, volume, attn);
  }

  clear() {
  }

  spawn() {
  }

  think() {

  }
};

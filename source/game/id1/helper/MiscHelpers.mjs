import Vector from '../../../shared/Vector.mjs';

/**
 * ported directly from QuakeC (weapons.qc/crandom)
 * @returns {number} a random number from -1 to 1
 */
export function crandom() {
  return 2.0 * (Math.random() - 0.5);
};

/**
 * Helper class to deal with flags stored in bits.
 * @deprecated please do not use.
 */
export class Flag {
  constructor(enumMap, ...values) {
    this._enum = enumMap;
    this._value = 0;

    const nullValue = Object.entries(this._enum).find(([, flag]) => flag === 0);

    /** @type {string} */
    this._nullValue = nullValue ? nullValue[0] : null;

    Object.seal(this);

    this.set(...values);
  }

  toString() {
    if (this._value === 0 && this._nullValue) {
      return this._nullValue;
    }

    return Object.entries(this._enum)
      .filter(([, flag]) => (flag > 0 && this._value & flag) === flag)
      .map(([name]) => name)
      .join(', ');
  }

  has(...flags) {
    for (const flag of flags) {
      if ((this._value & flag) === flag) {
        return true;
      }
    }

    return false;
  }

  set(...flags) {
    const values = Object.values(this._enum).reduce((prev, cur) => prev + cur);

    for (const flag of flags) {
      if ((values & flag) !== flag) {
        throw new TypeError('Unknown flag(s) ' + flag);
      }

      this._value |= flag;
    }

    return this;
  }

  unset(...flags) {
    for (const flag of flags) {
      this._value &= ~flag;
    }

    return this;
  }

  reset() {
    this._value = 0;

    return this;
  }
};

export class EntityWrapper {
  /**
   * @param {import('../entity/BaseEntity.mjs').default} entity wrapped entity
   */
  constructor(entity) {
    /** @private */
    this._entity_wf = new WeakRef(entity);
    this._assertEntity();
  }

  /**
   * @returns {import('../entity/BaseEntity.mjs').default} entity
   * @protected
   */
  get _entity() {
    return this._entity_wf.deref();
  }

  /** @protected */
  get _game() {
    return this._entity.game;
  }

  /** @protected */
  get _engine() {
    return this._entity.engine;
  }

  /** @protected */
  _assertEntity() {
  }
};

/**
 * Serializes and deserializes objects.
 * It’s mainly used to save and load the game.
 */
export class Serializer {
  static TYPE_PRIMITIVE = 'P';
  static TYPE_ARRAY = 'A';
  static TYPE_EDICT = 'E';
  static TYPE_FUNCTION = 'F';
  static TYPE_SERIALIZABLE = 'S';
  static TYPE_VECTOR = 'V';

  constructor(object, engine) {
    /** @private */
    this._object_wf = new WeakRef(object);

    /** @private */
    this._engine_wf = engine ? new WeakRef(engine) : null;

    /** @type {string[]} @private */
    this._serializableFields = [];

    /** @type {?string[]} @private */
    this._markerStart = null;
  }

  get _object() {
    return this._object_wf.deref();
  }

  get _engine() {
    if (this._engine_wf) {
      return this._engine_wf.deref();
    }

    return null;
  }

  /** Resets recorded fields. */
  resetFields() {
    this._serializableFields = [];
    this._markerStart = null;
  }

  /** Starts recording added fields. */
  startFields() {
    this._markerStart = Object.keys(this._object);
  }

  /** Stops recording added fields. */
  endFields() {
    this._serializableFields.push(...Object.keys(this._object).filter((key) => !this._markerStart.includes(key)));

    this._markerStart = null;
  }

  serialize() {
    const data = {};

    const serialize = (value) => {
      switch (true) {
        case typeof value === 'string':
        case typeof value === 'boolean':
        case typeof value === 'number':
        case value === null:
          return [Serializer.TYPE_PRIMITIVE, value];

        case typeof value === 'function':
          return [Serializer.TYPE_FUNCTION, value.toString()];

        case value instanceof Vector:
          return [Serializer.TYPE_VECTOR, ...value];

        case value instanceof Array:
          return [Serializer.TYPE_ARRAY, value.map((v) => serialize(v))];

        case value.edictId !== undefined: // keep this before the instanceof check of Serializer
          return [Serializer.TYPE_EDICT, value.edictId];

        case value._serializer instanceof Serializer:
          return [Serializer.TYPE_SERIALIZABLE, value._serializer.serialize()];
      }
      throw new TypeError('Unknown type for serialization: ' + typeof value);
    };

    for (const field of this._serializableFields) {
      const value = this._object[field];
      console.assert(value !== undefined, 'missing field', field);
      data[field] = serialize(value);
    }

    return data;
  }

  deserialize(data) {
    const deserialize = (value) => {
      switch (value[0]) {
        case Serializer.TYPE_PRIMITIVE:
          return value[1];

        case Serializer.TYPE_ARRAY:
          return value[1].map((v) => deserialize(v));

        case Serializer.TYPE_EDICT:
          return this._engine.GetEdictById(value[1]).entity;

        case Serializer.TYPE_FUNCTION: {
          let code = value[1];

          // regular function
          if (code.startsWith('function ')) {
            return (new Function('return ' + code))();
          }

          // arrow functions are a pain, we need to convert it into a regular function (though, no return value)
          code = 'function ' + code.replace('=>', '{') + '}';
          return (new Function('return ' + code))();
        }

        case Serializer.TYPE_VECTOR:
          return new Vector(...value.slice(1));

        case Serializer.TYPE_SERIALIZABLE: {
            const object = {};
            const serializer = Serializer.makeSerializable(object, this._engine);
            serializer.deserialize(value[1]);
            serializer._serializableFields = Object.keys(object);
            return object;
          };
      }
      throw new TypeError('Unknown type for deserialization: ' + value[0]);
    };

    // we purposefully ignore the _serializableFields in order to do the TYPE_SERIALIZABLE trick
    for (const [key, value] of Object.entries(data)) {
      if (value[0] === Serializer.TYPE_SERIALIZABLE) {
        this._object[key]._serializer.deserialize(value[1]);
        continue;
      }

      this._object[key] = deserialize(value);
    }
  }

  static makeSerializable(object, engine) {
    console.assert(object._serializer === undefined, 'object is already serializable');

    const serializer = new Serializer(object, engine);

    Object.defineProperty(object, '_serializer', {
      enumerable: false,
      configurable: false,
      writable: false,
      value: serializer,
    });

    serializer._serializableFields = Object.keys(object);

    return serializer;
  }
};

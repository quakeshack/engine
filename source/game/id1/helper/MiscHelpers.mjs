
/**
 * ported directly from QuakeC (weapons.qc/crandom)
 * @returns {number} a random number from -1 to 1
 */
export function crandom() {
  return 2.0 * (Math.random() - 0.5);
}

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
      if (this._value & flag === flag) {
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
}

export class EntityWrapper {
  /**
   * @param {import('./BaseEntity.mjs').default} entity wrapped entity
   */
  constructor(entity) {
    /** @protected */
    this._entity = entity;
    /** @protected */
    this._game = this._entity.game;
    /** @protected */
    this._engine = this._entity.engine;

    this._assertEntity();
  }

  /** @protected */
  _assertEntity() {
  }
}

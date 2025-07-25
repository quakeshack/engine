import Vector from '../../../../shared/Vector.mjs';

import { attn, channel, solid } from '../../Defs.mjs';
import { QuakeEntityAI } from '../../helper/AI.mjs';
import { GibEntity } from '../Player.mjs';
import { Grenade } from '../Weapons.mjs';
import { WalkMonster } from './BaseMonster.mjs';

export const qc = `
$cd id1/models/ogre_c
$origin 0 0 24
$base base
$skin base

$frame	stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8 stand9

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7
$frame walk8 walk9 walk10 walk11 walk12 walk13 walk14 walk15 walk16

$frame run1 run2 run3 run4 run5 run6 run7 run8

$frame swing1 swing2 swing3 swing4 swing5 swing6 swing7
$frame swing8 swing9 swing10 swing11 swing12 swing13 swing14

$frame smash1 smash2 smash3 smash4 smash5 smash6 smash7
$frame smash8 smash9 smash10 smash11 smash12 smash13 smash14

$frame shoot1 shoot2 shoot3 shoot4 shoot5 shoot6

$frame pain1 pain2 pain3 pain4 pain5

$frame painb1 painb2 painb3

$frame painc1 painc2 painc3 painc4 painc5 painc6

$frame paind1 paind2 paind3 paind4 paind5 paind6 paind7 paind8 paind9 paind10
$frame paind11 paind12 paind13 paind14 paind15 paind16

$frame paine1 paine2 paine3 paine4 paine5 paine6 paine7 paine8 paine9 paine10
$frame paine11 paine12 paine13 paine14 paine15

$frame death1 death2 death3 death4 death5 death6
$frame death7 death8 death9 death10 death11 death12
$frame death13 death14

$frame bdeath1 bdeath2 bdeath3 bdeath4 bdeath5 bdeath6
$frame bdeath7 bdeath8 bdeath9 bdeath10

$frame pull1 pull2 pull3 pull4 pull5 pull6 pull7 pull8 pull9 pull10 pull11
`;

/**
 * QUAKED monster_ogre (1 0 0) (-32 -32 -24) (32 32 64) Ambush
 */
export default class OgreMonsterEntity extends WalkMonster {
  static classname = 'monster_ogre';

  static _health = 200;
  static _size = [new Vector(-32.0, -32.0, -24.0), new Vector(32.0, 32.0, 64.0)];

  static _modelDefault = 'progs/ogre.mdl';
  static _modelHead = 'progs/h_ogre.mdl';

  get netname() {
    return 'an Ogre';
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _initStates() {
    // Stand states
    this._defineState('ogre_stand1', 'stand1', 'ogre_stand2', function() { this._ai.stand(); });
    this._defineState('ogre_stand2', 'stand2', 'ogre_stand3', function() { this._ai.stand(); });
    this._defineState('ogre_stand3', 'stand3', 'ogre_stand4', function() { this._ai.stand(); });
    this._defineState('ogre_stand4', 'stand4', 'ogre_stand5', function() { this._ai.stand(); });
    this._defineState('ogre_stand5', 'stand5', 'ogre_stand6', function() { this._ai.stand(); this.idleSound(); });
    this._defineState('ogre_stand6', 'stand6', 'ogre_stand7', function() { this._ai.stand(); });
    this._defineState('ogre_stand7', 'stand7', 'ogre_stand8', function() { this._ai.stand(); });
    this._defineState('ogre_stand8', 'stand8', 'ogre_stand9', function() { this._ai.stand(); });
    this._defineState('ogre_stand9', 'stand9', 'ogre_stand1', function() { this._ai.stand(); });

    // Walk states
    this._defineState('ogre_walk1', 'walk1', 'ogre_walk2', function() { this._ai.walk(3); });
    this._defineState('ogre_walk2', 'walk2', 'ogre_walk3', function() { this._ai.walk(2); });
    this._defineState('ogre_walk3', 'walk3', 'ogre_walk4', function() { this._ai.walk(2); this.idleSound(); });
    this._defineState('ogre_walk4', 'walk4', 'ogre_walk5', function() { this._ai.walk(2); });
    this._defineState('ogre_walk5', 'walk5', 'ogre_walk6', function() { this._ai.walk(2); });
    this._defineState('ogre_walk6', 'walk6', 'ogre_walk7', function() { this._ai.walk(5); this.dragSound(); });
    this._defineState('ogre_walk7', 'walk7', 'ogre_walk8', function() { this._ai.walk(3); });
    this._defineState('ogre_walk8', 'walk8', 'ogre_walk9', function() { this._ai.walk(2); });
    this._defineState('ogre_walk9', 'walk9', 'ogre_walk10', function() { this._ai.walk(3); });
    this._defineState('ogre_walk10', 'walk10', 'ogre_walk11', function() { this._ai.walk(1); });
    this._defineState('ogre_walk11', 'walk11', 'ogre_walk12', function() { this._ai.walk(2); });
    this._defineState('ogre_walk12', 'walk12', 'ogre_walk13', function() { this._ai.walk(3); });
    this._defineState('ogre_walk13', 'walk13', 'ogre_walk14', function() { this._ai.walk(3); });
    this._defineState('ogre_walk14', 'walk14', 'ogre_walk15', function() { this._ai.walk(3); });
    this._defineState('ogre_walk15', 'walk15', 'ogre_walk16', function() { this._ai.walk(3); });
    this._defineState('ogre_walk16', 'walk16', 'ogre_walk1', function() { this._ai.walk(4); });

    // Run states
    this._defineState('ogre_run1', 'run1', 'ogre_run2', function() { this._ai.run(9); this.idleSound(); });
    this._defineState('ogre_run2', 'run2', 'ogre_run3', function() { this._ai.run(12); });
    this._defineState('ogre_run3', 'run3', 'ogre_run4', function() { this._ai.run(8); });
    this._defineState('ogre_run4', 'run4', 'ogre_run5', function() { this._ai.run(22); });
    this._defineState('ogre_run5', 'run5', 'ogre_run6', function() { this._ai.run(16); });
    this._defineState('ogre_run6', 'run6', 'ogre_run7', function() { this._ai.run(4); });
    this._defineState('ogre_run7', 'run7', 'ogre_run8', function() { this._ai.run(13); });
    this._defineState('ogre_run8', 'run8', 'ogre_run1', function() { this._ai.run(24); });

    // Swing (melee) states
    this._defineState('ogre_swing1', 'swing1', 'ogre_swing2', function() { this._ai.charge(11); this.attackSound(); });
    this._defineState('ogre_swing2', 'swing2', 'ogre_swing3', function() { this._ai.charge(1); });
    this._defineState('ogre_swing3', 'swing3', 'ogre_swing4', function() { this._ai.charge(4); });
    this._defineState('ogre_swing4', 'swing4', 'ogre_swing5', function() { this._ai.charge(13); });
    this._defineState('ogre_swing5', 'swing5', 'ogre_swing6', function() { this._ai.charge(9); this._fireChainsaw(0); this.angles[1] += Math.random() * 25; });
    this._defineState('ogre_swing6', 'swing6', 'ogre_swing7', function() { this._fireChainsaw(200); this.angles[1] += Math.random() * 25; });
    this._defineState('ogre_swing7', 'swing7', 'ogre_swing8', function() { this._fireChainsaw(0); this.angles[1] += Math.random() * 25; });
    this._defineState('ogre_swing8', 'swing8', 'ogre_swing9', function() { this._fireChainsaw(0); this.angles[1] += Math.random() * 25; });
    this._defineState('ogre_swing9', 'swing9', 'ogre_swing10', function() { this._fireChainsaw(0); this.angles[1] += Math.random() * 25; });
    this._defineState('ogre_swing10', 'swing10', 'ogre_swing11', function() { this._fireChainsaw(-200); this.angles[1] += Math.random() * 25; });
    this._defineState('ogre_swing11', 'swing11', 'ogre_swing12', function() { this._fireChainsaw(0); this.angles[1] += Math.random() * 25; });
    this._defineState('ogre_swing12', 'swing12', 'ogre_swing13', function() { this._ai.charge(3); });
    this._defineState('ogre_swing13', 'swing13', 'ogre_swing14', function() { this._ai.charge(8); });
    this._defineState('ogre_swing14', 'swing14', 'ogre_run1', function() { this._ai.charge(9); });

    // Smash (melee) states
    this._defineState('ogre_smash1', 'smash1', 'ogre_smash2', function() { this._ai.charge(6); this.attackSound(); });
    this._defineState('ogre_smash2', 'smash2', 'ogre_smash3', function() { this._ai.charge(0); });
    this._defineState('ogre_smash3', 'smash3', 'ogre_smash4', function() { this._ai.charge(0); });
    this._defineState('ogre_smash4', 'smash4', 'ogre_smash5', function() { this._ai.charge(1); });
    this._defineState('ogre_smash5', 'smash5', 'ogre_smash6', function() { this._ai.charge(4); });
    this._defineState('ogre_smash6', 'smash6', 'ogre_smash7', function() { this._ai.charge(4); this._fireChainsaw(0); });
    this._defineState('ogre_smash7', 'smash7', 'ogre_smash8', function() { this._ai.charge(4); this._fireChainsaw(0); });
    this._defineState('ogre_smash8', 'smash8', 'ogre_smash9', function() { this._ai.charge(10); this._fireChainsaw(0); });
    this._defineState('ogre_smash9', 'smash9', 'ogre_smash10', function() { this._ai.charge(13); this._fireChainsaw(0); });
    this._defineState('ogre_smash10', 'smash10', 'ogre_smash11', function() { this._fireChainsaw(1); });
    this._defineState('ogre_smash11', 'smash11', 'ogre_smash12', function() { this._ai.charge(2); this._fireChainsaw(0); this.nextthink += Math.random() * 0.2; /* HACK */ });
    this._defineState('ogre_smash12', 'smash12', 'ogre_smash13', function() { this._ai.charge(); });
    this._defineState('ogre_smash13', 'smash13', 'ogre_smash14', function() { this._ai.charge(4); });
    this._defineState('ogre_smash14', 'smash14', 'ogre_run1', function() { this._ai.charge(12); });

    // Nail (grenade) attack states
    this._defineState('ogre_nail1', 'shoot1', 'ogre_nail2', function() { this._ai.face(); });
    this._defineState('ogre_nail2', 'shoot2', 'ogre_nail3', function() { this._ai.face(); });
    this._defineState('ogre_nail3', 'shoot2', 'ogre_nail4', function() { this._ai.face(); });
    this._defineState('ogre_nail4', 'shoot3', 'ogre_nail5', function() { this._ai.face(); this._fireGrenade(); });
    this._defineState('ogre_nail5', 'shoot4', 'ogre_nail6', function() { this._ai.face(); });
    this._defineState('ogre_nail6', 'shoot5', 'ogre_nail7', function() { this._ai.face(); });
    this._defineState('ogre_nail7', 'shoot6', 'ogre_run1', function() { this._ai.face(); });

    // Pain states
    this._defineState('ogre_pain1', 'pain1', 'ogre_pain2', function() {});
    this._defineState('ogre_pain2', 'pain2', 'ogre_pain3', function() {});
    this._defineState('ogre_pain3', 'pain3', 'ogre_pain4', function() {});
    this._defineState('ogre_pain4', 'pain4', 'ogre_pain5', function() {});
    this._defineState('ogre_pain5', 'pain5', 'ogre_run1', function() {});
    this._defineState('ogre_pain1b', 'painb1', 'ogre_pain1b2', function() {});
    this._defineState('ogre_pain1b2', 'painb2', 'ogre_pain1b3', function() {});
    this._defineState('ogre_pain1b3', 'painb3', 'ogre_run1', function() {});
    this._defineState('ogre_pain1c', 'painc1', 'ogre_pain1c2', function() {});
    this._defineState('ogre_pain1c2', 'painc2', 'ogre_pain1c3', function() {});
    this._defineState('ogre_pain1c3', 'painc3', 'ogre_pain1c4', function() {});
    this._defineState('ogre_pain1c4', 'painc4', 'ogre_pain1c5', function() {});
    this._defineState('ogre_pain1c5', 'painc5', 'ogre_pain1c6', function() {});
    this._defineState('ogre_pain1c6', 'painc6', 'ogre_run1', function() {});
    this._defineState('ogre_pain1d', 'paind1', 'ogre_pain1d2', function() {});
    this._defineState('ogre_pain1d2', 'paind2', 'ogre_pain1d3', function() { this._ai.pain(10); });
    this._defineState('ogre_pain1d3', 'paind3', 'ogre_pain1d4', function() { this._ai.pain(9); });
    this._defineState('ogre_pain1d4', 'paind4', 'ogre_pain1d5', function() { this._ai.pain(4); });
    this._defineState('ogre_pain1d5', 'paind5', 'ogre_pain1d6', function() {});
    this._defineState('ogre_pain1d6', 'paind6', 'ogre_pain1d7', function() {});
    this._defineState('ogre_pain1d7', 'paind7', 'ogre_pain1d8', function() {});
    this._defineState('ogre_pain1d8', 'paind8', 'ogre_pain1d9', function() {});
    this._defineState('ogre_pain1d9', 'paind9', 'ogre_pain1d10', function() {});
    this._defineState('ogre_pain1d10', 'paind10', 'ogre_pain1d11', function() {});
    this._defineState('ogre_pain1d11', 'paind11', 'ogre_pain1d12', function() {});
    this._defineState('ogre_pain1d12', 'paind12', 'ogre_pain1d13', function() {});
    this._defineState('ogre_pain1d13', 'paind13', 'ogre_pain1d14', function() {});
    this._defineState('ogre_pain1d14', 'paind14', 'ogre_pain1d15', function() {});
    this._defineState('ogre_pain1d15', 'paind15', 'ogre_pain1d16', function() {});
    this._defineState('ogre_pain1d16', 'paind16', 'ogre_run1', function() {});
    this._defineState('ogre_pain1e', 'paine1', 'ogre_pain1e2', function() {});
    this._defineState('ogre_pain1e2', 'paine2', 'ogre_pain1e3', function() { this._ai.pain(10); });
    this._defineState('ogre_pain1e3', 'paine3', 'ogre_pain1e4', function() { this._ai.pain(9); });
    this._defineState('ogre_pain1e4', 'paine4', 'ogre_pain1e5', function() { this._ai.pain(4); });
    this._defineState('ogre_pain1e5', 'paine5', 'ogre_pain1e6', function() {});
    this._defineState('ogre_pain1e6', 'paine6', 'ogre_pain1e7', function() {});
    this._defineState('ogre_pain1e7', 'paine7', 'ogre_pain1e8', function() {});
    this._defineState('ogre_pain1e8', 'paine8', 'ogre_pain1e9', function() {});
    this._defineState('ogre_pain1e9', 'paine9', 'ogre_pain1e10', function() {});
    this._defineState('ogre_pain1e10', 'paine10', 'ogre_pain1e11', function() {});
    this._defineState('ogre_pain1e11', 'paine11', 'ogre_pain1e12', function() {});
    this._defineState('ogre_pain1e12', 'paine12', 'ogre_pain1e13', function() {});
    this._defineState('ogre_pain1e13', 'paine13', 'ogre_pain1e14', function() {});
    this._defineState('ogre_pain1e14', 'paine14', 'ogre_pain1e15', function() {});
    this._defineState('ogre_pain1e15', 'paine15', 'ogre_run1', function() {});

    // Death states
    this._defineState('ogre_die1', 'death1', 'ogre_die2', function() {});
    this._defineState('ogre_die2', 'death2', 'ogre_die3', function() {});
    this._defineState('ogre_die3', 'death3', 'ogre_die4', function() { this.solid = solid.SOLID_NOT; this._dropBackpack(); });
    this._defineState('ogre_die4', 'death4', 'ogre_die5', function() {});
    this._defineState('ogre_die5', 'death5', 'ogre_die6', function() {});
    this._defineState('ogre_die6', 'death6', 'ogre_die7', function() {});
    this._defineState('ogre_die7', 'death7', 'ogre_die8', function() {});
    this._defineState('ogre_die8', 'death8', 'ogre_die9', function() {});
    this._defineState('ogre_die9', 'death9', 'ogre_die10', function() {});
    this._defineState('ogre_die10', 'death10', 'ogre_die11', function() {});
    this._defineState('ogre_die11', 'death11', 'ogre_die12', function() {});
    this._defineState('ogre_die12', 'death12', 'ogre_die13', function() {});
    this._defineState('ogre_die13', 'death13', 'ogre_die14', function() {});
    this._defineState('ogre_die14', 'death14', 'ogre_die14', function() {});
    this._defineState('ogre_bdie1', 'bdeath1', 'ogre_bdie2', function() {});
    this._defineState('ogre_bdie2', 'bdeath2', 'ogre_bdie3', function() { this._ai.forward(5); });
    this._defineState('ogre_bdie3', 'bdeath3', 'ogre_bdie4', function() { this.solid = solid.SOLID_NOT; this._dropBackpack(); });
    this._defineState('ogre_bdie4', 'bdeath4', 'ogre_bdie5', function() { this._ai.forward(1); });
    this._defineState('ogre_bdie5', 'bdeath5', 'ogre_bdie6', function() { this._ai.forward(3); });
    this._defineState('ogre_bdie6', 'bdeath6', 'ogre_bdie7', function() { this._ai.forward(7); });
    this._defineState('ogre_bdie7', 'bdeath7', 'ogre_bdie8', function() { this._ai.forward(25); });
    this._defineState('ogre_bdie8', 'bdeath8', 'ogre_bdie9', function() {});
    this._defineState('ogre_bdie9', 'bdeath9', 'ogre_bdie10', function() {});
    this._defineState('ogre_bdie10', 'bdeath10', 'ogre_bdie10', function() {});
  }

  _precache() {
    super._precache();
    this.engine.PrecacheSound('ogre/ogdrag.wav');
    this.engine.PrecacheSound('ogre/ogdth.wav');
    this.engine.PrecacheSound('ogre/ogidle.wav');
    this.engine.PrecacheSound('ogre/ogidle2.wav');
    this.engine.PrecacheSound('ogre/ogpain1.wav');
    this.engine.PrecacheSound('ogre/ogsawatk.wav');
    this.engine.PrecacheSound('ogre/ogwake.wav');
  }

  _fireGrenade() {
    if (!this.enemy) {
      return;
    }

    const velocity = this.calculateTrajectoryVelocity(this.enemy, null, 0.9);

    this.engine.SpawnEntity(Grenade.classname, { owner: this, velocity });
  }

  _fireChainsaw(side) {
    if (!this.enemy) {
      return;
    }

    if (!this.enemy.canReceiveDamage(this)) {
      return;
    }

    this._ai.charge(10);

    if (this.origin.distanceTo(this.enemy.origin) > 100) {
      return;
    }

    const ldmg = (Math.random() + Math.random() + Math.random()) * 4;

    this.damage(this.enemy, ldmg);

    if (side) {
      const { forward, right } = this.angles.angleVectors();
      const origin = this.origin.copy().add(forward.multiply(16));

      if (side === 1) {
        GibEntity.throwMeatGib(this.enemy, right.multiply(Math.random() * 100), origin);
      } else {
        GibEntity.throwMeatGib(this.enemy, right.multiply(side), origin);
      }
    }
  }

  _dropBackpack() {
    super._dropBackpack({ ammo_rockets: 2 });
  }

  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    if (this.pain_finished > this.game.time) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

    this.painSound();

    const r = Math.random();

    this.pain_finished = this.game.time + 1.0;

    if (r < 0.25) {
      this._runState('ogre_pain1');
    } else if (r < 0.5) {
      this._runState('ogre_pain1b');
    } else if (r < 0.75) {
      this._runState('ogre_pain1c');
    } else if (r < 0.875) {
      this._runState('ogre_pain1d');
      this.pain_finished += 1.0;
    } else {
      this._runState('ogre_pain1e');
      this.pain_finished += 1.0;
    }
  }

  thinkDie(attackerEntity) {
    this._sub.useTargets(attackerEntity);

    if (this.health < -80) {
      this.startSound(channel.CHAN_VOICE, 'player/udeath.wav');
      this._gib(false);
      return;
    }

    this.startSound(channel.CHAN_VOICE, 'ogre/ogdth.wav');

    if (Math.random() < 0.5) {
      this._runState('ogre_die1');
    }
    else {
      this._runState('ogre_bdie1');
    }
  }

  thinkMelee() {
    if (Math.random() > 0.5) {
      this._runState('ogre_smash1');
    } else {
      this._runState('ogre_swing1');
    }
  }

  thinkMissile() {
    this._runState('ogre_nail1');
  }

  thinkStand() {
    this._runState('ogre_stand1');
  }

  thinkWalk() {
    this._runState('ogre_walk1');
  }

  thinkRun() {
    this._runState('ogre_run1');
  }

  moveTargetReached(markerEntity) {
    this.startSound(channel.CHAN_VOICE, 'ogre/ogdrag.wav', 1.0, attn.ATTN_IDLE);
    return super.moveTargetReached(markerEntity);
  }

  attackSound() {
    this.startSound(channel.CHAN_WEAPON, 'ogre/ogsawatk.wav');
  }

  idleSound() {
    if (Math.random() > 0.2) {
      return;
    }

    if (Math.random() < 0.5) {
      this.startSound(channel.CHAN_VOICE, 'ogre/ogidle.wav');
    } else {
      this.startSound(channel.CHAN_VOICE, 'ogre/ogidle2.wav');
    }
  }

  dragSound() {
    if (Math.random() > 0.1) {
      return;
    }

    this.startSound(channel.CHAN_VOICE, 'ogre/ogdrag.wav');
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, 'ogre/ogpain1.wav');
  }

  hasMeleeAttack() {
    return true;
  }

  hasMissileAttack() {
    return true;
  }
};

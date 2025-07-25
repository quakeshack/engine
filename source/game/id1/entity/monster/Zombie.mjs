import Vector from '../../../../shared/Vector.mjs';

import { attn, channel, damage, moveType, solid } from '../../Defs.mjs';
import { QuakeEntityAI } from '../../helper/AI.mjs';
import BaseEntity from '../BaseEntity.mjs';
import { DamageInflictor } from '../Weapons.mjs';
import { WalkMonster } from './BaseMonster.mjs';

export const qc = `
$cd id1/models/zombie

$origin	0 0 24

$base base
$skin skin

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8
$frame stand9 stand10 stand11 stand12 stand13 stand14 stand15

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7 walk8 walk9 walk10 walk11
$frame walk12 walk13 walk14 walk15 walk16 walk17 walk18 walk19

$frame run1 run2 run3 run4 run5 run6 run7 run8 run9 run10 run11 run12
$frame run13 run14 run15 run16 run17 run18

$frame atta1 atta2 atta3 atta4 atta5 atta6 atta7 atta8 atta9 atta10 atta11
$frame atta12 atta13

$frame attb1 attb2 attb3 attb4 attb5 attb6 attb7 attb8 attb9 attb10 attb11
$frame attb12 attb13 attb14

$frame attc1 attc2 attc3 attc4 attc5 attc6 attc7 attc8 attc9 attc10 attc11
$frame attc12

$frame paina1 paina2 paina3 paina4 paina5 paina6 paina7 paina8 paina9 paina10
$frame paina11 paina12

$frame painb1 painb2 painb3 painb4 painb5 painb6 painb7 painb8 painb9 painb10
$frame painb11 painb12 painb13 painb14 painb15 painb16 painb17 painb18 painb19
$frame painb20 painb21 painb22 painb23 painb24 painb25 painb26 painb27 painb28

$frame painc1 painc2 painc3 painc4 painc5 painc6 painc7 painc8 painc9 painc10
$frame painc11 painc12 painc13 painc14 painc15 painc16 painc17 painc18

$frame paind1 paind2 paind3 paind4 paind5 paind6 paind7 paind8 paind9 paind10
$frame paind11 paind12 paind13

$frame paine1 paine2 paine3 paine4 paine5 paine6 paine7 paine8 paine9 paine10
$frame paine11 paine12 paine13 paine14 paine15 paine16 paine17 paine18 paine19
$frame paine20 paine21 paine22 paine23 paine24 paine25 paine26 paine27 paine28
$frame paine29 paine30

$frame cruc_1 cruc_2 cruc_3 cruc_4 cruc_5 cruc_6
`;

/**
 * QUAKED monster_zombie (1 0 0) (-16 -16 -24) (16 16 32) Crucified ambush
 * If crucified, stick the bounding box 12 pixels back into a wall to look right.
 */
export default class ZombieMonster extends WalkMonster {
  static classname = 'monster_zombie';

  static _health = 30;
  static _size = [new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 40.0)];

  static _modelDefault = 'progs/zombie.mdl';
  static _modelHead = 'progs/h_zombie.mdl';

  static SPAWN_CRUCIFIED = 1;

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();
    this.inpain = 0;
    this.pain_finished = 0;
    this._serializer.endFields();
  }

  _precache() {
    super._precache();
    this.engine.PrecacheModel('progs/zom_gib.mdl');
    this.engine.PrecacheSound('zombie/z_idle.wav');
    this.engine.PrecacheSound('zombie/z_idle1.wav');
    this.engine.PrecacheSound('zombie/z_shot1.wav');
    this.engine.PrecacheSound('zombie/z_gib.wav');
    this.engine.PrecacheSound('zombie/z_pain.wav');
    this.engine.PrecacheSound('zombie/z_pain1.wav');
    this.engine.PrecacheSound('zombie/z_fall.wav');
    this.engine.PrecacheSound('zombie/z_miss.wav');
    this.engine.PrecacheSound('zombie/z_hit.wav');
    this.engine.PrecacheSound('zombie/idle_w2.wav');
  }

  get netname() {
    return 'a Zombie';
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _initStates() {
    this._defineState('zombie_stand1', 'stand1', 'zombie_stand2', function () { this._ai.stand(); });
    this._defineState('zombie_stand2', 'stand2', 'zombie_stand3', function () { this._ai.stand(); });
    this._defineState('zombie_stand3', 'stand3', 'zombie_stand4', function () { this._ai.stand(); });
    this._defineState('zombie_stand4', 'stand4', 'zombie_stand5', function () { this._ai.stand(); });
    this._defineState('zombie_stand5', 'stand5', 'zombie_stand6', function () { this._ai.stand(); });
    this._defineState('zombie_stand6', 'stand6', 'zombie_stand7', function () { this._ai.stand(); });
    this._defineState('zombie_stand7', 'stand7', 'zombie_stand8', function () { this._ai.stand(); });
    this._defineState('zombie_stand8', 'stand8', 'zombie_stand9', function () { this._ai.stand(); });
    this._defineState('zombie_stand9', 'stand9', 'zombie_stand10', function () { this._ai.stand(); });
    this._defineState('zombie_stand10', 'stand10', 'zombie_stand11', function () { this._ai.stand(); });
    this._defineState('zombie_stand11', 'stand11', 'zombie_stand12', function () { this._ai.stand(); });
    this._defineState('zombie_stand12', 'stand12', 'zombie_stand13', function () { this._ai.stand(); });
    this._defineState('zombie_stand13', 'stand13', 'zombie_stand14', function () { this._ai.stand(); });
    this._defineState('zombie_stand14', 'stand14', 'zombie_stand15', function () { this._ai.stand(); });
    this._defineState('zombie_stand15', 'stand15', 'zombie_stand1', function () { this._ai.stand(); });

    this._defineState('zombie_cruc1', 'cruc_1', 'zombie_cruc2', function () {
      if (Math.random() >= 0.1) {
        return;
      }
      this.startSound(channel.CHAN_VOICE, 'zombie/idle_w2.wav', 1.0, attn.ATTN_STATIC);
    });
    this._defineState('zombie_cruc2', 'cruc_2', 'zombie_cruc3', function () {
      this.nextthink = this.game.time + 0.1 + Math.random() * 0.1;
    });
    this._defineState('zombie_cruc3', 'cruc_3', 'zombie_cruc4', function () {
      this.nextthink = this.game.time + 0.1 + Math.random() * 0.1;
    });
    this._defineState('zombie_cruc4', 'cruc_4', 'zombie_cruc5', function () {
      this.nextthink = this.game.time + 0.1 + Math.random() * 0.1;
    });
    this._defineState('zombie_cruc5', 'cruc_5', 'zombie_cruc6', function () {
      this.nextthink = this.game.time + 0.1 + Math.random() * 0.1;
    });
    this._defineState('zombie_cruc6', 'cruc_6', 'zombie_cruc1', function () {
      this.nextthink = this.game.time + 0.1 + Math.random() * 0.1;
    });

    // walk states
    this._defineState('zombie_walk1', 'walk1', 'zombie_walk2', () => { this._ai.walk(0); });
    this._defineState('zombie_walk2', 'walk2', 'zombie_walk3', () => { this._ai.walk(2); });
    this._defineState('zombie_walk3', 'walk3', 'zombie_walk4', () => { this._ai.walk(3); });
    this._defineState('zombie_walk4', 'walk4', 'zombie_walk5', () => { this._ai.walk(2); });
    this._defineState('zombie_walk5', 'walk5', 'zombie_walk6', () => { this._ai.walk(1); });
    this._defineState('zombie_walk6', 'walk6', 'zombie_walk7', () => { this._ai.walk(0); });
    this._defineState('zombie_walk7', 'walk7', 'zombie_walk8', () => { this._ai.walk(0); });
    this._defineState('zombie_walk8', 'walk8', 'zombie_walk9', () => { this._ai.walk(0); });
    this._defineState('zombie_walk9', 'walk9', 'zombie_walk10', () => { this._ai.walk(0); });
    this._defineState('zombie_walk10', 'walk10', 'zombie_walk11', () => { this._ai.walk(0); });
    this._defineState('zombie_walk11', 'walk11', 'zombie_walk12', () => { this._ai.walk(2); });
    this._defineState('zombie_walk12', 'walk12', 'zombie_walk13', () => { this._ai.walk(2); });
    this._defineState('zombie_walk13', 'walk13', 'zombie_walk14', () => { this._ai.walk(1); });
    this._defineState('zombie_walk14', 'walk14', 'zombie_walk15', () => { this._ai.walk(0); });
    this._defineState('zombie_walk15', 'walk15', 'zombie_walk16', () => { this._ai.walk(0); });
    this._defineState('zombie_walk16', 'walk16', 'zombie_walk17', () => { this._ai.walk(0); });
    this._defineState('zombie_walk17', 'walk17', 'zombie_walk18', () => { this._ai.walk(0); });
    this._defineState('zombie_walk18', 'walk18', 'zombie_walk19', () => { this._ai.walk(0); if (Math.random() < 0.2) {this.startSound(channel.CHAN_VOICE, 'zombie/z_idle.wav', 1.0, attn.ATTN_IDLE);} });
    this._defineState('zombie_walk19', 'walk19', 'zombie_walk1', () => { this._ai.walk(0); if (Math.random() < 0.2) {this.startSound(channel.CHAN_VOICE, 'zombie/z_idle.wav', 1.0, attn.ATTN_IDLE);} });

    // run states
    this._defineState('zombie_run1', 'run1', 'zombie_run2', () => { this._ai.run(1); this.inpain = 0; });
    this._defineState('zombie_run2', 'run2', 'zombie_run3', () => { this._ai.run(1); });
    this._defineState('zombie_run3', 'run3', 'zombie_run4', () => { this._ai.run(0); });
    this._defineState('zombie_run4', 'run4', 'zombie_run5', () => { this._ai.run(1); });
    this._defineState('zombie_run5', 'run5', 'zombie_run6', () => { this._ai.run(2); });
    this._defineState('zombie_run6', 'run6', 'zombie_run7', () => { this._ai.run(3); });
    this._defineState('zombie_run7', 'run7', 'zombie_run8', () => { this._ai.run(4); });
    this._defineState('zombie_run8', 'run8', 'zombie_run9', () => { this._ai.run(4); });
    this._defineState('zombie_run9', 'run9', 'zombie_run10', () => { this._ai.run(2); });
    this._defineState('zombie_run10', 'run10', 'zombie_run11', () => { this._ai.run(0); });
    this._defineState('zombie_run11', 'run11', 'zombie_run12', () => { this._ai.run(0); });
    this._defineState('zombie_run12', 'run12', 'zombie_run13', () => { this._ai.run(0); });
    this._defineState('zombie_run13', 'run13', 'zombie_run14', () => { this._ai.run(2); });
    this._defineState('zombie_run14', 'run14', 'zombie_run15', () => { this._ai.run(4); });
    this._defineState('zombie_run15', 'run15', 'zombie_run16', () => { this._ai.run(6); });
    this._defineState('zombie_run16', 'run16', 'zombie_run17', () => { this._ai.run(7); });
    this._defineState('zombie_run17', 'run17', 'zombie_run18', () => { this._ai.run(3); });
    this._defineState('zombie_run18', 'run18', 'zombie_run1', () => { this._ai.run(8); if (Math.random() < 0.2) {this.startSound(channel.CHAN_VOICE, 'zombie/z_idle.wav', 1.0, attn.ATTN_IDLE);} if (Math.random() > 0.8) {this.startSound(channel.CHAN_VOICE, 'zombie/z_idle1.wav', 1.0, attn.ATTN_IDLE);} });

    // attack sequences (prefix atta, attb, attc)
    this._defineState('zombie_atta1', 'atta1', 'zombie_atta2', () => { this._ai.face(); });
    this._defineState('zombie_atta2', 'atta2', 'zombie_atta3', () => { this._ai.face(); });
    this._defineState('zombie_atta3', 'atta3', 'zombie_atta4', () => { this._ai.face(); });
    this._defineState('zombie_atta4', 'atta4', 'zombie_atta5', () => { this._ai.face(); });
    this._defineState('zombie_atta5', 'atta5', 'zombie_atta6', () => { this._ai.face(); });
    this._defineState('zombie_atta6', 'atta6', 'zombie_atta7', () => { this._ai.face(); });
    this._defineState('zombie_atta7', 'atta7', 'zombie_atta8', () => { this._ai.face(); });
    this._defineState('zombie_atta8', 'atta8', 'zombie_atta9', () => { this._ai.face(); });
    this._defineState('zombie_atta9', 'atta9', 'zombie_atta10', () => { this._ai.face(); });
    this._defineState('zombie_atta10', 'atta10', 'zombie_atta11', () => { this._ai.face(); });
    this._defineState('zombie_atta11', 'atta11', 'zombie_atta12', () => { this._ai.face(); });
    this._defineState('zombie_atta12', 'atta12', 'zombie_atta13', () => { this._ai.face(); });
    this._defineState('zombie_atta13', 'atta13', 'zombie_run1', () => { this._ai.face(); this._fireGrenade(new Vector(-10, -22, 30)); });

    this._defineState('zombie_attb1', 'attb1', 'zombie_attb2', () => { this._ai.face(); });
    this._defineState('zombie_attb2', 'attb2', 'zombie_attb3', () => { this._ai.face(); });
    this._defineState('zombie_attb3', 'attb3', 'zombie_attb4', () => { this._ai.face(); });
    this._defineState('zombie_attb4', 'attb4', 'zombie_attb5', () => { this._ai.face(); });
    this._defineState('zombie_attb5', 'attb5', 'zombie_attb6', () => { this._ai.face(); });
    this._defineState('zombie_attb6', 'attb6', 'zombie_attb7', () => { this._ai.face(); });
    this._defineState('zombie_attb7', 'attb7', 'zombie_attb8', () => { this._ai.face(); });
    this._defineState('zombie_attb8', 'attb8', 'zombie_attb9', () => { this._ai.face(); });
    this._defineState('zombie_attb9', 'attb9', 'zombie_attb10', () => { this._ai.face(); });
    this._defineState('zombie_attb10', 'attb10', 'zombie_attb11', () => { this._ai.face(); });
    this._defineState('zombie_attb11', 'attb11', 'zombie_attb12', () => { this._ai.face(); });
    this._defineState('zombie_attb12', 'attb12', 'zombie_attb13', () => { this._ai.face(); });
    this._defineState('zombie_attb13', 'attb13', 'zombie_attb14', () => { this._ai.face(); });
    this._defineState('zombie_attb14', 'attb14', 'zombie_run1', () => { this._ai.face(); this._fireGrenade(new Vector(-10, -24, 29)); });

    this._defineState('zombie_attc1', 'attc1', 'zombie_attc2', () => { this._ai.face(); });
    this._defineState('zombie_attc2', 'attc2', 'zombie_attc3', () => { this._ai.face(); });
    this._defineState('zombie_attc3', 'attc3', 'zombie_attc4', () => { this._ai.face(); });
    this._defineState('zombie_attc4', 'attc4', 'zombie_attc5', () => { this._ai.face(); });
    this._defineState('zombie_attc5', 'attc5', 'zombie_attc6', () => { this._ai.face(); });
    this._defineState('zombie_attc6', 'attc6', 'zombie_attc7', () => { this._ai.face(); });
    this._defineState('zombie_attc7', 'attc7', 'zombie_attc8', () => { this._ai.face(); });
    this._defineState('zombie_attc8', 'attc8', 'zombie_attc9', () => { this._ai.face(); });
    this._defineState('zombie_attc9', 'attc9', 'zombie_attc10', () => { this._ai.face(); });
    this._defineState('zombie_attc10', 'attc10', 'zombie_attc11', () => { this._ai.face(); });
    this._defineState('zombie_attc11', 'attc11', 'zombie_attc12', () => { this._ai.face(); });
    this._defineState('zombie_attc12', 'attc12', 'zombie_run1', () => { this._ai.face(); this._fireGrenade(new Vector(-12, -19, 29)); });

    // pain sequences (paina)
    this._defineState('zombie_paina1', 'paina1', 'zombie_paina2', () => { this.startSound(channel.CHAN_VOICE, 'zombie/z_pain.wav'); });
    this._defineState('zombie_paina2', 'paina2', 'zombie_paina3', () => { this._ai.painforward(3); });
    this._defineState('zombie_paina3', 'paina3', 'zombie_paina4', () => { this._ai.painforward(1); });
    this._defineState('zombie_paina4', 'paina4', 'zombie_paina5', () => { this._ai.pain(1); });
    this._defineState('zombie_paina5', 'paina5', 'zombie_paina6', () => { this._ai.pain(3); });
    this._defineState('zombie_paina6', 'paina6', 'zombie_paina7', () => { this._ai.pain(1); });
    this._defineState('zombie_paina7', 'paina7', 'zombie_paina8', () => {});
    this._defineState('zombie_paina8', 'paina8', 'zombie_paina9', () => {});
    this._defineState('zombie_paina9', 'paina9', 'zombie_paina10', () => {});
    this._defineState('zombie_paina10', 'paina10', 'zombie_paina11', () => {});
    this._defineState('zombie_paina11', 'paina11', 'zombie_paina12', () => {});
    this._defineState('zombie_paina12', 'paina12', 'zombie_run1', () => {});

    // pain sequences (painb)
    this._defineState('zombie_painb1', 'painb1', 'zombie_painb2', () => { this.startSound(channel.CHAN_VOICE, 'zombie/z_pain1.wav'); });
    this._defineState('zombie_painb2', 'painb2', 'zombie_painb3', () => { this._ai.pain(2); });
    this._defineState('zombie_painb3', 'painb3', 'zombie_painb4', () => { this._ai.pain(8); });
    this._defineState('zombie_painb4', 'painb4', 'zombie_painb5', () => { this._ai.pain(6); });
    this._defineState('zombie_painb5', 'painb5', 'zombie_painb6', () => { this._ai.pain(2); });
    this._defineState('zombie_painb6', 'painb6', 'zombie_painb7', () => {});
    this._defineState('zombie_painb7', 'painb7', 'zombie_painb8', () => {});
    this._defineState('zombie_painb8', 'painb8', 'zombie_painb9', () => {});
    this._defineState('zombie_painb9', 'painb9', 'zombie_painb10', () => { this.startSound(channel.CHAN_BODY, 'zombie/z_fall.wav'); });
    this._defineState('zombie_painb10', 'painb10', 'zombie_painb11', () => {});
    this._defineState('zombie_painb11', 'painb11', 'zombie_painb12', () => {});
    this._defineState('zombie_painb12', 'painb12', 'zombie_painb13', () => {});
    this._defineState('zombie_painb13', 'painb13', 'zombie_painb14', () => {});
    this._defineState('zombie_painb14', 'painb14', 'zombie_painb15', () => {});
    this._defineState('zombie_painb15', 'painb15', 'zombie_painb16', () => {});
    this._defineState('zombie_painb16', 'painb16', 'zombie_painb17', () => {});
    this._defineState('zombie_painb17', 'painb17', 'zombie_painb18', () => {});
    this._defineState('zombie_painb18', 'painb18', 'zombie_painb19', () => {});
    this._defineState('zombie_painb19', 'painb19', 'zombie_painb20', () => {});
    this._defineState('zombie_painb20', 'painb20', 'zombie_painb21', () => {});
    this._defineState('zombie_painb21', 'painb21', 'zombie_painb22', () => {});
    this._defineState('zombie_painb22', 'painb22', 'zombie_painb23', () => {});
    this._defineState('zombie_painb23', 'painb23', 'zombie_painb24', () => {});
    this._defineState('zombie_painb24', 'painb24', 'zombie_painb25', () => {});
    this._defineState('zombie_painb25', 'painb25', 'zombie_painb26', () => { this._ai.painforward(1); });
    this._defineState('zombie_painb26', 'painb26', 'zombie_painb27', () => {});
    this._defineState('zombie_painb27', 'painb27', 'zombie_painb28', () => {});
    this._defineState('zombie_painb28', 'painb28', 'zombie_run1', () => {});

    // pain sequences (painc)
    this._defineState('zombie_painc1', 'painc1', 'zombie_painc2', () => { this.startSound(channel.CHAN_VOICE, 'zombie/z_pain1.wav'); });
    this._defineState('zombie_painc2', 'painc2', 'zombie_painc3', () => {});
    this._defineState('zombie_painc3', 'painc3', 'zombie_painc4', () => { this._ai.pain(3); });
    this._defineState('zombie_painc4', 'painc4', 'zombie_painc5', () => { this._ai.pain(1); });
    this._defineState('zombie_painc5', 'painc5', 'zombie_painc6', () => {});
    this._defineState('zombie_painc6', 'painc6', 'zombie_painc7', () => {});
    this._defineState('zombie_painc7', 'painc7', 'zombie_painc8', () => {});
    this._defineState('zombie_painc8', 'painc8', 'zombie_painc9', () => {});
    this._defineState('zombie_painc9', 'painc9', 'zombie_painc10', () => {});
    this._defineState('zombie_painc10', 'painc10', 'zombie_painc11', () => {});
    this._defineState('zombie_painc11', 'painc11', 'zombie_painc12', () => { this._ai.painforward(1); });
    this._defineState('zombie_painc12', 'painc12', 'zombie_painc13', () => { this._ai.painforward(1); });
    this._defineState('zombie_painc13', 'painc13', 'zombie_painc14', () => {});
    this._defineState('zombie_painc14', 'painc14', 'zombie_painc15', () => {});
    this._defineState('zombie_painc15', 'painc15', 'zombie_painc16', () => {});
    this._defineState('zombie_painc16', 'painc16', 'zombie_painc17', () => {});
    this._defineState('zombie_painc17', 'painc17', 'zombie_painc18', () => {});
    this._defineState('zombie_painc18', 'painc18', 'zombie_run1', () => {});

    // pain sequences (paind)
    this._defineState('zombie_paind1', 'paind1', 'zombie_paind2', () => { this.startSound(channel.CHAN_VOICE, 'zombie/z_pain.wav'); });
    this._defineState('zombie_paind2', 'paind2', 'zombie_paind3', () => {});
    this._defineState('zombie_paind3', 'paind3', 'zombie_paind4', () => {});
    this._defineState('zombie_paind4', 'paind4', 'zombie_paind5', () => {});
    this._defineState('zombie_paind5', 'paind5', 'zombie_paind6', () => {});
    this._defineState('zombie_paind6', 'paind6', 'zombie_paind7', () => {});
    this._defineState('zombie_paind7', 'paind7', 'zombie_paind8', () => {});
    this._defineState('zombie_paind8', 'paind8', 'zombie_paind9', () => {});
    this._defineState('zombie_paind9', 'paind9', 'zombie_paind10', () => { this._ai.pain(1); });
    this._defineState('zombie_paind10', 'paind10', 'zombie_paind11', () => {});
    this._defineState('zombie_paind11', 'paind11', 'zombie_paind12', () => {});
    this._defineState('zombie_paind12', 'paind12', 'zombie_paind13', () => {});
    this._defineState('zombie_paind13', 'paind13', 'zombie_run1', () => {});

    // pain sequences (paine)
    this._defineState('zombie_paine1', 'paine1', 'zombie_paine2', () => { this.startSound(channel.CHAN_VOICE, 'zombie/z_pain.wav'); this.health = 60; });
    this._defineState('zombie_paine2', 'paine2', 'zombie_paine3', () => { this._ai.pain(8); });
    this._defineState('zombie_paine3', 'paine3', 'zombie_paine4', () => { this._ai.pain(5); });
    this._defineState('zombie_paine4', 'paine4', 'zombie_paine5', () => { this._ai.pain(3); });
    this._defineState('zombie_paine5', 'paine5', 'zombie_paine6', () => { this._ai.pain(1); });
    this._defineState('zombie_paine6', 'paine6', 'zombie_paine7', () => { this._ai.pain(2); });
    this._defineState('zombie_paine7', 'paine7', 'zombie_paine8', () => { this._ai.pain(1); });
    this._defineState('zombie_paine8', 'paine8', 'zombie_paine9', () => { this._ai.pain(1); });
    this._defineState('zombie_paine9', 'paine9', 'zombie_paine10', () => { this._ai.pain(2); });
    this._defineState('zombie_paine10', 'paine10', 'zombie_paine11', () => { this.startSound(channel.CHAN_BODY, 'zombie/z_fall.wav'); this.solid = solid.SOLID_NOT; });
    this._defineState('zombie_paine11', 'paine11', 'zombie_paine12', () => { this.nextthink += 5; this.health = 60; });
    this._defineState('zombie_paine12', 'paine12', 'zombie_paine13', () => { /* stand-up logic */ });
    this._defineState('zombie_paine13', 'paine13', 'zombie_paine14', () => {});
    this._defineState('zombie_paine14', 'paine14', 'zombie_paine15', () => {});
    this._defineState('zombie_paine15', 'paine15', 'zombie_paine16', () => {});
    this._defineState('zombie_paine16', 'paine16', 'zombie_paine17', () => {});
    this._defineState('zombie_paine17', 'paine17', 'zombie_paine18', () => {});
    this._defineState('zombie_paine18', 'paine18', 'zombie_paine19', () => {});
    this._defineState('zombie_paine19', 'paine19', 'zombie_paine20', () => {});
    this._defineState('zombie_paine20', 'paine20', 'zombie_paine21', () => {});
    this._defineState('zombie_paine21', 'paine21', 'zombie_paine22', () => {});
    this._defineState('zombie_paine22', 'paine22', 'zombie_paine23', () => {});
    this._defineState('zombie_paine23', 'paine23', 'zombie_paine24', () => {});
    this._defineState('zombie_paine24', 'paine24', 'zombie_paine25', () => {});
    this._defineState('zombie_paine25', 'paine25', 'zombie_paine26', () => { this._ai.painforward(5); });
    this._defineState('zombie_paine26', 'paine26', 'zombie_paine27', () => { this._ai.painforward(3); });
    this._defineState('zombie_paine27', 'paine27', 'zombie_paine28', () => { this._ai.painforward(1); });
    this._defineState('zombie_paine28', 'paine28', 'zombie_paine29', () => { this._ai.pain(1); });
    this._defineState('zombie_paine29', 'paine29', 'zombie_paine30', () => {});
    this._defineState('zombie_paine30', 'paine30', 'zombie_run1', () => {});
  }

  thinkStand() {
    this._runState('zombie_stand1');
  }

  thinkWalk() {
    this._runState('zombie_walk1');
  }

  thinkRun() {
    this._runState('zombie_run1');
  }

  thinkMissile() {
    // randomly choose grenade attack variant
    const r = Math.random();
    if (r < 0.3) {this._runState('zombie_atta1');}
    else if (r < 0.6) {this._runState('zombie_attb1');}
    else {this._runState('zombie_attc1');}
  }

  hasMeleeAttack() {
    return true;
  }

  hasMissileAttack() {
    return true;
  }

  _postSpawn() {
    // crucified zombie prop is no longer a monster
    if ((this.spawnflags & ZombieMonster.SPAWN_CRUCIFIED) !== 0) {
      this._damageHandler = null;
      this.movetype = moveType.MOVETYPE_NONE;
      this.takedamage = damage.DAMAGE_NO;
      this.solid = solid.SOLID_NOT;
      this._runState('zombie_cruc1');
      return;
    }

    super._postSpawn();
  }

  // pain reaction
  thinkPain(attackerEntity, damage) {
    // always reset health to max
    this.health = this.constructor._health;

    // ignore small hits
    if (damage < 9) {
      return;
    }

    // already knocked down
    if (this.inpain === 2) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

    // big hit knocks to ground
    if (damage >= 25) {
      this.inpain = 2;
      this._runState('zombie_paine1');
      return;
    }

    // extend pain window if in quick pain
    if (this.inpain === 1) {
      this.pain_finished = this.game.time + 3;
      return;
    }

    // second hit within window also knock down
    if (this.pain_finished > this.game.time) {
      this.inpain = 2;
      this._runState('zombie_paine1');
      return;
    }

    // enter quick pain sequence
    this.inpain = 1;
    this.pain_finished = this.game.time + 3;

    const r = Math.random();

    if (r < 0.25) {
      this._runState('zombie_paina1');
    } else if (r < 0.5) {
      this._runState('zombie_painb1');
    } else if (r < 0.75) {
      this._runState('zombie_painc1');
    } else {
      this._runState('zombie_paind1');
    }
  }

  // death reaction
  thinkDie(attackerEntity) {
    this._sub.useTargets(attackerEntity);
    if (this.health < -35) {
      this._gib(true);
      return;
    }
    this.deathSound();
    this.solid = solid.SOLID_NOT;
    // immediate gib effect: use zombie_die logic
    this._gib(false);
  }

  // override sounds
  deathSound() {
    this.startSound(channel.CHAN_VOICE, 'zombie/z_gib.wav');
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, 'zombie/z_pain.wav');
  }

  // firing grenade
  _fireGrenade(offset) {
    this.startSound(channel.CHAN_WEAPON, 'zombie/z_shot1.wav');
    ZombieGibGrenade.Throw(this, offset);
  }

  // optional idle/sight sounds
  sightSound() {
    this.startSound(channel.CHAN_VOICE, 'zombie/z_hit.wav');
  }

  idleSound() {
    if (Math.random() < 0.1) {return;}
    this.startSound(channel.CHAN_VOICE, 'zombie/z_idle.wav', 1.0, attn.ATTN_IDLE);
  }
};

export class ZombieGibGrenade extends BaseEntity {
  static classname = 'monster_zombie_giblet';

  _declareFields() {
    this._damageInflictor = new DamageInflictor(this);
    this._serializer.startFields();
    this._alreadyMissed = false;
    this._serializer.endFields();
  }

  /**
   * @param {BaseEntity} other touched by
   */
  touch(other) {
    if (this._alreadyMissed) {
      this.remove();
      return;
    }

    if (other.equals(this.owner)) {
      return;
    }

    if (other.takedamage) {
      this.damage(other, 10, this.owner);
      this.startSound(channel.CHAN_WEAPON, 'zombie/z_hit.wav');
      this.remove();
      return;
    }

    this.startSound(channel.CHAN_WEAPON, 'zombie/z_miss.wav');

    this.velocity.clear();
    this.avelocity.clear();
    this._alreadyMissed = true;
  }

  spawn() {
    console.assert(this.owner instanceof BaseEntity, 'owner required');
    console.assert(this.owner.enemy instanceof BaseEntity, 'owner.enemy required');

    this.movetype = moveType.MOVETYPE_BOUNCE;
    this.solid = solid.SOLID_BBOX;

    // CR: here we have undefined behavior in QuakeC, makevectors is called before the calculation, I’m fixing it here despite risking a different gameplay experience
    const { forward, up, right } = this.angles.angleVectors();

    // calc origin
    const st = this.velocity; // we smuggle st in velocity
    const origin = this.origin.copy()
      .add(forward.multiply(st[0]))
      .add(right.multiply(st[1]))
      .add(up.multiply(st[2] - 24.0));

    this.velocity.set(this.owner.calculateTrajectoryVelocity(this.owner.enemy, origin));
    this.avelocity.setTo(3000.0, 1000.0, 2000.0);

    // missile duration
    this._scheduleThink(this.game.time + 2.5, () => this.remove());

    this.setModel('progs/zom_gib.mdl');
    this.setSize(Vector.origin, Vector.origin);
    this.setOrigin(origin);
  }

  /**
   * Tosses a giblet grenade.
   * @param {ZombieMonster} entity zombie throwing the giblet
   * @param {Vector} offset offset
   */
  static Throw(entity, offset) {
    entity.engine.SpawnEntity(ZombieGibGrenade.classname, {
      origin: entity.origin.copy(),
      angles: entity.angles.copy(),
      velocity: offset.copy(),
      owner: entity,
    });
  }
};

/* global Vector */

import { moveType, solid } from "../../Defs.mjs";
import BaseMonster from "./BaseMonster.mjs";

export default class ArmySoldierMonster extends BaseMonster {
  static classname = 'monster_army';

  _precache() {
    this.engine.PrecacheModel("progs/soldier.mdl");
    this.engine.PrecacheModel("progs/h_guard.mdl");
    this.engine.PrecacheModel("progs/gib1.mdl");
    this.engine.PrecacheModel("progs/gib2.mdl");
    this.engine.PrecacheModel("progs/gib3.mdl");

    this.engine.PrecacheSound("soldier/death1.wav");
    this.engine.PrecacheSound("soldier/idle.wav");
    this.engine.PrecacheSound("soldier/pain1.wav");
    this.engine.PrecacheSound("soldier/pain2.wav");
    this.engine.PrecacheSound("soldier/sattck1.wav");
    this.engine.PrecacheSound("soldier/sight1.wav");

    this.engine.PrecacheSound("player/udeath.wav");		// gib death
  }

  _initStates() {
    this._defineState('army_stand1', 'stand1', 'army_stand2', () => this._ai.stand());
    this._defineState('army_stand2', 'stand2', 'army_stand3', () => this._ai.stand());
    this._defineState('army_stand3', 'stand3', 'army_stand4', () => this._ai.stand());
    this._defineState('army_stand4', 'stand4', 'army_stand5', () => this._ai.stand());
    this._defineState('army_stand5', 'stand5', 'army_stand6', () => this._ai.stand());
    this._defineState('army_stand6', 'stand6', 'army_stand7', () => this._ai.stand());
    this._defineState('army_stand7', 'stand7', 'army_stand8', () => this._ai.stand());
    this._defineState('army_stand8', 'stand8', 'army_stand1', () => this._ai.stand());
  }

  spawn() {
    if (this.game.deathmatch) {
      this.remove();
      return;
    }

    this.solid = solid.SOLID_SLIDEBOX;
    this.movetype = moveType.MOVETYPE_STEP;

    this.setModel("progs/soldier.mdl");
    this.setSize(new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 40.0));
    this.health = 30;

    // this.walkmonsterStart();

    // start with standing
    this._runState('army_stand1');
  }

}

import BaseEntity from './BaseEntity.mjs';

import { Precache as WeaponsPrecache } from './Weapons.mjs';

export class BodyqueEntity extends BaseEntity {
  static classname = 'bodyque';

  /** @protected */
  _declareFields() {
    this._serializer.startFields();

    this.colormap = 0;

    this._serializer.endFields();
  }
};

/**
 * @param {import("../GameAPI.mjs").ServerGameAPI} game gameAPI
 */
function InitBodyQue(game) {
  game.bodyque_head = game.engine.SpawnEntity(BodyqueEntity.classname);

  let current = game.bodyque_head;

  for (let i = 0; i < 5; i++, current = current.owner) {
    current.owner = game.engine.SpawnEntity(BodyqueEntity.classname);
  }

  current.owner = game.bodyque_head;
}

/**
 * copies entity to the body que
 * @param {import("../GameAPI.mjs").ServerGameAPI} game gameAPI
 * @param {BaseEntity} entity entity to be copied
 */
export function CopyToBodyQue(game, entity) {
  game.bodyque_head.angles = entity.angles;
  game.bodyque_head.setModel(entity.model);
  game.bodyque_head.frame = entity.frame;
  game.bodyque_head.colormap = entity.colormap;
  game.bodyque_head.movetype = entity.movetype;
  game.bodyque_head.velocity = entity.velocity;
  game.bodyque_head.flags = 0;
  game.bodyque_head.setOrigin(entity.origin);
  game.bodyque_head.setSize(entity.mins, entity.maxs);
  game.bodyque_head = game.bodyque_head.owner;
};

export class WorldspawnEntity extends BaseEntity {
  static classname = 'worldspawn';

  _declareFields() {
    this._serializer.startFields();

    /** @type {string} wad file containing textures, only used by the compiler tools */
    this.wad = null;
    /** @type {string} proper map name */
    this.message = null;
    /** @type {number} 0 = medival, 1 = runes, 2 = techbase */
    this.worldtype = 0;
    /** @type {number} sets gravity */
    this.qs_gravity = 0;
    /** @type {number} cdtrack */
    this.sounds = 0;

    this._serializer.endFields();
  }

  _precache() {
    // the area based ambient sounds MUST be the first precache_sounds

    // player precaches
    WeaponsPrecache(this.engine);

    // sounds used from C physics code
    this.engine.PrecacheSound('demon/dland2.wav');		// landing thud
    this.engine.PrecacheSound('misc/h2ohit1.wav');		// landing splash

    // setup precaches allways needed
    this.engine.PrecacheSound('items/itembk2.wav');		// item respawn sound
    this.engine.PrecacheSound('player/plyrjmp8.wav');		// player jump
    this.engine.PrecacheSound('player/land.wav');			// player landing
    this.engine.PrecacheSound('player/land2.wav');		// player hurt landing
    this.engine.PrecacheSound('player/drown1.wav');		// drowning pain
    this.engine.PrecacheSound('player/drown2.wav');		// drowning pain
    this.engine.PrecacheSound('player/gasp1.wav');		// gasping for air
    this.engine.PrecacheSound('player/gasp2.wav');		// taking breath
    this.engine.PrecacheSound('player/h2odeath.wav');		// drowning death

    this.engine.PrecacheSound('misc/talk.wav');			// talk
    this.engine.PrecacheSound('player/teledth1.wav');		// telefrag
    this.engine.PrecacheSound('misc/r_tele1.wav');		// teleport sounds
    this.engine.PrecacheSound('misc/r_tele2.wav');
    this.engine.PrecacheSound('misc/r_tele3.wav');
    this.engine.PrecacheSound('misc/r_tele4.wav');
    this.engine.PrecacheSound('misc/r_tele5.wav');
    this.engine.PrecacheSound('weapons/lock4.wav');		// ammo pick up
    this.engine.PrecacheSound('weapons/pkup.wav');		// weapon up
    this.engine.PrecacheSound('items/armor1.wav');		// armor up
    this.engine.PrecacheSound('weapons/lhit.wav');		//lightning
    this.engine.PrecacheSound('weapons/lstart.wav');		//lightning start
    this.engine.PrecacheSound('items/damage3.wav');

    this.engine.PrecacheSound('misc/power.wav');			//lightning for boss

    // player gib sounds
    this.engine.PrecacheSound('player/gib.wav');			// player gib sound
    this.engine.PrecacheSound('player/udeath.wav');		// player gib sound
    this.engine.PrecacheSound('player/tornoff2.wav');		// gib sound

    // player pain sounds

    this.engine.PrecacheSound('player/pain1.wav');
    this.engine.PrecacheSound('player/pain2.wav');
    this.engine.PrecacheSound('player/pain3.wav');
    this.engine.PrecacheSound('player/pain4.wav');
    this.engine.PrecacheSound('player/pain5.wav');
    this.engine.PrecacheSound('player/pain6.wav');

    // player death sounds
    this.engine.PrecacheSound('player/death1.wav');
    this.engine.PrecacheSound('player/death2.wav');
    this.engine.PrecacheSound('player/death3.wav');
    this.engine.PrecacheSound('player/death4.wav');
    this.engine.PrecacheSound('player/death5.wav');

    // ax sounds
    this.engine.PrecacheSound('weapons/ax1.wav');			// ax swoosh
    this.engine.PrecacheSound('player/axhit1.wav');		// ax hit meat
    this.engine.PrecacheSound('player/axhit2.wav');		// ax hit world

    this.engine.PrecacheSound('player/h2ojump.wav');		// player jumping into water
    this.engine.PrecacheSound('player/slimbrn2.wav');		// player enter slime
    this.engine.PrecacheSound('player/inh2o.wav');		// player enter water
    this.engine.PrecacheSound('player/inlava.wav');		// player enter lava
    this.engine.PrecacheSound('misc/outwater.wav');		// leaving water sound

    this.engine.PrecacheSound('player/lburn1.wav');		// lava burn
    this.engine.PrecacheSound('player/lburn2.wav');		// lava burn

    this.engine.PrecacheSound('misc/water1.wav');			// swimming
    this.engine.PrecacheSound('misc/water2.wav');			// swimming

    this.engine.PrecacheModel('progs/player.mdl');
    this.engine.PrecacheModel('progs/eyes.mdl');
    this.engine.PrecacheModel('progs/h_player.mdl');
    this.engine.PrecacheModel('progs/gib1.mdl');
    this.engine.PrecacheModel('progs/gib2.mdl');
    this.engine.PrecacheModel('progs/gib3.mdl');

    this.engine.PrecacheModel('progs/s_bubble.spr');	// drowning bubbles
    this.engine.PrecacheModel('progs/s_explod.spr');	// sprite explosion

    this.engine.PrecacheModel('progs/v_axe.mdl');
    this.engine.PrecacheModel('progs/v_shot.mdl');
    this.engine.PrecacheModel('progs/v_nail.mdl');
    this.engine.PrecacheModel('progs/v_rock.mdl');
    this.engine.PrecacheModel('progs/v_shot2.mdl');
    this.engine.PrecacheModel('progs/v_nail2.mdl');
    this.engine.PrecacheModel('progs/v_rock2.mdl');

    this.engine.PrecacheModel('progs/bolt.mdl');		// for lightning gun
    this.engine.PrecacheModel('progs/bolt2.mdl');		// for lightning gun
    this.engine.PrecacheModel('progs/bolt3.mdl');		// for boss shock
    this.engine.PrecacheModel('progs/lavaball.mdl');	// for testing

    this.engine.PrecacheModel('progs/missile.mdl');
    this.engine.PrecacheModel('progs/grenade.mdl');
    this.engine.PrecacheModel('progs/spike.mdl');
    this.engine.PrecacheModel('progs/s_spike.mdl');

    this.engine.PrecacheModel('progs/backpack.mdl');

    this.engine.PrecacheModel('progs/zom_gib.mdl');

    this.engine.PrecacheModel('progs/v_light.mdl');

    this.engine.PrecacheModel('progs/s_light.spr'); // for debug_marker
  }

  spawn() {
    this.game.lastspawn = this.game.worldspawn;
    this.game.worldspawn = this;

    InitBodyQue(this.game);

    // custom map attributes
    this.engine.SetCvar('sv_gravity', this.model === 'maps/e1m8.bsp' ? 100 : 800);

    // QuakeShack: allow maps to set gravity per map
    if (this.qs_gravity) {
      this.engine.SetCvar('sv_gravity', this.qs_gravity);
    }

    //
    // Setup light animation tables. 'a' is total darkness, 'z' is maxbright.
    //

    // 0 normal
    this.engine.Lightstyle(0, 'm');

    // 1 FLICKER (first variety)
    this.engine.Lightstyle(1, 'mmnmmommommnonmmonqnmmo');

    // 2 SLOW STRONG PULSE
    this.engine.Lightstyle(2, 'abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba');

    // 3 CANDLE (first variety)
    this.engine.Lightstyle(3, 'mmmmmaaaaammmmmaaaaaabcdefgabcdefg');

    // 4 FAST STROBE
    this.engine.Lightstyle(4, 'mamamamamama');

    // 5 GENTLE PULSE 1
    this.engine.Lightstyle(5, 'jklmnopqrstuvwxyzyxwvutsrqponmlkj');

    // 6 FLICKER (second variety)
    this.engine.Lightstyle(6, 'nmonqnmomnmomomno');

    // 7 CANDLE (second variety)
    this.engine.Lightstyle(7, 'mmmaaaabcdefgmmmmaaaammmaamm');

    // 8 CANDLE (third variety)
    this.engine.Lightstyle(8, 'mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa');

    // 9 SLOW STROBE (fourth variety)
    this.engine.Lightstyle(9, 'aaaaaaaazzzzzzzz');

    // 10 FLUORESCENT FLICKER
    this.engine.Lightstyle(10, 'mmamammmmammamamaaamammma');

    // 11 SLOW PULSE NOT FADE TO BLACK
    this.engine.Lightstyle(11, 'abcdefghijklmnopqrrqponmlkjihgfedcba');

    // styles 32-62 are assigned by the light program for switchable lights

    // 63 testing
    this.engine.Lightstyle(63, 'a');
  }
};

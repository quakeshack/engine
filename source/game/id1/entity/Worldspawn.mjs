import BaseEntity from "./BaseEntity.mjs";

export class WorldspawnEntity extends BaseEntity {
  classname = 'worldspawn';

  spawn() {
    this.engine.PrecacheModel('progs/player.mdl');

    //
    // Setup light animation tables. 'a' is total darkness, 'z' is maxbright.
    //

    // 0 normal
    this.engine.Lightstyle(0, "m");

    // 1 FLICKER (first variety)
    this.engine.Lightstyle(1, "mmnmmommommnonmmonqnmmo");

    // 2 SLOW STRONG PULSE
    this.engine.Lightstyle(2, "abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba");

    // 3 CANDLE (first variety)
    this.engine.Lightstyle(3, "mmmmmaaaaammmmmaaaaaabcdefgabcdefg");

    // 4 FAST STROBE
    this.engine.Lightstyle(4, "mamamamamama");

    // 5 GENTLE PULSE 1
    this.engine.Lightstyle(5,"jklmnopqrstuvwxyzyxwvutsrqponmlkj");

    // 6 FLICKER (second variety)
    this.engine.Lightstyle(6, "nmonqnmomnmomomno");

    // 7 CANDLE (second variety)
    this.engine.Lightstyle(7, "mmmaaaabcdefgmmmmaaaammmaamm");

    // 8 CANDLE (third variety)
    this.engine.Lightstyle(8, "mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa");

    // 9 SLOW STROBE (fourth variety)
    this.engine.Lightstyle(9, "aaaaaaaazzzzzzzz");

    // 10 FLUORESCENT FLICKER
    this.engine.Lightstyle(10, "mmamammmmammamamaaamammma");

    // 11 SLOW PULSE NOT FADE TO BLACK
    this.engine.Lightstyle(11, "abcdefghijklmnopqrrqponmlkjihgfedcba");

    // styles 32-62 are assigned by the light program for switchable lights

    // 63 testing
    this.engine.Lightstyle(63, "a");
  }
};

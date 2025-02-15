
/**
 * called by worldspawn
 * @param engine
 */
export function Precache(engine) {
	// TODO: move “use in c code” precache commands back to the engine
	engine.PrecacheSound("weapons/r_exp3.wav");	// new rocket explosion
	engine.PrecacheSound("weapons/rocket1i.wav");	// spike gun
	engine.PrecacheSound("weapons/sgun1.wav");
	engine.PrecacheSound("weapons/guncock.wav");	// player shotgun
	engine.PrecacheSound("weapons/ric1.wav");	// ricochet (used in c code)
	engine.PrecacheSound("weapons/ric2.wav");	// ricochet (used in c code)
	engine.PrecacheSound("weapons/ric3.wav");	// ricochet (used in c code)
	engine.PrecacheSound("weapons/spike2.wav");	// super spikes
	engine.PrecacheSound("weapons/tink1.wav");	// spikes tink (used in c code)
	engine.PrecacheSound("weapons/grenade.wav");	// grenade launcher
	engine.PrecacheSound("weapons/bounce.wav");		// grenade bounce
	engine.PrecacheSound("weapons/shotgn2.wav");	// super shotgun
};



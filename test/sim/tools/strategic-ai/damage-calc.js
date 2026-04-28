'use strict';

const assert = require('../../../assert');

const { calculateDamage, estimateMaxHp } =
	require('../../../../dist/sim/tools/strategic-ai/mechanics/DamageCalc');
const { Dex } = require('../../../../dist/sim');

function emptySide() {
	return {
		stealthRock: false,
		spikes: 0,
		toxicSpikes: 0,
		stickyWeb: false,
		reflectTurns: 0,
		lightScreenTurns: 0,
		auroraVeilTurns: 0,
		tailwindTurns: 0,
		safeguardTurns: 0,
		mistTurns: 0,
		fainted: 0,
	};
}

function emptyField(weather = '', terrain = '') {
	return {
		weather,
		weatherTurns: 0,
		terrain,
		terrainTurns: 0,
		trickRoom: false,
		trickRoomTurns: 0,
		magicRoom: false,
		wonderRoom: false,
		gravity: false,
		gravityTurns: 0,
	};
}

/**
 * Build a fully-specified `CalcPokemon` from a species name. Defaults
 * to a fully-invested level-100 mon with no boosts.
 */
function mkMon(speciesName, opts = {}) {
	const species = Dex.species.get(speciesName);
	if (!species.exists) throw new Error(`Unknown species: ${speciesName}`);
	const types = opts.types ?? [...species.types];
	return {
		species: species.id,
		types,
		level: opts.level ?? 100,
		ability: opts.ability ?? '',
		item: opts.item ?? '',
		status: opts.status ?? '',
		boosts: opts.boosts ?? {},
		hpFraction: opts.hpFraction ?? 1,
		teraType: opts.teraType,
		terastallized: opts.terastallized ?? false,
		volatiles: new Set(opts.volatiles || []),
	};
}

function calc(opts) {
	return calculateDamage({
		attacker: opts.attacker,
		defender: opts.defender,
		move: Dex.moves.get(opts.move),
		field: opts.field || emptyField(),
		attackerSide: emptySide(),
		defenderSide: emptySide(),
		isDoubles: !!opts.isDoubles,
	});
}

describe('Strategic-AI DamageCalc', () => {
	it('respects type immunity (Earthquake into Levitate Latios)', () => {
		const result = calc({
			attacker: mkMon('Garchomp'),
			defender: mkMon('Latios', { ability: 'levitate' }),
			move: 'earthquake',
		});
		assert(result.immune, 'Earthquake should be immune through Levitate');
		assert.equal(result.avgDamage, 0);
	});

	it('respects type immunity from typing (Normal into Ghost)', () => {
		const result = calc({
			attacker: mkMon('Snorlax'),
			defender: mkMon('Gengar'),
			move: 'bodyslam',
		});
		assert(result.immune, 'Body Slam should be Ghost-immune');
	});

	it('STAB and supereffective: Garchomp Earthquake on Heatran is huge', () => {
		const ground = calc({
			attacker: mkMon('Garchomp'),
			defender: mkMon('Heatran'),
			move: 'earthquake',
		});
		const fire = calc({
			attacker: mkMon('Garchomp'),
			defender: mkMon('Skarmory'),
			move: 'earthquake',
		});
		assert(!ground.immune);
		const groundFraction = ground.avgDamage / ground.defenderMaxHp;
		const fireFraction = fire.avgDamage / fire.defenderMaxHp;
		assert(groundFraction > 0.4, `Earthquake vs Heatran should deal heavy damage; got ${groundFraction.toFixed(2)}`);
		assert(groundFraction > fireFraction * 1.5,
			`Heatran should take more from EQ than Skarmory does (got ${groundFraction.toFixed(2)} vs ${fireFraction.toFixed(2)})`);
	});

	it('hit chance reflects move accuracy', () => {
		const reliable = calc({
			attacker: mkMon('Garchomp'),
			defender: mkMon('Heatran'),
			move: 'earthquake',
		});
		const shaky = calc({
			attacker: mkMon('Hydreigon'),
			defender: mkMon('Heatran'),
			move: 'focusblast',
		});
		assert.equal(reliable.hitChance, 1, 'Earthquake should be 100% accurate');
		assert(shaky.hitChance < 1, 'Focus Blast should be < 100% accurate');
	});

	it('flags status moves as non-damaging', () => {
		const result = calc({
			attacker: mkMon('Toxapex'),
			defender: mkMon('Garchomp'),
			move: 'toxic',
		});
		assert(result.status, 'Toxic should be flagged as a status move');
		assert.equal(result.avgDamage, 0);
	});

	it('koProbability stays in [0, 1]', () => {
		const result = calc({
			attacker: mkMon('Garchomp', { boosts: { atk: 6 } }),
			defender: mkMon('Blissey', { hpFraction: 0.05 }),
			move: 'earthquake',
		});
		assert(result.koProbability >= 0 && result.koProbability <= 1,
			`koProbability should be in [0,1]; got ${result.koProbability}`);
	});

	it('returns DAMAGE_ROLLS in min<=avg<=max order', () => {
		const result = calc({
			attacker: mkMon('Garchomp'),
			defender: mkMon('Heatran'),
			move: 'earthquake',
		});
		assert(result.minDamage <= result.avgDamage,
			`min ${result.minDamage} should be <= avg ${result.avgDamage}`);
		assert(result.avgDamage <= result.maxDamage,
			`avg ${result.avgDamage} should be <= max ${result.maxDamage}`);
	});

	it('multi-hit moves account for the variable hit distribution', () => {
		const result = calc({
			attacker: mkMon('Cinccino', { ability: 'skilllink' }),
			defender: mkMon('Blissey'),
			move: 'tailslap',
		});
		assert(result.minDamage > 0);
		assert(result.maxDamage > result.minDamage,
			'multi-hit moves should produce a range of total damage');
	});

	it('estimateMaxHp returns positive HP for valid species', () => {
		const blissey = estimateMaxHp(mkMon('Blissey'));
		const ferrothorn = estimateMaxHp(mkMon('Ferrothorn'));
		assert(blissey > ferrothorn,
			`Blissey HP (${blissey}) should be greater than Ferrothorn HP (${ferrothorn})`);
		assert(blissey > 600, 'Blissey at 252 HP EV should be over 600 HP');
	});

	it('weather: Rain boosts Water moves and weakens Fire moves', () => {
		const sun = calc({
			attacker: mkMon('Charizard'),
			defender: mkMon('Latios'),
			move: 'flamethrower',
			field: emptyField('sunnyday'),
		});
		const rain = calc({
			attacker: mkMon('Charizard'),
			defender: mkMon('Latios'),
			move: 'flamethrower',
			field: emptyField('raindance'),
		});
		assert(sun.avgDamage > rain.avgDamage,
			`Sun should boost Fire moves over Rain (sun=${sun.avgDamage}, rain=${rain.avgDamage})`);
	});
});

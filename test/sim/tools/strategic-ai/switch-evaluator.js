'use strict';

const assert = require('../../../assert');

const { evaluateMatchup, chooseBestSwitch } =
	require('../../../../dist/sim/tools/strategic-ai/mechanics/SwitchEvaluator');
const { BattleStateTracker } =
	require('../../../../dist/sim/tools/strategic-ai/state/BattleStateTracker');
const { Dex } = require('../../../../dist/sim');

/**
 * Build a TrackedPokemon-shaped record from species + overrides. We
 * skip `applyRequest` because we don't actually need the request
 * machinery here; we just need the same fields the evaluator reads.
 */
function mkTracked(speciesName, opts = {}) {
	const species = Dex.species.get(speciesName);
	if (!species.exists) throw new Error(`Unknown species: ${speciesName}`);
	const types = opts.types ?? [...species.types];
	return {
		id: `mon:${species.id}`,
		name: species.name,
		species: species.id,
		level: opts.level ?? 100,
		condition: '100/100',
		hpFraction: opts.hpFraction ?? 1,
		status: opts.status ?? '',
		boosts: opts.boosts ?? {},
		types,
		teraType: opts.teraType,
		terastallized: opts.terastallized ?? false,
		ability: opts.ability ?? '',
		baseAbility: opts.ability ?? '',
		item: opts.item ?? '',
		revealedMoves: new Set(opts.revealedMoves || []),
		lastMove: opts.lastMove,
		sameMoveStreak: opts.sameMoveStreak ?? 0,
		choiceLocked: opts.choiceLocked ?? false,
		stats: opts.stats,
		volatiles: new Set(opts.volatiles || []),
		fainted: !!opts.fainted,
		active: !!opts.active,
		position: opts.position ?? -1,
	};
}

function freshTracker() {
	return new BattleStateTracker({ mySide: 'p1' });
}

describe('Strategic-AI SwitchEvaluator', () => {
	describe('regression: type-matchup math', () => {
		// The legacy `calculateTypeEffectiveness` multiplied attacker
		// types AGAINST defender types, which is wrong: a Water/Flying
		// attacker would look "weak" vs Rock even though it can pick the
		// move it actually attacks with. The current evaluator scores
		// matchups by *move* type, so a dual-STAB attacker should
		// correctly preferred against a defender that resists only one
		// of its STABs.
		it('Charizard (Fire/Flying) into Stealth Rock takes 50% (4x Rock weakness)', () => {
			const tracker = freshTracker();
			tracker.sides.p1.stealthRock = true;

			const charizard = mkTracked('Charizard', {
				ability: 'blaze',
				revealedMoves: ['flamethrower', 'airslash'],
			});
			const tyranitar = mkTracked('Tyranitar', {
				ability: 'sandstream',
				revealedMoves: ['stoneedge', 'crunch'],
			});

			const score = evaluateMatchup(charizard, tyranitar, tracker);
			assert(score.hazardFraction > 0.4,
				`Charizard into SR should take ~50% (got ${score.hazardFraction.toFixed(2)})`);
			assert(score.score < 0,
				`Charizard should score negatively into TTar with SR up (got ${score.score.toFixed(2)})`);
		});

		it('Garchomp into Heatran is a clean offensive matchup (EQ STAB)', () => {
			const tracker = freshTracker();
			const garchomp = mkTracked('Garchomp', {
				ability: 'roughskin',
				revealedMoves: ['earthquake', 'dragonclaw'],
			});
			const heatran = mkTracked('Heatran', {
				ability: 'flashfire',
				revealedMoves: ['magmastorm', 'earthpower'],
			});
			const score = evaluateMatchup(garchomp, heatran, tracker);
			assert(score.weDealFraction > 0.5,
				`Earthquake should hit Heatran for >50% (got ${score.weDealFraction.toFixed(2)})`);
			assert(score.score > 0,
				`Garchomp vs Heatran should score positively (got ${score.score.toFixed(2)})`);
		});

		it('chooseBestSwitch prefers the candidate with the better matchup', () => {
			const tracker = freshTracker();
			const heatran = mkTracked('Heatran', {
				ability: 'flashfire',
				revealedMoves: ['magmastorm', 'earthpower'],
			});
			const garchomp = mkTracked('Garchomp', {
				ability: 'roughskin',
				revealedMoves: ['earthquake', 'dragonclaw'],
			});
			const skarmory = mkTracked('Skarmory', {
				ability: 'sturdy',
				revealedMoves: ['bravebird', 'roost'],
			});

			const result = chooseBestSwitch([garchomp, skarmory], heatran, tracker);
			assert(result, 'should return a chosen mon');
			assert.equal(result.mon.species, 'garchomp',
				`should pick Garchomp over Skarmory vs Heatran (picked ${result.mon.species})`);
		});

		it('hazard damage shifts the matchup score', () => {
			const trackerNoHazards = freshTracker();
			const trackerHazards = freshTracker();
			trackerHazards.sides.p1.stealthRock = true;
			trackerHazards.sides.p1.spikes = 3;

			const garchomp = mkTracked('Garchomp', {
				ability: 'roughskin',
				revealedMoves: ['earthquake'],
			});
			const heatran = mkTracked('Heatran', {
				revealedMoves: ['magmastorm'],
			});
			const clean = evaluateMatchup(garchomp, heatran, trackerNoHazards);
			const dirty = evaluateMatchup(garchomp, heatran, trackerHazards);
			assert(dirty.score < clean.score,
				`Hazards should reduce switch-in value (clean=${clean.score.toFixed(2)} dirty=${dirty.score.toFixed(2)})`);
		});

		it('Heavy-Duty Boots negates hazard tax', () => {
			const tracker = freshTracker();
			tracker.sides.p1.stealthRock = true;
			tracker.sides.p1.spikes = 3;

			const tornNoBoots = mkTracked('Tornadus-Therian', {
				ability: 'regenerator',
				revealedMoves: ['hurricane'],
			});
			const tornBoots = mkTracked('Tornadus-Therian', {
				ability: 'regenerator',
				item: 'heavydutyboots',
				revealedMoves: ['hurricane'],
			});
			const ttar = mkTracked('Tyranitar', {
				revealedMoves: ['crunch'],
			});

			const dirty = evaluateMatchup(tornNoBoots, ttar, tracker);
			const clean = evaluateMatchup(tornBoots, ttar, tracker);
			assert(clean.hazardFraction < dirty.hazardFraction * 0.5,
				`Heavy-Duty Boots should mostly clear the hazard tax (dirty=${dirty.hazardFraction.toFixed(2)}, clean=${clean.hazardFraction.toFixed(2)})`);
		});
	});

	describe('boosted foe penalty', () => {
		it('boosted foe scores worse than the same foe at neutral', () => {
			const tracker = freshTracker();
			const dragonite = mkTracked('Dragonite', {
				ability: 'multiscale',
				revealedMoves: ['extremespeed', 'earthquake'],
			});
			const calmFoe = mkTracked('Garchomp', {
				revealedMoves: ['earthquake'],
			});
			const angryFoe = mkTracked('Garchomp', {
				revealedMoves: ['earthquake'],
				boosts: { atk: 2 },
			});
			const calm = evaluateMatchup(dragonite, calmFoe, tracker);
			const angry = evaluateMatchup(dragonite, angryFoe, tracker);
			assert(angry.score < calm.score,
				`+2 Atk Garchomp should score worse than neutral (calm=${calm.score.toFixed(2)} angry=${angry.score.toFixed(2)})`);
		});
	});

	// Regression: a monotype Electric team forced to switch into a foe
	// whose only revealed move is non-Ground used to happily pick a
	// 4×-weak Ground/Flying teammate. The fix: bestAttackingDamage now
	// always seeds STAB-type proxies for the foe so unrevealed STAB
	// threats still register in the matchup math.
	describe('regression: foe STAB awareness from species', () => {
		it('prefers a Levitate teammate over a 4× Ground-weak teammate vs a Ground STAB foe', () => {
			const tracker = freshTracker();
			// Foe only revealed Dragon Pulse; the AI should still
			// anticipate Earth Power because Garchomp is Ground-type.
			const garchomp = mkTracked('Garchomp', {
				ability: 'roughskin',
				revealedMoves: ['dragonpulse'],
			});
			const magnezone = mkTracked('Magnezone', {
				ability: 'magnetpull',
				revealedMoves: ['thunderbolt'],
			});
			const rotomFan = mkTracked('Rotom-Fan', {
				ability: 'levitate',
				revealedMoves: ['airslash'],
			});

			const picked = chooseBestSwitch([magnezone, rotomFan], garchomp, tracker);
			assert(picked, 'should return a chosen mon');
			assert.equal(picked.mon.species, 'rotomfan',
				`should prefer Rotom-Fan (Levitate) over 4× Ground-weak Magnezone ` +
				`(picked ${picked.mon.species})`);
		});

		it('still notices a 4× weak switch-in when the foe has only revealed one STAB', () => {
			const tracker = freshTracker();
			// Foe (Tyranitar) has only revealed Crunch; we should still
			// be afraid of its Rock STAB because TTar is part-Rock.
			const ttar = mkTracked('Tyranitar', {
				ability: 'sandstream',
				revealedMoves: ['crunch'],
			});
			const charizard = mkTracked('Charizard', {
				ability: 'blaze',
				revealedMoves: ['flamethrower'],
			});
			const result = evaluateMatchup(charizard, ttar, tracker);
			assert(result.foeDealFraction > 0.7,
				`Should anticipate STAB Rock threat from Tyranitar even when ` +
				`unrevealed (got ${result.foeDealFraction.toFixed(2)})`);
		});
	});

	// Regression: the AI didn't reward terrain-seed entry synergies, so
	// it never picked a Grassy Seed holder while Grassy Terrain was up.
	describe('terrain-seed entry synergy', () => {
		it('Grassy Seed holder scores higher when Grassy Terrain is active', () => {
			const trackerNoTerrain = freshTracker();
			const trackerGrassy = freshTracker();
			trackerGrassy.field.terrain = 'grassyterrain';

			const foe = mkTracked('Garchomp', {
				ability: 'roughskin',
				revealedMoves: ['earthquake'],
			});
			const tangrowth = mkTracked('Tangrowth', {
				ability: 'regenerator',
				item: 'grassyseed',
				revealedMoves: ['gigadrain'],
			});

			const plain = evaluateMatchup(tangrowth, foe, trackerNoTerrain);
			const synergy = evaluateMatchup(tangrowth, foe, trackerGrassy);
			assert(synergy.score > plain.score + 5,
				`Grassy Seed in Grassy Terrain should boost matchup score ` +
				`(plain=${plain.score.toFixed(2)} synergy=${synergy.score.toFixed(2)})`);
		});

		it('Intimidate bonus shifts the switch decision toward the physical-foe-counter', () => {
			const tracker = freshTracker();
			const garchomp = mkTracked('Garchomp', {
				ability: 'roughskin',
				revealedMoves: ['earthquake'],
				stats: { hp: 357, atk: 359, def: 246, spa: 222, spd: 237, spe: 333 },
			});
			// Two roughly comparable defensive answers; one has Intimidate.
			const landorus = mkTracked('Landorus-Therian', {
				ability: 'intimidate',
				item: 'leftovers',
				revealedMoves: ['earthquake'],
			});
			const gliscor = mkTracked('Gliscor', {
				ability: 'poisonheal',
				item: 'toxicorb',
				revealedMoves: ['earthquake'],
			});
			const intim = evaluateMatchup(landorus, garchomp, tracker);
			const plain = evaluateMatchup(gliscor, garchomp, tracker);
			assert(intim.score > plain.score,
				`Intimidate should score higher into a physical attacker than ` +
				`a non-Intimidate equivalent (intim=${intim.score.toFixed(2)} ` +
				`plain=${plain.score.toFixed(2)})`);
		});
	});
});

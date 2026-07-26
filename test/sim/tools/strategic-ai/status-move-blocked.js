'use strict';

/**
 * A status move the target cannot be affected by is the same class of
 * mistake as clicking a move it's immune to, and players read it the
 * same way ("it used Toxic into my Substitute and then just stood
 * there"). The damage path has always refused type- and ability-immune
 * attacks, but status moves skip that path entirely, so nothing stopped
 * the evaluator from handing out its normal +16 for Toxic into a Steel
 * type or Will-O-Wisp into Water Veil.
 *
 * Self-play can't cover this: most of these blockers (Good as Gold,
 * Safeguard, powder into Overcoat) come up a few times in a thousand
 * games, so a regression would hide for a long time behind an aggregate
 * rate. Hence direct assertions per blocker.
 *
 * The paired "still worth it" cases matter just as much — an
 * over-eager gate that refuses legal status moves would silently
 * recreate the "AI never uses status moves" complaint.
 */

const assert = require('../../../assert');

const { evaluateMove } =
	require('../../../../dist/sim/tools/strategic-ai/mechanics/MoveEvaluator');
const { BattleStateTracker } =
	require('../../../../dist/sim/tools/strategic-ai/state/BattleStateTracker');
const { Dex } = require('../../../../dist/sim');

function mkTracked(speciesName, opts = {}) {
	const species = Dex.species.get(speciesName);
	if (!species.exists) throw new Error(`Unknown species: ${speciesName}`);
	return {
		id: `mon:${species.id}`,
		name: species.name,
		species: species.id,
		level: opts.level ?? 100,
		condition: '100/100',
		hpFraction: opts.hpFraction ?? 1,
		status: opts.status ?? '',
		boosts: opts.boosts ?? {},
		types: opts.types ?? [...species.types],
		terastallized: false,
		ability: opts.ability ?? '',
		baseAbility: opts.ability ?? '',
		item: opts.item ?? '',
		revealedMoves: new Set(opts.revealedMoves || []),
		sameMoveStreak: 0,
		choiceLocked: false,
		lastMoveFailed: false,
		stats: opts.stats,
		volatiles: new Set(opts.volatiles || []),
		fainted: false,
		active: true,
		position: 0,
	};
}

function ctxFor(attacker, defender, tracker) {
	return {
		tracker,
		attacker,
		defender,
		mySide: 'p1',
		foeSide: 'p2',
		weOutspeed: true,
		isDoubles: false,
		valueOfBestSwitch: 0,
	};
}

/**
 * Score a status move in a fresh battle state.
 *
 * @param {string} moveId The status move to evaluate.
 * @param {object} attacker Tracked attacker, from `mkTracked`.
 * @param {object} defender Tracked defender, from `mkTracked`.
 * @param {(tracker: object) => void} [setup] Mutates field/side state.
 * @returns {object} The `MoveEvaluation`.
 */
function score(moveId, attacker, defender, setup) {
	const tracker = new BattleStateTracker({ mySide: 'p1' });
	if (setup) setup(tracker);
	return evaluateMove(Dex.moves.get(moveId), ctxFor(attacker, defender, tracker));
}

describe('Strategic-AI status-move blocking', () => {
	const clefable = () => mkTracked('Clefable', { ability: 'magicguard' });

	describe('rejects status moves that cannot possibly land', () => {
		const cases = [
			['Toxic into a Steel type', 'toxic', () => mkTracked('Skarmory')],
			['Toxic into a Poison type', 'toxic', () => mkTracked('Toxapex')],
			['Will-O-Wisp into a Fire type', 'willowisp', () => mkTracked('Volcarona')],
			['Will-O-Wisp into Water Veil', 'willowisp',
				() => mkTracked('Wailord', { ability: 'waterveil' })],
			['Thunder Wave into a Ground type', 'thunderwave', () => mkTracked('Garchomp')],
			['Thunder Wave into Limber', 'thunderwave',
				() => mkTracked('Hitmontop', { ability: 'limber' })],
			['Spore into Insomnia', 'spore',
				() => mkTracked('Noctowl', { ability: 'insomnia' })],
			['Spore into a Grass type (powder)', 'spore', () => mkTracked('Amoonguss')],
			['Spore into Overcoat (powder)', 'spore',
				() => mkTracked('Mandibuzz', { ability: 'overcoat' })],
			['Spore into Safety Goggles (powder)', 'spore',
				() => mkTracked('Garchomp', { item: 'safetygoggles' })],
			['Toxic into Good as Gold', 'toxic',
				() => mkTracked('Gholdengo', { ability: 'goodasgold' })],
			['Toxic into a Substitute', 'toxic',
				() => mkTracked('Garchomp', { volatiles: ['substitute'] })],
			['Toxic into an already-poisoned foe', 'toxic',
				() => mkTracked('Garchomp', { status: 'psn' })],
			['Leech Seed into a Grass type', 'leechseed', () => mkTracked('Amoonguss')],
			['Stun Spore into Purifying Salt', 'stunspore',
				() => mkTracked('Garganacl', { ability: 'purifyingsalt' })],
		];
		for (const [label, moveId, mkFoe] of cases) {
			it(label, () => {
				const result = score(moveId, clefable(), mkFoe());
				assert(result.score < 0,
					`${label}: expected a negative score, got ${result.score} ` +
					`(${result.rationale})`);
			});
		}

		it('Toxic under the foe\'s Safeguard', () => {
			const result = score('toxic', clefable(), mkTracked('Garchomp'), tracker => {
				tracker.sides.p2.safeguardTurns = 5;
			});
			assert(result.score < 0,
				`expected a negative score, got ${result.score} (${result.rationale})`);
		});

		it('Toxic on a grounded foe in Misty Terrain', () => {
			const result = score('toxic', clefable(), mkTracked('Garchomp'), tracker => {
				tracker.field.terrain = 'mistyterrain';
			});
			assert(result.score < 0,
				`expected a negative score, got ${result.score} (${result.rationale})`);
		});
	});

	describe('still uses status moves that can land', () => {
		const cases = [
			['Toxic into a neutral foe', 'toxic', () => mkTracked('Garchomp')],
			['Will-O-Wisp into a physical attacker', 'willowisp',
				() => mkTracked('Garchomp', { revealedMoves: ['earthquake'] })],
			['Spore into a non-Grass foe', 'spore', () => mkTracked('Garchomp')],
			// Glare is Normal-type and ignores the type chart, so Ground
			// types are *not* immune to it — only Thunder Wave's Electric
			// typing blocks them. A gate that keys off "paralysis" alone
			// rather than the move would wrongly refuse this.
			['Glare into a Ground type', 'glare', () => mkTracked('Garchomp')],
			// Sound moves and `bypasssub` moves punch through Substitute.
			['Growl through a Substitute', 'growl',
				() => mkTracked('Garchomp', { volatiles: ['substitute'] })],
		];
		for (const [label, moveId, mkFoe] of cases) {
			it(label, () => {
				const result = score(moveId, clefable(), mkFoe());
				assert(result.score > 0,
					`${label}: expected a positive score, got ${result.score} ` +
					`(${result.rationale})`);
			});
		}

		it('Toxic into an airborne foe under Misty Terrain (terrain only affects grounded)', () => {
			// Dragonite, not Corviknight: a Steel-type flyer is
			// poison-immune anyway and would pass for the wrong reason.
			const result = score('toxic', clefable(), mkTracked('Dragonite'), tracker => {
				tracker.field.terrain = 'mistyterrain';
			});
			assert(result.score > 0,
				`expected a positive score, got ${result.score} (${result.rationale})`);
		});

		it('Toxic through Safeguard with Infiltrator', () => {
			const attacker = mkTracked('Noivern', { ability: 'infiltrator' });
			const result = score('toxic', attacker, mkTracked('Garchomp'), tracker => {
				tracker.sides.p2.safeguardTurns = 5;
			});
			assert(result.score > 0,
				`expected a positive score, got ${result.score} (${result.rationale})`);
		});

		it('self-targeting status moves are never gated by the foe', () => {
			// Swords Dance doesn't touch the foe, so no foe-side blocker
			// may apply — not even Good as Gold.
			const foe = mkTracked('Gholdengo', { ability: 'goodasgold' });
			const attacker = mkTracked('Garchomp', { revealedMoves: ['earthquake'] });
			const result = score('swordsdance', attacker, foe);
			assert(result.score > 0,
				`expected a positive score, got ${result.score} (${result.rationale})`);
		});
	});

	describe('prices status moves by how often they land', () => {
		// The damage path always multiplied through hit chance, but every
		// branch of `evaluateStatus` returned a raw utility, so a
		// coin-flip sleep was worth exactly as much as a guaranteed one.
		it('prefers Spore over Hypnosis for the same effect', () => {
			const foe = mkTracked('Garchomp');
			const spore = score('spore', clefable(), foe);
			const hypnosis = score('hypnosis', clefable(), foe);
			assert(spore.score > hypnosis.score,
				`Spore (100%) should outscore Hypnosis (60%): ` +
				`${spore.score} vs ${hypnosis.score}`);
		});

		it('prefers Glare over Thunder Wave for the same paralysis', () => {
			const foe = mkTracked('Dragonite');
			const twave = score('thunderwave', clefable(), foe);
			const glare = score('glare', clefable(), foe);
			assert(glare.score > twave.score,
				`Glare (100%) should outscore Thunder Wave (90%): ` +
				`${glare.score} vs ${twave.score}`);
		});

		it('does not discount never-miss self-targeting moves', () => {
			// `accuracy: true` must be left alone rather than divided by
			// 100 into oblivion.
			const attacker = mkTracked('Garchomp', { revealedMoves: ['earthquake'] });
			const result = score('swordsdance', attacker, mkTracked('Skarmory'));
			assert(result.score > 5,
				`expected full credit, got ${result.score} (${result.rationale})`);
		});

		it('No Guard removes the accuracy discount', () => {
			const foe = mkTracked('Garchomp');
			const plain = score('hypnosis', clefable(), foe);
			const noGuard = score('hypnosis', mkTracked('Machamp', { ability: 'noguard' }), foe);
			assert(noGuard.score > plain.score,
				`No Guard Hypnosis should beat a 60% one: ` +
				`${noGuard.score} vs ${plain.score}`);
		});

		it('values sleep above the chip and stat-cut statuses', () => {
			// Sleep removes the target from the game for 1-3 turns, which
			// is strictly better than poison chip or a halved Attack. It
			// was priced at 20 against poison's 16, so a middling attack
			// beat Spore every time.
			const foe = mkTracked('Garchomp', { revealedMoves: ['earthquake'] });
			const spore = score('spore', clefable(), foe);
			const toxic = score('toxic', clefable(), foe);
			const wisp = score('willowisp', clefable(), foe);
			assert(spore.score > toxic.score && spore.score > wisp.score,
				`Spore should outrank Toxic and Will-O-Wisp: ` +
				`${spore.score} vs ${toxic.score} / ${wisp.score}`);
		});

		it('values sleep less against a nearly-fainted foe', () => {
			// At 10% HP the attack is the better click; sleeping something
			// we were going to KO anyway wastes the turn.
			const healthy = score('spore', clefable(), mkTracked('Garchomp'));
			const nearlyDead = score('spore', clefable(),
				mkTracked('Garchomp', { hpFraction: 0.1 }));
			assert(healthy.score > nearlyDead.score,
				`sleep should be worth more against a healthy foe: ` +
				`${healthy.score} vs ${nearlyDead.score}`);
		});
	});
});

'use strict';

/**
 * Regression coverage for the user-reported AI issues:
 *
 * - Destiny Bond was being spammed because it fell into the
 *   `unknownStatus` fallback (score = 2) which still beat 0-score
 *   moves like Counter / Mirror Coat.
 * - Baton Pass was never picked because it also fell into
 *   `unknownStatus`, so the AI would stack +6 boosts on one mon and
 *   never pass them.
 * - Encore had a flat 14 even when the foe just used a damaging move;
 *   it should be much higher when the foe last used a status / setup
 *   move (lock them out of attacking).
 * - Counter / Mirror Coat have `basePower: 0` and a `damageCallback`,
 *   so the damage path scored them at 0 and they were never picked.
 *
 * These tests exercise the corrected `evaluateMove` scoring.
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

function ctxFor(attacker, defender, tracker, overrides = {}) {
	return {
		tracker,
		attacker,
		defender,
		mySide: 'p1',
		foeSide: 'p2',
		weOutspeed: overrides.weOutspeed ?? true,
		isDoubles: overrides.isDoubles ?? false,
		valueOfBestSwitch: overrides.valueOfBestSwitch ?? 0,
	};
}

describe('Strategic-AI MoveEvaluator', () => {
	describe('Destiny Bond', () => {
		it('is a trash pick at full HP', () => {
			const tracker = freshTracker();
			const me = mkTracked('Aegislash', { ability: 'stancechange' });
			const foe = mkTracked('Garchomp', { revealedMoves: ['earthquake'] });
			const result = evaluateMove(Dex.moves.get('destinybond'), ctxFor(me, foe, tracker, {
				weOutspeed: false,
			}));
			assert(result.score < 0,
				`Destiny Bond at full HP should be heavily negative (got ${result.score})`);
		});

		it('scores high at low HP when the foe is faster', () => {
			const tracker = freshTracker();
			const me = mkTracked('Aegislash', { ability: 'stancechange', hpFraction: 0.18 });
			const foe = mkTracked('Garchomp', { revealedMoves: ['earthquake'] });
			const result = evaluateMove(Dex.moves.get('destinybond'), ctxFor(me, foe, tracker, {
				weOutspeed: false,
			}));
			assert(result.score > 30,
				`Destiny Bond at <20% HP vs faster foe should be a top pick (got ${result.score})`);
		});

		it('is refused when DB is already volatile (cannot be used twice in a row)', () => {
			const tracker = freshTracker();
			const me = mkTracked('Aegislash', {
				ability: 'stancechange', hpFraction: 0.18,
				volatiles: ['destinybond'],
			});
			const foe = mkTracked('Garchomp', { revealedMoves: ['earthquake'] });
			const result = evaluateMove(Dex.moves.get('destinybond'), ctxFor(me, foe, tracker, {
				weOutspeed: false,
			}));
			assert(result.score < 0,
				`Destiny Bond with DB volatile up should refuse (got ${result.score})`);
		});
	});

	describe('Baton Pass', () => {
		it('is highly valued when the attacker has positive boosts to pass', () => {
			const tracker = freshTracker();
			const me = mkTracked('Espeon', {
				ability: 'magicbounce',
				boosts: { spa: 2, spe: 2 },
			});
			const foe = mkTracked('Tyranitar', { revealedMoves: ['stoneedge'] });
			const result = evaluateMove(Dex.moves.get('batonpass'), ctxFor(me, foe, tracker, {
				valueOfBestSwitch: 10,
			}));
			assert(result.score > 30,
				`Baton Pass with +2 SpA / +2 Spe should be a top pick (got ${result.score})`);
		});

		it('beats stacking another boost when boosts are already high', () => {
			const tracker = freshTracker();
			const me = mkTracked('Espeon', {
				ability: 'magicbounce',
				boosts: { spa: 4, spe: 4 },
			});
			const foe = mkTracked('Tyranitar', { revealedMoves: ['stoneedge'] });
			const bp = evaluateMove(Dex.moves.get('batonpass'), ctxFor(me, foe, tracker, {
				valueOfBestSwitch: 8,
			}));
			const nastyPlot = evaluateMove(Dex.moves.get('nastyplot'), ctxFor(me, foe, tracker, {
				valueOfBestSwitch: 8,
			}));
			assert(bp.score > nastyPlot.score,
				`At +4 SpA, Baton Pass should outscore another Nasty Plot ` +
				`(BP=${bp.score} NP=${nastyPlot.score})`);
		});

		it('is unattractive when the attacker has no boosts and no switch target', () => {
			const tracker = freshTracker();
			const me = mkTracked('Espeon', { ability: 'magicbounce' });
			const foe = mkTracked('Tyranitar', { revealedMoves: ['stoneedge'] });
			const result = evaluateMove(Dex.moves.get('batonpass'), ctxFor(me, foe, tracker, {
				valueOfBestSwitch: 0,
			}));
			assert(result.score < 0,
				`Boostless Baton Pass with no good target should be negative (got ${result.score})`);
		});
	});

	describe('Counter / Mirror Coat', () => {
		it('Counter scores high when the foe just used a Physical move and we are slower', () => {
			const tracker = freshTracker();
			const me = mkTracked('Wobbuffet', { ability: 'shadowtag' });
			const foe = mkTracked('Garchomp', {
				revealedMoves: ['earthquake'],
				lastMove: 'earthquake',
			});
			const result = evaluateMove(Dex.moves.get('counter'), ctxFor(me, foe, tracker, {
				weOutspeed: false,
			}));
			assert(result.score > 20,
				`Counter vs a foe that just used Physical should score >20 (got ${result.score})`);
		});

		it('Mirror Coat scores high when the foe just used a Special move and we are slower', () => {
			const tracker = freshTracker();
			const me = mkTracked('Wobbuffet', { ability: 'shadowtag' });
			const foe = mkTracked('Heatran', {
				revealedMoves: ['magmastorm'],
				lastMove: 'magmastorm',
			});
			const result = evaluateMove(Dex.moves.get('mirrorcoat'), ctxFor(me, foe, tracker, {
				weOutspeed: false,
			}));
			assert(result.score > 20,
				`Mirror Coat vs a foe that just used Special should score >20 (got ${result.score})`);
		});

		it('Counter outscores Destiny Bond when the foe just used a Physical move', () => {
			const tracker = freshTracker();
			const me = mkTracked('Wobbuffet', { ability: 'shadowtag' });
			const foe = mkTracked('Garchomp', {
				revealedMoves: ['earthquake'],
				lastMove: 'earthquake',
			});
			const counter = evaluateMove(Dex.moves.get('counter'),
				ctxFor(me, foe, tracker, { weOutspeed: false }));
			const db = evaluateMove(Dex.moves.get('destinybond'),
				ctxFor(me, foe, tracker, { weOutspeed: false }));
			assert(counter.score > db.score,
				`Counter should beat Destiny Bond after a Physical hit ` +
				`(Counter=${counter.score} DB=${db.score})`);
		});
	});

	describe('Encore', () => {
		it('is highly valued when the foe just used a status / setup move', () => {
			const tracker = freshTracker();
			const me = mkTracked('Whimsicott', { ability: 'prankster' });
			const foe = mkTracked('Volcarona', {
				revealedMoves: ['quiverdance'],
				lastMove: 'quiverdance',
			});
			const result = evaluateMove(Dex.moves.get('encore'), ctxFor(me, foe, tracker));
			assert(result.score > 20,
				`Encore vs Quiver Dance user should score >20 (got ${result.score})`);
		});

		it('is modest when the foe just used a damaging move', () => {
			const tracker = freshTracker();
			const me = mkTracked('Whimsicott', { ability: 'prankster' });
			const foe = mkTracked('Volcarona', {
				revealedMoves: ['fireblast'],
				lastMove: 'fireblast',
			});
			const result = evaluateMove(Dex.moves.get('encore'), ctxFor(me, foe, tracker));
			assert(result.score >= 0 && result.score < 20,
				`Encore vs a pure attacker should be modest (got ${result.score})`);
		});
	});
});

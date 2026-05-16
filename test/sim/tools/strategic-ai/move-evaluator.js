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

	// Regression: priority moves only earned a +25 bonus when we were
	// slower AND would KO. Slow-mon scenarios (Mamoswine / Bisharp at
	// low HP needing a priority KO) were underrated, and Sucker Punch
	// was spammed into status/setup mons where it auto-fails.
	describe('priority move scoring', () => {
		it('Bullet Punch at low HP into a faster foe scores well above neutral', () => {
			const tracker = freshTracker();
			const scizor = mkTracked('Scizor', {
				ability: 'technician', hpFraction: 0.3,
				stats: { hp: 343, atk: 394, def: 236, spa: 138, spd: 226, spe: 195 },
			});
			const foe = mkTracked('Garchomp', {
				revealedMoves: ['earthquake'],
				stats: { hp: 357, atk: 359, def: 246, spa: 222, spd: 237, spe: 333 },
			});
			const priority = evaluateMove(Dex.moves.get('bulletpunch'),
				ctxFor(scizor, foe, tracker, { weOutspeed: false }));
			const normalAttack = evaluateMove(Dex.moves.get('xscissor'),
				ctxFor(scizor, foe, tracker, { weOutspeed: false }));
			// Bullet Punch should be at least competitive with the
			// stronger X-Scissor because we may not get a second turn.
			assert(priority.score > normalAttack.score - 5,
				`Bullet Punch insurance bonus should make it comparable ` +
				`to X-Scissor when low HP + slower ` +
				`(BP=${priority.score.toFixed(2)} X=${normalAttack.score.toFixed(2)})`);
		});

		it('Extreme Speed on a slow attacker rewards the priority KO branch', () => {
			const tracker = freshTracker();
			const dragonite = mkTracked('Dragonite', {
				ability: 'multiscale',
				stats: { hp: 386, atk: 403, def: 226, spa: 212, spd: 236, spe: 185 },
			});
			const weakened = mkTracked('Garchomp', {
				revealedMoves: ['earthquake'], hpFraction: 0.2,
				stats: { hp: 357, atk: 359, def: 246, spa: 222, spd: 237, spe: 333 },
			});
			const result = evaluateMove(Dex.moves.get('extremespeed'),
				ctxFor(dragonite, weakened, tracker, { weOutspeed: false }));
			// At 20% HP a +2 priority Normal-typed STAB attack should
			// guarantee a KO and earn the stacked-priority bonus.
			assert(result.score > 35,
				`Extreme Speed into a sub-20% foe should score >35 ` +
				`(got ${result.score.toFixed(2)})`);
		});
	});

	// Regression: Sucker Punch was being spammed against setup mons
	// (auto-fails) and was never preferred even when the foe was
	// choice-locked into a damaging move (guaranteed fire).
	describe('Sucker Punch', () => {
		it('hard-negative when the foe just used a status move', () => {
			const tracker = freshTracker();
			const bisharp = mkTracked('Bisharp', { ability: 'defiant' });
			const foe = mkTracked('Volcarona', {
				revealedMoves: ['quiverdance'],
				lastMove: 'quiverdance',
			});
			const result = evaluateMove(Dex.moves.get('suckerpunch'),
				ctxFor(bisharp, foe, tracker, { weOutspeed: false }));
			assert(result.score < 0,
				`Sucker Punch vs a fresh Quiver Dance user should score ` +
				`negative — it will auto-fail (got ${result.score})`);
		});

		it('high score when the foe is choice-locked into a damaging move', () => {
			const tracker = freshTracker();
			const bisharp = mkTracked('Bisharp', { ability: 'defiant' });
			const foe = mkTracked('Heatran', {
				revealedMoves: ['magmastorm'],
				lastMove: 'magmastorm',
				choiceLocked: true,
			});
			const result = evaluateMove(Dex.moves.get('suckerpunch'),
				ctxFor(bisharp, foe, tracker, { weOutspeed: false }));
			assert(result.score > 25,
				`Sucker Punch into a Choice-locked attacker should score >25 ` +
				`(got ${result.score})`);
		});
	});
});

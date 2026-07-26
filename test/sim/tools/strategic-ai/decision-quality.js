'use strict';

/**
 * Behavioural guarantees for the strategic AI, asserted over real
 * self-play games rather than synthetic contexts.
 *
 * These exist because the failures players actually report are
 * behavioural, not numeric: "it uses moves my Pokemon is immune to",
 * "it never uses status moves", "it makes dumb switches". A unit test on
 * `evaluateMove` can pass while the assembled engine still does all
 * three, so these run the whole stack and assert on the observed
 * decisions.
 *
 * The immune-move assertion is a hard zero, not a threshold: the AI has
 * a damage calculator and the type chart, so a *avoidable* immune click
 * is always a bug. Clicks that were forced (Choice-locked into Close
 * Combat when a Ghost switches in, mid-Outrage against a Fairy) are
 * excluded by `avoidableImmuneMoves` and correctly don't count.
 */

const assert = require('../../../assert');

const { runSelfPlay } = require('../../../../dist/sim/tools/selfplay');
const { decisionRates } = require('../../../../dist/sim/tools/strategic-ai/telemetry/DecisionStats');

/** Fixed seed so a failure is reproducible from the mocha output alone. */
const SEED = '1,2,3,4';

/**
 * Play a short series and return both contenders' telemetry.
 *
 * @param {number} a Contender A's difficulty.
 * @param {number} b Contender B's difficulty.
 * @param {number} games Games to play.
 * @returns {Promise<object>} The self-play result.
 */
async function series(a, b, games) {
	return runSelfPlay({
		// Small search budgets: these tests assert on decision *quality*,
		// and a full 200ms MCTS budget per decision would make the suite
		// take minutes for no extra signal.
		a: { difficulty: a, searchBudgetMs: 25 },
		b: { difficulty: b, searchBudgetMs: 25 },
		games,
		seed: SEED,
		telemetry: true,
		jobs: 0,
		maxTurns: 200,
		verbose: false,
	});
}

/**
 * Games per immune-move assertion.
 *
 * Sized from measurement, not taste: before the immunity fix, difficulty
 * 3 produced ~0.27 avoidable immune clicks per game, so 40 games
 * reliably surfaced ~10. A 6-game series showed zero even with the bug
 * present, i.e. it asserted nothing.
 */
const IMMUNE_SAMPLE_GAMES = 40;

/**
 * Games per status-move-rate assertion.
 *
 * Sized from measurement. A game yields ~22 move decisions, and
 * difficulty 5 is the noisiest tier by construction (MCTS is wall-clock
 * budgeted, so the same seed does a different number of rollouts each
 * run). Measured against difficulty 2: d5 reads 15.1% over 60 games but
 * swung as low as 9.5% over 24 — i.e. anything under ~60 games is
 * measuring run-to-run variance, not the policy, and this assertion both
 * passed and failed on identical code at 24.
 *
 * Rates at 60 games, for reference when this moves: d1 30.2%, d3 20.3%,
 * d4 18.9%, d5 15.1%. The gradient is expected — the weak tiers' pick
 * ladder wanders off the best move more often, and support moves are
 * usually the plausible-but-worse option it lands on.
 */
const STATUS_SAMPLE_GAMES = 60;

describe('Strategic-AI decision quality (slow)', () => {
	// Every tier, including 1. The low tiers used to run the random and
	// light engines, where these two guarantees simply did not hold —
	// which is exactly why players described the AI as having an on/off
	// switch. Now that all tiers share a real engine and differ only by
	// knobs, the guarantees are tier-independent and asserted as such.
	for (const difficulty of [1, 2, 3, 4, 5]) {
		it(`difficulty ${difficulty} never clicks an avoidable immune move`, async () => {
			const result = await series(difficulty, 2, IMMUNE_SAMPLE_GAMES);
			const counters = result.telemetry.a;
			assert(counters.moves > 500,
				`expected a meaningful sample, got ${counters.moves} moves`);
			assert.equal(counters.avoidableImmuneMoves, 0,
				`difficulty ${difficulty} clicked ${counters.avoidableImmuneMoves} avoidable ` +
				`immune move(s) out of ${counters.moves} (seed ${SEED})`);
		}).timeout(120000);

		it(`difficulty ${difficulty} uses status moves a meaningful fraction of the time`, async () => {
			const result = await series(difficulty, 2, STATUS_SAMPLE_GAMES);
			const rates = decisionRates(result.telemetry.a);
			// Human play on random-battle ladders sits well above 10%:
			// setup, hazards, recovery and status infliction are how
			// neutral matchups get converted. A tier that basically never
			// picks one has the support half of its move pool switched
			// off — the light engine used to sit at 2.4%.
			assert(rates.statusMoveRate > 0.10,
				`difficulty ${difficulty} status-move rate ` +
				`${(rates.statusMoveRate * 100).toFixed(1)}% is too low — ` +
				`support moves are being scored out of contention`);
		}).timeout(120000);
	}

	it('does not switch on more than half of all decisions', async () => {
		const result = await series(3, 3, 6);
		const rates = decisionRates(result.telemetry.a);
		// Includes forced post-faint switches, so the bar is deliberately
		// loose; this catches switch-loop regressions, not tuning drift.
		assert(rates.switchRate < 0.5,
			`switch rate ${(rates.switchRate * 100).toFixed(1)}% suggests a switch loop`);
	}).timeout(120000);

	it('the difficulty ladder spans a real strength range', async () => {
		// Tier-vs-tier scores can't detect the whole ladder sinking, or
		// every tier collapsing to the same strength, so each tier is
		// scored against the `random` engine — which has no knobs and so
		// cannot drift as the tiers themselves are retuned.
		//
		// Mirrored games are mandatory here. In `gen9randombattle`, team
		// quality is a larger effect than a couple of difficulty tiers,
		// and an unmirrored 40-game series reported d1 at 85% and d3 at
		// 75% purely on which side drew the better teams.
		//
		// What's asserted is only what this sample size can actually
		// resolve: every tier beats random play, and the bottom and top
		// of the ladder are far apart. Adjacent tiers are deliberately
		// close together, so asserting d3 < d4 < d5 here would be
		// asserting noise — use `selfplay.js --engine-b random` offline
		// for that.
		const scores = {};
		for (const difficulty of [1, 3, 5]) {
			const result = await runSelfPlay({
				a: { difficulty, searchBudgetMs: 25 },
				b: { difficulty: 3, engine: 'random' },
				games: 60,
				seed: SEED,
				mirror: true,
				jobs: 0,
				maxTurns: 200,
				verbose: false,
			});
			scores[difficulty] = result.interval.score;
		}
		const summary = [1, 3, 5]
			.map(d => `d${d}=${(scores[d] * 100).toFixed(1)}%`)
			.join(' ');
		for (const difficulty of [1, 3, 5]) {
			assert(scores[difficulty] > 0.5,
				`difficulty ${difficulty} should beat random play, got ${summary}`);
		}
		const span = scores[5] - scores[1];
		assert(span > 0.1,
			`difficulty 1 and 5 are only ${(span * 100).toFixed(1)} points apart ` +
			`(${summary}) — the tiers have collapsed into each other`);
	}).timeout(300000);
});

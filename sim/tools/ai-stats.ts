/**
 * Strength statistics for AI-vs-AI series: Elo conversion, confidence
 * intervals, and a sequential probability ratio test (SPRT).
 *
 * Self-play winrates are noisy. A 100-game series that reports "52%"
 * proves nothing — the 95% interval on 100 games is roughly ±10%, so
 * that result is equally consistent with a 40-Elo gain and a 15-Elo
 * loss. Two tools fix that:
 *
 *   - {@link scoreToElo} / {@link scoreInterval} report the *interval*,
 *     so a summary can never claim a gain it didn't measure.
 *   - {@link Sprt} runs the fixed-games series as a sequential test
 *     instead: it stops as soon as the evidence clears an accept or
 *     reject bound, which typically needs far fewer games than a
 *     fixed-N design at the same error rates.
 *
 * The SPRT is the "generalized" (GSPRT) variant used by chess engine
 * testing frameworks: rather than modelling win/draw/loss counts
 * separately, it treats each game's score (1 / 0.5 / 0) as a sample
 * from a distribution with unknown variance, estimates that variance
 * from the series itself, and evaluates the normal-model
 * log-likelihood ratio
 *
 *     LLR = N * (m1 - m0) * (2 * mean - m0 - m1) / (2 * variance)
 *
 * where `m0` / `m1` are the scores corresponding to the Elo bounds
 * being tested. Draws therefore reduce variance (and so tighten the
 * test) automatically, which matters a lot here because AI-vs-AI
 * Pokemon series produce many force-tied games.
 *
 * @license MIT
 */

/** Per-game score for one contender: 1 win, 0.5 tie, 0 loss. */
export type GameScore = 0 | 0.5 | 1;

/** SPRT verdict. `"continue"` means not enough evidence yet. */
export type SprtVerdict = "continue" | "accept-h1" | "accept-h0";

/** Bounds and error rates defining an SPRT. */
export interface SprtConfig {
	/**
	 * Elo gain under H0 — the hypothesis that the change is *not* an
	 * improvement. Conventionally 0 ("no change").
	 */
	elo0: number;
	/**
	 * Elo gain under H1 — the smallest improvement worth detecting.
	 * Larger values make the test cheaper but blind to small gains.
	 */
	elo1: number;
	/** Type-I error rate (probability of wrongly accepting H1). */
	alpha: number;
	/** Type-II error rate (probability of wrongly accepting H0). */
	beta: number;
}

/** A score estimate with a two-sided confidence interval. */
export interface ScoreInterval {
	/** Observed mean score in [0, 1]. */
	score: number;
	/** Lower bound of the confidence interval on the score. */
	scoreLow: number;
	/** Upper bound of the confidence interval on the score. */
	scoreHigh: number;
	/** {@link score} expressed as an Elo difference. */
	elo: number;
	/** Elo corresponding to {@link scoreLow}. */
	eloLow: number;
	/** Elo corresponding to {@link scoreHigh}. */
	eloHigh: number;
}

/** Default SPRT: "is this at least +10 Elo?" at 5% error rates. */
export const DEFAULT_SPRT: SprtConfig = { elo0: 0, elo1: 10, alpha: 0.05, beta: 0.05 };

/**
 * Convert an expected score to an Elo difference.
 *
 * @param score Expected score in [0, 1].
 * @returns The Elo difference, clamped to +/-800 so a 100%/0% series
 * reports a large finite number instead of +/-Infinity.
 */
export function scoreToElo(score: number): number {
	if (score <= 0) return -800;
	if (score >= 1) return 800;
	const elo = -400 * Math.log10(1 / score - 1);
	return Math.max(-800, Math.min(800, elo));
}

/**
 * Convert an Elo difference to an expected score.
 *
 * @param elo The Elo difference.
 * @returns The expected score in (0, 1).
 */
export function eloToScore(elo: number): number {
	return 1 / (1 + 10 ** (-elo / 400));
}

/**
 * Summarise a series of per-game scores as a score and Elo interval.
 *
 * Uses the normal approximation on the sample mean, which is
 * well-behaved here because a series is many independent games. The
 * variance is taken from the sample, so a draw-heavy series correctly
 * reports a tighter interval than a decisive one.
 *
 * @param scores Per-game scores for the contender being rated.
 * @param z Standard-normal quantile for the interval (1.96 = 95%).
 * @returns The score/Elo point estimate with confidence bounds.
 */
export function scoreInterval(scores: readonly number[], z = 1.96): ScoreInterval {
	const n = scores.length;
	if (n === 0) {
		return { score: 0.5, scoreLow: 0, scoreHigh: 1, elo: 0, eloLow: -800, eloHigh: 800 };
	}
	const mean = scores.reduce((a, b) => a + b, 0) / n;
	const halfWidth = z * Math.sqrt(sampleVariance(scores, mean) / n);
	const low = Math.max(0, mean - halfWidth);
	const high = Math.min(1, mean + halfWidth);
	return {
		score: mean,
		scoreLow: low,
		scoreHigh: high,
		elo: scoreToElo(mean),
		eloLow: scoreToElo(low),
		eloHigh: scoreToElo(high),
	};
}

/**
 * Sequential probability ratio test over per-game scores.
 *
 * Feed each game's score as it completes and stop the series as soon as
 * {@link verdict} leaves `"continue"`. A run that never clears either
 * bound is inconclusive — report the interval from
 * {@link scoreInterval} rather than pretending the winrate is a result.
 */
export class Sprt {
	/** Elo bounds and error rates this test was configured with. */
	readonly config: SprtConfig;
	private readonly m0: number;
	private readonly m1: number;
	private readonly upper: number;
	private readonly lower: number;
	private n = 0;
	private sum = 0;
	private sumSquares = 0;

	/**
	 * @param config Elo bounds and error rates. Defaults to
	 * {@link DEFAULT_SPRT}.
	 */
	constructor(config: SprtConfig = DEFAULT_SPRT) {
		this.config = config;
		this.m0 = eloToScore(config.elo0);
		this.m1 = eloToScore(config.elo1);
		this.upper = Math.log((1 - config.beta) / config.alpha);
		this.lower = Math.log(config.beta / (1 - config.alpha));
	}

	/** Number of games observed so far. */
	get games(): number {
		return this.n;
	}

	/**
	 * Record one game's outcome.
	 *
	 * @param score The contender's score for that game (1 / 0.5 / 0).
	 */
	observe(score: number): void {
		this.n++;
		this.sum += score;
		this.sumSquares += score * score;
	}

	/**
	 * Current log-likelihood ratio.
	 *
	 * @returns The LLR, or 0 before enough games to estimate variance.
	 */
	llr(): number {
		if (this.n < 2) return 0;
		const mean = this.sum / this.n;
		// Variance floor: an all-draws or all-wins prefix has zero
		// sample variance, which would divide by zero and declare a
		// verdict off two games.
		const variance = Math.max(1e-4, (this.sumSquares / this.n) - (mean * mean));
		return (this.n * (this.m1 - this.m0) * ((2 * mean) - this.m0 - this.m1)) / (2 * variance);
	}

	/**
	 * Current verdict.
	 *
	 * @returns `"accept-h1"` once the LLR clears the upper bound,
	 * `"accept-h0"` once it falls below the lower bound, else
	 * `"continue"`.
	 */
	verdict(): SprtVerdict {
		const llr = this.llr();
		if (llr >= this.upper) return "accept-h1";
		if (llr <= this.lower) return "accept-h0";
		return "continue";
	}

	/** The LLR bounds `[reject, accept]` this test is walking between. */
	bounds(): { lower: number, upper: number } {
		return { lower: this.lower, upper: this.upper };
	}
}

/**
 * Sample variance of a score series.
 *
 * @param scores The per-game scores.
 * @param mean The precomputed mean of `scores`.
 * @returns The variance, floored above zero so callers can divide by it.
 */
function sampleVariance(scores: readonly number[], mean: number): number {
	if (scores.length < 2) return 0.25;
	let acc = 0;
	for (const s of scores) acc += (s - mean) * (s - mean);
	return Math.max(1e-6, acc / (scores.length - 1));
}

/**
 * Strategic-AI engine interface.
 *
 * An "engine" is a self-contained decision-maker: given a Showdown
 * `ChoiceRequest` plus the tracker / PRNG / per-mon state owned by the
 * host {@link PlayerAI}, it returns the showdown command
 * string (e.g. `"move 1"`, `"switch 3"`, `"team 1,2,3,4,5,6"`,
 * `"pass"`).
 *
 * Engines deliberately don't touch the network or the battle stream;
 * they're pure functions of their inputs (modulo PRNG draws). This keeps
 * them trivial to unit-test against a `BattleStream` snapshot, and lets
 * the search engines (one-ply, MCTS) embed the heuristic engine as a
 * rollout policy.
 *
 * The {@link DifficultyPolicy} module is responsible for picking which
 * engine handles a given `difficulty` level and for filling in the
 * noise/info-forgetting knobs on {@link EngineContext}.
 *
 * @license MIT
 */
import type { PRNG } from "../../../prng";
import type { ChoiceRequest } from "../../../side";
import type { BattleStateTracker } from "../state/BattleStateTracker";

/**
 * Per-host mutable state passed down to every engine call. The host
 * owns these maps so the engine can stay stateless across calls.
 */
export interface EngineContext {
	/** Battle state tracker, or `null` if we haven't seen any requests yet. */
	tracker: BattleStateTracker | null;
	/** PRNG for noise / sampling. */
	prng: PRNG;
	/** Difficulty 1..5 the user configured. Engines may key behaviour on this. */
	difficulty: number;
	/** Per-Pokemon last-move ids. */
	lastMoveByMon: Map<string, string>;
	/** Per-Pokemon disabled-move sets (Imprison/Disable). */
	disabledMovesByMon: Map<string, Set<string>>;
	/** Per-Pokemon last switch turn. */
	lastSwitchTurnByMon: Map<string, number>;
	/**
	 * Epsilon-greedy noise probability. With probability `noiseEpsilon`
	 * the engine picks a uniformly-random alternative from its
	 * candidate set instead of the top-scored option. 0 disables noise.
	 */
	noiseEpsilon: number;
	/**
	 * For low-difficulty engines: probability to "forget" any single
	 * piece of revealed info (a foe's revealed move, a known item, ...)
	 * during scoring. 0 disables forgetting.
	 */
	infoForgetting: number;
	/** Optional per-engine search budget in ms (used by OnePly / MCTS). */
	searchBudgetMs?: number;
	/**
	 * Probability the random engine picks a move over a switch when both
	 * are legal. Defaults to 1 (always move). Used by dev runners that
	 * want stress-testing pivots.
	 */
	randomMoveProb?: number;
	/**
	 * Probability the random engine attempts a Mega/Ultra/Dynamax/Tera
	 * when available. Defaults to 0.
	 */
	randomMegaProb?: number;
}

/**
 * Public interface every engine implements.
 */
export interface Engine {
	/** Stable engine id (`"random"`, `"light"`, `"heuristic"`, ...). */
	readonly id: string;
	/**
	 * Make a decision for `request`. Must return a valid showdown
	 * command for the request kind (`"move N"`, `"switch N"`,
	 * `"team ..."`, `"pass"`, or `","`-joined for doubles). When the
	 * request is `wait`, return `""`.
	 */
	choose(request: ChoiceRequest, ctx: EngineContext): string;
}

/** Pick a random element from `arr` using `prng`. */
export function sampleArray<T>(arr: T[], prng: PRNG): T {
	return arr[Math.floor(prng.random() * arr.length)];
}

/**
 * Apply epsilon-greedy noise: with probability `epsilon` returns a
 * uniformly-random element from `candidates`; otherwise returns
 * `bestPick`. If `candidates` is empty, returns `bestPick` unmodified.
 */
export function applyNoise<T>(
	bestPick: T,
	candidates: T[],
	epsilon: number,
	prng: PRNG
): T {
	if (epsilon <= 0 || candidates.length <= 1) return bestPick;
	if (prng.random() >= epsilon) return bestPick;
	const alternatives = candidates.filter(c => c !== bestPick);
	if (!alternatives.length) return bestPick;
	return sampleArray(alternatives, prng);
}

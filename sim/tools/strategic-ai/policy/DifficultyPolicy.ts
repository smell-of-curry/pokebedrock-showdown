/**
 * Strategic-AI difficulty policy.
 *
 * Maps the user-visible `difficulty` integer (1..5) to a concrete
 * engine instance plus the per-engine knobs (move-ladder advance cap,
 * info-forgetting, switch margin). Centralising this here lets us tune
 * each tier without touching the engines themselves.
 *
 * Mapping:
 *
 * | difficulty | engine      | cap  | ratio exp | forgetting | switch margin |
 * |-----------:|:------------|:-----|:----------|:-----------|:--------------|
 * | 1          | HeuristicE. | 0.75 | 0.30      | 0.85       | 26            |
 * | 2          | HeuristicE. | 0.60 | 0.40      | 0.55       | 16            |
 * | 3          | HeuristicE. | 0.30 | 1.00      | 0.25       | 10            |
 * | 4          | OnePly      | 0.12 | 1.00      | 0.08       | 6             |
 * | 5          | MCTS        | 0.00 | 1.00      | 0.00       | 4             |
 *
 * Measured against a fixed `random`-engine yardstick (200 mirrored
 * `gen9randombattle` games each, `--engine-b random`), which is the only
 * reference that stays comparable while the tiers themselves are being
 * retuned: d1 +110 Elo, d2 +230, d3 +363, d4 +338, d5 +449. Avoidable
 * immune-move clicks are 0.0-0.1% at every tier against the yardstick's
 * own 3-4%.
 *
 * ## Why every tier plays the same game
 *
 * Difficulty 1 used to run {@link RandomEngine} (uniformly random
 * choices) and difficulty 2 a separate, simpler {@link
 * LightHeuristicEngine}. Both are still selectable by name, but neither
 * is on the auto ladder any more, because "weak" was being implemented
 * as "structurally broken":
 *
 * - The random tier clicked moves the target was immune to ~3% of the
 *   time and switched on a coin flip.
 * - The light tier scored matchups off the *type chart alone* (so a mon
 *   with the right coverage move still read as a bad matchup), switched
 *   unconditionally below 30% HP with no check that the incoming mon
 *   survived, and used status moves on 2.4% of its turns against the
 *   real engine's 18%.
 *
 * Since both tiers are what low-level trainers and wild Pokemon roll
 * into, players met one of these on most early encounters and read the
 * whole AI as having an on/off switch — competent one battle, clicking
 * Earthquake into a Levitate mon the next.
 *
 * So weakness is now expressed the way a weak *player* is weak:
 * incomplete recall of what the opponent has shown (`infoForgetting`),
 * a poor sense of *how much* better the best line is
 * (`ladderRatioExponent`, which carries most of the tier-1-to-3
 * spread), a greater chance of taking a plausible-but-worse line
 * (`ladderAdvanceCap`), reluctance to switch (`switchMargin`), and less
 * lookahead (engine tier). What no tier does any more is pick a move
 * that accomplishes nothing: {@link selectByScoreLadder} only ever
 * walks between same-sign scores, so a positive option is never traded
 * for an immune or useless one no matter how loose the other knobs get.
 *
 * The `engine` option on `PlayerAIOptions` can force any tier to a
 * specific engine for tooling / testing.
 *
 * @license MIT
 */
import type { Engine, EngineContext } from "../engines/Engine";
import { HeuristicEngine } from "../engines/HeuristicEngine";
import { LightHeuristicEngine } from "../engines/LightHeuristicEngine";
import { MctsEngine } from "../engines/MctsEngine";
import { OnePlySearchEngine } from "../engines/OnePlySearchEngine";
import { RandomEngine } from "../engines/RandomEngine";

/**
 * Engine names accepted by {@link pickEngine}, as a runtime list so CLI
 * tools can validate a flag against it.
 */
export const ENGINE_NAMES = [
	"auto", "random", "light", "heuristic", "oneply", "mcts",
] as const;

/** Engine names accepted by {@link pickEngine}. */
export type EngineName = typeof ENGINE_NAMES[number];

/** Per-tier knobs applied to {@link EngineContext}. */
export interface DifficultyKnobs {
	ladderAdvanceCap: number;
	ladderRatioExponent: number;
	infoForgetting: number;
	switchMargin: number;
	searchBudgetMs?: number;
}

/** Compute the ladder/info-forgetting/switch knobs for a difficulty level. */
export function knobsForDifficulty(difficulty: number): DifficultyKnobs {
	switch (difficulty) {
	case 1:
		return {
			ladderAdvanceCap: 0.75, ladderRatioExponent: 0.30,
			infoForgetting: 0.85, switchMargin: 26,
		};
	case 2:
		return {
			ladderAdvanceCap: 0.60, ladderRatioExponent: 0.40,
			infoForgetting: 0.55, switchMargin: 16,
		};
	case 3:
		return {
			ladderAdvanceCap: 0.30, ladderRatioExponent: 1,
			infoForgetting: 0.25, switchMargin: 10,
		};
	case 4:
		return {
			ladderAdvanceCap: 0.12, ladderRatioExponent: 1,
			infoForgetting: 0.08, switchMargin: 6, searchBudgetMs: 100,
		};
	case 5:
		// Fully greedy: no move-selection noise at max difficulty.
		return {
			ladderAdvanceCap: 0, ladderRatioExponent: 1,
			infoForgetting: 0, switchMargin: 4, searchBudgetMs: 200,
		};
	default:
		return {
			ladderAdvanceCap: 0.30, ladderRatioExponent: 1,
			infoForgetting: 0.25, switchMargin: 10,
		};
	}
}

/**
 * Produce a fresh engine for `difficulty`, optionally overridden by
 * the explicit `engine` name.
 */
export function pickEngine(
	difficulty: number,
	engine: EngineName = "auto"
): Engine {
	const resolved = engine === "auto" ? autoFor(difficulty) : engine;
	switch (resolved) {
	case "random":
		return new RandomEngine();
	case "light":
		return new LightHeuristicEngine();
	case "heuristic":
		return new HeuristicEngine();
	case "oneply":
		return new OnePlySearchEngine();
	case "mcts":
		return new MctsEngine();
	default:
		// Unknown engine string: behave like tier 3.
		return new HeuristicEngine();
	}
}

function autoFor(difficulty: number): Exclude<EngineName, "auto"> {
	// Tiers 1-3 share the heuristic engine and differ only by knobs; see
	// the module docs for why the random and light engines are no longer
	// on the auto ladder.
	if (difficulty <= 3) return "heuristic";
	if (difficulty === 4) return "oneply";
	return "mcts";
}

/**
 * Apply the per-tier knobs to an {@link EngineContext}. Idempotent.
 */
export function applyKnobs(ctx: EngineContext, difficulty: number): void {
	const knobs = knobsForDifficulty(difficulty);
	ctx.ladderAdvanceCap = knobs.ladderAdvanceCap;
	ctx.ladderRatioExponent = knobs.ladderRatioExponent;
	ctx.infoForgetting = knobs.infoForgetting;
	ctx.switchMargin = knobs.switchMargin;
	// Always assign so a reused EngineContext can't inherit a prior tier's
	// budget; `options.searchBudgetMs` is re-applied by the caller afterward,
	// and readers fall back to DEFAULT_BUDGET_MS when this is undefined.
	ctx.searchBudgetMs = knobs.searchBudgetMs;
}

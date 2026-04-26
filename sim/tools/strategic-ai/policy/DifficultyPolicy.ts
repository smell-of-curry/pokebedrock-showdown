/**
 * Strategic-AI difficulty policy.
 *
 * Maps the user-visible `difficulty` integer (1..5) to a concrete
 * engine instance plus the per-engine knobs (epsilon-greedy noise,
 * info-forgetting). Centralising this here lets us tune each tier
 * without touching the engines themselves.
 *
 * Mapping (matches the project plan):
 *
 * | difficulty | engine        | noise epsilon | info forgetting |
 * |-----------:|:--------------|:--------------|:----------------|
 * | 1          | RandomEngine  | 1.0           | 1.0             |
 * | 2          | LightEngine   | 0.30          | 0.50            |
 * | 3          | HeuristicE.   | 0.10          | 0.20            |
 * | 4          | OnePly (TBD)  | 0.05          | 0.10            |
 * | 5          | MCTS (TBD)    | 0.00          | 0.00            |
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

/** Engine names accepted by `DifficultyPolicy.create`. */
export type EngineName =
	| "auto" |
	"random" |
	"light" |
	"heuristic" |
	"oneply" |
	"mcts";

/** Per-tier knobs applied to {@link EngineContext}. */
export interface DifficultyKnobs {
	noiseEpsilon: number;
	infoForgetting: number;
	searchBudgetMs?: number;
}

/** Compute the noise/info-forgetting knobs for a difficulty level. */
export function knobsForDifficulty(difficulty: number): DifficultyKnobs {
	switch (difficulty) {
		case 1:
			return { noiseEpsilon: 1.0, infoForgetting: 1.0 };
		case 2:
			return { noiseEpsilon: 0.30, infoForgetting: 0.50 };
		case 3:
			return { noiseEpsilon: 0.10, infoForgetting: 0.20 };
		case 4:
			return { noiseEpsilon: 0.05, infoForgetting: 0.10, searchBudgetMs: 100 };
		case 5:
			return { noiseEpsilon: 0.0, infoForgetting: 0.0, searchBudgetMs: 200 };
		default:
			return { noiseEpsilon: 0.10, infoForgetting: 0.20 };
	}
}

/**
 * Produce a fresh engine for `difficulty`, optionally overridden by
 * the explicit `engine` name. Search tiers (`oneply`, `mcts`) fall back
 * to the heuristic engine until those phases land.
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
	if (difficulty <= 1) return "random";
	if (difficulty === 2) return "light";
	if (difficulty === 3) return "heuristic";
	if (difficulty === 4) return "oneply";
	return "mcts";
}

/**
 * Apply the per-tier knobs to an {@link EngineContext}. Idempotent.
 */
export function applyKnobs(ctx: EngineContext, difficulty: number): void {
	const knobs = knobsForDifficulty(difficulty);
	ctx.noiseEpsilon = knobs.noiseEpsilon;
	ctx.infoForgetting = knobs.infoForgetting;
	if (knobs.searchBudgetMs) ctx.searchBudgetMs = knobs.searchBudgetMs;
}

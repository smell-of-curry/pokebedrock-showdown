/**
 * Strategic-AI public surface.
 *
 * Re-exports the public class, the engine factory, and the type
 * surface third-party hosts (e.g. `TrainerActor`) might want.
 *
 * @license MIT
 */
export { PlayerAI, type PlayerAIOptions } from "../player-ai";
export {
	pickEngine,
	knobsForDifficulty,
	applyKnobs,
	type EngineName,
	type DifficultyKnobs,
} from "./policy/DifficultyPolicy";
export { type Engine, type EngineContext } from "./engines/Engine";
export { HeuristicEngine } from "./engines/HeuristicEngine";
export { LightHeuristicEngine } from "./engines/LightHeuristicEngine";
export { MctsEngine } from "./engines/MctsEngine";
export { OnePlySearchEngine } from "./engines/OnePlySearchEngine";
export {
	RandomEngine,
	type RandomMoveOption,
	type RandomSwitchOption,
} from "./engines/RandomEngine";
export {
	BattleStateTracker,
	type TrackedPokemon,
	type SideState,
	type FieldState,
} from "./state/BattleStateTracker";
export { parseLine, type BattleEvent, type SideId } from "./state/LogParser";
export {
	calculateDamage,
	fromTracked,
	type DamageRange,
	type DamageCalcInput,
	type CalcPokemon,
} from "./mechanics/DamageCalc";
export { evaluateMove, type MoveEvalContext, type MoveEvaluation } from "./mechanics/MoveEvaluator";
export { evaluateMatchup, chooseBestSwitch, type MatchupScore } from "./mechanics/SwitchEvaluator";
export { pickTarget } from "./mechanics/TargetPicker";
export {
	chooseTransform,
	type TransformDecision,
	type TransformPolicyInput,
} from "./mechanics/TransformPolicy";
export {
	inferFoeActive,
	inferMon,
	topMoves,
	type FoeInference,
	type Distribution,
} from "./state/OpponentInference";

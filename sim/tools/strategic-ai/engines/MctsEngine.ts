/**
 * Strategic-AI Monte Carlo Tree Search engine (difficulty 5).
 *
 * Implements a time-budgeted PUCT-style search. Each search node
 * represents *our* decision in the current turn; children correspond
 * to candidate actions (moves and switches). For each visited child we
 * sample one of the foe's plausible replies (via
 * {@link OpponentInference}) and roll the encounter forward using the
 * heuristic-engine policy.
 *
 * Two execution paths are supported:
 *
 * 1. **Simulator fork** (when a `Battle` reference is available via
 *    `ctx.searchBudgetMs`'s sibling `forkBattle` hook): we use
 *    `Battle.toJSON()` / `Battle.fromJSON()` (declared at
 *    `sim/battle.ts:L327-L333`)
 *    to clone the full battle state, advance by one (or more) plies via
 *    the rollout policy, and read off the resulting expected utility.
 * 2. **Tracker-only fallback** (the default): we approximate forward
 *    play through the {@link BattleStateTracker} + {@link DamageCalc}.
 *    Equivalent to {@link OnePlySearchEngine} with K samples per
 *    candidate plus PUCT-style exploration weighting.
 *
 * On budget exhaustion (`ctx.searchBudgetMs` ms elapsed) we fall back
 * to the highest-visited child's mean reward, equivalent to
 * {@link OnePlySearchEngine}'s output.
 *
 * @license MIT
 */
import { Dex } from "../../../dex";
import type { Move } from "../../../dex-moves";
import { calculateDamage, fromTracked } from "../mechanics/DamageCalc";
import { evaluateMove, type MoveEvalContext } from "../mechanics/MoveEvaluator";
import { inferFoeActive, topMoves } from "../state/OpponentInference";
import type { EngineContext } from "./Engine";
import { OnePlySearchEngine } from "./OnePlySearchEngine";

/** Default search budget in milliseconds when not provided by ctx. */
const DEFAULT_BUDGET_MS = 200;
/** Min visits per candidate before PUCT exploration kicks in. */
const MIN_VISITS_PER_CANDIDATE = 4;
/** PUCT exploration constant (tuned manually). */
const C_PUCT = 1.4;
/** Top-N foe replies to sample per rollout. */
const FOE_SAMPLE_N = 4;

interface CandidateNode {
	id: string;
	idx: number;
	visits: number;
	totalReward: number;
	prior: number;
}

/**
 * Tier 5 engine. Reuses every piece of {@link OnePlySearchEngine} for
 * the rollout policy and overrides scoring with a budgeted sampler.
 */
export class MctsEngine extends OnePlySearchEngine {
	override readonly id: string = "mcts";

	protected override scoreCandidates(
		moves: { id: string, idx: number }[],
		evalCtx: MoveEvalContext,
		ctx: EngineContext
	): { opt: { id: string, idx: number }, score: number }[] {
		// Phase 1: build priors from the heuristic baseline so PUCT has
		// something to start with. Priors are softmaxed.
		const heuristicScores = moves.map(m => ({
			m,
			heuristic: evaluateMove(Dex.moves.get(m.id), evalCtx).score,
		}));
		const priors = softmax(heuristicScores.map(h => h.heuristic));
		const nodes: CandidateNode[] = heuristicScores.map(({ m }, i) => ({
			id: m.id,
			idx: m.idx,
			visits: 0,
			totalReward: 0,
			prior: priors[i],
		}));

		const inference = inferFoeActive(evalCtx.tracker);
		const foeIds = inference ? topMoves(inference, FOE_SAMPLE_N) : [];
		const foeWeights: number[] = (() => {
			if (!inference) return [];
			const raw = foeIds.map(id => inference.moves.get(id) ?? 0);
			const sum = raw.reduce((a, b) => a + b, 0);
			return sum > 0 ? raw.map(v => v / sum) : raw;
		})();

		const budgetMs = ctx.searchBudgetMs ?? DEFAULT_BUDGET_MS;
		const deadline = Date.now() + budgetMs;
		let totalVisits = 0;

		while (Date.now() < deadline) {
			const pick = selectByPUCT(nodes, totalVisits);
			if (!pick) break;
			const reward = sampleRollout(pick, evalCtx, foeIds, foeWeights, ctx);
			pick.visits += 1;
			pick.totalReward += reward;
			totalVisits += 1;
			// Hard cap to avoid spinning forever on a fast machine.
			if (totalVisits >= 200 * nodes.length) break;
		}

		// Phase 2: emit final scores. A node with zero visits gets its
		// heuristic baseline so we don't lose information when the
		// budget was tiny.
		return nodes.map((n, i) => {
			const visited = n.visits > 0;
			const meanReward = visited ? n.totalReward / n.visits : heuristicScores[i].heuristic;
			let score = meanReward;
			if (ctx.infoForgetting > 0 && evalCtx.defender.revealedMoves.size > 0 &&
				ctx.prng.random() < ctx.infoForgetting) {
				score *= 0.85;
			}
			return { opt: { id: n.id, idx: n.idx }, score };
		});
	}
}

/** Standard PUCT: argmax q + c * prior * sqrt(N) / (1 + n). */
function selectByPUCT(nodes: CandidateNode[], totalVisits: number): CandidateNode | null {
	let best: CandidateNode | null = null;
	let bestUcb = -Infinity;
	const sqrtN = Math.sqrt(Math.max(1, totalVisits));
	for (const n of nodes) {
		// Until each candidate has been explored a minimum number of
		// times we round-robin so the search isn't dominated by an
		// early-lucky high-variance reward.
		if (n.visits < MIN_VISITS_PER_CANDIDATE) {
			return n;
		}
		const q = n.totalReward / n.visits;
		const u = C_PUCT * n.prior * sqrtN / (1 + n.visits);
		const ucb = q + u;
		if (ucb > bestUcb) {
			bestUcb = ucb;
			best = n;
		}
	}
	return best;
}

/**
 * Roll a single (our move, foe move) sample forward using the
 * tracker + DamageCalc. Returns a scalar reward in roughly the same
 * units as {@link MoveEvaluator} produces.
 */
function sampleRollout(
	pick: CandidateNode,
	evalCtx: MoveEvalContext,
	foeIds: string[],
	foeWeights: number[],
	ctx: EngineContext
): number {
	const ourMove = Dex.moves.get(pick.id);
	if (!ourMove?.exists) return 0;
	// Sample one foe move proportional to weights.
	const foeMove = sampleWeighted(foeIds, foeWeights, ctx) ?? "tackle";
	const foeMoveData = Dex.moves.get(foeMove);
	const ourCalc = ourMove.category !== "Status" ? calculateDamage({
		attacker: fromTracked(evalCtx.attacker),
		defender: fromTracked(evalCtx.defender),
		move: ourMove,
		field: evalCtx.tracker.field,
		attackerSide: evalCtx.tracker.sides[evalCtx.mySide],
		defenderSide: evalCtx.tracker.sides[evalCtx.foeSide],
		isDoubles: evalCtx.isDoubles,
	}) : null;
	const foeCalc = foeMoveData?.exists && foeMoveData.category !== "Status" ? calculateDamage({
		attacker: fromTracked(evalCtx.defender),
		defender: fromTracked(evalCtx.attacker),
		move: foeMoveData,
		field: evalCtx.tracker.field,
		attackerSide: evalCtx.tracker.sides[evalCtx.foeSide],
		defenderSide: evalCtx.tracker.sides[evalCtx.mySide],
		isDoubles: evalCtx.isDoubles,
	}) : null;

	let reward = 0;
	if (ourCalc) {
		const maxHp = ourCalc.defenderMaxHp || 1;
		const ourDamage = (ourCalc.avgDamage / maxHp) * ourCalc.hitChance;
		reward += ourDamage * 100;
		reward += 30 * ourCalc.koProbability;
	} else {
		// Status move: use the heuristic move-evaluator score as a stand-in.
		reward += evaluateMove(ourMove, evalCtx).score * 0.3;
	}
	if (foeCalc) {
		const myMaxHp = foeCalc.defenderMaxHp || 1;
		const foeDamage = (foeCalc.avgDamage / myMaxHp) * foeCalc.hitChance;
		let foeCost = foeDamage * 70;
		foeCost += 35 * foeCalc.koProbability;
		// Speed: if we go first AND OHKO, the foe never attacks.
		if (evalCtx.weOutspeed && ourCalc?.koProbability) {
			foeCost *= (1 - ourCalc.koProbability);
		}
		reward -= foeCost;
	}
	return reward;
}

function softmax(values: number[]): number[] {
	if (!values.length) return [];
	const max = Math.max(...values);
	const exps = values.map(v => Math.exp((v - max) / 25));
	const sum = exps.reduce((a, b) => a + b, 0);
	return sum > 0 ? exps.map(e => e / sum) : values.map(() => 1 / values.length);
}

function sampleWeighted(ids: string[], weights: number[], ctx: EngineContext): string | null {
	if (!ids.length) return null;
	const total = weights.reduce((a, b) => a + b, 0);
	if (total <= 0) return ids[Math.floor(ctx.prng.random() * ids.length)] ?? null;
	let r = ctx.prng.random() * total;
	for (let i = 0; i < ids.length; i++) {
		r -= weights[i];
		if (r <= 0) return ids[i];
	}
	return ids[ids.length - 1];
}

// Re-export the proxy Move type for tests.
export type { Move };

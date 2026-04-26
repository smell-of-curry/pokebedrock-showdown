/**
 * Strategic-AI one-ply search engine (difficulty 4).
 *
 * Extends {@link HeuristicEngine} by evaluating every candidate action
 * against the foe's *predicted* reply this turn. For each (our move,
 * foe move) pair we compute:
 *
 *     utility = α * koValueWeDeal
 *             + β * expectedDamageWeDeal
 *             - γ * expectedDamageWeTake
 *             + δ * koPenalty(weGetKOed)
 *
 * where the foe move distribution comes from
 * {@link OpponentInference}. We don't fork the actual simulator here —
 * that's tier 5's job. This tier just adds one layer of "if I do X, do
 * I die for it?" to the heuristic.
 *
 * Speed order matters: if we outspeed the foe and our move OHKOs them,
 * we never take their reply. If we don't outspeed (or foe holds Choice
 * Scarf), the foe's damage lands first.
 *
 * @license MIT
 */
import { Dex } from "../../../dex";
import type { Move } from "../../../dex-moves";
import { calculateDamage, fromTracked } from "../mechanics/DamageCalc";
import { evaluateMove, type MoveEvalContext } from "../mechanics/MoveEvaluator";
import { inferFoeActive, topMoves } from "../state/OpponentInference";
import { HeuristicEngine } from "./HeuristicEngine";
import type { EngineContext } from "./Engine";

/** Number of top foe moves we sample by likelihood for the lookahead. */
const SAMPLE_FOE_MOVES = 4;

/** Weights for the one-ply utility blend. Tuned vs the heuristic engine. */
const W_OUR_DAMAGE = 1.0;
const W_OUR_KO = 30;
const W_FOE_DAMAGE = 0.7;
const W_GET_KOED = 35;

/**
 * Heuristic + one-ply expectimax over the predicted foe reply.
 */
export class OnePlySearchEngine extends HeuristicEngine {
	override readonly id: string = "oneply";

	protected override scoreCandidates(
		moves: { id: string, idx: number }[],
		evalCtx: MoveEvalContext,
		ctx: EngineContext
	): { opt: { id: string, idx: number }, score: number }[] {
		const inference = inferFoeActive(evalCtx.tracker);
		const foeMoveCandidates = inference ? topMoves(inference, SAMPLE_FOE_MOVES) : [];
		const foeWeights = inference ? topMoveWeights(inference, foeMoveCandidates) : [];

		return moves.map(opt => {
			const move = Dex.moves.get(opt.id);
			if (!move?.exists) return { opt, score: -Infinity };
			const baseEval = evaluateMove(move, evalCtx);
			const ourScore = computeOurOutcome(move, evalCtx);
			let weightedFoe = 0;
			let totalWeight = 0;
			for (let i = 0; i < foeMoveCandidates.length; i++) {
				const id = foeMoveCandidates[i];
				const w = foeWeights[i] ?? 0;
				if (w <= 0) continue;
				const foeMove = Dex.moves.get(id);
				if (!foeMove?.exists) continue;
				weightedFoe += w * computeFoeOutcome(foeMove, evalCtx, ourScore);
				totalWeight += w;
			}
			if (totalWeight > 0) weightedFoe /= totalWeight;
			// Combine: we use the heuristic baseline as a backbone,
			// then layer the search delta on top so categories that
			// don't go through the calc (status, hazards, pivot) still
			// score correctly.
			const search = ourScore.utility - weightedFoe;
			let score = 0.4 * baseEval.score + search;
			if (ctx.infoForgetting > 0 && evalCtx.defender.revealedMoves.size > 0 &&
				ctx.prng.random() < ctx.infoForgetting) {
				score *= 0.85;
			}
			return { opt, score };
		});
	}
}

/** Weight = score / total of the inference distribution restricted to top-N. */
function topMoveWeights(inference: NonNullable<ReturnType<typeof inferFoeActive>>, ids: string[]): number[] {
	const out = ids.map(id => inference.moves.get(id) ?? 0);
	const sum = out.reduce((a, b) => a + b, 0);
	if (sum <= 0) return out;
	return out.map(v => v / sum);
}

/**
 * Compute our move's outcome (damage we deal, KO probability, utility
 * contribution). Returns the components so the foe's reply can read
 * `ourKills` to know if we KOed first.
 */
function computeOurOutcome(
	move: Move,
	ctx: MoveEvalContext
): { utility: number, koProb: number, ourDamageFraction: number } {
	if (move.category === "Status") {
		return { utility: 0, koProb: 0, ourDamageFraction: 0 };
	}
	const calc = calculateDamage({
		attacker: fromTracked(ctx.attacker),
		defender: fromTracked(ctx.defender),
		move,
		field: ctx.tracker.field,
		attackerSide: ctx.tracker.sides[ctx.mySide],
		defenderSide: ctx.tracker.sides[ctx.foeSide],
		isDoubles: ctx.isDoubles,
	});
	const maxHp = calc.defenderMaxHp || 1;
	const dmgFrac = (calc.avgDamage / maxHp) * calc.hitChance;
	let utility = W_OUR_DAMAGE * dmgFrac * 100;
	utility += W_OUR_KO * calc.koProbability;
	return { utility, koProb: calc.koProbability, ourDamageFraction: dmgFrac };
}

/**
 * Compute the foe's reply outcome and translate into a *cost* (positive
 * means bad for us). If we outspeed and our move KOs, the foe never
 * gets to fire — so the cost is 0.
 */
function computeFoeOutcome(
	foeMove: Move,
	ctx: MoveEvalContext,
	ourOutcome: { utility: number, koProb: number, ourDamageFraction: number }
): number {
	if (foeMove.category === "Status") {
		// A status move from the foe is mildly bad for us.
		return 5;
	}
	const calc = calculateDamage({
		attacker: fromTracked(ctx.defender),
		defender: fromTracked(ctx.attacker),
		move: foeMove,
		field: ctx.tracker.field,
		attackerSide: ctx.tracker.sides[ctx.foeSide],
		defenderSide: ctx.tracker.sides[ctx.mySide],
		isDoubles: ctx.isDoubles,
	});
	const myMaxHp = calc.defenderMaxHp || 1;
	const dmgFrac = (calc.avgDamage / myMaxHp) * calc.hitChance;
	let cost = W_FOE_DAMAGE * dmgFrac * 100;
	// We're KOed by the foe? Penalty.
	cost += W_GET_KOED * calc.koProbability;
	// Speed factor: if we outspeed *and* our move OHKOs, the foe never
	// fires. Approximate as `cost *= (1 - P(we move first AND KO))`.
	if (ctx.weOutspeed && ourOutcome.koProb > 0) {
		cost *= (1 - ourOutcome.koProb);
	}
	return cost;
}

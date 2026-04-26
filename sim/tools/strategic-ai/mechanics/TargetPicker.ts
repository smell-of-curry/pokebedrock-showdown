/**
 * Strategic-AI target picker for doubles / triples.
 *
 * Showdown's `MoveRequest.active[i].moves[j].target` tells us what
 * targeting class a move uses (`normal`, `allAdjacentFoes`, `allies`,
 * `self`, etc.). For most spread targets the simulator either picks
 * automatically (`allAdjacent`) or rejects an explicit target. For
 * `normal` and a few related classes we *must* supply an integer
 * target.
 *
 * This module decides which adjacent foe to target, accounting for:
 *
 * - Spread-move BP penalty (0.75x): we still pick the foe who'd take
 *   the most damage *after* the spread cut.
 * - Redirection abilities: Storm Drain (Water -> redirected to ally
 *   with the ability), Lightning Rod (Electric), Follow Me / Rage
 *   Powder volatiles. We avoid picking redirected slots when the
 *   alternative scores nearly as well.
 * - Avoiding allies with our own spread moves (e.g. a Ground move with
 *   a grounded ally).
 * - Helping Hand bonus (when our ally selected Helping Hand).
 * - Wide Guard / Quick Guard: we don't bother avoiding them; the
 *   simulator handles the "blocked" outcome and we just take the
 *   damage hit by the heuristic.
 *
 * @license MIT
 */
import { toID } from "../../../dex";
import type { Move } from "../../../dex-moves";
import type { BattleStateTracker, TrackedPokemon } from "../state/BattleStateTracker";
import { calculateDamage, fromTracked } from "./DamageCalc";

/** Showdown target indices: `-2,-1` are allies, `1,2` are foes. */
export type TargetIndex = -3 | -2 | -1 | 1 | 2 | 3;

/** Inputs for {@link pickTarget}. */
export interface TargetPickInput {
	tracker: BattleStateTracker;
	attacker: TrackedPokemon;
	move: Move;
	/** All foe slots we might point at (active mons on the foe's side). */
	foeSlots: TrackedPokemon[];
	/** Our active slots (used for ally-avoidance and Helping Hand). */
	allySlots: TrackedPokemon[];
	/** True if our ally selected Helping Hand for this turn. */
	allyUsedHelpingHand?: boolean;
	/** Convert tracker `position` to showdown slot index (1=a, 2=b, ...). */
	foePositionToTarget?: (position: number) => TargetIndex;
}

/**
 * Pick the best target for `move`. Returns a Showdown target index
 * (1 for the first foe slot, 2 for the second) or `null` if the move
 * is a spread / no-target move that should be issued without a target.
 */
export function pickTarget(input: TargetPickInput): TargetIndex | null {
	const { move, foeSlots } = input;
	const target = move.target || "normal";
	if (
		target === "allAdjacent" ||
		target === "allAdjacentFoes" ||
		target === "all" ||
		target === "foeSide" ||
		target === "allySide" ||
		target === "self" ||
		target === "scripted" ||
		target === "randomNormal"
	) {
		return null;
	}
	if (foeSlots.length === 0) return null;

	let best: TargetIndex | null = null;
	let bestScore = -Infinity;
	for (const foe of foeSlots) {
		if (foe.fainted) continue;
		const targetIdx = (input.foePositionToTarget?.(foe.position) ?? ((foe.position + 1) as TargetIndex));
		const score = scoreTarget(foe, input);
		if (score > bestScore) {
			best = targetIdx;
			bestScore = score;
		}
	}
	return best;
}

function scoreTarget(foe: TrackedPokemon, input: TargetPickInput): number {
	const { tracker, attacker, move } = input;
	const a = fromTracked(attacker);
	const d = fromTracked(foe);
	const range = calculateDamage({
		attacker: a,
		defender: d,
		move,
		field: tracker.field,
		attackerSide: tracker.sides[tracker.mySide],
		defenderSide: tracker.sides[tracker.foeSide],
		isDoubles: input.allySlots.length > 1 || input.foeSlots.length > 1,
		spread: false,
	});
	let score = range.avgDamage;
	if (range.koProbability >= 0.95) score += 1500;
	else if (range.koProbability >= 0.5) score += 800;

	// Redirection penalty.
	const moveType = move.type;
	for (const ally of input.allySlots) {
		if (ally.id === foe.id) continue;
		if (ally.id === attacker.id) continue;
		const ab = toID(ally.ability);
		if (ab === "stormdrain" && moveType === "Water") score -= 1000;
		if (ab === "lightningrod" && moveType === "Electric") score -= 1000;
	}
	for (const f of input.foeSlots) {
		if (f.id === foe.id) continue;
		if (toID(f.ability) === "stormdrain" && moveType === "Water") score -= 500;
		if (toID(f.ability) === "lightningrod" && moveType === "Electric") score -= 500;
	}
	if (foe.volatiles.has("followme") || foe.volatiles.has("ragepowder")) {
		score -= 800;
	}

	if (input.allyUsedHelpingHand) score *= 1.5;
	return score;
}

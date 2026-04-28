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
		target === "randomNormal" ||
		// Ally-targeted moves (Helping Hand, Coaching, Decorate, Pollen
		// Puff into ally, ...) don't take a foe slot index. Callers are
		// expected to format these themselves with a negative target;
		// we just return `null` so a misuse here can't manufacture an
		// illegal positive index.
		target === "adjacentAlly" ||
		target === "adjacentAllyOrSelf" ||
		target === "allies"
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

	// Redirection: Storm Drain / Lightning Rod / Follow Me / Rage Powder
	// pull single-target moves on our side onto the redirector, regardless
	// of which foe slot we explicitly target. The penalty therefore needs
	// to land on the *non-redirector* slots so the picker effectively
	// surfaces the redirector as the highest-scoring target (since that's
	// where the move will end up anyway).
	const moveType = move.type;
	const allyRedirector = input.allySlots.find(ally => {
		if (ally.id === attacker.id) return false;
		const ab = toID(ally.ability);
		return (ab === "stormdrain" && moveType === "Water") ||
			(ab === "lightningrod" && moveType === "Electric");
	});
	if (allyRedirector) {
		// An ally with Storm Drain / Lightning Rod siphons our own move.
		// We don't gain anything by spamming it into a foe slot; mark all
		// foe slots equally bad. Conservative penalty applied to every foe.
		score -= 1000;
	}

	const foeRedirector = input.foeSlots.find(f => {
		const ab = toID(f.ability);
		const hasVolatile = f.volatiles.has("followme") || f.volatiles.has("ragepowder");
		return hasVolatile ||
			(ab === "stormdrain" && moveType === "Water") ||
			(ab === "lightningrod" && moveType === "Electric");
	});
	if (foeRedirector && foeRedirector.id !== foe.id) {
		// Picking the non-redirector is pointless — the simulator will
		// reroute the move to the redirector regardless.
		score -= 800;
	}

	if (input.allyUsedHelpingHand) score *= 1.5;
	return score;
}

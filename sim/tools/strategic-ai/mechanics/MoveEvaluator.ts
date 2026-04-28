/**
 * Strategic-AI move evaluator.
 *
 * The legacy `chooseBestMove`/`evaluateStatusMove` lived as a giant
 * `switch` over hardcoded move IDs. This module replaces that with a
 * data-driven scorer: every move is classified into one of a small set
 * of "effect categories" (damage, recover, boost, status, hazard,
 * pivot, screen, phaze, priority, ...) and each category has its own
 * rule. New moves slot in for free as long as their `Move` data
 * advertises the right flags / fields.
 *
 * The scorer returns a unitless utility number, with damage moves
 * normalised to roughly the same scale as status moves so that the
 * engine can compare them directly. A pivot move's score is its damage
 * value plus the value of its best switch target (see
 * `valueOfBestSwitch`).
 *
 * @license MIT
 */
import { Dex, toID } from "../../../dex";
import type { Move } from "../../../dex-moves";
import type { BattleStateTracker, TrackedPokemon } from "../state/BattleStateTracker";
import {
	calculateDamage,
	type CalcPokemon,
	type DamageRange,
	estimateMaxHp,
	fromTracked,
} from "./DamageCalc";

/**
 * What a single move evaluation needs to know about the world. Designed
 * to be cheap to fill in from a `BattleStateTracker` plus a
 * `MoveRequest` slot.
 */
export interface MoveEvalContext {
	tracker: BattleStateTracker;
	attacker: TrackedPokemon;
	defender: TrackedPokemon;
	/** Tracker side ids. */
	mySide: "p1" | "p2" | "p3" | "p4";
	foeSide: "p1" | "p2" | "p3" | "p4";
	/** Speed-tier comparison: true if our mon outspeeds the foe right now. */
	weOutspeed: boolean;
	/** True for Doubles/Triples (used for spread move logic). */
	isDoubles: boolean;
	/** Optional pre-computed value of our best switch-in for pivot scoring. */
	valueOfBestSwitch?: number;
}

/** Result of a move evaluation. */
export interface MoveEvaluation {
	moveId: string;
	score: number;
	damage?: DamageRange;
	/** A short tag explaining the dominant factor in `score`. */
	rationale: string;
}

/**
 * Evaluate a single move against a single defender.
 *
 * The score is a heuristic utility number: large positive = great,
 * 0 = neutral / no-op, negative = actively harmful. The engine should
 * pick the move with the highest score (with optional epsilon noise).
 */
export function evaluateMove(
	move: Move | string,
	ctx: MoveEvalContext
): MoveEvaluation {
	const m = typeof move === "string" ? Dex.moves.get(move) : move;
	const moveId = toID(m.id || (m as { name?: string }).name || "");
	if (!m || !moveId) {
		return { moveId, score: -Infinity, rationale: "unknown" };
	}
	if (m.category === "Status") {
		return evaluateStatus(m, moveId, ctx);
	}
	const { tracker, attacker, defender } = ctx;
	const calc = calculateDamage({
		attacker: fromTracked(attacker),
		defender: fromTracked(defender),
		move: m,
		field: tracker.field,
		attackerSide: tracker.sides[ctx.mySide],
		defenderSide: tracker.sides[ctx.foeSide],
		isDoubles: ctx.isDoubles,
	});
	const maxHp = calc.defenderMaxHp || estimateMaxHp(fromTracked(defender));
	const damageScore = (calc.avgDamage / Math.max(1, maxHp)) * 100; // 0..100ish
	let score = damageScore * calc.hitChance;
	let rationale = "damage";
	if (calc.koProbability > 0.95) {
		score += 40 * calc.koProbability;
		rationale = "OHKO";
	} else if (calc.koProbability > 0.5) {
		score += 25 * calc.koProbability;
		rationale = "likelyKO";
	}
	// Priority bonus: when the foe outspeeds and is in KO range, priority
	// effectively converts a possible KO into a guaranteed one.
	if (m.priority > 0 && !ctx.weOutspeed) {
		const remaining = (defender.hpFraction ?? 1) * maxHp;
		if (calc.avgDamage >= remaining * 0.9) {
			score += 25;
			rationale = "priorityKO";
		} else {
			score += 5;
		}
	}
	if (m.priority < 0) {
		score -= 5;
	}
	// Pivot moves: include the value of our best switch target.
	if (m.selfSwitch) {
		const pivotValue = ctx.valueOfBestSwitch ?? 0;
		score += pivotValue * 0.6 + 5;
		rationale = "pivot";
	}
	// Recoil moves: penalise when we're already low.
	if (m.recoil && (attacker.hpFraction ?? 1) < 0.4) score -= 10;
	if (m.mindBlownRecoil && (attacker.hpFraction ?? 1) < 0.6) score -= 15;
	// Self-destruct: only if it KOs.
	// Move data only uses string literals (`"always"`, `"ifHit"`) for
	// `selfdestruct`; the boolean form is dead.
	if (m.selfdestruct === "ifHit" || m.selfdestruct === "always") {
		if (calc.koProbability < 0.95) score -= 50;
	}
	// Drain moves: bonus for healing into the threat.
	if (m.drain) {
		score += 4;
	}
	// Damaging hazard removers (Rapid Spin, Mortal Spin) — the
	// hazard-removal block in `evaluateStatus` is unreachable for these
	// moves because they are Physical-category, so we add the same
	// utility here on the damage path.
	if (moveId === "rapidspin" || moveId === "mortalspin") {
		const mySideState = tracker.sides[ctx.mySide];
		const myHazards =
			(mySideState.stealthRock ? 1 : 0) +
			mySideState.spikes +
			mySideState.toxicSpikes +
			(mySideState.stickyWeb ? 1 : 0);
		if (myHazards > 0) {
			score += myHazards * 12;
			rationale = "hazardRemoval";
		}
	}
	return { moveId, score, damage: calc, rationale };
}

/**
 * Status-move scoring. Categorises by effect and applies per-category
 * rules. Returns a `MoveEvaluation` whose `score` is comparable to
 * damage move scores (roughly 0..100 scale).
 */
function evaluateStatus(
	move: Move,
	moveId: string,
	ctx: MoveEvalContext
): MoveEvaluation {
	const { attacker, defender, tracker, foeSide, mySide } = ctx;
	const mySideState = tracker.sides[mySide];
	const foeSideState = tracker.sides[foeSide];

	let score = 0;
	let rationale = "status";
	const myHp = attacker.hpFraction ?? 1;

	// Recovery moves.
	if (isRecoveryMove(moveId, move)) {
		const deficit = 1 - myHp;
		score = deficit * 60;
		if (myHp > 0.8) score = -10; // Don't waste a turn at near-full HP.
		if (attacker.status === "tox" || attacker.status === "psn") score -= 5;
		rationale = "recover";
		return { moveId, score, rationale };
	}

	// Self stat-up moves. `move.boosts` doubles as the foe-debuff field for
	// moves like Growl / Charm / Tail Whip, so only treat it as a self-boost
	// when the move actually targets the user.
	const isSelfBoost =
		!!move.self?.boosts ||
		(!!move.boosts && move.target === "self") ||
		moveId === "shellsmash" || moveId === "bellydrum";
	if (isSelfBoost) {
		const boostScore = scoreBoostMove(move, moveId, ctx);
		return { moveId, score: boostScore, rationale: "boost" };
	}
	// Foe-target stat-drop moves (Growl, Charm, Tail Whip, Sand Attack, ...).
	if (move.boosts) {
		const debuffScore = scoreDebuffMove(move, ctx);
		return { moveId, score: debuffScore, rationale: "debuff" };
	}

	// Status-inflicting moves.
	if (move.status) {
		score = scoreStatusInfliction(move.status, ctx);
		rationale = `status:${move.status}`;
		return { moveId, score, rationale };
	}

	// Hazard moves.
	if (moveId === "stealthrock") {
		if (foeSideState.stealthRock) return { moveId, score: -10, rationale: "hazardSet" };
		return { moveId, score: hazardSetValue(ctx, "stealthrock"), rationale: "hazard:sr" };
	}
	if (moveId === "spikes") {
		if (foeSideState.spikes >= 3) return { moveId, score: -10, rationale: "hazardCap" };
		return { moveId, score: hazardSetValue(ctx, "spikes"), rationale: "hazard:spikes" };
	}
	if (moveId === "toxicspikes") {
		if (foeSideState.toxicSpikes >= 2) return { moveId, score: -10, rationale: "hazardCap" };
		return { moveId, score: hazardSetValue(ctx, "toxicspikes"), rationale: "hazard:tspikes" };
	}
	if (moveId === "stickyweb") {
		if (foeSideState.stickyWeb) return { moveId, score: -10, rationale: "hazardSet" };
		return { moveId, score: hazardSetValue(ctx, "stickyweb"), rationale: "hazard:web" };
	}

	// Hazard removal.
	if (moveId === "rapidspin" || moveId === "defog" || moveId === "tidyup" || moveId === "mortalspin") {
		const myHazards =
			(mySideState.stealthRock ? 1 : 0) +
			mySideState.spikes +
			mySideState.toxicSpikes +
			(mySideState.stickyWeb ? 1 : 0);
		score = myHazards * 12;
		if (moveId === "defog") {
			// Defog also removes our screens, which is bad; account for it.
			if (mySideState.reflectTurns + mySideState.lightScreenTurns > 0) score -= 6;
			if (foeSideState.reflectTurns + foeSideState.lightScreenTurns > 0) score += 8;
		}
		return { moveId, score, rationale: "hazardRemoval" };
	}

	// Phazing / forcing switches.
	if (move.forceSwitch) {
		// Useful when foe has setup boosts.
		const foeBoosts = sumPositiveBoosts(defender);
		score = foeBoosts * 10 + 5;
		return { moveId, score, rationale: "phaze" };
	}

	// Screens.
	if (moveId === "reflect" || moveId === "lightscreen" || moveId === "auroraveil") {
		const turns =
			moveId === "reflect" ? mySideState.reflectTurns :
			moveId === "lightscreen" ? mySideState.lightScreenTurns :
			mySideState.auroraVeilTurns;
		if (turns > 0) return { moveId, score: -10, rationale: "screenUp" };
		score = 18;
		const weather = tracker.field.weather;
		const auroraOk = weather === "snow" || weather === "snowscape" || weather === "hail";
		if (moveId === "auroraveil" && !auroraOk) {
			score = -20; // Aurora Veil requires snow/hail.
		}
		return { moveId, score, rationale: "screen" };
	}

	// Field setters.
	if (moveId === "trickroom") {
		// Useful if we're slower; harmful if we're faster.
		score = ctx.weOutspeed ? -15 : 22;
		if (tracker.field.trickRoom) score = -10;
		return { moveId, score, rationale: "trickroom" };
	}
	if (moveId === "tailwind") {
		score = mySideState.tailwindTurns > 0 ? -5 : 18;
		return { moveId, score, rationale: "tailwind" };
	}

	// Substitute.
	if (moveId === "substitute") {
		if (myHp <= 0.25) return { moveId, score: -15, rationale: "subTooLow" };
		if (attacker.volatiles.has("substitute")) return { moveId, score: -10, rationale: "subUp" };
		// Bonus if foe is choice-locked into a status move target.
		score = 12;
		if (defender.choiceLocked) score += 6;
		return { moveId, score, rationale: "sub" };
	}

	// Taunt / Encore / Disable / Torment.
	if (moveId === "taunt") {
		// Punish setup mons / status spammers.
		score = sumPositiveBoosts(defender) > 0 ? 5 : 12;
		return { moveId, score, rationale: "taunt" };
	}
	if (moveId === "encore") {
		score = defender.lastMove ? 14 : -5;
		return { moveId, score, rationale: "encore" };
	}
	if (moveId === "disable") {
		score = defender.lastMove ? 10 : -5;
		return { moveId, score, rationale: "disable" };
	}

	// Wish / Healing Wish / Memento.
	if (moveId === "wish") {
		score = mySideState.fainted >= 2 ? 10 : 18;
		return { moveId, score, rationale: "wish" };
	}
	if (moveId === "healingwish" || moveId === "lunardance") {
		score = (1 - myHp) * 30 + 5;
		if (myHp > 0.85) score = -20;
		return { moveId, score, rationale: "healWish" };
	}

	// Trick / Switcheroo / Knock Off (status branch handled by damage path).
	if (moveId === "trick" || moveId === "switcheroo") {
		const aItem = toID(attacker.item);
		const dItem = toID(defender.item);
		if (!aItem) return { moveId, score: -10, rationale: "trickNoItem" };
		// Tricking a Choice item onto a setup mon is gold.
		if (aItem.startsWith("choice")) score += 18;
		// Receiving an item is mildly good.
		if (dItem) score += 4;
		return { moveId, score, rationale: "trick" };
	}

	// Fallback: small positive value so the AI considers exotic status moves
	// rather than ignoring them entirely.
	return { moveId, score: 2, rationale: "unknownStatus" };
}

function isRecoveryMove(moveId: string, move: Move): boolean {
	if (move.heal) return true;
	switch (moveId) {
		case "recover":
		case "softboiled":
		case "milkdrink":
		case "moonlight":
		case "morningsun":
		case "synthesis":
		case "roost":
		case "shoreup":
		case "slackoff":
		case "rest":
		// `wish` is intentionally NOT here: it has a dedicated branch in
		// `evaluateStatus` (delayed self-heal scoring) that would otherwise
		// be unreachable.
		case "healorder":
		case "lifedew":
			return true;
	}
	return false;
}

function scoreBoostMove(
	move: Move,
	moveId: string,
	ctx: MoveEvalContext
): number {
	const boosts = move.self?.boosts ?? move.boosts ?? {};
	const myBoosts = ctx.attacker.boosts;
	let score = 0;
	for (const [stat, amount] of Object.entries(boosts)) {
		if (typeof amount !== "number") continue;
		const cur = myBoosts[stat] || 0;
		// Diminishing returns: +1 from 0 is more valuable than +1 from +5.
		const incremental = amount > 0 ? Math.max(0, 6 - cur) / 6 : 1;
		const stageValue = stat === "spe" ? 12 : (stat === "atk" || stat === "spa" ? 9 : 6);
		score += amount * stageValue * incremental;
	}
	if (moveId === "bellydrum") {
		score = (ctx.attacker.hpFraction ?? 1) >= 0.55 ? 60 : -20;
	}
	if (moveId === "shellsmash") {
		score = 35;
	}
	// Boost moves are awful when we're about to die.
	if ((ctx.attacker.hpFraction ?? 1) < 0.25) score -= 10;
	return score;
}

/**
 * Score a foe-target stat-drop move (e.g. Growl, Tail Whip, Charm).
 * The shape of `move.boosts` is identical to a self-boost, but the
 * stages are *applied to the defender* and so should be inverted in
 * sign relative to {@link scoreBoostMove}.
 */
function scoreDebuffMove(move: Move, ctx: MoveEvalContext): number {
	const boosts = move.boosts ?? {};
	const foeBoosts = ctx.defender.boosts;
	let score = 0;
	for (const [stat, amount] of Object.entries(boosts)) {
		if (typeof amount !== "number") continue;
		const cur = foeBoosts[stat] || 0;
		// Drops below -6 do nothing; diminishing returns vs already-low foe.
		const incremental = amount < 0 ? Math.max(0, 6 + cur) / 6 : 1;
		const stageValue = stat === "spe" ? 10 : (stat === "atk" || stat === "spa" ? 8 : 5);
		score += -amount * stageValue * incremental;
	}
	// Don't waste a turn debuffing a foe that's about to faint.
	if ((ctx.defender.hpFraction ?? 1) < 0.2) score -= 5;
	return score;
}

function scoreStatusInfliction(status: string, ctx: MoveEvalContext): number {
	const { defender } = ctx;
	if (defender.status) return -10; // Already statused.
	switch (status) {
		case "tox":
		case "psn": {
			if (defender.types.includes("Steel") || defender.types.includes("Poison")) return -20;
			return 16;
		}
		case "brn": {
			if (defender.types.includes("Fire")) return -20;
			return 14;
		}
		case "par": {
			if (defender.types.includes("Electric") || defender.types.includes("Ground")) return -20;
			return ctx.weOutspeed ? 6 : 14;
		}
		case "slp": {
			return 18;
		}
		case "frz": return 6; // Rare.
	}
	return 4;
}

function hazardSetValue(ctx: MoveEvalContext, hazard: string): number {
	const { tracker, foeSide } = ctx;
	const remainingFoes = tracker.getTeam(foeSide)
		.filter(m => !m.fainted)
		.length;
	if (remainingFoes <= 1) return -5;
	let value = 6 * remainingFoes;
	if (hazard === "stealthrock") value = 8 * remainingFoes;
	return value;
}

function sumPositiveBoosts(mon: TrackedPokemon): number {
	let total = 0;
	for (const v of Object.values(mon.boosts)) total += Math.max(0, v);
	return total;
}

/**
 * Compute the "value of best switch target" used by pivot moves. This
 * is a thin wrapper over {@link evaluateMatchup}.
 *
 * Defined here (rather than in `SwitchEvaluator.ts`) so the
 * `MoveEvaluator` doesn't pull in switch logic by default; the engine
 * fills `ctx.valueOfBestSwitch` lazily.
 */
export function bestPivotValue(
	candidates: TrackedPokemon[],
	ctx: MoveEvalContext,
	score: (mon: TrackedPokemon) => number
): number {
	let best = -Infinity;
	for (const cand of candidates) {
		if (cand.fainted) continue;
		if (cand.id === ctx.attacker.id) continue;
		const v = score(cand);
		if (v > best) best = v;
	}
	return Number.isFinite(best) ? best : 0;
}

/** Re-export used by `HeuristicEngine` for convenience. */
export type { CalcPokemon };

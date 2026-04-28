/**
 * Strategic-AI transform decision policy.
 *
 * Decides whether to consume a per-battle one-shot transformation
 * resource on the *current* turn:
 *
 * - **Mega Evolution** (`canMegaEvo`, `canMegaEvoX`, `canMegaEvoY`,
 *   `canUltraBurst`): generally the first opportunity, but defer if
 *   Mega-evolving moves us out of a kill range or saps our speed tier.
 * - **Z-Move** (`canZMove`): use to break through a defensive resist
 *   wall, secure a KO, or reverse an unfavorable matchup. Z-Power
 *   converts the move's rules in non-trivial ways (unstoppable hit,
 *   custom BP). We pick the Z-eligible slot whose Z form's expected
 *   damage delta vs the regular form is largest, and only fire when
 *   the regular form fell short of a KO.
 * - **Dynamax** (`canDynamax`, gen 8 only): turns the next three turns
 *   into Max moves with a 2x HP buff. We dynamax when we're in a
 *   damage race and the HP buff is decisive.
 * - **Terastallize** (`canTerastallize`): single-use type swap. Most
 *   valuable when Tera type grants:
 *     - Immunity to a 4x foe weakness (defensive Tera).
 *     - STAB on the move we want to throw next (offensive Tera).
 *     - Tera Blast STAB on a coverage type our species couldn't
 *       otherwise hit (`Dragapult-Tera-Fairy`-style).
 *
 * The output is a *command suffix* (`" mega"`, `" zmove"`, `" dynamax"`,
 * `" terastallize"`) that the engine appends to its `"move N"` choice.
 *
 * @license MIT
 */
import { Dex, toID } from "../../../dex";
import type { Move } from "../../../dex-moves";
import type { PokemonMoveRequestData } from "../../../side";
import type { BattleStateTracker, TrackedPokemon } from "../state/BattleStateTracker";
import { calculateDamage, fromTracked } from "./DamageCalc";

/** Decision returned by {@link chooseTransform}. */
export interface TransformDecision {
	/** Suffix to append to `move N`. Includes the leading space. */
	suffix: string;
	/** Short tag describing the choice (`"mega"`, `"tera-defensive"`, ...). */
	rationale: string;
}

/** Inputs for the policy. */
export interface TransformPolicyInput {
	tracker: BattleStateTracker;
	myMon: TrackedPokemon;
	foeMon: TrackedPokemon;
	active: PokemonMoveRequestData;
	/** Move id (toID-form) the engine has decided on this turn. */
	chosenMoveId: string;
}

/**
 * Decide whether to fire a transform alongside the chosen move.
 * Returns `null` when no transform is appropriate.
 *
 * Priority (we pick at most one per turn): Tera > Z > Mega > Dynamax.
 * Tera is the only one of these that can compose with any other in
 * the same battle state (you can Tera the turn you Mega in some
 * cartridge metas, but not in showdown), so the order matters.
 */
export function chooseTransform(input: TransformPolicyInput): TransformDecision | null {
	const teraDecision = considerTera(input);
	if (teraDecision) return teraDecision;
	const zDecision = considerZMove(input);
	if (zDecision) return zDecision;
	const megaDecision = considerMega(input);
	if (megaDecision) return megaDecision;
	const dynaDecision = considerDynamax(input);
	if (dynaDecision) return dynaDecision;
	return null;
}

// -----------------------------------------------------------------------
// Tera
// -----------------------------------------------------------------------

function considerTera(input: TransformPolicyInput): TransformDecision | null {
	const { active, myMon, foeMon, tracker, chosenMoveId } = input;
	const teraType = active.canTerastallize;
	if (!teraType) return null;
	if (myMon.terastallized) return null;

	// Compute three pillars: defensive value, offensive value, Tera Blast value.
	const defScore = teraDefensiveValue(teraType, myMon, foeMon);
	const offScore = teraOffensiveValue(teraType, myMon, foeMon, tracker, chosenMoveId);
	const tbScore = teraTeraBlastValue(teraType, myMon, foeMon, tracker, chosenMoveId);
	const total = Math.max(defScore, offScore, tbScore);
	const myHp = myMon.hpFraction ?? 1;
	// Save Tera for low-HP sweepers if the threat could KO us this turn.
	if (myHp < 0.4 && offScore > 12) {
		return { suffix: " terastallize", rationale: "tera-save-sweeper" };
	}
	if (total < 12) return null;
	const which = defScore === total ? "defensive" :
		offScore === total ? "offensive" : "tblast";
	return { suffix: " terastallize", rationale: `tera-${which}` };
}

function teraDefensiveValue(
	teraType: string,
	me: TrackedPokemon,
	foe: TrackedPokemon
): number {
	const foeBest = foeBestStabType(foe);
	if (!foeBest) return 0;
	const before = effectivenessMul([foeBest], me.types);
	const after = effectivenessMul([foeBest], [teraType]);
	if (after === 0 && before > 0) return 30; // Immunity earned.
	if (after < before) return Math.max(0, (before - after) * 12);
	return 0;
}

function teraOffensiveValue(
	teraType: string,
	me: TrackedPokemon,
	foe: TrackedPokemon,
	tracker: BattleStateTracker,
	chosenMoveId: string
): number {
	const move = Dex.moves.get(chosenMoveId);
	if (!move?.exists || move.category === "Status") return 0;
	if (move.type !== teraType) return 0;
	// Tera onto a STAB type we already had: less of a swing, but still
	// the Tera STAB multiplier is strong (1.5 -> 2.0 with Adaptability,
	// or 2.0 baseline if we didn't have STAB before).
	const hadStab = me.types.includes(teraType);
	const calc = calculateDamage({
		attacker: {
			...fromTracked(me),
			terastallized: true,
			types: [teraType],
			originalTypes: me.types.slice(),
			teraType,
		},
		defender: fromTracked(foe),
		move,
		field: tracker.field,
		attackerSide: tracker.sides[tracker.mySide],
		defenderSide: tracker.sides[tracker.foeSide],
	});
	const baseline = calculateDamage({
		attacker: fromTracked(me),
		defender: fromTracked(foe),
		move,
		field: tracker.field,
		attackerSide: tracker.sides[tracker.mySide],
		defenderSide: tracker.sides[tracker.foeSide],
	});
	const delta = calc.avgDamage - baseline.avgDamage;
	const ratio = baseline.avgDamage > 0 ? delta / baseline.avgDamage : 0;
	// Big bonus when the calc converts non-OHKO into OHKO.
	if (calc.koProbability >= 0.95 && baseline.koProbability < 0.6) return 30;
	return Math.max(0, ratio * 25 + (hadStab ? 0 : 5));
}

function teraTeraBlastValue(
	teraType: string,
	me: TrackedPokemon,
	foe: TrackedPokemon,
	tracker: BattleStateTracker,
	chosenMoveId: string
): number {
	if (chosenMoveId !== "terablast") return 0;
	// Tera Blast becomes the user's Tera type after Terastallizing.
	const move = Dex.moves.get("terablast");
	if (!move) return 0;
	const proxy = { ...move, type: teraType } as Move;
	const calc = calculateDamage({
		attacker: {
			...fromTracked(me),
			terastallized: true,
			types: [teraType],
			originalTypes: me.types.slice(),
			teraType,
		},
		defender: fromTracked(foe),
		move: proxy,
		field: tracker.field,
		attackerSide: tracker.sides[tracker.mySide],
		defenderSide: tracker.sides[tracker.foeSide],
	});
	return calc.koProbability >= 0.95 ? 35 : Math.min(20, calc.avgDamage / 10);
}

function foeBestStabType(foe: TrackedPokemon): string | null {
	for (const id of foe.revealedMoves) {
		const m = Dex.moves.get(id);
		if (!m?.exists) continue;
		if (m.category === "Status") continue;
		if (foe.types.includes(m.type)) return m.type;
	}
	return foe.types[0] ?? null;
}

// -----------------------------------------------------------------------
// Z-Move
// -----------------------------------------------------------------------

function considerZMove(input: TransformPolicyInput): TransformDecision | null {
	const { active, myMon, foeMon, tracker, chosenMoveId } = input;
	const z = active.canZMove;
	if (!z) return null;
	// Find the Z slot matching the chosen move (if any).
	const slots = Array.isArray(z) ? z : Object.values(z);
	const chosen = slots.find((s: { move?: string } | null | undefined) =>
		s && toID(s.move ?? "") === chosenMoveId);
	if (!chosen) return null;
	// Estimate baseline damage from the regular move.
	const move = Dex.moves.get(chosenMoveId);
	if (!move?.exists) return null;
	// Z-status moves grant a free +1 boost / clear status on top of the
	// base effect. They're occasionally worth it, but blanket-firing on
	// any chosen status move burns the one-shot resource on routine
	// setup turns and preempts the lower-priority Mega/Dynamax branches
	// (TransformPolicy returns the first matching transform). Defer to
	// the caller: don't auto-consume Z on status moves.
	if (move.category === "Status") return null;
	const baseline = calculateDamage({
		attacker: fromTracked(myMon),
		defender: fromTracked(foeMon),
		move,
		field: tracker.field,
		attackerSide: tracker.sides[tracker.mySide],
		defenderSide: tracker.sides[tracker.foeSide],
	});
	if (baseline.koProbability >= 0.95) return null; // Already KOing.
	// Synthesize the Z-move proxy: BP = 175-200 typical, +1 priority not
	// counted here, ignores Substitute, etc. We approximate by doubling BP.
	const zMove: Move = { ...move, basePower: Math.max(100, (move.basePower || 80) * 1.7), id: `z${move.id}` as never };
	const zCalc = calculateDamage({
		attacker: fromTracked(myMon),
		defender: fromTracked(foeMon),
		move: zMove,
		field: tracker.field,
		attackerSide: tracker.sides[tracker.mySide],
		defenderSide: tracker.sides[tracker.foeSide],
	});
	if (zCalc.koProbability >= 0.95) {
		return { suffix: " zmove", rationale: "z-ko" };
	}
	// Use Z as a panic button if we're low and the foe is faster.
	if ((myMon.hpFraction ?? 1) < 0.35 && (foeMon.stats?.spe ?? 0) > (myMon.stats?.spe ?? 0)) {
		return { suffix: " zmove", rationale: "z-panic" };
	}
	return null;
}

// -----------------------------------------------------------------------
// Mega
// -----------------------------------------------------------------------

function considerMega(input: TransformPolicyInput): TransformDecision | null {
	const { active } = input;
	if (active.canMegaEvo) return { suffix: " mega", rationale: "mega" };
	if (active.canMegaEvoX) return { suffix: " megax", rationale: "mega-x" };
	if (active.canMegaEvoY) return { suffix: " megay", rationale: "mega-y" };
	if (active.canUltraBurst) return { suffix: " ultra", rationale: "ultra-burst" };
	return null;
}

// -----------------------------------------------------------------------
// Dynamax (gen 8)
// -----------------------------------------------------------------------

function considerDynamax(input: TransformPolicyInput): TransformDecision | null {
	const { active, myMon, foeMon } = input;
	if (!active.canDynamax) return null;
	const myHp = myMon.hpFraction ?? 1;
	const foeHp = foeMon.hpFraction ?? 1;
	// Dynamax to convert HP races, especially when we're behind.
	if (myHp < 0.6 && foeHp > 0.7) return { suffix: " dynamax", rationale: "dyna-comeback" };
	// Dynamax for the immediate threat of a Max-move side effect (sun
	// from Max Flare, terrain, hazards). Heuristic: any active dynamax
	// option early in the battle is decent.
	const tracker = input.tracker;
	if (tracker.turn <= 3) return { suffix: " dynamax", rationale: "dyna-early" };
	return null;
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function effectivenessMul(attackingTypes: string[], defenderTypes: string[]): number {
	if (!attackingTypes.length) return 1;
	let total = 0;
	let hits = 0;
	for (const a of attackingTypes) {
		if (!Dex.getImmunity(a, defenderTypes)) {
			total += 0;
			hits++;
			continue;
		}
		let exp = 0;
		for (const d of defenderTypes) exp += Dex.getEffectiveness(a, d);
		total += 2 ** exp;
		hits++;
	}
	return hits ? total / hits : 1;
}

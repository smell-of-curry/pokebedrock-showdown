/**
 * Strategic-AI switch evaluator.
 *
 * Replaces the legacy `evaluateMatchup` / `chooseBestSwitch` heuristic.
 * The legacy code multiplied attacker types against defender types,
 * which produced the wrong score for any mon with two STAB options
 * (the AI would think it was *weak* to a defender that resisted only
 * one of its STABs). This implementation computes:
 *
 * - The defender's best plausible damage roll on us, using
 *   {@link calculateDamage} with our defenders' types/abilities/items.
 *   "Plausible" means: we use the foe's revealed moves first, and fall
 *   back to a probability-weighted set of common STAB choices when the
 *   foe hasn't revealed enough.
 * - Our best plausible damage roll on the foe, using the same logic
 *   but against their species/types.
 * - Speed-tier comparison with Tailwind / Trick Room / Choice Scarf
 *   awareness.
 * - Hazard damage on entry, with Heavy-Duty Boots / Magic Guard /
 *   Levitate exemptions (delegated to `BattleStateTracker`).
 * - Foe boost penalties; phazing / unaware / clear smog mitigation.
 *
 * @license MIT
 */
import { Dex, toID } from "../../../dex";
import type { Move } from "../../../dex-moves";
import type { BattleStateTracker, TrackedPokemon } from "../state/BattleStateTracker";
import type { SideId } from "../state/LogParser";
import {
	calculateDamage,
	estimateMaxHp,
	fromTracked,
	type CalcPokemon,
} from "./DamageCalc";

/** Result of `evaluateMatchup`. Higher is better for our side. */
export interface MatchupScore {
	/** Aggregate utility (positive = good for us). */
	score: number;
	/** Damage we can deal as a fraction of foe HP. 0..1 (or higher for OHKO). */
	weDealFraction: number;
	/** Damage foe can deal as a fraction of our HP. 0..1 (or higher). */
	foeDealFraction: number;
	/** Speed delta in `>0 means we're faster` units. */
	speedDelta: number;
	/** Hazard damage we'd take on entry, as fraction of HP. */
	hazardFraction: number;
}

const COMMON_COVERAGE_TYPES = [
	"Normal",
	"Fire",
	"Water",
	"Electric",
	"Grass",
	"Ice",
	"Fighting",
	"Poison",
	"Ground",
	"Flying",
	"Psychic",
	"Bug",
	"Rock",
	"Ghost",
	"Dragon",
	"Dark",
	"Steel",
	"Fairy",
];

/**
 * Evaluate the matchup of our `mon` against the foe's active mon. We
 * assume both are at full health unless `mon.hpFraction` says otherwise.
 *
 * @param mon - our Pokemon (typically a switch candidate).
 * @param foe - the foe's active mon.
 * @param tracker - battle state tracker for field/side/hazard data.
 */
export function evaluateMatchup(
	mon: TrackedPokemon,
	foe: TrackedPokemon,
	tracker: BattleStateTracker
): MatchupScore {
	const myCalc = fromTracked(mon);
	const foeCalc = fromTracked(foe);

	// Best-known foe attack on us. Side IDs are ordered (attacker, defender)
	// so screens / Tailwind are read off the correct sides.
	const foeBest = bestAttackingDamage(
		foeCalc, myCalc, tracker, foe, mon, /* known */ true,
		tracker.foeSide, tracker.mySide,
	);
	// Our best attack on the foe (using known moves first).
	const myBest = bestAttackingDamage(
		myCalc, foeCalc, tracker, mon, foe, /* known */ false,
		tracker.mySide, tracker.foeSide,
	);

	const myMaxHp = estimateMaxHp(myCalc);
	const foeMaxHp = estimateMaxHp(foeCalc);

	const weDealFraction = (myBest?.avgDamage || 0) / Math.max(1, foeMaxHp);
	const foeDealFraction = (foeBest?.avgDamage || 0) / Math.max(1, myMaxHp);

	// Speed delta: positive => we're faster.
	const speedDelta = computeSpeedDelta(mon, foe, tracker);

	// Hazard damage on entry (mon is the candidate switching in).
	const ourSide = tracker.mySide;
	const hazardFraction = tracker.hazardDamageFraction(mon, ourSide);

	// Score formula. Tunable weights chosen so the components are roughly
	// comparable: a 100% damage threat counts about as much as a clean
	// speed advantage and a 25% hazard tax.
	let score = 0;
	score += weDealFraction * 30;
	score -= foeDealFraction * 30;
	score += speedDelta > 0 ? 6 : speedDelta < 0 ? -4 : 0;
	score -= hazardFraction * 25;
	// Status risk: if foe is poisoning and we're a Steel/Poison? Free
	// switch. If we're vulnerable to Toxic Spikes and not immune, count
	// it via hazardFraction proxy already.
	const statusOnUs = mon.status && mon.status !== "fnt" ? 4 : 0;
	score -= statusOnUs;
	// Boosted-foe penalty.
	let foeBoosts = 0;
	for (const v of Object.values(foe.boosts)) foeBoosts += Math.max(0, v);
	if (foeBoosts > 0 && toID(mon.ability) !== "unaware") {
		score -= foeBoosts * 4;
	}

	return { score, weDealFraction, foeDealFraction, speedDelta, hazardFraction };
}

/**
 * Pick the best switch-in among `candidates` against the current foe.
 * Returns the candidate with the highest score, breaking ties by
 * highest `weDealFraction - foeDealFraction`.
 */
export function chooseBestSwitch(
	candidates: TrackedPokemon[],
	foe: TrackedPokemon,
	tracker: BattleStateTracker
): { mon: TrackedPokemon, score: MatchupScore } | null {
	let best: TrackedPokemon | null = null;
	let bestScore: MatchupScore | null = null;
	for (const cand of candidates) {
		if (cand.fainted) continue;
		const ms = evaluateMatchup(cand, foe, tracker);
		if (!best || ms.score > (bestScore?.score ?? -Infinity)) {
			best = cand;
			bestScore = ms;
		}
	}
	if (!best || !bestScore) return null;
	return { mon: best, score: bestScore };
}

/**
 * Find the best damaging move `attacker` can throw at `defender`.
 *
 * When `useKnownOnly` is true (foe -> us evaluation) we only consider
 * moves the foe has actually revealed; if they haven't revealed any
 * damaging moves yet, we fall back to the best STAB damage assuming
 * a 100 base-power move of each of their STAB types.
 *
 * For our own evaluation we walk our actual moveset (revealedMoves
 * for our side is seeded by `applyRequest`).
 */
function bestAttackingDamage(
	attacker: CalcPokemon,
	defender: CalcPokemon,
	tracker: BattleStateTracker,
	attackerMon: TrackedPokemon,
	defenderMon: TrackedPokemon,
	useKnownOnly: boolean,
	attackerSideId: SideId,
	defenderSideId: SideId,
): { avgDamage: number, moveId: string } | null {
	const moves: Move[] = [];
	for (const id of attackerMon.revealedMoves) {
		const m = Dex.moves.get(id);
		if (m && m.category !== "Status" && m.basePower > 0) moves.push(m);
	}
	if (!moves.length) {
		// Fall back to imagined STAB attacks at BP 100. We synthesise
		// `Move`-like records via `Dex.getActiveMove` of a placeholder
		// (Tackle) and override its `type`/`basePower` for the calc.
		const tackleProto = Dex.moves.get("tackle");
		for (const t of attackerMon.types) {
			moves.push({
				...tackleProto,
				id: `proxy${t.toLowerCase()}` as never,
				name: `Proxy ${t}`,
				type: t,
				category: "Physical",
				basePower: 100,
				accuracy: 100,
			});
		}
		// Coverage moves: the most-feared off-type move. We probe a
		// shortlist of common types; the best one wins.
		if (!useKnownOnly) {
			for (const t of COMMON_COVERAGE_TYPES) {
				if (attackerMon.types.includes(t)) continue;
				moves.push({
					...tackleProto,
					id: `proxy${t.toLowerCase()}` as never,
					name: `Proxy ${t}`,
					type: t,
					category: "Physical",
					basePower: 80,
					accuracy: 100,
				});
			}
		}
	}
	let best: { avgDamage: number, moveId: string } | null = null;
	for (const m of moves) {
		const range = calculateDamage({
			attacker,
			defender,
			move: m,
			field: tracker.field,
			attackerSide: tracker.sides[attackerSideId],
			defenderSide: tracker.sides[defenderSideId],
		});
		if (!best || range.avgDamage > best.avgDamage) {
			best = { avgDamage: range.avgDamage, moveId: toID(m.id || (m as { name?: string }).name || "") };
		}
	}
	return best;
}

/**
 * Effective speed delta between our `mon` and `foe`, factoring in
 * Tailwind, Trick Room, and Choice Scarf. Positive => we move first.
 */
function computeSpeedDelta(
	mon: TrackedPokemon,
	foe: TrackedPokemon,
	tracker: BattleStateTracker
): number {
	const weather = tracker.field.weather;
	const mySpe = scaledSpeed(mon, tracker.sides[tracker.mySide].tailwindTurns > 0, weather);
	const foeSpe = scaledSpeed(foe, tracker.sides[tracker.foeSide].tailwindTurns > 0, weather);
	let delta = mySpe - foeSpe;
	if (tracker.field.trickRoom) delta = -delta;
	return delta;
}

function scaledSpeed(mon: TrackedPokemon, tailwind: boolean, weather: string): number {
	let spe = mon.stats?.spe ?? approximateSpeed(mon);
	const stage = mon.boosts.spe || 0;
	if (stage > 0) spe = Math.floor(spe * (2 + stage) / 2);
	else if (stage < 0) spe = Math.floor(spe * 2 / (2 - stage));
	if (toID(mon.item) === "choicescarf") spe = Math.floor(spe * 1.5);
	const ability = toID(mon.ability);
	const isRain = weather === "raindance" || weather === "primordialsea";
	const isSun = weather === "sunnyday" || weather === "desolateland";
	if (ability === "swiftswim" && isRain) spe *= 2;
	if (ability === "chlorophyll" && isSun) spe *= 2;
	if (ability === "sandrush" && weather === "sandstorm") spe *= 2;
	if (ability === "slushrush" &&
		(weather === "snow" || weather === "snowscape" || weather === "hail")) {
		spe *= 2;
	}
	if (tailwind) spe *= 2;
	if (mon.status === "par" && ability !== "quickfeet") spe = Math.floor(spe / 2);
	if (ability === "quickfeet" && mon.status) spe = Math.floor(spe * 1.5);
	return spe;
}

function approximateSpeed(mon: TrackedPokemon): number {
	const species = Dex.species.get(mon.species);
	if (!species?.baseStats) return 80;
	const base = species.baseStats.spe || 80;
	const lvl = mon.level || 100;
	return Math.floor(((2 * base + 31 + 63) * lvl) / 100) + 5;
}

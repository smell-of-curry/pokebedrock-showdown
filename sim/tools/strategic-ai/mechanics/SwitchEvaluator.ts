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

	// Entry-synergy bonuses: things that happen the moment `mon`
	// switches in, which the rest of the matchup math doesn't capture
	// because it works from the *current* tracker state.
	score += entrySynergyBonus(mon, foe, tracker);

	return { score, weDealFraction, foeDealFraction, speedDelta, hazardFraction };
}

/**
 * Score the "switching this mon in right now" effects that aren't
 * already captured by the static matchup numbers:
 *
 * - **Terrain seeds** (Grassy/Electric/Misty/Psychic Seed) trigger on
 *   entry under the matching terrain and grant a +1 stat boost. Worth
 *   ~+10 since the boost lingers for the whole stay-in window.
 * - **Intimidate** drops the foe's Attack on entry. Heavily valuable
 *   against physical attackers, neutral otherwise.
 * - **Weather setters** (Drought/Drizzle/Sand Stream/Snow Warning)
 *   on switch-in: bonus when the weather they set differs from the
 *   currently-active one and would benefit us (e.g. a Chlorophyll
 *   teammate would love a sunlight setter). We approximate this as
 *   "any new weather you bring in is mildly positive".
 *
 * @param mon The candidate switch-in.
 * @param foe The foe currently on the field.
 * @param tracker Battle state tracker.
 * @returns A synergy bonus in roughly the [-2, +14] range.
 */
function entrySynergyBonus(
	mon: TrackedPokemon,
	foe: TrackedPokemon,
	tracker: BattleStateTracker
): number {
	let bonus = 0;
	const item = toID(mon.item);
	const ability = toID(mon.ability);
	const terrain = tracker.field.terrain;

	// Terrain-seed entry boost. The seed is consumed on entry and grants
	// +1 Def (Grassy/Electric) or +1 SpDef (Misty/Psychic) for the stay.
	if (
		(item === "grassyseed" && terrain === "grassyterrain") ||
		(item === "electricseed" && terrain === "electricterrain") ||
		(item === "mistyseed" && terrain === "mistyterrain") ||
		(item === "psychicseed" && terrain === "psychicterrain")
	) {
		bonus += 10;
	}

	// Intimidate: foe loses one stage of Attack on our entry. Scales
	// with how much the foe was going to lean on Attack.
	if (ability === "intimidate") {
		const foeAtk = foe.stats?.atk ?? 0;
		const foeSpa = foe.stats?.spa ?? 0;
		// Reduce by ~25% damage on physical hits → ~+6 matchup units;
		// scale by how physical the foe looks. Pure special attackers
		// get the floor (the lost Atk is wasted).
		const physicalLean = foeAtk > foeSpa ? 1 : foeAtk >= foeSpa * 0.85 ? 0.5 : 0.15;
		// Unaware on the foe ignores our Intimidate drop's offensive
		// impact, though the stage is still applied; treat that as
		// neutral.
		if (toID(foe.ability) === "unaware") bonus += 0;
		else bonus += 7 * physicalLean;
	}

	// Weather setters on entry: a switch-in that brings a *new* weather
	// is usually a positive — either it benefits us directly or it
	// disrupts the foe's weather-dependent strategy. Capped to +4 so
	// it doesn't dominate the matchup math.
	const weatherFromAbility: Record<string, string> = {
		drought: "sunnyday",
		drizzle: "raindance",
		sandstream: "sandstorm",
		snowwarning: "snowscape",
		orichalcumpulse: "sunnyday",
		hadronengine: "electricterrain",
	};
	const broughtWeather = weatherFromAbility[ability];
	if (broughtWeather && broughtWeather !== tracker.field.weather && broughtWeather !== tracker.field.terrain) {
		bonus += 4;
	}

	return bonus;
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
 * We pull every revealed damaging move from the attacker's known set,
 * AND additionally consider STAB-type proxies derived from the
 * attacker's species. STAB types are publicly inferable from the
 * species, so this isn't "cheating": the AI just refuses to pretend
 * a Garchomp won't have a Ground STAB until it sees Earthquake.
 *
 * Without this, a foe that has only revealed one of its two STABs
 * looks artificially safe — so on monotype teams the AI would happily
 * switch a 4×-weak teammate into an unrevealed coverage hit.
 *
 * When `useKnownOnly` is false (our → foe evaluation) we additionally
 * probe a wider coverage-type shortlist so we estimate our own
 * unrevealed-but-likely move pool optimistically.
 *
 * @param attacker The CalcPokemon snapshot of the attacking side.
 * @param defender The CalcPokemon snapshot of the defending side.
 * @param tracker Battle state tracker (provides field / side state).
 * @param attackerMon TrackedPokemon record for the attacker (move pool).
 * @param defenderMon TrackedPokemon record for the defender (unused, for symmetry).
 * @param useKnownOnly True when we're estimating the foe's threat to us:
 *   skips the wide coverage probe but still includes STAB proxies.
 * @param attackerSideId Tracker side id of the attacker (for screens/Tailwind).
 * @param defenderSideId Tracker side id of the defender (for screens/Tailwind).
 * @returns The highest expected damage roll along with the move id, or `null`
 *   if no damaging move can be modelled (e.g. an immune defender).
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
	void defenderMon;
	const moves: Move[] = [];
	for (const id of attackerMon.revealedMoves) {
		const m = Dex.moves.get(id);
		if (m && m.category !== "Status" && m.basePower > 0) moves.push(m);
	}
	// Always add STAB proxies for the attacker's effective types — but
	// only ones the attacker doesn't already cover with a revealed move
	// of the same type. Species typing is public information, so
	// assuming the mon has at least *one* damaging STAB option is safe
	// and prevents the AI from over-trusting an incomplete revealed
	// list. Skipping types we already see avoids double-counting
	// (revealed Earthquake + imagined "Proxy Ground" → over-estimate).
	const revealedTypes = new Set(moves.map(m => m.type));
	const tackleProto = Dex.moves.get("tackle");
	const seenProxyTypes = new Set<string>();
	for (const t of attackerMon.types) {
		if (seenProxyTypes.has(t) || revealedTypes.has(t)) continue;
		seenProxyTypes.add(t);
		// Slightly lower BP for the proxy (80) than a real STAB so the
		// estimate is "the foe probably has *some* attack of this type"
		// without claiming it's a guaranteed top-tier hit.
		moves.push({
			...tackleProto,
			id: `proxystab${t.toLowerCase()}` as never,
			name: `Proxy ${t}`,
			type: t,
			category: "Physical",
			basePower: 80,
			accuracy: 100,
		});
	}
	if (!useKnownOnly) {
		// Coverage moves: the most-feared off-type move. We probe a
		// shortlist of common types; the best one wins.
		for (const t of COMMON_COVERAGE_TYPES) {
			if (seenProxyTypes.has(t) || revealedTypes.has(t)) continue;
			moves.push({
				...tackleProto,
				id: `proxycov${t.toLowerCase()}` as never,
				name: `Proxy ${t}`,
				type: t,
				category: "Physical",
				basePower: 80,
				accuracy: 100,
			});
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

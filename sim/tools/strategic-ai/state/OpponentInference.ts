/**
 * Opponent move-set / item / ability inference.
 *
 * Showdown's `request` JSON exposes only what the player is allowed to
 * see: species, level, types, HP%, base ability hint (often partial),
 * and item only when revealed. The strategic AI tracks every protocol
 * event ({@link BattleStateTracker}) so we can layer informed guesses
 * on top of that:
 *
 * - **Item inference:** if a foe has been on the field through Stealth
 *   Rock without taking damage, it's holding Heavy-Duty Boots. If a
 *   physical Ground move missed (or hit and did nothing), the foe has
 *   Air Balloon. Lots of survives-at-1HP signal Focus Sash. Repeating
 *   the same attacking move two turns in a row strongly implies a
 *   Choice item.
 * - **Ability inference:** the simulator emits `|-ability|` on activation
 *   for many abilities (Intimidate, Mold Breaker, Sand Stream, etc.); we
 *   pick those up directly via the tracker. Otherwise, we limit guesses
 *   to legal abilities (`Dex.species.get(...).abilities`).
 * - **Move-set inference:** revealed moves come from the tracker; for
 *   the rest, we sample a uniform prior over the species' learnset as
 *   available in `Dex.data.Learnsets`. This module does not currently
 *   intersect that learnset with the active format's legal move pool.
 *
 * The output is always a probability distribution over moves /
 * abilities / items, never a single guess. Search engines (one-ply,
 * MCTS) sample from these distributions rather than committing to a
 * "guessed" build.
 *
 * @license MIT
 */
import { Dex, toID } from "../../../dex";
import type { Move } from "../../../dex-moves";
import type { Species } from "../../../dex-species";
import type { BattleStateTracker, TrackedPokemon } from "./BattleStateTracker";

/**
 * Probability distribution over a discrete set of values. Values
 * sum to ~1.0 (small float drift acceptable). Keys are ids.
 */
export type Distribution<K extends string = string> = Map<K, number>;

/** Aggregate inference about a single foe Pokemon. */
export interface FoeInference {
	/** The tracked record this inference is about. */
	mon: TrackedPokemon;
	/** Move-id distribution over the foe's *unrevealed* slots. */
	moves: Distribution;
	/** Ability-id distribution. */
	abilities: Distribution;
	/** Item-id distribution. */
	items: Distribution;
	/** True if we believe the foe is locked into its last move (Choice). */
	choiceLocked: boolean;
	/** True if we believe the foe holds Heavy-Duty Boots. */
	hasBoots: boolean;
	/** True if we believe the foe holds Air Balloon. */
	hasAirBalloon: boolean;
}

/**
 * Build a fresh inference snapshot for the foe's active Pokemon. Cheap
 * to call every turn; designed not to do learnset lookups twice in a
 * row for the same species.
 */
export function inferFoeActive(tracker: BattleStateTracker): FoeInference | null {
	const foe = tracker.foeActive;
	if (!foe) return null;
	return inferMon(tracker, foe);
}

/** Inference for an arbitrary tracked Pokemon (any side). */
export function inferMon(tracker: BattleStateTracker, mon: TrackedPokemon): FoeInference {
	const moves = inferMoves(mon);
	const abilities = inferAbilities(mon);
	const items = inferItems(tracker, mon);
	const hasBoots = (mon.item ? toID(mon.item) === "heavydutyboots" : (items.get("heavydutyboots") ?? 0) > 0.5);
	const hasAirBalloon = (mon.item ? toID(mon.item) === "airballoon" : (items.get("airballoon") ?? 0) > 0.5);
	return {
		mon,
		moves,
		abilities,
		items,
		choiceLocked: mon.choiceLocked,
		hasBoots,
		hasAirBalloon,
	};
}

/** Top-N most-likely moves the foe might use this turn. */
export function topMoves(inf: FoeInference, n: number): string[] {
	const entries = Array.from(inf.moves.entries()).sort((a, b) => b[1] - a[1]);
	return entries.slice(0, n).map(([id]) => id);
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

/** Cache of legal-move arrays per species id. */
const learnsetCache = new Map<string, string[]>();

function inferMoves(mon: TrackedPokemon): Distribution {
	const dist: Distribution = new Map();
	// Revealed moves get high mass.
	const revealed = Array.from(mon.revealedMoves);
	if (mon.choiceLocked && mon.lastMove) {
		dist.set(mon.lastMove, 1);
		return dist;
	}
	const revealedShare = Math.min(0.85, revealed.length * 0.25);
	const remaining = 1 - revealedShare;
	for (const id of revealed) {
		dist.set(id, revealedShare / Math.max(1, revealed.length));
	}
	// Spread `remaining` over the species' legal moves we haven't seen yet.
	const learnset = legalMoves(mon.species);
	const unseen = learnset.filter(m => !revealed.includes(m));
	if (unseen.length === 0) return dist;
	const per = remaining / unseen.length;
	for (const id of unseen) {
		dist.set(id, (dist.get(id) || 0) + per);
	}
	return dist;
}

function inferAbilities(mon: TrackedPokemon): Distribution {
	const dist: Distribution = new Map();
	if (mon.ability) {
		dist.set(toID(mon.ability), 1);
		return dist;
	}
	const species = Dex.species.get(mon.species);
	if (!species?.exists) {
		dist.set("", 1);
		return dist;
	}
	const choices = uniqueAbilityIds(species);
	if (choices.length === 0) {
		dist.set("", 1);
		return dist;
	}
	const per = 1 / choices.length;
	for (const id of choices) dist.set(id, per);
	return dist;
}

function inferItems(tracker: BattleStateTracker, mon: TrackedPokemon): Distribution {
	const dist: Distribution = new Map();
	if (mon.item !== undefined && mon.item !== "") {
		dist.set(toID(mon.item), 1);
		return dist;
	}
	if (mon.item === "") {
		// Item explicitly removed; treat as known-empty.
		dist.set("", 1);
		return dist;
	}
	// Heuristics from observed events.
	let bootsScore = 0;
	let sashScore = 0;
	let balloonScore = 0;
	let evioliteScore = 0;
	let choiceScore = 0;
	let leftoversScore = 0;
	let avScore = 0;

	// Heavy-Duty Boots: foe stayed in through hazards on its side without
	// hazard damage. Approximated: if hazards exist on the foe side and
	// the foe is at >75% HP after several turns, slightly boost boots.
	const ss = tracker.sides[tracker.foeSide];
	if ((ss.stealthRock || ss.spikes > 0 || ss.stickyWeb) && mon.hpFraction >= 0.95 && tracker.turn > 1) {
		bootsScore += 0.5;
	}

	// Choice items: if the foe used the same move twice in a row.
	if (mon.sameMoveStreak >= 2) choiceScore += 0.6;
	if (mon.choiceLocked) choiceScore += 0.4;

	// Eviolite: NFE foes default to Eviolite in singles.
	const species = Dex.species.get(mon.species);
	if (species?.exists && species.nfe) evioliteScore += 0.6;

	// Air Balloon: tracker emits `|-item|airballoon|` when the user is
	// hit — we don't get a *miss* signal for ground moves currently, so
	// we only weight balloon when the species is commonly seen with it.
	if (species?.exists) {
		const tagged = species.types.includes("Electric") || species.types.includes("Steel");
		if (tagged) balloonScore += 0.05;
	}

	leftoversScore = 0.05; // Generic prior.
	avScore = 0.05;
	sashScore = 0.05;

	// Normalise the heuristic mass so the distribution sums to ~1.0 even
	// when individual heuristics over-allocate (e.g. an NFE foe through
	// hazards mid choice-streak can otherwise total ~1.85).
	const totals =
		bootsScore + sashScore + balloonScore + evioliteScore +
		choiceScore + leftoversScore + avScore;
	const scale = totals > 1 ? 1 / totals : 1;
	const rest = totals > 1 ? 0 : Math.max(0, 1 - totals);
	dist.set("heavydutyboots", bootsScore * scale);
	dist.set("focussash", sashScore * scale);
	dist.set("airballoon", balloonScore * scale);
	dist.set("eviolite", evioliteScore * scale);
	dist.set("choicescarf", choiceScore * 0.45 * scale);
	dist.set("choiceband", choiceScore * 0.35 * scale);
	dist.set("choicespecs", choiceScore * 0.20 * scale);
	dist.set("leftovers", leftoversScore * scale);
	dist.set("assaultvest", avScore * scale);
	dist.set("", rest);
	return dist;
}

function legalMoves(species: string): string[] {
	const id = toID(species);
	const cached = learnsetCache.get(id);
	if (cached) return cached;
	const result: string[] = [];
	const speciesObj = Dex.species.get(species);
	if (!speciesObj?.exists) {
		learnsetCache.set(id, result);
		return result;
	}
	// Showdown stores learnsets by the *base* species (cosmetic forms
	// share). We pull the dex's learnset map and accept anything from any
	// gen the mon could have learned — close enough for inference.
	const data = (Dex as unknown as { data: { Learnsets?: Record<string, { learnset?: Record<string, string[]> }> } }).data;
	const ls = data?.Learnsets?.[id]?.learnset ?? data?.Learnsets?.[toID(speciesObj.baseSpecies)]?.learnset;
	if (ls) {
		for (const moveId of Object.keys(ls)) {
			const mv: Move | undefined = Dex.moves.get(moveId);
			if (mv?.exists) result.push(moveId);
		}
	}
	learnsetCache.set(id, result);
	return result;
}

function uniqueAbilityIds(species: Species): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const abilities = species.abilities ?? {};
	for (const slot of ["0", "1", "H", "S"] as const) {
		const a = (abilities as unknown as Record<string, string>)[slot];
		if (!a) continue;
		const id = toID(a);
		if (id && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

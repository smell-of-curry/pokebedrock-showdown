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
 * Score for a move whose target is immune to it.
 *
 * Strongly negative rather than 0 so it always loses to a real option,
 * and so a same-sign score ladder (see `selectByScoreLadder`) can never
 * walk from a positive move into an immune one. Still finite, so a mon
 * left with nothing but immune moves picks one and moves on instead of
 * falling through to `"default"`.
 */
const IMMUNE_MOVE_SCORE = -60;

/**
 * Most turns of future payoff a setup move is allowed to bank on.
 *
 * Without a cap, a boost against a foe that barely scratches us projects
 * an unbounded number of attacking turns and the AI would set up
 * forever. Four is about as far ahead as the "nothing changes" premise
 * holds — past that the foe has switched or found an answer.
 */
const SETUP_TURN_CAP = 4;

/**
 * Haircut applied to projected setup payoff.
 *
 * The projection assumes the matchup stays put; in practice the foe
 * switches, we get statused or flinched, or they simply KO us a turn
 * earlier than the average roll suggested. Half credit keeps setup
 * competitive with attacking without making it the default.
 */
const SETUP_DISCOUNT = 0.5;

/**
 * Utility of putting a healthy foe to sleep, before the accuracy
 * discount in {@link applyStatusAccuracy} and the bulk scaling in
 * {@link scoreStatusInfliction}.
 *
 * Sized against the damage path, which scores roughly `100 x` the HP
 * fraction dealt: sleep is worth about as much as a strong neutral hit
 * because the free turns it buys convert into exactly that. Spore ends
 * up around 30 (100% accurate), Hypnosis around 18 (60%) — so the AI
 * reaches for the reliable one and still prefers a clean KO over
 * either.
 */
const SLEEP_BASE_VALUE = 34;

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
	/**
	 * True if our attacker's previous move attempt failed (missed,
	 * blocked by immunity, blocked by Protect, etc.). Engine fills this
	 * from `engineCtx.lastMoveFailedByMon` so power-doubling moves like
	 * Stomping Tantrum can be scored at their boosted value.
	 */
	attackerLastMoveFailed?: boolean;
	/**
	 * True when the defender is expected to have already taken damage
	 * this turn — in doubles, an earlier-deciding partner committed to
	 * a damaging move. Powers Assurance's 2× BP.
	 */
	defenderTookDamageThisTurn?: boolean;
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
	// Counter-style moves use `damageCallback` with `basePower: 0`, so the
	// normal damage path scores them at 0. Handle them up-front: they're
	// only good in narrow situations (foe just hit us with the right
	// category and we'd survive another hit), but they're game-winning
	// when they line up.
	if (moveId === "counter" || moveId === "mirrorcoat" || moveId === "metalburst") {
		return evaluateCounterMove(m, moveId, ctx);
	}
	// Sucker Punch: priority physical that only fires if the foe is
	// about to use an attacking move this turn. The normal damage path
	// still scores its BP correctly, but we need an extra branch to
	// avoid spamming it into setup/status mons (where it auto-fails
	// and we lose the turn) and to *reward* it when we can predict
	// the foe's reply will be a damaging move.
	if (moveId === "suckerpunch") {
		const evaluation = evaluateSuckerPunch(m, ctx);
		if (evaluation) return evaluation;
	}
	if (m.category === "Status") {
		// A status move the target simply cannot be affected by is the
		// same class of mistake as clicking a move it's immune to, and
		// players read it the same way. Reject it before the per-effect
		// scoring can hand out any bonuses.
		const blocked = statusMoveBlockedBy(m, moveId, ctx);
		if (blocked) return { moveId, score: IMMUNE_MOVE_SCORE, rationale: `blocked:${blocked}` };
		return applyStatusAccuracy(m, evaluateStatus(m, moveId, ctx), ctx);
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
		attackerMovesFirst: ctx.weOutspeed,
		attackerLastMoveFailed: ctx.attackerLastMoveFailed,
		// Approximations for conditional-BP moves where exact per-turn
		// tracking would be expensive. Both have low false-positive
		// cost — at worst a slightly over-scored Lash Out / Assurance.
		attackerLostStatThisTurn: hasActiveNegativeBoost(attacker),
		// Singles callers leave this unset (Assurance stays at base
		// BP); the doubles engine threads in "a partner already
		// committed to attacking this turn".
		defenderTookDamageThisTurn: ctx.defenderTookDamageThisTurn ?? false,
	});
	// A move the target is immune to accomplishes literally nothing: it
	// wastes the turn, reveals the move, and leaves us to eat the reply.
	// Reject it outright rather than letting the additive bonuses below
	// (priority, pivot, hazard removal) lift it back above 0 — that is
	// how a Ground move ends up clicked into a Levitate mon, or Sucker
	// Punch into a Ghost, until the user faints.
	if (calc.immune) {
		return { moveId, score: IMMUNE_MOVE_SCORE, damage: calc, rationale: "immune" };
	}
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
	// Priority bonus. Showdown priority is in [-7, +5]; almost every
	// positive-priority move we care about sits in +1..+4 (Quick Attack,
	// Bullet Punch, Sucker Punch, Mach Punch, Aqua Jet, Ice Shard,
	// Extreme Speed, Fake Out, First Impression). Score them by what
	// they actually buy us:
	//
	//   - Guaranteed KO when the foe would have outsped us (the big win).
	//   - Insurance KO when our own HP is low enough that the foe's hit
	//     would faint us before a slower move resolved.
	//   - Chip damage that puts the foe in KO range for the bench (so
	//     the next mon can finish them off cleanly).
	//   - Even at full HP / outspeeding, a small baseline so the AI
	//     doesn't ignore priority entirely on neutral matchups.
	if (m.priority > 0) {
		const remaining = (defender.hpFraction ?? 1) * maxHp;
		const myHp = attacker.hpFraction ?? 1;
		const wouldKO = calc.avgDamage >= remaining * 0.9 || calc.koProbability > 0.5;
		const stackedPriority = m.priority >= 2 ? 1.5 : 1;
		if (!ctx.weOutspeed) {
			if (wouldKO) {
				score += 30 * stackedPriority;
				rationale = "priorityKO";
			} else if (myHp < 0.4) {
				// We're slower AND fragile — a guaranteed hit is huge
				// even if it doesn't KO, because we may not get another
				// turn at all.
				score += 14 * stackedPriority;
				rationale = "priorityInsurance";
			} else {
				score += 6 * stackedPriority;
			}
		} else if (wouldKO) {
			// Outspeeding + KO is the same outcome as a slower KO, but
			// priority still helps if e.g. the foe is +Spe boosted or
			// Scarfed and we mis-counted.
			score += 8 * stackedPriority;
			rationale = "priorityKO";
		} else {
			score += 3 * stackedPriority;
		}
		// "Chip into KO range for next mon": even if this hit doesn't
		// KO and we're not in danger, weakening a foe so a bench
		// sweeper finishes it next turn is real value.
		const chipBringsKORange =
			!wouldKO &&
			(calc.avgDamage / Math.max(1, remaining)) >= 0.35;
		if (chipBringsKORange) score += 4;
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

/** `Move.target` values that aim at an opposing Pokemon. */
const FOE_TARGETS = new Set([
	"normal", "any", "randomNormal", "adjacentFoe",
	"allAdjacentFoes", "allAdjacent", "scripted",
]);

/**
 * Discount a status move's utility by the chance it actually connects.
 *
 * The damage path multiplies through `calc.hitChance`, but every branch
 * of {@link evaluateStatus} returned a raw utility, so Hypnosis (60%)
 * and Sing (55%) were priced identically to Spore (100%) and Thunder
 * Wave to Zap Cannon. Clicking a coin-flip status where a reliable one
 * (or an attack) was available is one of the "ineffective move" cases
 * players notice.
 *
 * Self-, ally- and side-targeting moves (setup, recovery, hazards,
 * screens) have `accuracy: true` and are untouched.
 *
 * Only positive scores are scaled. Shrinking a negative score toward
 * zero would *promote* a bad move as its accuracy drops — the same
 * inversion bug that the old score-scaling info-forgetting had.
 *
 * @param move The status move being considered.
 * @param evaluation The raw evaluation from {@link evaluateStatus}.
 * @param ctx The move evaluation context.
 * @returns The evaluation with `score` discounted by hit chance.
 */
function applyStatusAccuracy(
	move: Move,
	evaluation: MoveEvaluation,
	ctx: MoveEvalContext
): MoveEvaluation {
	if (evaluation.score <= 0) return evaluation;
	if (move.accuracy === true) return evaluation;
	let accuracy = move.accuracy / 100;
	// No Guard on either side, and Gravity, make the move land anyway.
	const noGuard = toID(ctx.attacker.ability) === "noguard" ||
		toID(ctx.defender.ability) === "noguard";
	if (noGuard) accuracy = 1;
	else if (ctx.tracker.field.gravity) accuracy = Math.min(1, accuracy * (1 / 0.6));
	if (accuracy >= 1) return evaluation;
	return { ...evaluation, score: evaluation.score * accuracy };
}

/** Types that are flatly immune to a given non-volatile status. */
const STATUS_IMMUNE_TYPES: { [status: string]: string[] } = {
	psn: ["Steel", "Poison"],
	tox: ["Steel", "Poison"],
	brn: ["Fire"],
	par: ["Electric"],
};

/** Per-status ability immunities, keyed by status id. */
const STATUS_IMMUNE_ABILITIES: { [status: string]: Set<string> } = {
	psn: new Set(["immunity", "pastelveil"]),
	tox: new Set(["immunity", "pastelveil"]),
	brn: new Set(["waterveil", "waterbubble", "thermalexchange"]),
	par: new Set(["limber"]),
	slp: new Set(["insomnia", "vitalspirit", "sweetveil"]),
	frz: new Set(["magmaarmor"]),
};

/** Abilities that shrug off every non-volatile status. */
const ALL_STATUS_IMMUNE_ABILITIES = new Set(["comatose", "purifyingsalt", "shieldsdown"]);

/**
 * Reasons a status move aimed at the foe will do literally nothing.
 *
 * The damage path already refuses type- and ability-immune attacks, but
 * status moves bypass it entirely, so nothing stopped the AI from
 * clicking Toxic into a Substitute, Will-O-Wisp into Water Veil, or
 * anything at all into Gholdengo. To a player those are the same
 * mistake as an immune attack.
 *
 * Self-, ally-, and side-targeting moves are never blocked here — they
 * don't interact with the foe at all.
 *
 * @param move The status move being considered.
 * @param moveId The move's id.
 * @param ctx The move evaluation context.
 * @returns A short reason tag when the move cannot affect the target, or
 * `null` when it can (or when we can't prove otherwise).
 */
function statusMoveBlockedBy(
	move: Move,
	moveId: string,
	ctx: MoveEvalContext
): string | null {
	if (!FOE_TARGETS.has(move.target)) return null;
	const { defender, attacker, tracker } = ctx;
	const foeAbility = toID(defender.ability || "");
	const foeItem = toID(defender.item || "");
	// Infiltrator sees through the foe's Substitute and Safeguard, so
	// every "we're walled by a barrier" check below has to respect it.
	const infiltrator = toID(attacker.ability || "") === "infiltrator";

	// Good as Gold: no status move from an opponent ever connects.
	if (foeAbility === "goodasgold") return "goodasgold";
	// Magic Bounce returns the move at us, which is worse than passing.
	if (foeAbility === "magicbounce" && move.flags?.reflectable) return "magicbounce";
	// Powder moves miss Grass types, Overcoat, and Safety Goggles.
	if (move.flags?.powder) {
		if (defender.types.includes("Grass")) return "powderGrass";
		if (foeAbility === "overcoat") return "overcoat";
		if (foeItem === "safetygoggles") return "safetygoggles";
	}
	// Substitute eats anything that doesn't explicitly punch through it.
	if (
		defender.volatiles.has("substitute") && !infiltrator &&
		!move.flags?.bypasssub && !move.flags?.sound
	) {
		return "substitute";
	}
	// Type immunity, but only for the handful of status moves that opt
	// into the type chart (`ignoreImmunity: false`, e.g. Thunder Wave).
	// The rest deliberately ignore it.
	if (move.ignoreImmunity === false && !Dex.getImmunity(move.type, defender.types)) {
		return "typeImmune";
	}
	// Leech Seed's Grass immunity is a bespoke `onTryImmunity`, not a
	// flag or a type-chart entry, so it needs naming.
	if (moveId === "leechseed" && defender.types.includes("Grass")) return "leechGrass";
	if (moveId === "leechseed" && defender.volatiles.has("leechseed")) return "seeded";

	// Everything past here is specific to inflicting a status.
	const status = move.status;
	if (!status) return null;
	if (defender.status) return "alreadyStatused";
	if (ALL_STATUS_IMMUNE_ABILITIES.has(foeAbility)) return foeAbility;
	if (STATUS_IMMUNE_ABILITIES[status]?.has(foeAbility)) return foeAbility;
	// Leaf Guard is sun-conditional; Flower Veil covers the whole side
	// but we only model the active target.
	const sun = tracker.field.weather === "sunnyday" || tracker.field.weather === "desolateland";
	if (foeAbility === "leafguard" && sun) return "leafguard";
	if (foeAbility === "flowerveil" && defender.types.includes("Grass")) return "flowerveil";
	// Safeguard blocks status infliction (but not stat drops), which is
	// why this check sits below the general-purpose ones.
	if (tracker.sides[ctx.foeSide].safeguardTurns > 0 && !infiltrator) return "safeguard";
	if (STATUS_IMMUNE_TYPES[status]?.some(t => defender.types.includes(t))) return "typeStatus";
	// Terrain: Misty blocks every major status, Electric blocks sleep —
	// both only on a grounded target, so an airborne foe is still fair
	// game.
	if (tracker.isPokemonGrounded(defender)) {
		const terrain = tracker.field.terrain;
		if (terrain === "mistyterrain") return "mistyterrain";
		if (terrain === "electricterrain" && (status === "slp" || moveId === "yawn")) {
			return "electricterrain";
		}
	}
	return null;
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

	// Hazard moves. Priority order (tuned per playtest feedback):
	//   Sticky Web > Stealth Rock > Toxic Spikes > Spikes
	// Sticky Web wins because the -1 Spe stage every switch-in takes
	// reshapes the rest of the battle (a slow team suddenly outspeeds);
	// SR is the universal chip; T-Spikes punishes grounded non-Poison
	// foes with passive damage that compounds with switches; Spikes are
	// last because they only fire on grounded mons and stack slowly.
	if (moveId === "stickyweb") {
		if (foeSideState.stickyWeb) return { moveId, score: -10, rationale: "hazardSet" };
		return { moveId, score: hazardSetValue(ctx, "stickyweb"), rationale: "hazard:web" };
	}
	if (moveId === "stealthrock") {
		if (foeSideState.stealthRock) return { moveId, score: -10, rationale: "hazardSet" };
		return { moveId, score: hazardSetValue(ctx, "stealthrock"), rationale: "hazard:sr" };
	}
	if (moveId === "toxicspikes") {
		if (foeSideState.toxicSpikes >= 2) return { moveId, score: -10, rationale: "hazardCap" };
		return { moveId, score: hazardSetValue(ctx, "toxicspikes"), rationale: "hazard:tspikes" };
	}
	if (moveId === "spikes") {
		if (foeSideState.spikes >= 3) return { moveId, score: -10, rationale: "hazardCap" };
		return { moveId, score: hazardSetValue(ctx, "spikes"), rationale: "hazard:spikes" };
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
		score = scoreEncore(ctx);
		return { moveId, score, rationale: "encore" };
	}
	if (moveId === "disable") {
		score = defender.lastMove ? 10 : -5;
		return { moveId, score, rationale: "disable" };
	}

	// Destiny Bond — only worth it as a desperation trade when we expect
	// to die this turn anyway. Showdown also rejects two DBs in a row,
	// so refuse if our DB volatile is already up.
	if (moveId === "destinybond") {
		score = scoreDestinyBond(ctx);
		return { moveId, score, rationale: "destinybond" };
	}

	// Baton Pass — pivot that *also* transfers boosts. The legacy fallback
	// scored this at 2, so the AI would hoard boosts on one mon instead of
	// passing them. Score is dominated by the value of the boosts being
	// passed plus the value of our best switch target.
	if (moveId === "batonpass") {
		score = scoreBatonPass(ctx);
		return { moveId, score, rationale: "batonpass" };
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

	// Yawn — delayed sleep that gives the foe one turn of warning. The
	// stall-tier value of Yawn is *forcing a switch*: the foe either
	// stays in and falls asleep, or pivots and gives us free entry.
	// Compounds well with Protect (burn a turn while the timer ticks)
	// and with hazards on the foe side (any forced switch eats chip).
	if (moveId === "yawn") {
		if (defender.status) return { moveId, score: -10, rationale: "yawnRedundant" };
		// Electric/Misty Terrain only block sleep on *grounded* targets;
		// an airborne / Levitate foe can still be put to sleep.
		const yawnBlockedByTerrain =
			(tracker.field.terrain === "electricterrain" || tracker.field.terrain === "mistyterrain") &&
			tracker.isPokemonGrounded(defender);
		if (yawnBlockedByTerrain) {
			return { moveId, score: -10, rationale: "yawnTerrainBlocked" };
		}
		if (attacker.volatiles.has("yawn") || defender.volatiles.has("yawn")) {
			return { moveId, score: -10, rationale: "yawnAlreadyUp" };
		}
		let yawnScore = 18;
		// Stall combo: Protect lets us burn the foe's "awake" turn so
		// sleep lands without giving them a free attack.
		const stallMyMoves = attacker.revealedMoves;
		const hasProtect = stallMyMoves.has("protect") ||
			stallMyMoves.has("kingsshield") || stallMyMoves.has("spikyshield");
		if (hasProtect) yawnScore += 8;
		// Hazards already up on the foe side punish the forced switch.
		const foeSideHere = tracker.sides[ctx.foeSide];
		if (foeSideHere.stealthRock || foeSideHere.spikes || foeSideHere.stickyWeb) {
			yawnScore += 4;
		}
		return { moveId, score: yawnScore, rationale: "yawn" };
	}

	// Endure — only valuable when we're holding a pinch berry / sash
	// that we *want* to trigger, or as a desperation play with the
	// foe outspeeding for a KO and a teammate ready to revenge.
	if (moveId === "endure") {
		const item = toID(attacker.item);
		const endureHp = attacker.hpFraction ?? 1;
		const pinchBerry =
			item === "salacberry" || item === "liechiberry" ||
			item === "petayaberry" || item === "ganlonberry" ||
			item === "apicotberry";
		if (attacker.volatiles.has("endure") || attacker.volatiles.has("protect")) {
			return { moveId, score: -15, rationale: "endureRepeat" };
		}
		if (pinchBerry && endureHp < 0.6 && endureHp > 0.1) {
			return { moveId, score: 22, rationale: "endurePinchSetup" };
		}
		if (item === "focussash" && endureHp > 0.95) {
			// Sash is already going to save us; Endure is redundant.
			return { moveId, score: -5, rationale: "endureSashRedundant" };
		}
		if (endureHp < 0.25 && !ctx.weOutspeed) {
			return { moveId, score: 8, rationale: "endureDesperation" };
		}
		return { moveId, score: -5, rationale: "endureUnnecessary" };
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
	let anyMeaningful = false;
	let boostsSpeed = false;
	// Preferred model: price the boost as the extra damage it buys over
	// the turns we expect to survive. See `projectedSetupValue`.
	const projected = projectedSetupValue(boosts, ctx);
	if (projected !== null) {
		score = projected.value;
		anyMeaningful = projected.meaningful;
		boostsSpeed = projected.boostsSpeed;
	} else {
		// Fallback for when we can't price it — no damaging move known
		// for the attacker yet (early in a battle, or a synthetic test
		// context). Flat per-stage values, with diminishing returns.
		for (const [stat, amount] of Object.entries(boosts)) {
			if (typeof amount !== "number") continue;
			const cur = myBoosts[stat] || 0;
			// Diminishing returns: +1 from 0 is more valuable than +1 from +5.
			const incremental = amount > 0 ? Math.max(0, 6 - cur) / 6 : 1;
			const stageValue = stat === "spe" ? 12 : (stat === "atk" || stat === "spa" ? 9 : 6);
			const contribution = amount * stageValue * incremental;
			score += contribution;
			if (contribution >= 4) anyMeaningful = true;
			if (stat === "spe" && amount > 0 && cur < 6) boostsSpeed = true;
		}
	}
	if (moveId === "bellydrum") {
		score = (ctx.attacker.hpFraction ?? 1) >= 0.55 ? 60 : -20;
		anyMeaningful = true;
	}
	if (moveId === "shellsmash") {
		score = 35;
		anyMeaningful = true;
		boostsSpeed = true;
	}
	// Boost moves are awful when we're about to die.
	if ((ctx.attacker.hpFraction ?? 1) < 0.25) score -= 10;
	// Setup-window bonus: when our active mon is essentially locked
	// in to surviving the next hit (Focus Sash @ full HP, Sturdy @
	// full HP, Weakness Policy holder with foe revealed a SE move,
	// Unburden holder pre-activation), double down on the setup pick
	// instead of attacking. This is the textbook "Sash sweeper finds
	// a free turn" / "WP setup-into-sweep" line — without the bonus
	// the AI keeps trading hits and wastes the protection.
	if (anyMeaningful && inSetupWindow(ctx)) {
		score += 18;
		// Speed-boost specifically wins the game when the setup mon
		// is slower than the foe (or about to faint to a faster hit).
		// The classic example is a Weakness Policy holder picking
		// Dragon Dance / Shift Gear / Quiver Dance over Sword Dance —
		// after the WP trigger we're +2/+2/+2 and outspeed everything
		// in range. The extra +10 makes Speed setup decisively win
		// over pure offensive boosts when both are on the table.
		if (boostsSpeed && !ctx.weOutspeed) score += 10;
	}
	return score;
}

/**
 * Fraction of the foe's max HP our best known damaging move deals, and
 * the fraction of ours the foe's best known reply deals. Cached per
 * evaluation context because a mon evaluates several moves per turn
 * against the same pair.
 */
const offenseCache = new WeakMap<MoveEvalContext, { ours: number, theirs: number } | null>();

/**
 * Stat multiplier for a boost stage, as the simulator applies it.
 *
 * @param stage The boost stage, clamped to [-6, 6].
 * @returns The multiplicative modifier.
 */
function boostMultiplier(stage: number): number {
	const s = Math.max(-6, Math.min(6, stage));
	return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}

/**
 * Best expected damage either side can deal right now, as a fraction of
 * the target's max HP.
 *
 * Only moves we've actually seen count. For our own side that's the
 * whole moveset (the request seeds it), so this is exact; for the foe it
 * grows as the battle reveals moves, which is the correct amount of
 * information to plan with.
 *
 * @param ctx The evaluation context.
 * @returns Both damage fractions, or `null` if we know no damaging move
 * for our own attacker and therefore can't price anything.
 */
function offenseProfile(ctx: MoveEvalContext): { ours: number, theirs: number } | null {
	const cached = offenseCache.get(ctx);
	if (cached !== undefined) return cached;
	const ours = bestDamageFraction(ctx, ctx.attacker, ctx.defender, ctx.mySide, ctx.foeSide);
	const result = ours > 0 ?
		{
			ours,
			theirs: bestDamageFraction(ctx, ctx.defender, ctx.attacker, ctx.foeSide, ctx.mySide),
		} :
		null;
	offenseCache.set(ctx, result);
	return result;
}

/**
 * Highest expected damage fraction across a mon's known damaging moves.
 *
 * @param ctx The evaluation context (for field and side state).
 * @param attacker The attacking mon.
 * @param defender The defending mon.
 * @param attackerSide The attacker's tracker side id.
 * @param defenderSide The defender's tracker side id.
 * @returns The best `avgDamage / maxHp * hitChance`, or 0 if no known
 * damaging move connects.
 */
function bestDamageFraction(
	ctx: MoveEvalContext,
	attacker: TrackedPokemon,
	defender: TrackedPokemon,
	attackerSide: MoveEvalContext["mySide"],
	defenderSide: MoveEvalContext["mySide"]
): number {
	let best = 0;
	for (const moveId of attacker.revealedMoves) {
		const move = Dex.moves.get(moveId);
		if (!move?.exists || move.category === "Status" || !move.basePower) continue;
		const calc = calculateDamage({
			attacker: fromTracked(attacker),
			defender: fromTracked(defender),
			move,
			field: ctx.tracker.field,
			attackerSide: ctx.tracker.sides[attackerSide],
			defenderSide: ctx.tracker.sides[defenderSide],
			isDoubles: ctx.isDoubles,
		});
		const maxHp = calc.defenderMaxHp || estimateMaxHp(fromTracked(defender));
		const frac = (calc.avgDamage / Math.max(1, maxHp)) * calc.hitChance;
		if (frac > best) best = frac;
	}
	return best;
}

/**
 * Price a boost move as the extra damage it buys.
 *
 * The old model gave every stage a flat constant (+9 for Attack, +12 for
 * Speed, ...). On the same scale, a neutral STAB hit scores 30-50, so a
 * Swords Dance could essentially never win — the AI attacked every turn
 * and looked like it had no idea support moves existed. But the flat
 * constant is wrong in both directions: the same Swords Dance is worth
 * almost nothing when we're about to be KOed, and worth the game when
 * we're walling the foe.
 *
 * So price it properly. An offensive boost multiplies our damage output;
 * a defensive boost buys turns; both cash out as damage dealt over the
 * turns we expect to live:
 *
 *     value = ourDamagePerTurn * (extra damage multiplier) * turnsLeft
 *
 * `turnsLeft` comes from how hard the foe actually hits us, and we spend
 * this turn setting up rather than attacking, so it's one less than the
 * number of hits we survive. A discount covers what the model ignores
 * (the foe switching, getting statused, losing the speed tie).
 *
 * @param boosts The stat boosts the move applies to the user.
 * @param ctx The evaluation context.
 * @returns The projected value plus flags the caller needs, or `null`
 * when there isn't enough information to price it.
 */
function projectedSetupValue(
	boosts: { [stat: string]: number | undefined },
	ctx: MoveEvalContext
): { value: number, meaningful: boolean, boostsSpeed: boolean } | null {
	const offense = offenseProfile(ctx);
	if (!offense) return null;
	const myBoosts = ctx.attacker.boosts;
	const myHp = ctx.attacker.hpFraction ?? 1;
	// Floor the incoming damage: against a foe that can't hurt us the
	// projection would otherwise run away to infinity, and passive
	// damage (hazards, weather, poison) is real anyway.
	const foeDamage = Math.max(0.08, offense.theirs);
	const hitsSurvived = myHp / foeDamage;

	const physical = (ctx.attacker.stats?.atk ?? 0) >= (ctx.attacker.stats?.spa ?? 0);
	const offensiveStat = physical ? "atk" : "spa";
	const defensiveStat = physical ? "def" : "spd";

	let damageMultiplier = 1;
	let defenceMultiplier = 1;
	let speedStages = 0;
	let miscValue = 0;
	for (const [stat, amount] of Object.entries(boosts)) {
		if (typeof amount !== "number" || amount === 0) continue;
		const cur = myBoosts[stat] || 0;
		const ratio = boostMultiplier(cur + amount) / boostMultiplier(cur);
		if (stat === offensiveStat) damageMultiplier *= ratio;
		else if (stat === "atk" || stat === "spa") damageMultiplier *= 1 + ((ratio - 1) * 0.25);
		else if (stat === defensiveStat) defenceMultiplier *= ratio;
		else if (stat === "def" || stat === "spd") defenceMultiplier *= 1 + ((ratio - 1) * 0.5);
		else if (stat === "spe") speedStages += amount;
		// Accuracy / evasion: small flat credit, they don't fit the model.
		else miscValue += amount * 3;
	}

	// Offensive: more damage per turn, for every turn after this one.
	const attackTurns = Math.max(0, Math.min(SETUP_TURN_CAP, hitsSurvived - 1));
	const damagePerTurn = offense.ours * 100;
	let value = damagePerTurn * (damageMultiplier - 1) * attackTurns;

	// Defensive: fewer incoming hits means more turns to attack in.
	if (defenceMultiplier > 1) {
		const boostedHitsSurvived = (myHp / (foeDamage / defenceMultiplier)) - 1;
		const extraTurns = Math.min(SETUP_TURN_CAP, boostedHitsSurvived) - attackTurns;
		if (extraTurns > 0) value += damagePerTurn * extraTurns;
	}

	// Speed: worth a turn when it flips the speed tier, and little
	// otherwise. Flipping it means we attack before taking the hit for
	// the rest of the matchup, which is roughly one extra attack.
	if (speedStages > 0 && !ctx.weOutspeed) value += damagePerTurn * 0.8;
	else if (speedStages > 0) value += damagePerTurn * 0.15 * Math.min(1, speedStages);

	value = (value * SETUP_DISCOUNT) + miscValue;
	return {
		value,
		// "Meaningful" gates the setup-window bonus: a boost we can't
		// cash in (already maxed, or dying this turn) shouldn't collect it.
		meaningful: value >= 6,
		boostsSpeed: speedStages > 0 && (myBoosts.spe || 0) < 6,
	};
}

/**
 * Heuristic: true when the attacker is essentially guaranteed to live
 * through one more incoming hit this turn, even if the foe outspeeds.
 * Used to gate setup-window bonuses (Sword Dance, Calm Mind, ...).
 *
 * Conditions:
 *
 * - Focus Sash at ≥99% HP — Sash blocks any single-hit KO from full.
 * - Sturdy at ≥99% HP — same guarantee.
 *
 * Multiscale / Shadow Shield aren't included here because they only
 * halve damage rather than block KOs; the damage calc already accounts
 * for their multiplier when scoring attacking moves.
 *
 * @param ctx Move evaluation context.
 * @returns true if the attacker is locked in to surviving the turn.
 */
function hasGuaranteedSurvivalThisTurn(ctx: MoveEvalContext): boolean {
	const a = ctx.attacker;
	const hpf = a.hpFraction ?? 1;
	if (hpf < 0.99) return false;
	const item = toID(a.item);
	const ability = toID(a.ability);
	if (item === "focussash") return true;
	if (ability === "sturdy") return true;
	return false;
}

/**
 * True iff the given Pokemon is currently sitting on at least one
 * negative stat-stage boost. Used as a coarse proxy for Lash Out's
 * "stat lowered THIS turn" trigger — perfect tracking would need
 * per-turn boost-deltas; this catches the common case (Intimidate
 * switch-in, Sticky Web, foe Snarl/Charm) and only over-scores when
 * the negative stage has been hanging around for multiple turns.
 *
 * @param mon The tracked Pokemon snapshot to inspect.
 * @returns true when any boost stage in `mon.boosts` is below zero.
 */
function hasActiveNegativeBoost(mon: TrackedPokemon): boolean {
	for (const v of Object.values(mon.boosts)) {
		if (typeof v === "number" && v < 0) return true;
	}
	return false;
}

/**
 * True when the attacker is in a "setup window" — i.e. it has a
 * resource that will plausibly keep it on the field for at least one
 * more turn even into bad damage. This generalises the original
 * Sash / Sturdy "guaranteed survival" idea to also cover Weakness
 * Policy bait scenarios and Unburden pre-activation.
 *
 * Used by {@link scoreBoostMove} to lift setup moves and by
 * {@link hazardSetValue} to lift hazard sets (those are the two moves
 * that *want* to fire on a turn-of-survival).
 *
 * @param ctx Move-eval context (attacker, defender, tracker).
 * @returns true when the attacker should be treated as "definitely
 *   here next turn", false otherwise.
 */
function inSetupWindow(ctx: MoveEvalContext): boolean {
	if (hasGuaranteedSurvivalThisTurn(ctx)) return true;
	const a = ctx.attacker;
	const hpf = a.hpFraction ?? 1;
	const item = toID(a.item);
	const ability = toID(a.ability);
	// Weakness Policy bait: holder lives at ≥60% HP and the foe has a
	// revealed SE move. The WP trigger arrives next turn, granting +2
	// Atk / +2 SpA — exactly the conditions that turn a Dragon Dance
	// from "I hope" into "I'm sweeping".
	if (item === "weaknesspolicy" && hpf >= 0.6) {
		for (const moveId of ctx.defender.revealedMoves) {
			const move = Dex.moves.get(moveId);
			if (!move?.exists || move.category === "Status") continue;
			let eff = 0;
			for (const t of a.types) eff += Dex.getEffectiveness(move.type, t);
			if (eff > 0) return true;
		}
	}
	// Unburden holder still carrying a one-shot consumable. When that
	// fires (Sash, Booster Energy, Seed, pinch berry, Sitrus, Lum) we
	// suddenly double our Speed — the same "set up now and sweep next
	// turn" plan as Weakness Policy.
	if (ability === "unburden") {
		const oneShotItems = new Set([
			"focussash", "boosterenergy",
			"grassyseed", "electricseed", "mistyseed", "psychicseed",
			"salacberry", "liechiberry", "petayaberry",
			"ganlonberry", "apicotberry", "starfberry",
			"sitrusberry", "lumberry",
		]);
		if (oneShotItems.has(item)) return true;
	}
	return false;
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
	const { defender, attacker } = ctx;
	// "Stall combo" detection: status with a follow-up plan (Protect to
	// burn the timer, Recover/Roost to negate the residual damage
	// trade, a Defensive boost to outlast). When we have one of those
	// in our revealed move set, the status is more valuable because
	// we can capitalise on it next turn instead of letting the foe
	// switch out cleanly.
	const myMoves = attacker.revealedMoves;
	const hasProtect =
		myMoves.has("protect") || myMoves.has("kingsshield") ||
		myMoves.has("spikyshield") || myMoves.has("banefulbunker") ||
		myMoves.has("silktrap") || myMoves.has("burningbulwark");
	const hasRecovery =
		myMoves.has("recover") || myMoves.has("roost") ||
		myMoves.has("softboiled") || myMoves.has("slackoff") ||
		myMoves.has("milkdrink") || myMoves.has("synthesis") ||
		myMoves.has("moonlight") || myMoves.has("morningsun") ||
		myMoves.has("shoreup");
	const hasDefBoost =
		myMoves.has("irondefense") || myMoves.has("amnesia") ||
		myMoves.has("cosmicpower") || myMoves.has("acidarmor") ||
		myMoves.has("calmmind") || myMoves.has("bulkup");
	const stallComboBonus = (hasProtect ? 4 : 0) + (hasRecovery ? 4 : 0) + (hasDefBoost ? 3 : 0);
	// Every "this can't land" case (type, ability, terrain, Safeguard,
	// Substitute, already-statused) is rejected up-front by
	// `statusMoveBlockedBy`, so from here it's purely about how much the
	// status is worth against this target.
	switch (status) {
	case "tox":
	case "psn": {
		// Poison is a damage-over-time clock: worth much less against a
		// foe that will faint or force us out long before it ticks.
		const bulk = defender.hpFraction ?? 1;
		return 16 * (0.5 + 0.5 * bulk) + stallComboBonus;
	}
	case "brn": {
		// Burn's halved Attack only matters against a physical threat.
		const physical = defenderLeansPhysical(defender);
		return (physical ? 18 : 10) + stallComboBonus;
	}
	case "par": {
		// Paralysis is a speed-control tool; near-worthless if we're
		// already faster, and the full-paralysis chance is a bonus.
		return (ctx.weOutspeed ? 6 : 16) + stallComboBonus;
	}
	case "slp": {
		// Sleep is the strongest status in the game: the target loses
		// 1-3 turns outright, which is strictly better than the chip or
		// stat cut the others apply. It was priced at 20 — a rounding
		// error above paralysis — so Spore lost to a middling attack
		// every time. Worth the most against a healthy foe we can't
		// simply KO; against something already at low HP the attack is
		// the better click.
		const bulk = defender.hpFraction ?? 1;
		return SLEEP_BASE_VALUE * (0.45 + 0.55 * bulk) + stallComboBonus;
	}
	case "frz": return 6; // Rare.
	}
	return 4;
}

/**
 * Guess whether a Pokemon attacks primarily off its physical side.
 *
 * Used to price Burn, whose Attack cut is dead weight against a special
 * attacker. Prefers revealed moves (what it has actually clicked) and
 * falls back to comparing its base Attack and Special Attack.
 *
 * @param mon The Pokemon to classify.
 * @returns true when it looks physically oriented.
 */
function defenderLeansPhysical(mon: TrackedPokemon): boolean {
	let physical = 0;
	let special = 0;
	for (const id of mon.revealedMoves) {
		const category = Dex.moves.get(id).category;
		if (category === "Physical") physical++;
		else if (category === "Special") special++;
	}
	if (physical || special) return physical >= special;
	const baseStats = Dex.species.get(mon.species).baseStats;
	return !baseStats || baseStats.atk >= baseStats.spa;
}

/**
 * Score Counter / Mirror Coat / Metal Burst.
 *
 * These moves are non-Status but use `damageCallback` with `basePower: 0`,
 * so the standard damage path returns 0. They're only useful in a narrow
 * situation: the foe just hit us with a matching attack category and
 * we're slower (so we'll bank a hit, then strike back for 2x its damage).
 *
 * Metal Burst is bidirectional (works on either category) and only fires
 * after we've taken damage that turn, so its scoring is slightly more
 * lenient about category prediction.
 *
 * @param move The move definition.
 * @param moveId The move id (`counter`, `mirrorcoat`, or `metalburst`).
 * @param ctx The move evaluation context.
 * @returns A `MoveEvaluation` whose `score` represents this move's utility.
 */
function evaluateCounterMove(
	move: Move,
	moveId: string,
	ctx: MoveEvalContext
): MoveEvaluation {
	const { attacker, defender } = ctx;
	// Required category that the foe must hit us with for this to fire.
	const requiredFoeCategory: "Physical" | "Special" | "Any" =
		moveId === "counter" ? "Physical" :
		moveId === "mirrorcoat" ? "Special" : "Any";
	const foeLast = defender.lastMove ? Dex.moves.get(defender.lastMove) : null;
	const foeLastCategory = foeLast?.category;
	// Counter and Mirror Coat have -5 priority, so they *always* move
	// after the foe regardless of Speed — meaning they reflect "damage
	// taken this turn" even when we outspeed. Only Metal Burst sits at
	// +0 priority and genuinely whiffs when we move first; for it the
	// move is best when we're the slower mon.
	const slower = moveId === "counter" || moveId === "mirrorcoat" ?
		true : !ctx.weOutspeed;
	let score: number;
	let rationale = moveId;
	const matches =
		requiredFoeCategory === "Any" ||
		(foeLastCategory && foeLastCategory === requiredFoeCategory);
	if (matches && slower) {
		// Foe is committed (e.g. Choice-locked) makes this almost guaranteed.
		score = defender.choiceLocked ? 55 : 35;
		rationale = `${moveId}:setup`;
	} else if (matches) {
		score = 12;
	} else if (foeLastCategory) {
		// Foe just used the opposite category — predicting they'll do it
		// again is a coin-flip; mildly negative so it's not the top pick
		// but still considered.
		score = -4;
	} else {
		// No info on the foe yet (turn 1, fresh switch-in). Modest baseline
		// so it can outscore truly useless moves but isn't a default pick.
		score = 4;
	}
	// Health gate: must survive a hit to retaliate.
	if ((attacker.hpFraction ?? 1) < 0.25) score -= 20;
	return { moveId, score, damage: undefined, rationale };
}

/**
 * Score Sucker Punch.
 *
 * The standard damage path already returns the BP-70 estimate, but it
 * doesn't know that Sucker Punch *fails outright* unless the foe is
 * about to use an attacking move on the same turn. We don't have a
 * perfect predictor, but two signals are usually decisive:
 *
 * - Foe **just used** a status / setup / pivot move (and isn't
 *   choice-locked) → Sucker Punch has a high probability of failing
 *   this turn; large negative score so the AI prefers any other move.
 * - Otherwise (including the foe being **choice-locked** into a
 *   damaging move, where Sucker Punch is almost guaranteed to fire):
 *   fall through to the normal damage path. That scores the move on
 *   its actual damage — so a weak / non-STAB Sucker Punch isn't
 *   mistaken for a real KO — while STAB / boosts / items and the
 *   priority-KO bonus still register.
 *
 * Returns `null` to fall through to the default damage path when no
 * specific failure signal applies.
 *
 * @param move The Sucker Punch move definition.
 * @param ctx The move evaluation context.
 * @returns A `MoveEvaluation` when we have an opinion, otherwise null.
 */
function evaluateSuckerPunch(
	move: Move,
	ctx: MoveEvalContext
): MoveEvaluation | null {
	const { defender } = ctx;
	const last = defender.lastMove ? Dex.moves.get(defender.lastMove) : null;
	const lastWasStatus = last?.exists && last.category === "Status";
	if (lastWasStatus && !defender.choiceLocked) {
		// Foe likely sets up / heals again this turn → Sucker Punch
		// auto-fails. Give it a hard negative score.
		return { moveId: toID(move.id), score: -15, rationale: "suckerpunchFail" };
	}
	// Otherwise (incl. the foe being choice-locked into an attack, where
	// Sucker Punch is almost guaranteed to fire) fall through to the
	// normal damage path. That scores the move on its *actual* damage —
	// so a weak / non-STAB Sucker Punch isn't mistaken for a real KO —
	// and already layers on the priority-KO bonus when the hit is
	// genuinely threatening.
	return null;
}

/**
 * Score Encore. Locking the foe is best when they just used a non-damaging
 * move (setup, status, hazard) — we deny them a damaging turn. Locking
 * them into a damaging move they just used is mildly useful (predictability)
 * but a wasted turn against pure attackers.
 *
 * @param ctx The move evaluation context.
 * @returns The Encore utility score (~ -5..28 range).
 */
function scoreEncore(ctx: MoveEvalContext): number {
	const { defender } = ctx;
	if (!defender.lastMove) return -5;
	if (defender.choiceLocked) return -2; // Foe is already locked into one move.
	const lastMove = Dex.moves.get(defender.lastMove);
	if (!lastMove?.exists) return 4;
	if (lastMove.category === "Status") {
		// Locking a setup or hazard mon out of attacking is huge.
		return 28;
	}
	return 8;
}

/**
 * Score Destiny Bond. Only valuable as a desperation trade: we expect
 * to faint this turn anyway, so we take the foe with us. Showdown
 * disallows two DBs in a row, so refuse if our DB volatile is up.
 *
 * @param ctx The move evaluation context.
 * @returns The Destiny Bond utility score.
 */
function scoreDestinyBond(ctx: MoveEvalContext): number {
	const { attacker } = ctx;
	if (attacker.volatiles.has("destinybond")) return -25;
	const myHp = attacker.hpFraction ?? 1;
	// Destiny Bond only forces a trade if the bond is *up* at the moment
	// we faint. Destiny Bond itself has +0 priority, so when the foe
	// outspeeds and can KO us this turn we faint *before* the bond ever
	// resolves and the move whiffs. The reliable desperation line is the
	// opposite of what it looks like: we want to move first, set the
	// bond, and let the foe's KO this turn drag them down with us.
	const weMoveFirst = ctx.weOutspeed;
	// Critical HP + we get the bond up before the incoming KO — the
	// textbook "low HP, take them with me" trade.
	if (myHp < 0.25 && weMoveFirst) return 55;
	if (myHp < 0.4 && weMoveFirst) return 18;
	// Healthy (wasted turn), or we're slower (bond likely whiffs to a
	// faster KO before it can resolve).
	return -10;
}

/**
 * Score Baton Pass.
 *
 * Two utility sources stack:
 *
 * 1. Boosts the user is currently holding (each +1 stage worth a stage-
 *    weighted amount — same valuation as a self-boost move).
 * 2. The matchup value of the best switch target receiving those boosts
 *    (we don't waste BP into a 4x weak mon).
 *
 * Without boosts to pass and without a meaningful switch-in, BP is
 * essentially U-turn without damage — modestly negative.
 *
 * @param ctx The move evaluation context.
 * @returns The Baton Pass utility score.
 */
function scoreBatonPass(ctx: MoveEvalContext): number {
	const { attacker } = ctx;
	// Value of boosts being passed. We weight offensive stages high
	// because that's the whole point of a BP chain; speed is also
	// strong (Agility/Dragon Dance pass).
	let boostValue = 0;
	for (const [stat, raw] of Object.entries(attacker.boosts)) {
		const stage = Math.max(0, raw);
		if (!stage) continue;
		const perStage = stat === "spe" ? 12 : (stat === "atk" || stat === "spa") ? 11 : 6;
		boostValue += stage * perStage;
	}
	const switchValue = ctx.valueOfBestSwitch ?? 0;
	// If we have boosts, passing them is excellent — easily dominate the
	// fallback "+2" tier and most attacking options. Without boosts,
	// scale by the switch value so we still consider BP as a pivot.
	if (boostValue > 0) {
		return boostValue + Math.max(0, switchValue) * 0.6 + 8;
	}
	// No boosts: BP becomes a no-damage pivot. Mildly positive only if
	// the switch target is genuinely good and we don't have a better
	// attacking option (the engine will compare scores).
	if (switchValue > 8) return switchValue * 0.5;
	return -8;
}

function hazardSetValue(ctx: MoveEvalContext, hazard: string): number {
	const { tracker, foeSide, attacker } = ctx;
	const remainingFoes = tracker.getTeam(foeSide)
		.filter(m => !m.fainted)
		.length;
	if (remainingFoes <= 1) return -5;
	// Per-hazard base value, sized to reflect strategic worth across
	// the remaining foe team:
	//   - Sticky Web: -1 Spe to every grounded switch-in (massive tempo).
	//   - Stealth Rock: universal chip, fires on every switch incl.
	//     Heavy-Duty Boots-less Flying / Levitate / 4× SR-weak.
	//   - Toxic Spikes: stacking poison damage on grounded non-Poison.
	//   - Spikes: scales by layer, slowest payoff.
	let perFoe: number;
	switch (hazard) {
	case "stickyweb": perFoe = 10; break;
	case "stealthrock": perFoe = 8; break;
	case "toxicspikes": perFoe = 7; break;
	default: perFoe = 6; break;
	}
	let value = perFoe * remainingFoes;
	// Setup-window bonus: a Sturdy / Focus Sash user at full HP is
	// virtually guaranteed to live this turn, so the hazard set is
	// effectively free regardless of how the matchup looks otherwise.
	// We also lift hazards inside the wider setup window (WP bait,
	// Unburden pre-activation) since those mons are sticking around.
	if (inSetupWindow(ctx)) value += 12;
	// "Suicide hazard" play: when the active mon is going to faint
	// regardless of what it does this turn (e.g. faster foe + foe's
	// best move OHKOs us), a hazard set is a free farewell present to
	// the rest of the team. Previously we *penalised* low HP here,
	// which is exactly backwards: a Sturdy/Sash that's already broken
	// is still going to land its move before falling, and the foe
	// would have killed us with a damaging move either way. So we
	// lift hazards modestly when the mon is doomed but still able to
	// act this turn, instead of subtracting points.
	const hpf = attacker.hpFraction ?? 1;
	if (hpf < 0.25 && hpf > 0) value += 6;
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

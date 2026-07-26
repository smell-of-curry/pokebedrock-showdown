/**
 * Per-decision telemetry for the strategic AI.
 *
 * Winrate tells you *whether* a change helped; it never tells you what
 * the AI is actually doing wrong. These counters do, and they exist
 * specifically because the behaviours players complain about are
 * directly countable:
 *
 *   - "it uses moves the Pokemon is immune to" -> {@link immuneMoves}
 *   - "it never uses status moves to support itself" -> {@link statusMoves}
 *   - "it makes dumb switches" -> {@link switches}
 *   - "the battle stalls out" -> {@link rejections} / {@link defaults}
 *
 * An immune-move click is a hard bug, not a tuning question: the AI has
 * a full damage calculator and a type chart, so the correct count is
 * exactly zero at every difficulty above random. Tracking it as a
 * number makes that assertable in a test instead of something a player
 * has to report.
 *
 * Recording is opt-in (`PlayerAIOptions.stats`) and costs one damage
 * calculation per chosen move, so it stays out of the production
 * decision path.
 *
 * @license MIT
 */
import { Dex, toID } from "../../../dex";
import type { ChoiceRequest, MoveRequest } from "../../../side";
import { calculateDamage, fromTracked } from "../mechanics/DamageCalc";
import type { BattleStateTracker } from "../state/BattleStateTracker";

/** A plain snapshot of the counters, safe to structured-clone. */
export interface DecisionCounters {
	/** Decisions where the engine returned a non-empty command. */
	decisions: number;
	/** Chosen commands that selected a move. */
	moves: number;
	/** Chosen moves whose target was immune (0 damage from immunity). */
	immuneMoves: number;
	/**
	 * Immune clicks the AI could have avoided — another legal move on the
	 * same request would have connected.
	 *
	 * This is the number that means something. A raw immune click is
	 * often forced: Choice-locked into Close Combat when the foe brings
	 * in a Ghost, or mid-Outrage when they bring in a Fairy. Counting
	 * those as mistakes hides the real ones, so they're excluded here.
	 * Anything left is a genuine bug and the target is zero.
	 */
	avoidableImmuneMoves: number;
	/**
	 * Chosen damaging moves that deal 0 damage for any reason (immunity,
	 * 0 base power against this target, no viable defensive stat).
	 */
	zeroDamageMoves: number;
	/** Chosen moves resisted by the target (below 1x effectiveness). */
	resistedMoves: number;
	/** Chosen moves that were `Status` category. */
	statusMoves: number;
	/** Voluntary and forced switches. */
	switches: number;
	/** `pass` commands emitted in multi-slot requests. */
	passes: number;
	/** `default` commands emitted (engine gave up; sim auto-chooses). */
	defaults: number;
	/** Choices the simulator rejected. */
	rejections: number;
}

/** Rates derived from {@link DecisionCounters}, for reporting. */
export interface DecisionRates {
	/** Immune clicks as a fraction of chosen moves (incl. forced ones). */
	immuneMoveRate: number;
	/** Avoidable immune clicks as a fraction of chosen moves. Must be 0. */
	avoidableImmuneMoveRate: number;
	/** Zero-damage clicks as a fraction of chosen moves. */
	zeroDamageMoveRate: number;
	/** Resisted clicks as a fraction of chosen moves. */
	resistedMoveRate: number;
	/** Status moves as a fraction of chosen moves. */
	statusMoveRate: number;
	/** Switches as a fraction of all decisions. */
	switchRate: number;
	/** Rejections as a fraction of all decisions. */
	rejectionRate: number;
}

/** Mutable counter set with recording hooks. */
export class DecisionStats {
	private readonly counters: DecisionCounters = emptyCounters();

	/**
	 * Record one decision.
	 *
	 * @param request The request the engine answered.
	 * @param choice The command string the engine returned.
	 * @param tracker The AI's battle state tracker, or `null` if the AI
	 * hasn't seen a request with a side id yet.
	 */
	record(request: ChoiceRequest, choice: string, tracker: BattleStateTracker | null): void {
		if (!choice) return;
		this.counters.decisions++;
		// Doubles/triples answer every slot in one command.
		const parts = choice.split(",").map(p => p.trim()).filter(Boolean);
		for (let slot = 0; slot < parts.length; slot++) {
			this.recordSlot(parts[slot], slot, request, tracker);
		}
	}

	/** Record that the simulator rejected our choice. */
	recordRejection(): void {
		this.counters.rejections++;
	}

	/** A copy of the raw counters. */
	snapshot(): DecisionCounters {
		return { ...this.counters };
	}

	/**
	 * Fold another counter set into this one.
	 *
	 * @param other Counters to add (e.g. from a worker thread).
	 */
	merge(other: DecisionCounters): void {
		for (const key of Object.keys(this.counters) as (keyof DecisionCounters)[]) {
			this.counters[key] += other[key] ?? 0;
		}
	}

	/**
	 * Classify one slot's command and bump the matching counters.
	 *
	 * @param part One comma-separated command (`"move 3"`, `"switch 2"`, ...).
	 * @param slot Which active slot this command answers.
	 * @param request The request being answered.
	 * @param tracker The AI's tracker, used for the damage check.
	 */
	private recordSlot(
		part: string,
		slot: number,
		request: ChoiceRequest,
		tracker: BattleStateTracker | null
	): void {
		if (part === "pass") {
			this.counters.passes++;
			return;
		}
		if (part === "default") {
			this.counters.defaults++;
			return;
		}
		if (part.startsWith("switch")) {
			this.counters.switches++;
			return;
		}
		if (!part.startsWith("move")) return;
		this.counters.moves++;
		const moveId = resolveChosenMoveId(part, slot, request);
		if (!moveId || !tracker) return;
		const move = Dex.moves.get(moveId);
		if (!move?.exists) return;
		if (move.category === "Status") {
			this.counters.statusMoves++;
			return;
		}
		const attacker = tracker.myActive;
		const defender = tracker.foeActive;
		if (!attacker || !defender) return;
		const calc = calculateDamage({
			attacker: fromTracked(attacker),
			defender: fromTracked(defender),
			move,
			field: tracker.field,
			attackerSide: tracker.sides[tracker.mySide],
			defenderSide: tracker.sides[tracker.foeSide],
		});
		if (calc.immune) {
			this.counters.immuneMoves++;
			if (hadConnectingAlternative(request, slot, moveId, tracker)) {
				this.counters.avoidableImmuneMoves++;
			}
		}
		if (calc.avgDamage <= 0) this.counters.zeroDamageMoves++;
		else if (Dex.getEffectiveness(move.type, defender.types) < 0) this.counters.resistedMoves++;
	}
}

/**
 * Whether the request offered any other usable move that wasn't blocked
 * by immunity.
 *
 * @param request The request that was answered.
 * @param slot The active slot the choice was for.
 * @param chosenId The move id that was chosen.
 * @param tracker The AI's tracker, for the damage check.
 * @returns true if a different legal move would have connected, meaning
 * the immune click was avoidable.
 */
function hadConnectingAlternative(
	request: ChoiceRequest,
	slot: number,
	chosenId: string,
	tracker: BattleStateTracker
): boolean {
	const active = (request as MoveRequest).active?.[slot];
	const attacker = tracker.myActive;
	const defender = tracker.foeActive;
	if (!active?.moves || !attacker || !defender) return false;
	for (const entry of active.moves) {
		const id = toID(entry.id || entry.move);
		if (!id || id === chosenId) continue;
		if (entry.disabled || entry.pp === 0) continue;
		const alt = Dex.moves.get(id);
		if (!alt?.exists) continue;
		// A status move always "connects" in the sense that matters here:
		// it does something, whereas the immune attack does nothing.
		if (alt.category === "Status") return true;
		const calc = calculateDamage({
			attacker: fromTracked(attacker),
			defender: fromTracked(defender),
			move: alt,
			field: tracker.field,
			attackerSide: tracker.sides[tracker.mySide],
			defenderSide: tracker.sides[tracker.foeSide],
		});
		if (!calc.immune && calc.avgDamage > 0) return true;
	}
	return false;
}

/**
 * Zeroed counters.
 *
 * @returns A fresh {@link DecisionCounters} with every field at 0.
 */
export function emptyCounters(): DecisionCounters {
	return {
		decisions: 0,
		moves: 0,
		immuneMoves: 0,
		avoidableImmuneMoves: 0,
		zeroDamageMoves: 0,
		resistedMoves: 0,
		statusMoves: 0,
		switches: 0,
		passes: 0,
		defaults: 0,
		rejections: 0,
	};
}

/**
 * Derive reportable rates from raw counters.
 *
 * @param c The counters to summarise.
 * @returns Fractions, with 0 substituted for any 0/0 denominator.
 */
export function decisionRates(c: DecisionCounters): DecisionRates {
	const perMove = (n: number) => (c.moves > 0 ? n / c.moves : 0);
	const perDecision = (n: number) => (c.decisions > 0 ? n / c.decisions : 0);
	return {
		immuneMoveRate: perMove(c.immuneMoves),
		avoidableImmuneMoveRate: perMove(c.avoidableImmuneMoves),
		zeroDamageMoveRate: perMove(c.zeroDamageMoves),
		resistedMoveRate: perMove(c.resistedMoves),
		statusMoveRate: perMove(c.statusMoves),
		switchRate: perDecision(c.switches),
		rejectionRate: perDecision(c.rejections),
	};
}

/**
 * Resolve which move a `move N` command selected, using the request's
 * own move list so the mapping matches whatever the simulator offered.
 *
 * @param part The single-slot command (`"move 2 1"`, `"move 3 tera"`, ...).
 * @param slot Which active slot the command answers.
 * @param request The request being answered.
 * @returns The move id, or `null` if the command doesn't name a
 * resolvable move (e.g. `move <name>` against a request with no
 * matching entry).
 */
function resolveChosenMoveId(part: string, slot: number, request: ChoiceRequest): string | null {
	const arg = part.slice("move".length).trim().split(/\s+/)[0];
	if (!arg) return null;
	const active = (request as MoveRequest).active?.[slot];
	const moves = active?.moves;
	const index = Number(arg);
	if (Number.isInteger(index) && index >= 1) {
		// `move N` is 1-based over the request's move list.
		const entry = moves?.[index - 1];
		return entry ? toID(entry.id || entry.move) : null;
	}
	// Engines emit indices, but a hand-written `move <id>` is legal too.
	const id = toID(arg);
	if (!moves) return id || null;
	const entry = moves.find(m => toID(m.id || m.move) === id);
	return entry ? toID(entry.id || entry.move) : id || null;
}

/**
 * Strategic-AI heuristic engine (difficulty 3).
 *
 * Replaces the legacy single-ply scoring inside the original
 * `player-ai.ts` shell with a composition of:
 *
 * - {@link DamageCalc} for damage *distributions* (min/avg/max/KO%).
 * - {@link MoveEvaluator} for category-based move scoring (status,
 *   hazards, pivot, priority, recovery, ...).
 * - {@link SwitchEvaluator} for switch matchup scoring with the
 *   correct per-attacker-type effectiveness math.
 * - {@link TargetPicker} for doubles target selection (redirection,
 *   spread, Helping Hand).
 * - {@link OpponentInference} for layered guesses about hidden info.
 *
 * The engine keeps the host {@link PlayerAI}'s legacy
 * "switch lock" / "Protect spam guard" knobs so its public behaviour
 * stays close to today's at the same difficulty.
 *
 * @license MIT
 */
import { Dex, toID } from "../../../dex";
import type {
	ChoiceRequest,
	MoveRequest,
	PokemonMoveRequestData,
	PokemonSwitchRequestData,
	SideRequestData,
	SwitchRequest,
	TeamPreviewRequest,
} from "../../../side";
import { calculateDamage, fromTracked } from "../mechanics/DamageCalc";
import { evaluateMove, type MoveEvalContext } from "../mechanics/MoveEvaluator";
import { chooseBestSwitch, evaluateMatchup } from "../mechanics/SwitchEvaluator";
import { pickTarget } from "../mechanics/TargetPicker";
import { chooseTransform } from "../mechanics/TransformPolicy";
import type { BattleStateTracker, TrackedPokemon } from "../state/BattleStateTracker";
import { applyNoise, type Engine, type EngineContext } from "./Engine";

/** Switch-out HP threshold below which we consider safe-pivoting. */
const HP_SWITCH_OUT_THRESHOLD = 0.3;
/** Faint-emergency HP threshold (combine with foe-faster check). */
const FAINT_THRESHOLD = 0.1;
/** How many turns we lock against re-switching the same mon. */
const SWITCH_LOCK_TURNS = 2;
/** Chance per-turn to consider Protect when it's available and safe. */
const PROTECT_CONSIDER_CHANCE = 0.15;
/** Switch-out matchup threshold; below this, switching is favoured. */
const SWITCH_OUT_MATCHUP = -8;

/** Lazy `Dex.moves.get`. */
function moveOf(id: string) {
	return Dex.moves.get(id);
}

/**
 * Default heuristic engine. Stateless (state lives on `EngineContext`).
 */
export class HeuristicEngine implements Engine {
	readonly id: string = "heuristic";

	choose(request: ChoiceRequest, ctx: EngineContext): string {
		if (request.wait) return "";
		if (request.teamPreview) return this.chooseTeamPreview(request, ctx);
		if (request.forceSwitch) return this.chooseForceSwitch(request, ctx);
		return this.chooseMove(request, ctx);
	}

	// -----------------------------------------------------------------
	// Team preview
	// -----------------------------------------------------------------

	private chooseTeamPreview(
		request: TeamPreviewRequest,
		ctx: EngineContext
	): string {
		const tracker = ctx.tracker;
		const side = request.side;
		const foes = side.foePokemon ?? [];
		if (!side.pokemon.length || !foes.length || !tracker) return "default";

		// Score each of our mons as a lead by summing matchup scores
		// against every foe.
		const myMons = side.pokemon
			.map((p, idx) => ({ p, idx, mon: this.resolveTrackedFromRequest(p, ctx, tracker.mySide) }))
			.filter(x => x.mon);
		const foeMons = foes
			.map(p => this.resolveTrackedFromRequest(p, ctx, tracker.foeSide))
			.filter((m): m is TrackedPokemon => !!m);

		let bestLead = 0;
		let bestScore = -Infinity;
		for (const candidate of myMons) {
			let total = 0;
			for (const foe of foeMons) {
				total += evaluateMatchup(candidate.mon!, foe, tracker).score;
			}
			if (total > bestScore) {
				bestScore = total;
				bestLead = candidate.idx;
			}
		}

		const order = [
			bestLead,
			...Array.from({ length: side.pokemon.length }, (_, i) => i).filter(i => i !== bestLead),
		];
		return `team ${order.map(i => i + 1).join(",")}`;
	}

	// -----------------------------------------------------------------
	// Force switch
	// -----------------------------------------------------------------

	private chooseForceSwitch(
		request: SwitchRequest,
		ctx: EngineContext
	): string {
		const side = request.side;
		const slots = request.forceSwitch || [];
		if (!side?.pokemon) return "pass";
		const tracker = ctx.tracker;
		const foeActive = tracker?.foeActive ?? null;

		const taken = new Set<number>();
		const actions = slots.map(needsSwitch => {
			if (!needsSwitch) return "pass";
			const candidates: { req: PokemonSwitchRequestData, idx: number, mon: TrackedPokemon }[] = [];
			for (let i = 0; i < side.pokemon.length; i++) {
				const p = side.pokemon[i];
				if (!p || p.active || p.condition.endsWith(" fnt")) continue;
				if (taken.has(i + 1)) continue;
				const mon = tracker ? this.resolveTrackedFromRequest(p, ctx, tracker.mySide) : null;
				if (!mon) continue;
				candidates.push({ req: p, idx: i + 1, mon });
			}
			if (!candidates.length) return "pass";
			let pickIdx = candidates[0].idx;
			if (tracker && foeActive) {
				const best = chooseBestSwitch(
					candidates.map(c => c.mon),
					foeActive,
					tracker
				);
				if (best) {
					const match = candidates.find(c => c.mon.id === best.mon.id);
					if (match) pickIdx = match.idx;
				}
			}
			taken.add(pickIdx);
			return `switch ${pickIdx}`;
		});
		return actions.join(", ");
	}

	// -----------------------------------------------------------------
	// Move requests (the big one)
	// -----------------------------------------------------------------

	private chooseMove(request: MoveRequest, ctx: EngineContext): string {
		const tracker = ctx.tracker;
		const side = request.side;
		if (!side || !request.active || !tracker) return "default";

		const decisions: string[] = request.active.map((active, slotIndex) => {
			const sideMon = side.pokemon[slotIndex];
			if (!sideMon || sideMon.condition.endsWith(" fnt")) return "pass";
			return this.decideForSlot(request, ctx, tracker, slotIndex, active);
		});
		return decisions.join(", ");
	}

	private decideForSlot(
		request: MoveRequest,
		ctx: EngineContext,
		tracker: BattleStateTracker,
		slotIndex: number,
		active: PokemonMoveRequestData
	): string {
		const side = request.side;
		const sideMon = side.pokemon[slotIndex];
		const myMon = this.resolveTrackedFromRequest(sideMon, ctx, tracker.mySide);
		const foeMon = tracker.foeActive;
		if (!myMon || !foeMon) return "default";

		const monId = this.monIdForSlot(side, slotIndex, ctx);
		const lastMoveId = monId ? ctx.lastMoveByMon.get(monId) : undefined;

		// 1. Should we switch out?
		const switchCandidates = this.gatherSwitchCandidates(side, slotIndex, ctx, tracker);
		const trapped = !!active.trapped;
		if (!trapped && switchCandidates.length > 0) {
			const switchDecision = this.maybeSwitchOut(
				myMon, foeMon, tracker, side, slotIndex, ctx, switchCandidates
			);
			if (switchDecision) {
				if (monId) ctx.lastSwitchTurnByMon.set(monId, tracker.turn);
				return switchDecision;
			}
		}

		// 2. Filter available moves.
		const availableMoves = this.availableMoves(active, monId, ctx);
		if (!availableMoves.length) return "default";

		// 3. Optional Protect probe.
		if (lastMoveId !== "protect" && ctx.prng.random() < PROTECT_CONSIDER_CHANCE) {
			const protectIdx = availableMoves.findIndex(m => m.id === "protect");
			if (protectIdx >= 0) {
				if (monId) ctx.lastMoveByMon.set(monId, "protect");
				return `move ${this.moveCommandIndex(active, "protect")}`;
			}
		}

		// 4. Score each candidate move.
		const evalCtx: MoveEvalContext = {
			tracker,
			attacker: myMon,
			defender: foeMon,
			mySide: tracker.mySide,
			foeSide: tracker.foeSide,
			weOutspeed: this.weOutspeed(myMon, foeMon, tracker),
			isDoubles: request.active.length > 1,
			valueOfBestSwitch: switchCandidates.length ?
				this.bestSwitchValue(switchCandidates, foeMon, tracker) :
				0,
		};

		const scored = this.scoreCandidates(availableMoves, evalCtx, ctx);
		scored.sort((a, b) => b.score - a.score);

		// 5. Anti-staleness: avoid repeating the same move turn-after-turn
		// when an alternative is nearly as good (predictability hurts).
		let pick = scored[0];
		if (
			scored.length > 1 &&
			pick.opt.id === lastMoveId &&
			scored[1].score >= 0.9 * pick.score
		) {
			pick = scored[1];
		}
		// 6. Apply epsilon noise.
		const noisedPool = scored.filter(s => s.score >= pick.score * 0.5);
		const noised = applyNoise(pick, noisedPool, ctx.noiseEpsilon, ctx.prng);
		const chosen = noised.opt;
		if (monId) ctx.lastMoveByMon.set(monId, chosen.id);

		// 7. Format command (with target for doubles).
		return this.formatMoveCommand(active, chosen.id, slotIndex, request, ctx, tracker, myMon);
	}

	/**
	 * Evaluate whether the active mon should switch this turn. Returns a
	 * `switch N` command or `null` to indicate "stay in".
	 */
	private maybeSwitchOut(
		myMon: TrackedPokemon,
		foeMon: TrackedPokemon,
		tracker: BattleStateTracker,
		side: SideRequestData,
		slotIndex: number,
		ctx: EngineContext,
		switchCandidates: { req: PokemonSwitchRequestData, idx: number, mon: TrackedPokemon }[]
	): string | null {
		const monId = this.monIdForSlot(side, slotIndex, ctx);
		const lastSwitch = monId ? ctx.lastSwitchTurnByMon.get(monId) : undefined;
		if (lastSwitch !== undefined && tracker.turn - lastSwitch < SWITCH_LOCK_TURNS) return null;

		const myHp = myMon.hpFraction ?? 1;
		const matchup = evaluateMatchup(myMon, foeMon, tracker);
		const myStats = myMon.stats;
		const foeStats = foeMon.stats;
		const wereFaster = (myStats?.spe ?? 0) > (foeStats?.spe ?? 0);

		const wantSwitch =
			(myHp < FAINT_THRESHOLD && !wereFaster) ||
			matchup.score < SWITCH_OUT_MATCHUP ||
			((myMon.boosts.atk || 0) <= -3 && (myStats?.atk ?? 0) >= (myStats?.spa ?? 0)) ||
			((myMon.boosts.spa || 0) <= -3 && (myStats?.spa ?? 0) >= (myStats?.atk ?? 0)) ||
			(myHp < HP_SWITCH_OUT_THRESHOLD && matchup.score < 0);
		if (!wantSwitch) return null;

		// Find best candidate.
		const best = chooseBestSwitch(
			switchCandidates.map(c => c.mon),
			foeMon,
			tracker
		);
		if (!best) return null;
		const slot = switchCandidates.find(c => c.mon.id === best.mon.id);
		if (!slot) return null;
		// Skill-gated: lower difficulty switches less reliably.
		const skill = Math.max(0, Math.min(1, (ctx.difficulty - 1) / 4));
		if (ctx.prng.random() > skill) return null;
		return `switch ${slot.idx}`;
	}

	/**
	 * Score every candidate move. Default implementation defers to
	 * {@link evaluateMove} and applies info-forgetting noise. Subclasses
	 * (e.g. {@link OnePlySearchEngine}) override this to layer search
	 * on top.
	 */
	protected scoreCandidates(
		moves: { id: string, idx: number }[],
		evalCtx: MoveEvalContext,
		ctx: EngineContext
	): { opt: { id: string, idx: number }, score: number }[] {
		return moves.map(opt => {
			const move = moveOf(opt.id);
			const evalResult = evaluateMove(move, evalCtx);
			let score = evalResult.score;
			if (ctx.infoForgetting > 0 && evalCtx.defender.revealedMoves.size > 0 &&
				ctx.prng.random() < ctx.infoForgetting) {
				score *= 0.85;
			}
			return { opt, score };
		});
	}

	private bestSwitchValue(
		switchCandidates: { mon: TrackedPokemon }[],
		foeMon: TrackedPokemon,
		tracker: BattleStateTracker
	): number {
		let best = -Infinity;
		for (const c of switchCandidates) {
			const score = evaluateMatchup(c.mon, foeMon, tracker).score;
			if (score > best) best = score;
		}
		return Number.isFinite(best) ? best : 0;
	}

	private gatherSwitchCandidates(
		side: SideRequestData,
		slotIndex: number,
		ctx: EngineContext,
		tracker: BattleStateTracker
	): { req: PokemonSwitchRequestData, idx: number, mon: TrackedPokemon }[] {
		const out: { req: PokemonSwitchRequestData, idx: number, mon: TrackedPokemon }[] = [];
		for (let i = 0; i < side.pokemon.length; i++) {
			const p = side.pokemon[i];
			if (!p || p.active || p.condition.endsWith(" fnt")) continue;
			const mon = this.resolveTrackedFromRequest(p, ctx, tracker.mySide);
			if (!mon) continue;
			out.push({ req: p, idx: i + 1, mon });
		}
		return out;
	}

	// -----------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------

	private weOutspeed(
		me: TrackedPokemon,
		foe: TrackedPokemon,
		tracker: BattleStateTracker
	): boolean {
		const mySpe = me.stats?.spe ?? 0;
		const foeSpe = foe.stats?.spe ?? 0;
		const myEff = mySpe * (tracker.sides[tracker.mySide].tailwindTurns > 0 ? 2 : 1);
		const foeEff = foeSpe * (tracker.sides[tracker.foeSide].tailwindTurns > 0 ? 2 : 1);
		const baseFaster = myEff > foeEff;
		return tracker.field.trickRoom ? !baseFaster : baseFaster;
	}

	private availableMoves(
		active: PokemonMoveRequestData,
		monId: string | null,
		ctx: EngineContext
	): { id: string, idx: number }[] {
		const out: { id: string, idx: number }[] = [];
		const monDisabled = monId ? ctx.disabledMovesByMon.get(monId) : undefined;
		active.moves.forEach((move, idx) => {
			if (move.disabled) return;
			if (move.pp === 0) return;
			if (monDisabled?.has(move.id)) return;
			out.push({ id: move.id, idx: idx + 1 });
		});
		return out;
	}

	private moveCommandIndex(active: PokemonMoveRequestData, moveId: string): number {
		const idx = active.moves.findIndex(m => m.id === moveId);
		return idx >= 0 ? idx + 1 : 1;
	}

	private formatMoveCommand(
		active: PokemonMoveRequestData,
		moveId: string,
		slotIndex: number,
		request: MoveRequest,
		ctx: EngineContext,
		tracker: BattleStateTracker,
		myMon: TrackedPokemon
	): string {
		const idx = this.moveCommandIndex(active, moveId);
		// Decide whether to consume a one-shot transformation (Tera/
		// Mega/Z/Dynamax). The transform decision needs to know which
		// move we picked, so we compute it after move selection.
		let suffix = "";
		const foeMon = tracker.foeActive;
		if (foeMon) {
			const transform = chooseTransform({
				tracker,
				myMon,
				foeMon,
				active,
				chosenMoveId: moveId,
			});
			if (transform) suffix = transform.suffix;
		}
		if (request.active.length <= 1) return `move ${idx}${suffix}`;
		const move = moveOf(moveId);
		const target = move.target;
		const ourSlots = request.active
			.map((_, i) => i)
			.filter(i => {
				const p = (request.side).pokemon[i];
				return p && p.active && !p.condition.endsWith(" fnt");
			});
		const foeSlotMons = (request.side?.foePokemon ?? [])
			.map((p, i) => ({ p, i }))
			.filter(({ p }) => p.active && !p.condition.endsWith(" fnt"))
			.map(({ p }) => this.resolveTrackedFromRequest(p, ctx, tracker.foeSide))
			.filter((m): m is TrackedPokemon => !!m);
		const allyMons = ourSlots
			.map(i => this.resolveTrackedFromRequest(
				(request.side).pokemon[i], ctx, tracker.mySide))
			.filter((m): m is TrackedPokemon => !!m);

		switch (target) {
			case "normal":
			case "any":
			case "adjacentFoe": {
				const t = pickTarget({
					tracker,
					attacker: myMon,
					move,
					foeSlots: foeSlotMons,
					allySlots: allyMons,
				});
				return t !== null ? `move ${idx} ${t}${suffix}` : `move ${idx}${suffix}`;
			}
			case "adjacentAlly":
				return `move ${idx} -${(slotIndex ^ 1) + 1}${suffix}`;
			case "adjacentAllyOrSelf": {
				const allyIndex = slotIndex ^ 1;
				const ally = (request.side).pokemon[allyIndex];
				const allyAlive = !!ally && !ally.condition.endsWith(" fnt");
				return `move ${idx} -${(allyAlive ? allyIndex : slotIndex) + 1}${suffix}`;
			}
			default:
				return `move ${idx}${suffix}`;
		}
	}

	private monIdForSlot(
		side: SideRequestData,
		slotIndex: number,
		ctx: EngineContext
	): string | null {
		const me = side.pokemon[slotIndex];
		if (!me) return null;
		if (me.uuid) return me.uuid;
		const sideId = side.id ?? ctx.tracker?.mySide ?? "p1";
		const colon = me.ident.indexOf(":");
		const name = colon >= 0 ? me.ident.slice(colon + 1).trim() : me.ident;
		return `${sideId}|${name}`;
	}

	/**
	 * Look up the tracker record corresponding to a request entry.
	 * The tracker indexes mons by uuid (preferred) or `${side}|${name}`,
	 * and is fed by `applyRequest` before the engine runs, so this
	 * lookup should always succeed for a current-team mon.
	 */
	private resolveTrackedFromRequest(
		req: PokemonSwitchRequestData,
		ctx: EngineContext,
		sideId: "p1" | "p2" | "p3" | "p4"
	): TrackedPokemon | null {
		const tracker = ctx.tracker;
		if (!tracker) return null;
		if (req.uuid) {
			const m = tracker.pokemon.get(req.uuid);
			if (m) return m;
		}
		const colon = req.ident.indexOf(":");
		const name = colon >= 0 ? req.ident.slice(colon + 1).trim() : req.ident;
		for (const mon of tracker.pokemon.values()) {
			if (mon.name === name && (mon.id.startsWith(`${sideId}:`) || mon.id === req.uuid)) {
				return mon;
			}
		}
		// Fallback: synthesise a minimal record so we don't crash.
		return null;
	}
}

/** Re-export the small helper consumers may want. */
export { calculateDamage, fromTracked, toID };

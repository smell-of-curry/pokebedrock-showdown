/**
 * Strategic-AI light heuristic engine (difficulty 2).
 *
 * Preserves the *behaviour* of the legacy single-ply heuristic AI so cheap
 * NPCs / low-difficulty trainers feel the same as before the tiered
 * overhaul. We deliberately don't pull in {@link DamageCalc},
 * {@link MoveEvaluator}, or {@link OpponentInference} here: this engine
 * is supposed to feel weak relative to the new {@link HeuristicEngine}
 * (difficulty 3+).
 *
 * The implementation mirrors the legacy single-ply scoring with the
 * critical correctness fixes from Phase 1b applied (per-Pokemon last
 * move / disabled moves / switch lock, weather sourced from the
 * tracker, type-effectiveness math fixed). Anything beyond that is
 * intentionally absent.
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
import type { Engine, EngineContext } from "./Engine";

const FAINT_THRESHOLD = 0.1;
const SWITCH_OUT_HP = 0.3;
const SWITCH_OUT_MATCHUP = -3;
const SWITCH_LOCK_TURNS = 2;
const PROTECT_CHANCE = 0.15;

const TYPE_MATCHUP_WEIGHT = 2.5;
const SPEED_TIER_COEFF = 4.0;
const HP_FRACTION_COEFF = 0.4;
const HP_WEIGHT = 0.25;
const ANTI_BOOST_WEIGHT = 25;

const ANTI_BOOST_MOVES = new Set(["haze", "clearsmog", "spectralthief"]);

interface MoveOption { id: string; idx: number }

export class LightHeuristicEngine implements Engine {
	readonly id = "light";

	choose(request: ChoiceRequest, ctx: EngineContext): string {
		if (request.wait) return "";
		if (request.teamPreview) return this.teamPreview(request, ctx);
		if (request.forceSwitch) return this.forceSwitch(request, ctx);
		return this.move(request, ctx);
	}

	private teamPreview(request: TeamPreviewRequest, _ctx: EngineContext): string {
		const side = request.side;
		const foes = side.foePokemon ?? [];
		if (!side.pokemon.length || !foes.length) return "default";
		let bestLead = 0;
		let bestScore = -Infinity;
		for (let i = 0; i < side.pokemon.length; i++) {
			const me = side.pokemon[i];
			if (!me || me.condition.endsWith(" fnt")) continue;
			let total = 0;
			for (const foe of foes) total += this.matchup(me, foe);
			if (total > bestScore) {
				bestScore = total;
				bestLead = i;
			}
		}
		const order = [
			bestLead,
			...Array.from({ length: side.pokemon.length }, (_, i) => i).filter(i => i !== bestLead),
		];
		return `team ${order.map(i => i + 1).join(",")}`;
	}

	private forceSwitch(request: SwitchRequest, _ctx: EngineContext): string {
		const side = request.side;
		const slots = request.forceSwitch || [];
		if (!side?.pokemon) return "pass";
		const foeActive = (side.foePokemon ?? []).find(p => p.active && !p.condition.endsWith(" fnt"));
		const taken = new Set<number>();
		const actions = slots.map(must => {
			if (!must) return "pass";
			let bestIdx = -1;
			let bestScore = -Infinity;
			for (let i = 0; i < side.pokemon.length; i++) {
				const p = side.pokemon[i];
				if (!p || p.active || p.condition.endsWith(" fnt") || taken.has(i + 1)) continue;
				const score = foeActive ? this.matchup(p, foeActive) : 0;
				if (score > bestScore) {
					bestScore = score;
					bestIdx = i + 1;
				}
			}
			if (bestIdx < 0) return "pass";
			taken.add(bestIdx);
			return `switch ${bestIdx}`;
		});
		return actions.join(", ");
	}

	private move(request: MoveRequest, ctx: EngineContext): string {
		const side = request.side;
		if (!side || !request.active) return "default";
		const decisions = request.active.map((active, slotIndex) => {
			const sideMon = side.pokemon[slotIndex];
			if (!sideMon || sideMon.condition.endsWith(" fnt")) return "pass";
			return this.decideForSlot(request, ctx, slotIndex, active);
		});
		return decisions.join(", ");
	}

	private decideForSlot(
		request: MoveRequest,
		ctx: EngineContext,
		slotIndex: number,
		active: PokemonMoveRequestData
	): string {
		const side = request.side;
		const me = side.pokemon[slotIndex];
		const foe = (side.foePokemon ?? []).find(p => p.active);
		const monId = this.monIdForSlot(side, slotIndex, ctx);
		const lastMoveId = monId ? ctx.lastMoveByMon.get(monId) : undefined;
		const turn = ctx.tracker?.turn ?? 0;

		// 1. Switch out?
		if (foe && !active.trapped) {
			const lastSwitch = monId ? ctx.lastSwitchTurnByMon.get(monId) : undefined;
			const canSwitch = side.pokemon.filter(p => !p.active && !p.condition.endsWith(" fnt"));
			if (canSwitch.length && (lastSwitch === undefined || turn - lastSwitch >= SWITCH_LOCK_TURNS)) {
				if (this.shouldSwitchOut(me, foe)) {
					const skill = Math.max(0, Math.min(1, (ctx.difficulty - 1) / 4));
					if (ctx.prng.random() < skill) {
						const slot = this.bestSwitchSlot(side, foe);
						if (slot > 0) {
							if (monId) ctx.lastSwitchTurnByMon.set(monId, turn);
							return `switch ${slot}`;
						}
					}
				}
			}
		}

		const moves = this.availableMoves(active, monId, ctx);
		if (!moves.length) return "default";

		// 2. Protect probe.
		if (lastMoveId !== "protect" && ctx.prng.random() < PROTECT_CHANCE) {
			const protectIdx = moves.findIndex(m => m.id === "protect");
			if (protectIdx >= 0) {
				if (monId) ctx.lastMoveByMon.set(monId, "protect");
				return `move ${moves[protectIdx].idx}`;
			}
		}

		// 3. Score moves.
		let best = moves[0];
		let bestScore = -Infinity;
		let second = moves[0];
		let secondScore = -Infinity;
		for (const m of moves) {
			const score = this.scoreMove(m, me, foe, ctx);
			if (score > bestScore) {
				secondScore = bestScore;
				second = best;
				bestScore = score;
				best = m;
			} else if (score > secondScore) {
				secondScore = score;
				second = m;
			}
		}
		// Avoid repeating the same move when alternatives are close.
		if (second && best.id === lastMoveId && secondScore >= 0.9 * bestScore) {
			best = second;
		}

		if (monId) ctx.lastMoveByMon.set(monId, best.id);
		// Singles or non-targetable: just `move N`. We omit doubles
		// targeting on purpose (the Light engine never knew about it).
		if (request.active.length <= 1) return `move ${best.idx}`;
		const move = Dex.moves.get(best.id);
		switch (move.target) {
			case "normal":
			case "any":
			case "adjacentFoe":
				return `move ${best.idx} 1`;
			case "adjacentAlly":
				return `move ${best.idx} -${(slotIndex ^ 1) + 1}`;
			default:
				return `move ${best.idx}`;
		}
	}

	private shouldSwitchOut(me: PokemonSwitchRequestData, foe: PokemonSwitchRequestData): boolean {
		const myHpFrac = parseHpFraction(me.condition);
		if (myHpFrac < FAINT_THRESHOLD && (me.stats?.spe ?? 0) < (foe.stats?.spe ?? 0)) return true;
		const matchup = this.matchup(me, foe);
		if (matchup < SWITCH_OUT_MATCHUP) return true;
		if ((me.boosts.atk || 0) <= -3 && (me.stats?.atk ?? 0) >= (me.stats?.spa ?? 0)) return true;
		if ((me.boosts.spa || 0) <= -3 && (me.stats?.spa ?? 0) >= (me.stats?.atk ?? 0)) return true;
		if (myHpFrac < SWITCH_OUT_HP) return true;
		return false;
	}

	private bestSwitchSlot(side: SideRequestData, foe: PokemonSwitchRequestData): number {
		let bestIdx = -1;
		let bestScore = -Infinity;
		for (let i = 0; i < side.pokemon.length; i++) {
			const p = side.pokemon[i];
			if (!p || p.active || p.condition.endsWith(" fnt")) continue;
			const score = this.matchup(p, foe);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i + 1;
			}
		}
		return bestIdx;
	}

	private scoreMove(
		opt: MoveOption,
		me: PokemonSwitchRequestData,
		foe: PokemonSwitchRequestData | undefined,
		ctx: EngineContext
	): number {
		const move = Dex.getActiveMove(opt.id);
		if (!move) return 0;
		if (move.category === "Status") {
			return scoreStatusMoveLight(move.id, me, foe, ctx);
		}
		if (!foe) return move.basePower || 0;
		// Simple damage estimate.
		const dmg = simpleDamage(move, me, foe, ctx.tracker?.field.weather ?? "");
		const foeHp = parseCurrentHp(foe.condition);
		let value = dmg * 0.8;
		if (dmg >= foeHp) value += 40;
		return value;
	}

	private matchup(me: PokemonSwitchRequestData, foe: PokemonSwitchRequestData): number {
		let score = 0;
		score += typeEffectivenessLight(me.types, foe.types) * TYPE_MATCHUP_WEIGHT;
		if ((me.stats?.spe ?? 0) > (foe.stats?.spe ?? 0)) score += SPEED_TIER_COEFF;
		else if ((me.stats?.spe ?? 0) < (foe.stats?.spe ?? 0)) score -= SPEED_TIER_COEFF;
		const myHp = parseHpFraction(me.condition);
		const foeHp = parseHpFraction(foe.condition);
		score += (myHp - foeHp) * HP_FRACTION_COEFF * HP_WEIGHT;
		const myBoosts = sumBoosts(me.boosts);
		const foeBoosts = sumBoosts(foe.boosts);
		score += myBoosts - foeBoosts;
		if (foeBoosts > 0 && hasAntiBoostMove(me)) score += ANTI_BOOST_WEIGHT;
		return score;
	}

	private availableMoves(
		active: PokemonMoveRequestData,
		monId: string | null,
		ctx: EngineContext
	): MoveOption[] {
		const out: MoveOption[] = [];
		const monDisabled = monId ? ctx.disabledMovesByMon.get(monId) : undefined;
		active.moves.forEach((m, idx) => {
			if (m.disabled) return;
			if (m.pp === 0) return;
			if (monDisabled?.has(m.id)) return;
			out.push({ id: m.id, idx: idx + 1 });
		});
		return out;
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
}

// -----------------------------------------------------------------------
// Helpers (file-private)
// -----------------------------------------------------------------------

function scoreStatusMoveLight(
	moveId: string,
	me: PokemonSwitchRequestData,
	foe: PokemonSwitchRequestData | undefined,
	ctx: EngineContext
): number {
	const foeStatused = foe?.status && foe.status !== "";
	switch (moveId) {
		case "willowisp":
			if (foe && !foeStatused && (foe.stats?.atk ?? 0) > (foe.stats?.spa ?? 0) && !foe.types.includes("Fire")) return 35;
			break;
		case "thunderwave":
			if (foe && !foeStatused && (foe.stats?.spe ?? 0) > (me.stats?.spe ?? 0) &&
				!foe.types.includes("Ground") && !foe.types.includes("Electric")) return 30;
			break;
		case "swordsdance":
		case "nastyplot": {
			const isPhysical = moveId === "swordsdance";
			const cur = isPhysical ? (me.boosts.atk || 0) : (me.boosts.spa || 0);
			const suitable = isPhysical ?
				(me.stats?.atk ?? 0) >= (me.stats?.spa ?? 0) :
				(me.stats?.spa ?? 0) >= (me.stats?.atk ?? 0);
			if (cur < 2 && suitable) return 20;
			break;
		}
		case "stealthrock": {
			const set = ctx.tracker?.sides[ctx.tracker.foeSide].stealthRock;
			if (!set) return 20;
			break;
		}
		case "spikes": {
			const layers = ctx.tracker?.sides[ctx.tracker.foeSide].spikes ?? 0;
			if (layers < 3) return 15;
			break;
		}
	}
	return 0;
}

function simpleDamage(
	move: { basePower: number, category: string, type: string, multihit?: number | number[] },
	atk: PokemonSwitchRequestData,
	def: PokemonSwitchRequestData,
	weather: string
): number {
	if (!move.basePower) return 0;
	let bp = move.basePower;
	if (move.multihit) {
		if (Array.isArray(move.multihit)) {
			const [lo, hi] = move.multihit;
			bp *= (lo + hi) / 2;
		} else bp *= move.multihit;
	}
	const isPhysical = move.category === "Physical";
	let atkStat = isPhysical ? atk.stats.atk : atk.stats.spa;
	let defStat = isPhysical ? def.stats.def : def.stats.spd;
	atkStat *= boostMul(atk.boosts[isPhysical ? "atk" : "spa"] || 0);
	defStat *= boostMul(def.boosts[isPhysical ? "def" : "spd"] || 0);
	const ability = (atk.ability || atk.baseAbility || "").toLowerCase();
	if (isPhysical && (ability === "hugepower" || ability === "purepower")) atkStat *= 2;
	const item = (atk.item || "").toLowerCase();
	if (isPhysical && /choice ?band/.test(item)) atkStat *= 1.5;
	if (!isPhysical && /choice ?specs/.test(item)) atkStat *= 1.5;
	let damage = (((2 * 100) / 5 + 2) * bp * atkStat) / defStat / 50 + 2;
	if (atk.types.includes(move.type)) damage *= ability === "adaptability" ? 2 : 1.5;
	let typeExp = 0;
	for (const t of def.types) typeExp += Dex.getEffectiveness(move.type, t);
	if (!Dex.getImmunity(move.type, def.types)) damage = 0;
	else damage *= 2 ** typeExp;
	if (weather === "raindance" || weather === "primordialsea") {
		if (move.type === "Water") damage *= 1.5;
		if (move.type === "Fire") damage *= weather === "primordialsea" ? 0 : 0.5;
	} else if (weather === "sunnyday" || weather === "desolateland") {
		if (move.type === "Fire") damage *= 1.5;
		if (move.type === "Water") damage *= weather === "desolateland" ? 0 : 0.5;
	}
	if (isPhysical && atk.status === "brn" && ability !== "guts") damage *= 0.5;
	if (item.includes('life orb')) damage *= 1.3;
	if (item.includes('expert belt') && 2 ** typeExp > 1) damage *= 1.2;
	damage *= 0.925;
	return Math.max(0, damage);
}

function typeEffectivenessLight(atkTypes: string[], defTypes: string[]): number {
	if (!atkTypes.length) return 1;
	let total = 0;
	for (const a of atkTypes) {
		if (!Dex.getImmunity(a, defTypes)) continue;
		let exp = 0;
		for (const d of defTypes) exp += Dex.getEffectiveness(a, d);
		total += 2 ** exp;
	}
	return total / atkTypes.length;
}

function boostMul(stage: number): number {
	if (stage >= 0) return (2 + stage) / 2;
	return 2 / (2 - stage);
}

function parseCurrentHp(condition: string): number {
	const head = condition.split(" ")[0];
	const slash = head.indexOf("/");
	if (slash < 0) {
		const n = parseInt(head);
		return Number.isFinite(n) ? n : 0;
	}
	return parseInt(head.slice(0, slash)) || 0;
}

function parseHpFraction(condition: string): number {
	const head = condition.split(" ")[0];
	if (head === "0" || head.endsWith("fnt")) return 0;
	const slash = head.indexOf("/");
	if (slash < 0) {
		const v = parseInt(head);
		return Number.isFinite(v) ? v / 100 : 0;
	}
	const cur = parseInt(head.slice(0, slash));
	const max = parseInt(head.slice(slash + 1));
	return max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0;
}

function sumBoosts(boosts: { [s: string]: number }): number {
	let total = 0;
	for (const v of Object.values(boosts)) total += v;
	return total;
}

function hasAntiBoostMove(p: PokemonSwitchRequestData): boolean {
	for (const m of p.moves) if (ANTI_BOOST_MOVES.has(toID(m))) return true;
	return false;
}

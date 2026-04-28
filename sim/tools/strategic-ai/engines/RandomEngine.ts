/**
 * Strategic-AI random engine (difficulty 1).
 *
 * Full replacement for the old `RandomPlayerAI`. The engine handles
 * every protocol scenario the simulator can throw at it (move requests
 * with multi-target slots, force switches with reviving / commanding
 * mons, team preview, mega / Z / dynamax / tera / ultra burst), so
 * downstream consumers (`PlayerAI` at difficulty 1, the dev
 * runners under `sim/tools/runner.ts`, `exhaustive-runner.ts`) can rely
 * on it as their sole source of "play randomly".
 *
 * The class exposes `protected` extension hooks (`pickMoveOption`,
 * `pickSwitchSlot`, `pickTeamSlot`) so specialised runners can subclass
 * and steer the random walker (e.g. the exhaustive coordinator that
 * tries to cover every species/move/item once).
 *
 * @license MIT
 */
import type {
	ChoiceRequest,
	MoveRequest,
	PokemonSwitchRequestData,
	SwitchRequest,
	TeamPreviewRequest,
} from "../../../side";
import type { Engine, EngineContext } from "./Engine";

/** A move candidate emitted by the engine for selection. */
export interface RandomMoveOption {
	/** 1-indexed move slot in the showdown command. */
	slot: number;
	/** Raw move name as the simulator labelled it (Z-move name etc.). */
	move: string;
	/** Showdown move target hint, may be undefined. */
	target?: string;
	/** Whether this candidate represents a Z-move. */
	zMove: boolean;
	/** Pre-built showdown command string for this candidate. */
	choice: string;
}

/** A switch candidate for force-switch / pivot decisions. */
export interface RandomSwitchOption {
	/** 1-indexed bench slot. */
	slot: number;
	/** Raw request entry for the bench mon. */
	pokemon: PokemonSwitchRequestData;
}

/** Inclusive integer range helper. */
function range(start: number, end: number): number[] {
	const out: number[] = [];
	for (let i = start; i <= end; i++) out.push(i);
	return out;
}

/**
 * Default random engine. Stateless across calls; everything mutable
 * lives on {@link EngineContext}.
 */
export class RandomEngine implements Engine {
	readonly id: string = "random";

	choose(request: ChoiceRequest, ctx: EngineContext): string {
		if (request.wait) return "";
		if (request.teamPreview) return this.team(request, ctx);
		if (request.forceSwitch) return this.forceSwitch(request, ctx);
		return this.move(request, ctx);
	}

	// -----------------------------------------------------------------
	// Team preview
	// -----------------------------------------------------------------

	protected team(request: TeamPreviewRequest, ctx: EngineContext): string {
		const team = request.side.pokemon;
		const order: number[] = [];
		const used = new Set<number>();
		const target = request.maxChosenTeamSize ?? team.length;
		while (order.length < target && used.size < team.length) {
			const slot = this.pickTeamSlot(
				team.map((p, i) => ({ slot: i + 1, pokemon: p })).filter(t => !used.has(t.slot)),
				ctx
			);
			if (!slot) break;
			used.add(slot);
			order.push(slot);
		}
		if (!order.length) return "default";
		return `team ${order.join(",")}`;
	}

	// -----------------------------------------------------------------
	// Force switch
	// -----------------------------------------------------------------

	protected forceSwitch(request: SwitchRequest, ctx: EngineContext): string {
		const side = request.side;
		const pokemon = side.pokemon;
		const mustSwitchFlags = request.forceSwitch || [];
		const chosenSlots: number[] = [];
		const commands = mustSwitchFlags.map((mustSwitch, slotIndex) => {
			if (!mustSwitch) return "pass";
			const validSwitches = range(1, pokemon.length).filter(benchSlot => {
				const benchPoke = pokemon[benchSlot - 1];
				if (!benchPoke) return false;
				// Active mons are not necessarily the first N entries of
				// `request.side.pokemon`; rely on the request's own
				// `active` flag rather than list position.
				if (benchPoke.active) return false;
				if (chosenSlots.includes(benchSlot)) return false;
				const fainted = benchPoke.condition.endsWith(" fnt");
				if (fainted && !benchPoke.reviving) return false;
				return true;
			});
			if (!validSwitches.length) return "pass";
			const chosen = this.pickSwitchSlot(
				validSwitches.map(slot => ({ slot, pokemon: pokemon[slot - 1] })),
				ctx
			);
			chosenSlots.push(chosen);
			return `switch ${chosen}`;
		});
		return commands.join(", ");
	}

	// -----------------------------------------------------------------
	// Move requests
	// -----------------------------------------------------------------

	protected move(request: MoveRequest, ctx: EngineContext): string {
		const side = request.side;
		const myPokemon = side.pokemon;
		const chosenSlots: number[] = [];
		const activeSlots = request.active || [];
		const moveProb = ctx.randomMoveProb ?? 1.0;
		const megaProb = ctx.randomMegaProb ?? 0;

		// Showdown only accepts one Mega / Ultra Burst / Dynamax / Tera
		// per battle, but the request's `canX` flags are repeated across
		// every active slot. Track which ones have been claimed so we
		// don't emit two transform commands in the same turn.
		const transformsUsed = {
			mega: false,
			ultra: false,
			dynamax: false,
			tera: false,
		};
		const commands = activeSlots.map((active, i) => {
			const me = myPokemon[i];
			if (!me) return "pass";
			if (me.condition.endsWith(" fnt") || me.commanding) return "pass";

			const canMegaEvo = !!active.canMegaEvo && !transformsUsed.mega;
			const canUltraBurst = !!active.canUltraBurst && !transformsUsed.ultra;
			let canZMove = !!active.canZMove;
			const canDynamax = !!active.canDynamax && !transformsUsed.dynamax;
			const canTerastallize = !!active.canTerastallize && !transformsUsed.tera;

			const doTransform =
				(canMegaEvo || canUltraBurst || canDynamax || canTerastallize) &&
				ctx.prng.random() < megaProb;

			const usingMaxMoves =
				(!active.canDynamax && !!active.maxMoves) ||
				(doTransform && canDynamax);
			const rawMoves = usingMaxMoves && active.maxMoves ?
				active.maxMoves.maxMoves :
				active.moves;

			const moveObjs: RandomMoveOption[] = range(1, rawMoves.length)
				.filter(idx => !rawMoves[idx - 1].disabled)
				.map(idx => {
					const rm = rawMoves[idx - 1];
					return {
						slot: idx,
						move: rm.move,
						target: rm.target,
						zMove: false,
						choice: "",
					};
				});

			if (canZMove && active.canZMove) {
				for (let z = 0; z < active.canZMove.length; z++) {
					const zInfo = active.canZMove[z];
					if (zInfo) {
						moveObjs.push({
							slot: z + 1,
							move: zInfo.move,
							target: zInfo.target,
							zMove: true,
							choice: "",
						});
					}
				}
			}

			const hasAlly =
				myPokemon.length > 1 &&
				!myPokemon[i ^ 1]?.condition.endsWith(" fnt");
			const finalMoves = moveObjs.filter(
				m => m.target !== "adjacentAlly" || hasAlly
			);

			const validSwitchSlots = range(1, 6).filter(benchSlot => {
				const benchPoke = myPokemon[benchSlot - 1];
				if (!benchPoke) return false;
				if (benchPoke.active) return false;
				if (chosenSlots.includes(benchSlot)) return false;
				if (benchPoke.condition.endsWith(" fnt")) return false;
				return true;
			});
			const canSwitch = active.trapped ? [] : validSwitchSlots;

			if (
				canSwitch.length &&
				(!finalMoves.length || ctx.prng.random() > moveProb)
			) {
				const chosen = this.pickSwitchSlot(
					canSwitch.map(slot => ({ slot, pokemon: myPokemon[slot - 1] })),
					ctx
				);
				chosenSlots.push(chosen);
				return `switch ${chosen}`;
			}

			if (!finalMoves.length) return "pass";

			for (const opt of finalMoves) {
				let choiceStr = `move ${opt.slot}`;
				if (request.active && request.active.length > 1) {
					if (["normal", "any", "adjacentFoe"].includes(opt.target ?? "")) {
						choiceStr += ` ${1 + Math.floor(ctx.prng.random() * 2)}`;
					}
					if (opt.target === "adjacentAlly") {
						choiceStr += ` -${(i ^ 1) + 1}`;
					} else if (opt.target === "adjacentAllyOrSelf") {
						if (hasAlly) {
							choiceStr += ` -${1 + Math.floor(ctx.prng.random() * 2)}`;
						} else {
							choiceStr += ` -${i + 1}`;
						}
					}
				}
				if (opt.zMove) choiceStr += " zmove";
				opt.choice = choiceStr;
			}

			const chosenMove = this.pickMoveOption(finalMoves, ctx);
			if (chosenMove.endsWith(" zmove")) {
				canZMove = false;
				return chosenMove;
			}
			if (doTransform) {
				if (canTerastallize) {
					transformsUsed.tera = true;
					return `${chosenMove} terastallize`;
				} else if (canDynamax) {
					transformsUsed.dynamax = true;
					return `${chosenMove} dynamax`;
				} else if (canMegaEvo) {
					transformsUsed.mega = true;
					return `${chosenMove} mega`;
				} else if (canUltraBurst) {
					transformsUsed.ultra = true;
					return `${chosenMove} ultra`;
				}
			}
			return chosenMove;
		});

		return commands.join(", ");
	}

	// -----------------------------------------------------------------
	// Extension hooks. Override these to bias decisions while reusing
	// the generic move/switch enumeration above.
	// -----------------------------------------------------------------

	/** Pick one of the candidate move choices. Returns `option.choice`. */
	protected pickMoveOption(options: RandomMoveOption[], ctx: EngineContext): string {
		return ctx.prng.sample(options).choice;
	}

	/** Pick a bench slot from `options`. Returns the slot number. */
	protected pickSwitchSlot(options: RandomSwitchOption[], ctx: EngineContext): number {
		return ctx.prng.sample(options).slot;
	}

	/** Pick a team-preview slot. Returns 0 to abort the loop. */
	protected pickTeamSlot(
		options: { slot: number, pokemon: PokemonSwitchRequestData }[],
		ctx: EngineContext
	): number {
		if (!options.length) return 0;
		return ctx.prng.sample(options).slot;
	}
}

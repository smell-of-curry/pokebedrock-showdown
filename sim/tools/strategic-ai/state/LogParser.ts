/**
 * Showdown protocol log parser.
 *
 * Showdown's `BattleStream` ships a newline+pipe-delimited text protocol
 * (see `sim/SIM-PROTOCOL.md`). The base `BattlePlayer` only dispatches
 * `|request|` / `|error|` lines and silently appends everything else to
 * `this.log`. The strategic AI needs vastly more than just the request
 * JSON to play well, so this parser pulls the meaningful events out of
 * those discarded lines.
 *
 * The parser is intentionally permissive: unknown line kinds are
 * returned as `null` so we don't crash on protocol changes. Each event
 * the AI cares about is normalised into a small, plain-data object so
 * downstream consumers (the state tracker) don't have to know the wire
 * format.
 *
 * @license MIT
 */
/** Side identifier used by Showdown protocol (`p1`, `p2`, `p3`, `p4`). */
export type SideId = "p1" | "p2" | "p3" | "p4";

/**
 * Active-field position. Showdown encodes positions as letters
 * appended to the side id: `p1a`, `p1b`, `p1c`. We represent them
 * as 0-indexed integers because every other module here uses indices.
 */
export type ActivePosition = 0 | 1 | 2;

/**
 * A `POKEMON` reference parsed from a protocol line, e.g. `p1a: Pikachu`.
 */
export interface PokemonRef {
	side: SideId;
	/** Active slot on that side, 0-indexed. May be -1 for benched/team mons. */
	position: number;
	/** Nickname (or species name when unnamed). */
	name: string;
}

/**
 * Discriminated union of every protocol event the strategic AI cares
 * about. Anything not in this list is returned as `null` from
 * {@link parseLine}.
 */
export type BattleEvent =
	| { kind: "turn", turn: number } |
	{ kind: "gametype", gametype: string } |
	{ kind: "gen", gen: number } |
	{ kind: "tier", tier: string } |
	{ kind: "rule", rule: string } |
	{ kind: "teamsize", side: SideId, size: number } |
	{ kind: "battlestart" } |
	{ kind: "win", side?: SideId, name?: string } |
	{ kind: "tie" } |
	{ kind: "move", user: PokemonRef, move: string, target?: PokemonRef, missed: boolean, from?: string } |
	{ kind: "switch", pokemon: PokemonRef, details: string, hp: string, status: string, forced: boolean } |
	{ kind: "drag", pokemon: PokemonRef, details: string, hp: string, status: string } |
	{ kind: "detailschange", pokemon: PokemonRef, details: string } |
	{ kind: "formechange", pokemon: PokemonRef, species: string } |
	{ kind: "faint", pokemon: PokemonRef } |
	{ kind: "cant", pokemon: PokemonRef, reason: string, move?: string } |
	{ kind: "damage", pokemon: PokemonRef, hp: string, status: string, from?: string } |
	{ kind: "heal", pokemon: PokemonRef, hp: string, status: string, from?: string } |
	{ kind: "sethp", pokemon: PokemonRef, hp: string } |
	{ kind: "status", pokemon: PokemonRef, status: string } |
	{ kind: "curestatus", pokemon: PokemonRef, status: string } |
	{ kind: "boost", pokemon: PokemonRef, stat: string, amount: number } |
	{ kind: "unboost", pokemon: PokemonRef, stat: string, amount: number } |
	{ kind: "setboost", pokemon: PokemonRef, stat: string, amount: number } |
	{ kind: "clearboost", pokemon: PokemonRef } |
	{ kind: "clearallboost" } |
	{ kind: "clearpositiveboost", target: PokemonRef } |
	{ kind: "clearnegativeboost", pokemon: PokemonRef } |
	{ kind: "invertboost", pokemon: PokemonRef } |
	{ kind: "weather", weather: string, upkeep: boolean, from?: string } |
	{ kind: "fieldstart", condition: string, from?: string } |
	{ kind: "fieldend", condition: string } |
	{ kind: "sidestart", side: SideId, condition: string } |
	{ kind: "sideend", side: SideId, condition: string } |
	{ kind: "swapsideconditions" } |
	{ kind: "ability", pokemon: PokemonRef, ability: string, from?: string } |
	{ kind: "endability", pokemon: PokemonRef } |
	{ kind: "item", pokemon: PokemonRef, item: string, from?: string } |
	{ kind: "enditem", pokemon: PokemonRef, item: string, from?: string, eat: boolean } |
	{ kind: "transform", pokemon: PokemonRef, species: string } |
	{ kind: "mega", pokemon: PokemonRef, megastone: string } |
	{ kind: "primal", pokemon: PokemonRef } |
	{ kind: "burst", pokemon: PokemonRef, species: string, item: string } |
	{ kind: "zpower", pokemon: PokemonRef } |
	{ kind: "terastallize", pokemon: PokemonRef, type: string } |
	{ kind: "volatilestart", pokemon: PokemonRef, effect: string, from?: string } |
	{ kind: "volatileend", pokemon: PokemonRef, effect: string } |
	{ kind: "activate", pokemon: PokemonRef, effect: string } |
	{ kind: "crit", pokemon: PokemonRef } |
	{ kind: "supereffective", pokemon: PokemonRef } |
	{ kind: "resisted", pokemon: PokemonRef } |
	{ kind: "immune", pokemon: PokemonRef, from?: string } |
	{ kind: "miss", source?: PokemonRef, target?: PokemonRef } |
	{ kind: "fail", pokemon: PokemonRef, action?: string };

/**
 * Type-guard for {@link SideId}. Used by the parser before casting any
 * raw protocol payload into a side id, so the rest of the strategic-AI
 * pipeline can rely on the type without duplicating the check.
 */
export function isSideId(value: string): value is SideId {
	return value === "p1" || value === "p2" || value === "p3" || value === "p4";
}

/**
 * Convert a `POKEMON` reference like `p1a: Pikachu` (or `p1: Pikachu` for
 * team-preview / benched references) into a {@link PokemonRef}. Returns
 * `null` if the string doesn't match the expected format.
 */
export function parsePokemonRef(raw: string | undefined): PokemonRef | null {
	if (!raw) return null;
	const colonIdx = raw.indexOf(":");
	if (colonIdx < 0) return null;
	const ident = raw.slice(0, colonIdx).trim();
	const name = raw.slice(colonIdx + 1).trim();
	const m = /^(p[1-4])([a-c])?$/.exec(ident);
	if (!m) return null;
	const side = m[1] as SideId;
	const position = m[2] ? m[2].charCodeAt(0) - "a".charCodeAt(0) : -1;
	return { side, position, name };
}

/**
 * Pull `[from] EFFECT` (and similar) suffixes out of the trailing
 * positional arguments of a protocol line. Returns the matching value or
 * `undefined` when not present.
 */
function extractKwarg(args: string[], key: string): string | undefined {
	const prefix = `[${key}]`;
	for (const arg of args) {
		if (arg.startsWith(prefix)) {
			return arg.slice(prefix.length).trim();
		}
	}
	return undefined;
}

/**
 * Normalise a Showdown effect descriptor (e.g. `move: Stealth Rock`,
 * `ability: Drizzle`, `item: Leftovers`, `Sandstorm`) to a bare name.
 */
export function stripEffectPrefix(effect: string): string {
	const colon = effect.indexOf(":");
	if (colon < 0) return effect.trim();
	return effect.slice(colon + 1).trim();
}

/**
 * Parse a single Showdown protocol line into a {@link BattleEvent}.
 *
 * Lines must start with `|`. Anything else (including the blank line
 * separator) returns `null`. Likewise unknown `|kind|` headers return
 * `null` rather than throwing, because new mechanics can appear at any
 * time and the AI should tolerate them gracefully.
 */
export function parseLine(line: string): BattleEvent | null {
	if (!line?.startsWith("|")) return null;
	// Showdown lines start with a leading `|`, so split-and-skip the
	// empty first element. We split on every `|` because tail args are
	// always positional or `[key]value`-tagged kwargs.
	const parts = line.slice(1).split("|");
	const kind = parts[0];
	const args = parts.slice(1);
	if (!kind) return null;
	switch (kind) {
		case "turn":
			return { kind: "turn", turn: parseInt(args[0]) || 0 };
		case "gametype":
			return { kind: "gametype", gametype: args[0] || "singles" };
		case "gen": {
			const g = parseInt(args[0]);
			if (Number.isNaN(g)) return null;
			return { kind: "gen", gen: g };
		}
		case "tier":
			return { kind: "tier", tier: args[0] || "" };
		case "rule":
			return { kind: "rule", rule: args[0] || "" };
		case "teamsize": {
			const side = args[0] as SideId;
			const size = parseInt(args[1]) || 0;
			if (!side) return null;
			return { kind: "teamsize", side, size };
		}
		case "start":
			return { kind: "battlestart" };
		case "win": {
			// Real Showdown logs use `|win|<player name>` (e.g. `|win|Bot 1`),
			// but tools and replay fixtures sometimes pre-normalise to a
			// raw side id. Accept both: keep `side` populated when we can
			// detect it, expose the raw payload as `name` otherwise.
			const arg = (args[0] || "").trim();
			const side = /^p[1-4]$/.test(arg) ? (arg as SideId) : undefined;
			return { kind: "win", side, name: arg || undefined };
		}
		case "tie":
			return { kind: "tie" };
		case "move": {
			const user = parsePokemonRef(args[0]);
			if (!user) return null;
			const target = parsePokemonRef(args[2]);
			const missed = args.includes("[miss]");
			const from = extractKwarg(args, "from");
			return { kind: "move", user, move: args[1] || "", target: target ?? undefined, missed, from };
		}
		case "switch":
		case "drag": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			const [hp, ...statusParts] = (args[2] || "").split(" ");
			const status = statusParts.join(" ").trim();
			if (kind === "drag") {
				return { kind: "drag", pokemon: ref, details: args[1] || "", hp, status };
			}
			return {
				kind: "switch",
				pokemon: ref,
				details: args[1] || "",
				hp,
				status,
				forced: false,
			};
		}
		case "detailschange": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "detailschange", pokemon: ref, details: args[1] || "" };
		}
		case "-formechange": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "formechange", pokemon: ref, species: args[1] || "" };
		}
		case "faint": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "faint", pokemon: ref };
		}
		case "cant": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "cant", pokemon: ref, reason: args[1] || "", move: args[2] };
		}
		case "-damage": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			const [hp, ...statusParts] = (args[1] || "").split(" ");
			return {
				kind: "damage",
				pokemon: ref,
				hp,
				status: statusParts.join(" ").trim(),
				from: extractKwarg(args, "from"),
			};
		}
		case "-heal": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			// `|-heal|POKEMON|DETAILS|HP STATUS` (Pokebedrock variant) and
			// upstream `|-heal|POKEMON|HP STATUS`. Detect by whether the
			// second arg looks like an HP fraction.
			const rawHp = args.length >= 3 && /\d/.test(args[2] || "") ? args[2] : args[1];
			const [hp, ...statusParts] = (rawHp || "").split(" ");
			return {
				kind: "heal",
				pokemon: ref,
				hp,
				status: statusParts.join(" ").trim(),
				from: extractKwarg(args, "from"),
			};
		}
		case "-sethp": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "sethp", pokemon: ref, hp: args[1] || "" };
		}
		case "-status": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "status", pokemon: ref, status: args[1] || "" };
		}
		case "-curestatus": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "curestatus", pokemon: ref, status: args[1] || "" };
		}
		case "-boost":
		case "-unboost":
		case "-setboost": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			const stat = args[1] || "";
			const amount = parseInt(args[2]) || 0;
			if (kind === "-boost") return { kind: "boost", pokemon: ref, stat, amount };
			if (kind === "-unboost") return { kind: "unboost", pokemon: ref, stat, amount };
			return { kind: "setboost", pokemon: ref, stat, amount };
		}
		case "-clearboost": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "clearboost", pokemon: ref };
		}
		case "-clearallboost":
			return { kind: "clearallboost" };
		case "-clearpositiveboost": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "clearpositiveboost", target: ref };
		}
		case "-clearnegativeboost": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "clearnegativeboost", pokemon: ref };
		}
		case "-invertboost": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "invertboost", pokemon: ref };
		}
		case "-weather":
			return {
				kind: "weather",
				weather: args[0] || "none",
				upkeep: args.includes("[upkeep]"),
				from: extractKwarg(args, "from"),
			};
		case "-fieldstart":
			return {
				kind: "fieldstart",
				condition: stripEffectPrefix(args[0] || ""),
				from: extractKwarg(args, "from"),
			};
		case "-fieldend":
			return { kind: "fieldend", condition: stripEffectPrefix(args[0] || "") };
		case "-sidestart": {
			const sideRaw = (args[0] || "").split(":")[0].trim();
			if (!isSideId(sideRaw)) return null;
			return {
				kind: "sidestart",
				side: sideRaw,
				condition: stripEffectPrefix(args[1] || ""),
			};
		}
		case "-sideend": {
			const sideRaw = (args[0] || "").split(":")[0].trim();
			if (!isSideId(sideRaw)) return null;
			return {
				kind: "sideend",
				side: sideRaw,
				condition: stripEffectPrefix(args[1] || ""),
			};
		}
		case "-swapsideconditions":
			return { kind: "swapsideconditions" };
		case "-ability": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "ability", pokemon: ref, ability: args[1] || "", from: extractKwarg(args, "from") };
		}
		case "-endability": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "endability", pokemon: ref };
		}
		case "-item": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "item", pokemon: ref, item: args[1] || "", from: extractKwarg(args, "from") };
		}
		case "-enditem": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return {
				kind: "enditem",
				pokemon: ref,
				item: args[1] || "",
				from: extractKwarg(args, "from"),
				eat: args.includes("[eat]"),
			};
		}
		case "-transform": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "transform", pokemon: ref, species: args[1] || "" };
		}
		case "-mega": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "mega", pokemon: ref, megastone: args[1] || "" };
		}
		case "-primal": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "primal", pokemon: ref };
		}
		case "-burst": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "burst", pokemon: ref, species: args[1] || "", item: args[2] || "" };
		}
		case "-zpower": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "zpower", pokemon: ref };
		}
		case "-terastallize": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "terastallize", pokemon: ref, type: args[1] || "" };
		}
		case "-start": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return {
				kind: "volatilestart",
				pokemon: ref,
				effect: stripEffectPrefix(args[1] || ""),
				from: extractKwarg(args, "from"),
			};
		}
		case "-end": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "volatileend", pokemon: ref, effect: stripEffectPrefix(args[1] || "") };
		}
		case "-activate": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "activate", pokemon: ref, effect: stripEffectPrefix(args[1] || "") };
		}
		case "-crit": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "crit", pokemon: ref };
		}
		case "-supereffective": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "supereffective", pokemon: ref };
		}
		case "-resisted": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "resisted", pokemon: ref };
		}
		case "-immune": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "immune", pokemon: ref, from: extractKwarg(args, "from") };
		}
		case "-miss":
			return {
				kind: "miss",
				source: parsePokemonRef(args[0]) ?? undefined,
				target: parsePokemonRef(args[1]) ?? undefined,
			};
		case "-fail": {
			const ref = parsePokemonRef(args[0]);
			if (!ref) return null;
			return { kind: "fail", pokemon: ref, action: args[1] };
		}
		default:
			return null;
	}
}

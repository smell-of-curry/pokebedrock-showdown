/**
 * AI-vs-AI self-play winrate harness.
 *
 * Pits two `PlayerAI` configurations against each other over many
 * battles and reports winrates, so strategic-ai changes can be
 * validated empirically ("does difficulty 4 actually beat difficulty 2
 * more than 50% of the time?") instead of by eyeball.
 *
 * Sides are swapped every game to cancel any p1/p2 bias, and each game
 * gets a fresh deterministic seed derived from the run seed so results
 * are reproducible (independent of how many worker threads ran them).
 *
 * Games are distributed across a `worker_threads` pool (default: all
 * cores minus one) since each battle is independent, synchronous CPU
 * work — a single-threaded series leaves the rest of the machine idle.
 *
 * Usage (after `node build`):
 *
 *     node dist/sim/tools/selfplay.js --a 5 --b 3 --games 100
 *     node dist/sim/tools/selfplay.js --a 4 --b 4 --format gen9randombattle
 *     node dist/sim/tools/selfplay.js --a 3 --b 1 --games 50 --seed 1234 --jobs 4
 *
 * @license MIT
 */

import * as fs from "fs";
import * as os from "os";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

import { type ObjectReadWriteStream } from "../../lib/streams";
import * as BattleStreams from "../battle-stream";
import { PRNG, type PRNGSeed } from "../prng";
import type { ChoiceRequest } from "../side";
import { Teams } from "../teams";
import {
	DEFAULT_SPRT,
	Sprt,
	scoreInterval,
	type ScoreInterval,
	type SprtConfig,
	type SprtVerdict,
} from "./ai-stats";
import { PlayerAI, type PlayerAIOptions } from "./player-ai";
import { ENGINE_NAMES, type EngineName } from "./strategic-ai/policy/DifficultyPolicy";
import {
	DecisionStats,
	decisionRates,
	emptyCounters,
	type DecisionCounters,
} from "./strategic-ai/telemetry/DecisionStats";

/** One contender's configuration. */
export interface ContenderConfig {
	/** Label used in reporting (defaults to `d<difficulty>`). */
	name?: string;
	/** Difficulty 0..5 passed through to {@link PlayerAI}. */
	difficulty: number;
	/** Optional search budget override (ms) for OnePly/MCTS tiers. */
	searchBudgetMs?: number;
	/**
	 * Force a specific engine instead of the one the difficulty ladder
	 * would pick.
	 *
	 * The point of this is an *absolute* yardstick. A tier-vs-tier score
	 * only says whether d4 still beats d3; it says nothing about whether
	 * either got stronger, so retuning both at once can look like "no
	 * change" while the whole ladder sinks. Pinning one side to
	 * `random` — which has no knobs and so cannot drift — gives a fixed
	 * reference every tier can be scored against across revisions.
	 */
	engine?: EngineName;
}

/** Options for {@link runSelfPlay}. */
export interface SelfPlayOptions {
	a: ContenderConfig;
	b: ContenderConfig;
	/** Number of games to play. Defaults to 50. */
	games?: number;
	/** Format id. Defaults to `gen9randombattle`. */
	format?: string;
	/** Run seed for reproducibility. */
	seed?: PRNGSeed | null;
	/** Hard cap on turns before the game is scored a tie. Defaults to 500. */
	maxTurns?: number;
	/**
	 * Wall-clock cap per game in ms. A stalled game (e.g. a rejected
	 * choice nobody retries) is force-tied after this long, and scored
	 * as an errored tie if even the force-tie doesn't land. Without it
	 * a single deadlocked battle drains the event loop and node exits
	 * mid-series with code 0 and no summary. Defaults to 60000.
	 */
	gameTimeoutMs?: number;
	/**
	 * Worker threads to spread games across. Defaults to all cores
	 * minus one. `1` runs everything inline on the main thread.
	 */
	jobs?: number;
	/** Log each game's result line to stdout. */
	verbose?: boolean;
	/**
	 * Play games in mirrored pairs: the same two generated teams are
	 * played twice with the contenders swapped between them. Both
	 * contenders therefore pilot both teams, which removes team-quality
	 * luck — by far the largest variance source in random-battle
	 * formats — from the comparison.
	 */
	mirror?: boolean;
	/**
	 * Run the series as a sequential test and stop as soon as the
	 * evidence clears a bound. `games` becomes the maximum, not the
	 * target.
	 */
	sprt?: SprtConfig;
	/** Collect per-decision telemetry (costs a damage calc per move). */
	telemetry?: boolean;
}

/** Aggregated results returned by {@link runSelfPlay}. */
export interface SelfPlayResult {
	games: number;
	winsA: number;
	winsB: number;
	ties: number;
	/** Wins for A as a fraction of decisive games. */
	winrateA: number;
	avgTurns: number;
	errors: number;
	/**
	 * A's score and Elo with a 95% confidence interval, counting ties
	 * as half a point. This — not {@link winrateA} — is the number to
	 * quote: it says how big the measured edge is *and* how sure we are.
	 */
	interval: ScoreInterval;
	/** SPRT verdict, when `options.sprt` was set. */
	sprt?: { verdict: SprtVerdict, llr: number, config: SprtConfig };
	/** Per-decision counters per contender, when `options.telemetry` was set. */
	telemetry?: { a: DecisionCounters, b: DecisionCounters };
}

/**
 * `PlayerAI` subclass that retries after a rejected choice instead of
 * stalling the stream. The production host (PokeBedrock) replays via
 * its interpreter's error handling; standalone streams have nobody to
 * do that, so without this a single `[Invalid choice]` deadlocks the
 * game.
 */
class SelfPlayAI extends PlayerAI {
	private lastSeenRequest: ChoiceRequest | null = null;
	private retriesForRequest = 0;
	private static readonly MAX_RETRIES = 5;

	override receiveRequest(request: ChoiceRequest): string {
		this.lastSeenRequest = request;
		this.retriesForRequest = 0;
		return super.receiveRequest(request);
	}

	override receiveError(error: Error): void {
		super.receiveError(error);
		// `[Unavailable choice]` is followed by an updated request from
		// the sim, so only self-retry the truly terminal rejections.
		if (error.message.startsWith("[Unavailable choice]")) return;
		const request = this.lastSeenRequest;
		if (!request || this.retriesForRequest >= SelfPlayAI.MAX_RETRIES) return;
		this.retriesForRequest++;
		const choice = super.receiveRequest(request);
		if (choice) this.choose(choice);
	}
}

/** Per-game outcome. */
interface GameResult {
	/** `"a"`, `"b"`, or `null` for a tie/aborted game. */
	winner: "a" | "b" | null;
	turns: number;
	errored: boolean;
	/** First stream error message, when `errored` is set. */
	errorMessage?: string;
	/** Per-contender decision counters, when telemetry was enabled. */
	counters?: { a: DecisionCounters, b: DecisionCounters };
}

/** Everything a worker needs to play one game. Structured-cloneable. */
interface WorkerTask {
	index: number;
	format: string;
	aIsP1: boolean;
	a: ContenderConfig;
	b: ContenderConfig;
	/** Per-game seed; AI seeds, battle seed, and retries derive from it. */
	gameSeed: PRNGSeed;
	maxTurns: number;
	gameTimeoutMs: number;
	/**
	 * Packed teams for p1/p2. Always set by {@link runSelfPlay}: leaving
	 * the team out makes the simulator generate one from a fresh crypto
	 * seed, which silently defeats `--seed` reproducibility. Generating
	 * teams up front also lets mirrored pairs reuse the same two teams.
	 */
	teams: { p1: string, p2: string };
	telemetry: boolean;
}

/**
 * Play a single battle between the two contenders.
 *
 * @param format Format id to run.
 * @param aIsP1 Whether contender A plays as p1 this game.
 * @param a Contender A's config.
 * @param b Contender B's config.
 * @param prng Run-level PRNG used to derive per-game seeds.
 * @param maxTurns Turn cap before forcing a tie.
 * @param gameTimeoutMs Wall-clock cap before the game is force-tied.
 * @param teams Packed teams for p1 and p2.
 * @param telemetry Whether to collect per-decision counters.
 * @returns The winner (by contender), turn count, and error flag.
 */
async function playGame(
	format: string,
	aIsP1: boolean,
	a: ContenderConfig,
	b: ContenderConfig,
	prng: PRNG,
	maxTurns: number,
	gameTimeoutMs: number,
	teams: { p1: string, p2: string },
	telemetry: boolean
): Promise<GameResult> {
	const battleStream = new BattleStreams.BattleStream();
	const streams = BattleStreams.getPlayerStreams(battleStream);
	// Expose the live battle on the player sub-streams the way the
	// production host does (it hands `PlayerAI` the raw battle stream),
	// so the MCTS tier's fork rollouts are exercised in self-play too.
	for (const sub of [streams.p1, streams.p2]) {
		Object.defineProperty(sub, "battle", { get: () => battleStream.battle });
	}

	const newSeed = (): PRNGSeed => [
		prng.random(2 ** 16), prng.random(2 ** 16),
		prng.random(2 ** 16), prng.random(2 ** 16),
	].join(",") as PRNGSeed;

	const statsA = telemetry ? new DecisionStats() : undefined;
	const statsB = telemetry ? new DecisionStats() : undefined;
	const makeAI = (
		stream: ObjectReadWriteStream<string>,
		config: ContenderConfig,
		stats: DecisionStats | undefined
	) => new SelfPlayAI(stream, {
		difficulty: config.difficulty,
		searchBudgetMs: config.searchBudgetMs,
		engine: config.engine,
		seed: newSeed(),
		stats,
	} satisfies PlayerAIOptions);

	const p1 = makeAI(streams.p1, aIsP1 ? a : b, aIsP1 ? statsA : statsB);
	const p2 = makeAI(streams.p2, aIsP1 ? b : a, aIsP1 ? statsB : statsA);
	// A crashed AI loop is the only signal that a game is unwinnable; surface
	// it immediately instead of waiting for the force-tie/hang timers. A
	// *successful* `start()` resolves at battle end (possibly before `consume`
	// reads `|win|`), so success maps to a never-settling promise and can't
	// win the race — only a rejection produces a value.
	const onlyOnFailure = (p: Promise<void>, side: string) =>
		p.then(() => new Promise<never>(() => {}), (err: Error) => ({ side, err }));
	const aiFailure = Promise.race([
		onlyOnFailure(p1.start(), "p1"),
		onlyOnFailure(p2.start(), "p2"),
	]);

	const p1Name = aIsP1 ? "Contender A" : "Contender B";
	const p2Name = aIsP1 ? "Contender B" : "Contender A";
	void streams.omniscient.write(
		`>start ${JSON.stringify({ formatid: format, seed: newSeed() })}\n` +
		`>player p1 ${JSON.stringify({ name: p1Name, team: teams.p1 })}\n` +
		`>player p2 ${JSON.stringify({ name: p2Name, team: teams.p2 })}`
	);

	let turns = 0;
	let winnerName: string | null = null;
	let tie = false;
	let errored = false;
	let errorMessage: string | undefined;

	// Stage 1: a stalled battle (rejected choice nobody retried) sits
	// idle waiting for input — force-tie it so the stream still emits a
	// result. Stage 2: if even that produces nothing, abandon the game
	// entirely. Both timers also keep the event loop alive: without
	// them a deadlocked game makes node exit 0 mid-series.
	const forceTieTimer = setTimeout(() => {
		try {
			void streams.omniscient.write(">forcetie");
		} catch {}
	}, gameTimeoutMs);
	let hangTimer: NodeJS.Timeout | undefined;
	const hung = new Promise<"hung">(resolve => {
		hangTimer = setTimeout(() => resolve("hung"), gameTimeoutMs + 5000);
	});

	const consume = async (): Promise<void> => {
		for await (const chunk of streams.omniscient) {
			for (const line of chunk.split("\n")) {
				if (line.startsWith("|turn|")) {
					turns = parseInt(line.slice("|turn|".length)) || turns;
					if (turns >= maxTurns) void streams.omniscient.write(">forcetie");
				} else if (line.startsWith("|win|")) {
					winnerName = line.slice("|win|".length).trim();
				} else if (line === "|tie") {
					tie = true;
				}
			}
			if (winnerName || tie) break;
		}
	};

	try {
		const raced = await Promise.race([consume(), hung, aiFailure]);
		if (raced === "hung") {
			errored = true;
			errorMessage = `game hung after ${gameTimeoutMs}ms (force-tie ignored)`;
		} else if (raced && typeof raced === "object") {
			errored = true;
			errorMessage = `${raced.side} AI failed: ${raced.err.message}`;
		}
	} catch (err) {
		errored = true;
		errorMessage = (err as Error).message;
	} finally {
		clearTimeout(forceTieTimer);
		if (hangTimer) clearTimeout(hangTimer);
	}
	try {
		void streams.omniscient.writeEnd();
	} catch {}

	const counters = statsA && statsB ?
		{ a: statsA.snapshot(), b: statsB.snapshot() } :
		undefined;
	if (!winnerName) return { winner: null, turns, errored, errorMessage, counters };
	const winner = winnerName === "Contender A" ? "a" : winnerName === "Contender B" ? "b" : null;
	return { winner, turns, errored, errorMessage, counters };
}

/**
 * Play one game with retries for games that die before turn 1 (e.g.
 * the random team generator rolled a custom species with incomplete
 * dex data) — those measure nothing about the AIs, so re-roll them
 * with the next seed derived from the same game PRNG.
 *
 * @param task The game's task description (configs, seed, caps).
 * @returns The final game result after up to 3 re-rolls.
 */
async function playGameWithRetries(task: WorkerTask): Promise<GameResult> {
	const prng = PRNG.get(task.gameSeed);
	const play = () => playGame(
		task.format, task.aIsP1, task.a, task.b, prng,
		task.maxTurns, task.gameTimeoutMs, task.teams, task.telemetry
	);
	let result = await play();
	for (let attempt = 0; result.errored && result.turns === 0 && attempt < 3; attempt++) {
		result = await play();
	}
	return result;
}

/**
 * Run a set of game tasks across a `worker_threads` pool. Each worker
 * plays one game at a time; a crashed worker scores its in-flight game
 * as an errored tie and is respawned.
 *
 * @param tasks The games to play.
 * @param jobs Pool size (number of concurrent worker threads).
 * @param onResult Called once per task as results arrive (any order).
 * @param shouldStop Polled before each task is claimed; returning true
 * drains the pool without starting further games (SPRT early stop).
 */
async function runWithWorkerPool(
	tasks: WorkerTask[],
	jobs: number,
	onResult: (index: number, result: GameResult) => void,
	shouldStop: () => boolean = () => false
): Promise<void> {
	let next = 0;
	const spawn = () => new Worker(__filename, { workerData: { selfPlayWorker: true } });
	const runOne = (worker: Worker, task: WorkerTask) => new Promise<GameResult>((resolve, reject) => {
		const onMessage = (msg: { index: number, result: GameResult }) => {
			cleanup();
			resolve(msg.result);
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		// A worker can die (OOM, process.exit) without ever emitting "error";
		// without this the lane would hang forever instead of erroring the
		// game and respawning the worker.
		const onExit = (code: number) => {
			cleanup();
			reject(new Error(`worker exited before replying (code ${code})`));
		};
		const cleanup = () => {
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("exit", onExit);
		};
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
		worker.postMessage(task);
	});

	const lane = async () => {
		let worker = spawn();
		while (next < tasks.length && !shouldStop()) {
			const task = tasks[next++];
			try {
				onResult(task.index, await runOne(worker, task));
			} catch (err) {
				onResult(task.index, {
					winner: null,
					turns: 0,
					errored: true,
					errorMessage: `worker crashed: ${(err as Error).message}`,
				});
				void worker.terminate();
				worker = spawn();
			}
		}
		await worker.terminate();
	};

	await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, lane));
}

/**
 * Run the full self-play series and aggregate results.
 *
 * @param options Contenders, game count, format, seed, and verbosity.
 * @returns Aggregate winrates and stats for the series.
 */
export async function runSelfPlay(options: SelfPlayOptions): Promise<SelfPlayResult> {
	const maxGames = options.games ?? 50;
	const format = options.format ?? "gen9randombattle";
	const maxTurns = options.maxTurns ?? 500;
	const gameTimeoutMs = options.gameTimeoutMs ?? 60_000;
	const jobs = Math.max(1, options.jobs ?? defaultJobs());
	const telemetry = !!options.telemetry;
	const mirror = !!options.mirror;
	const prng = PRNG.get(options.seed ?? null);
	const newSeed = (): PRNGSeed => [
		prng.random(2 ** 16), prng.random(2 ** 16),
		prng.random(2 ** 16), prng.random(2 ** 16),
	].join(",") as PRNGSeed;

	// Mirrored series play each team pair twice, so the game count has to
	// be even for every pair to complete.
	const games = mirror ? Math.max(2, maxGames - (maxGames % 2)) : maxGames;

	// Pre-derive every game's seed AND team from the run PRNG so results
	// are reproducible regardless of pool size or completion order. The
	// teams matter most: omitting them makes the simulator generate from
	// a fresh crypto seed, which silently voids `--seed`.
	const tasks: WorkerTask[] = [];
	for (let i = 0; i < games; i++) {
		const isSecondLeg = mirror && i % 2 === 1;
		const teams = isSecondLeg ?
			// Second leg of a mirrored pair: same two teams, swapped
			// contenders. `aIsP1` flips below, so A now pilots the team
			// B just played and vice versa.
			tasks[i - 1].teams :
			{ p1: generateTeam(format, newSeed()), p2: generateTeam(format, newSeed()) };
		tasks.push({
			index: i,
			format,
			aIsP1: i % 2 === 0,
			a: options.a,
			b: options.b,
			gameSeed: newSeed(),
			maxTurns,
			gameTimeoutMs,
			teams,
			telemetry,
		});
	}

	let winsA = 0;
	let winsB = 0;
	let ties = 0;
	let errors = 0;
	let totalTurns = 0;
	let completed = 0;
	const counters = { a: emptyCounters(), b: emptyCounters() };
	const sprt = options.sprt ? new Sprt(options.sprt) : null;
	// SPRT observations are fed in task order, not completion order, so
	// the stopping point is identical at any `--jobs`. Out-of-order
	// results wait in `pending` until the contiguous prefix reaches them.
	const pending = new Map<number, GameResult>();
	let nextToScore = 0;
	const scores: number[] = [];
	let stopped = false;

	const scoreOf = (result: GameResult) =>
		result.winner === "a" ? 1 : result.winner === "b" ? 0 : 0.5;

	const drain = () => {
		while (pending.has(nextToScore)) {
			const first = pending.get(nextToScore)!;
			pending.delete(nextToScore);
			// In mirrored mode a pair is one observation (average of both
			// legs), which is what removes the team-luck variance.
			if (!mirror) {
				scores.push(scoreOf(first));
				nextToScore++;
			} else if (pending.has(nextToScore + 1)) {
				const second = pending.get(nextToScore + 1)!;
				pending.delete(nextToScore + 1);
				scores.push((scoreOf(first) + scoreOf(second)) / 2);
				nextToScore += 2;
			} else {
				// Wait for the pair's second leg.
				pending.set(nextToScore, first);
				return;
			}
			if (sprt) {
				sprt.observe(scores[scores.length - 1]);
				if (sprt.verdict() !== "continue") stopped = true;
			}
		}
	};

	const record = (index: number, result: GameResult) => {
		completed++;
		totalTurns += result.turns;
		if (result.errored) errors++;
		if (result.winner === "a") winsA++;
		else if (result.winner === "b") winsB++;
		else ties++;
		if (result.counters) {
			// Contender labels are already normalised inside playGame, so
			// these fold together regardless of which side each played.
			counters.a = mergeCounters(counters.a, result.counters.a);
			counters.b = mergeCounters(counters.b, result.counters.b);
		}
		pending.set(index, result);
		drain();
		if (options.verbose) {
			const tag = result.winner === "a" ? nameOf(options.a, "A") :
				result.winner === "b" ? nameOf(options.b, "B") : "tie";
			const llr = sprt ? `  LLR ${sprt.llr().toFixed(2)}` : "";
			console.log(`[${completed}/${games}] game ${index + 1}: ${tag} in ${result.turns} turns` +
				`${result.errored ? ` (errored: ${result.errorMessage})` : ""}${llr}`);
		}
	};

	if (jobs === 1) {
		for (const task of tasks) {
			if (stopped) break;
			record(task.index, await playGameWithRetries(task));
		}
	} else {
		await runWithWorkerPool(tasks, jobs, record, () => stopped);
	}

	const decisive = winsA + winsB;
	const played = winsA + winsB + ties;
	return {
		games: played,
		winsA,
		winsB,
		ties,
		winrateA: decisive > 0 ? winsA / decisive : 0.5,
		avgTurns: played > 0 ? totalTurns / played : 0,
		errors,
		interval: scoreInterval(scores),
		...(sprt ? { sprt: { verdict: sprt.verdict(), llr: sprt.llr(), config: sprt.config } } : {}),
		...(telemetry ? { telemetry: counters } : {}),
	};
}

/**
 * Generate and pack one team for a format.
 *
 * @param format Format id (must have a random team generator).
 * @param seed Seed for the generator, so the team is reproducible.
 * @returns The packed team string.
 * @throws if the format has no team generator, since a strength series
 * without fixed teams can be neither seeded nor mirrored.
 */
function generateTeam(format: string, seed: PRNGSeed): string {
	try {
		return Teams.pack(Teams.generate(format, { seed }));
	} catch (err) {
		throw new Error(
			`Cannot generate a team for format "${format}": ${(err as Error).message}. ` +
			`The self-play harness needs a format with a random team generator ` +
			`(e.g. gen9randombattle, gen9randomdoublesbattle).`
		);
	}
}

/**
 * Add two counter sets.
 *
 * @param into The accumulated counters.
 * @param from The counters to add.
 * @returns A new summed counter set.
 */
function mergeCounters(into: DecisionCounters, from: DecisionCounters): DecisionCounters {
	const stats = new DecisionStats();
	stats.merge(into);
	stats.merge(from);
	return stats.snapshot();
}

/**
 * Default worker-pool size: all cores minus one, so the machine stays
 * responsive while a series runs.
 *
 * @returns The default number of worker threads.
 */
function defaultJobs(): number {
	const cores: number = (os as { availableParallelism?: () => number }).availableParallelism?.() ??
		os.cpus().length;
	return Math.max(1, cores - 1);
}

/**
 * Display name for a contender.
 *
 * @param config The contender config.
 * @param fallbackTag `"A"` or `"B"`, used when no name is set.
 * @returns The label used in CLI output.
 */
function nameOf(config: ContenderConfig, fallbackTag: string): string {
	return config.name ?? `${fallbackTag}(d${config.difficulty})`;
}

/**
 * Parse `--flag value` style CLI arguments.
 *
 * @param argv Raw argv slice (no node/script entries).
 * @returns Flag-to-value map; bare flags map to `"true"`.
 */
function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			args[key] = next;
			i++;
		} else {
			args[key] = "true";
		}
	}
	return args;
}

// Worker-thread entry: play games sent from the main thread's pool.
if (!isMainThread && (workerData as { selfPlayWorker?: boolean } | null)?.selfPlayWorker) {
	parentPort!.on("message", (task: WorkerTask) => {
		playGameWithRetries(task)
			.then(result => parentPort!.postMessage({ index: task.index, result }))
			.catch((err: Error) => parentPort!.postMessage({
				index: task.index,
				result: {
					winner: null,
					turns: 0,
					errored: true,
					errorMessage: err.message,
				} satisfies GameResult,
			}));
	});
}

if (require.main === module && isMainThread) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(
			`Usage: node dist/sim/tools/selfplay.js [options]\n` +
			`  --a <0..5>        Contender A difficulty (default 3)\n` +
			`  --b <0..5>        Contender B difficulty (default 1)\n` +
			`  --games <n>       Games to play (default 50)\n` +
			`  --format <id>     Format id (default gen9randombattle)\n` +
			`  --seed <n,n,n,n>  Run seed for reproducibility\n` +
			`  --budget-a <ms>   Search budget override for A\n` +
			`  --budget-b <ms>   Search budget override for B\n` +
			`  --engine-a <id>   Force A's engine (${ENGINE_NAMES.join("|")})\n` +
			`  --engine-b <id>   Force B's engine (fixed yardstick: random)\n` +
			`  --max-turns <n>   Turn cap per game (default 500)\n` +
			`  --game-timeout <ms>  Wall-clock cap per game before force-tie (default 60000)\n` +
			`  --jobs <n>        Worker threads (default: cores - 1; 1 = inline)\n` +
			`  --quiet           Suppress per-game lines\n` +
			`  --mirror          Play mirrored pairs (same teams, swapped sides)\n` +
			`  --sprt            Stop early once the result is significant\n` +
			`  --elo0 <n>        SPRT null hypothesis in Elo (default 0)\n` +
			`  --elo1 <n>        SPRT alternative hypothesis in Elo (default 10)\n` +
			`  --alpha <p>       SPRT type-I error rate (default 0.05)\n` +
			`  --beta <p>        SPRT type-II error rate (default 0.05)\n` +
			`  --telemetry       Count immune/status/switch/rejection decisions\n` +
			`  --out <path>      Write the result as JSON\n` +
			`  --baseline <path> Compare against a saved run and exit 1 on regression\n` +
			`  --write-baseline <path>  Save this run as the baseline`
		);
		process.exit(0);
	}
	// Reject NaN / out-of-range numeric flags up front with a clear usage
	// error instead of letting them flow into runSelfPlay() as empty runs,
	// immediate timeouts, or invalid difficulty configs.
	const intArg = (
		raw: string | undefined,
		name: string,
		min: number,
		max = Infinity
	): number | undefined => {
		if (raw === undefined) return undefined;
		const n = Number(raw);
		if (!Number.isInteger(n) || n < min || n > max) {
			const range = max === Infinity ? `>= ${min}` : `${min}..${max}`;
			console.error(`Invalid --${name}: "${raw}" (expected integer ${range})`);
			process.exit(1);
		}
		return n;
	};
	const floatArg = (raw: string | undefined, name: string): number | undefined => {
		if (raw === undefined) return undefined;
		const n = Number(raw);
		if (!Number.isFinite(n)) {
			console.error(`Invalid --${name}: "${raw}" (expected a number)`);
			process.exit(1);
		}
		return n;
	};
	const engineArg = (raw: string | undefined, name: string): EngineName | undefined => {
		if (raw === undefined) return undefined;
		if (!(ENGINE_NAMES as readonly string[]).includes(raw)) {
			console.error(`Invalid --${name}: "${raw}" (expected ${ENGINE_NAMES.join("|")})`);
			process.exit(1);
		}
		return raw as EngineName;
	};
	const format = args.format ?? "gen9randombattle";
	const options: SelfPlayOptions = {
		a: {
			difficulty: intArg(args.a, "a", 0, 5) ?? 3,
			searchBudgetMs: intArg(args["budget-a"], "budget-a", 0),
			engine: engineArg(args["engine-a"], "engine-a"),
		},
		b: {
			difficulty: intArg(args.b, "b", 0, 5) ?? 1,
			searchBudgetMs: intArg(args["budget-b"], "budget-b", 0),
			engine: engineArg(args["engine-b"], "engine-b"),
		},
		games: intArg(args.games, "games", 1),
		format,
		seed: (args.seed as PRNGSeed | undefined) ?? null,
		maxTurns: intArg(args["max-turns"], "max-turns", 1),
		gameTimeoutMs: intArg(args["game-timeout"], "game-timeout", 0),
		jobs: intArg(args.jobs, "jobs", 1),
		verbose: !args.quiet,
		mirror: !!args.mirror,
		telemetry: !!args.telemetry,
		sprt: args.sprt ? {
			elo0: floatArg(args.elo0, "elo0") ?? DEFAULT_SPRT.elo0,
			elo1: floatArg(args.elo1, "elo1") ?? DEFAULT_SPRT.elo1,
			alpha: floatArg(args.alpha, "alpha") ?? DEFAULT_SPRT.alpha,
			beta: floatArg(args.beta, "beta") ?? DEFAULT_SPRT.beta,
		} : undefined,
	};
	void runSelfPlay(options).then(result => {
		const aLabel = nameOf(options.a, "A");
		const bLabel = nameOf(options.b, "B");
		console.log(`\n=== Self-play: ${aLabel} vs ${bLabel} (${format}${options.mirror ? ", mirrored" : ""}) ===`);
		console.log(`games:    ${result.games}`);
		console.log(`${aLabel} wins: ${result.winsA}`);
		console.log(`${bLabel} wins: ${result.winsB}`);
		console.log(`ties:     ${result.ties}${result.errors ? `  (errors: ${result.errors})` : ""}`);
		console.log(`winrate ${aLabel}: ${(result.winrateA * 100).toFixed(1)}% of decisive games`);
		const iv = result.interval;
		console.log(`score ${aLabel}:   ${(iv.score * 100).toFixed(1)}%  ` +
			`[${(iv.scoreLow * 100).toFixed(1)}%, ${(iv.scoreHigh * 100).toFixed(1)}%] 95% CI`);
		console.log(`elo ${aLabel}:     ${iv.elo >= 0 ? "+" : ""}${iv.elo.toFixed(0)}  ` +
			`[${iv.eloLow.toFixed(0)}, ${iv.eloHigh.toFixed(0)}]`);
		console.log(`avg turns: ${result.avgTurns.toFixed(1)}`);
		if (result.sprt) {
			const { verdict, llr, config } = result.sprt;
			console.log(`sprt:      ${verdict} (LLR ${llr.toFixed(2)}, ` +
				`H0 ${config.elo0} Elo vs H1 ${config.elo1} Elo)`);
		}
		if (result.telemetry) {
			printTelemetry(aLabel, result.telemetry.a);
			printTelemetry(bLabel, result.telemetry.b);
		}
		if (args.out) {
			fs.writeFileSync(args.out, `${JSON.stringify({
				format, mirror: !!options.mirror, seed: options.seed,
				a: options.a, b: options.b, ...result,
			}, null, "\t")}\n`);
			console.log(`wrote ${args.out}`);
		}
		if (args["write-baseline"]) {
			writeBaseline(args["write-baseline"], format, options, result);
			console.log(`wrote baseline ${args["write-baseline"]}`);
		}
		process.exit(args.baseline ? checkBaseline(args.baseline, result) : 0);
	});
}

/**
 * Print one contender's decision telemetry.
 *
 * @param label The contender's display name.
 * @param counters That contender's counters.
 */
function printTelemetry(label: string, counters: DecisionCounters): void {
	const r = decisionRates(counters);
	const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
	console.log(`telemetry ${label}: ${counters.decisions} decisions, ${counters.moves} moves`);
	console.log(`  immune clicks   ${counters.immuneMoves} (${pct(r.immuneMoveRate)})` +
		`  of which avoidable: ${counters.avoidableImmuneMoves} (${pct(r.avoidableImmuneMoveRate)})`);
	console.log(`  zero-damage     ${counters.zeroDamageMoves} (${pct(r.zeroDamageMoveRate)})`);
	console.log(`  resisted        ${counters.resistedMoves} (${pct(r.resistedMoveRate)})`);
	console.log(`  status moves    ${counters.statusMoves} (${pct(r.statusMoveRate)})`);
	console.log(`  switches        ${counters.switches} (${pct(r.switchRate)})`);
	console.log(`  rejections      ${counters.rejections} (${pct(r.rejectionRate)})`);
}

/** A saved run, used as the regression reference for `--baseline`. */
interface Baseline {
	format: string;
	mirror: boolean;
	a: ContenderConfig;
	b: ContenderConfig;
	games: number;
	/** A's mean score in the baseline run. */
	score: number;
	/** A's Elo in the baseline run. */
	elo: number;
	/** Lower 95% bound on A's score, i.e. the floor a rerun must clear. */
	scoreLow: number;
	created: string;
}

/**
 * Save a run as a reusable baseline.
 *
 * @param path Where to write the baseline JSON.
 * @param format The format the series ran.
 * @param options The series options.
 * @param result The series result.
 */
function writeBaseline(
	path: string,
	format: string,
	options: SelfPlayOptions,
	result: SelfPlayResult
): void {
	const baseline: Baseline = {
		format,
		mirror: !!options.mirror,
		a: options.a,
		b: options.b,
		games: result.games,
		score: result.interval.score,
		elo: result.interval.elo,
		scoreLow: result.interval.scoreLow,
		created: new Date().toISOString(),
	};
	fs.writeFileSync(path, `${JSON.stringify(baseline, null, "\t")}\n`);
}

/**
 * Compare a run against a saved baseline.
 *
 * A regression is only reported when the two intervals don't overlap —
 * i.e. the new run's *upper* bound sits below the baseline's *lower*
 * bound. Anything less than that is noise, and failing CI on noise
 * trains people to ignore the gate.
 *
 * @param path Path to the baseline JSON.
 * @param result The current series result.
 * @returns The process exit code: 1 on a real regression, else 0.
 */
function checkBaseline(path: string, result: SelfPlayResult): number {
	let baseline: Baseline;
	try {
		baseline = JSON.parse(fs.readFileSync(path, "utf8"));
	} catch (err) {
		console.error(`\nCannot read baseline ${path}: ${(err as Error).message}`);
		return 1;
	}
	const iv = result.interval;
	console.log(`\nbaseline:  score ${(baseline.score * 100).toFixed(1)}% ` +
		`(${baseline.elo >= 0 ? "+" : ""}${baseline.elo.toFixed(0)} Elo, ${baseline.games} games, ${baseline.created})`);
	if (iv.scoreHigh < baseline.scoreLow) {
		console.error(`REGRESSION: this run's 95% upper bound (${(iv.scoreHigh * 100).toFixed(1)}%) ` +
			`is below the baseline's lower bound (${(baseline.scoreLow * 100).toFixed(1)}%).`);
		return 1;
	}
	console.log(`no regression detected (intervals overlap).`);
	return 0;
}

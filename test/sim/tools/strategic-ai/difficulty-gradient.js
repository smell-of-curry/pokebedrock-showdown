'use strict';

const assert = require('../../../assert');

const Sim = require('../../../../dist/sim');
const BattleStreams = require('../../../../dist/sim/battle-stream');
const { PlayerAI } =
	require('../../../../dist/sim/tools/strategic-ai');

const DEFAULT_FORMAT = 'gen9anythinggoes';

// Two pre-built 6-Pokemon teams so the simulator doesn't have to fall
// back to its (custom) random pool for missing slots, which references
// species not present in this fork's Dex.
const TEAM_A = [
	{ species: 'Garchomp', ability: 'roughskin', moves: ['earthquake', 'dragonclaw', 'fireblast', 'stealthrock'], evs: { hp: 4, atk: 252, spe: 252 } },
	{ species: 'Heatran', ability: 'flashfire', moves: ['magmastorm', 'earthpower', 'flashcannon', 'taunt'], evs: { hp: 252, spa: 252, spe: 4 } },
	{ species: 'Toxapex', ability: 'regenerator', moves: ['scald', 'recover', 'haze', 'toxic'], evs: { hp: 252, def: 252, spd: 4 } },
	{ species: 'Dragonite', ability: 'multiscale', moves: ['extremespeed', 'earthquake', 'dragondance', 'roost'], evs: { hp: 4, atk: 252, spe: 252 } },
	{ species: 'Clefable', ability: 'magicguard', moves: ['moonblast', 'softboiled', 'thunderwave', 'flamethrower'], evs: { hp: 252, def: 4, spa: 252 } },
	{ species: 'Excadrill', ability: 'moldbreaker', moves: ['earthquake', 'ironhead', 'rapidspin', 'rockslide'], evs: { hp: 4, atk: 252, spe: 252 } },
];
const TEAM_B = [
	{ species: 'Tyranitar', ability: 'sandstream', moves: ['stoneedge', 'crunch', 'earthquake', 'icepunch'], evs: { hp: 4, atk: 252, spe: 252 } },
	{ species: 'Skarmory', ability: 'sturdy', moves: ['bravebird', 'roost', 'spikes', 'whirlwind'], evs: { hp: 252, def: 252, spd: 4 } },
	{ species: 'Hydreigon', ability: 'levitate', moves: ['darkpulse', 'dracometeor', 'fireblast', 'flashcannon'], evs: { hp: 4, spa: 252, spe: 252 } },
	{ species: 'Ferrothorn', ability: 'ironbarbs', moves: ['powerwhip', 'gyroball', 'leechseed', 'spikes'], evs: { hp: 252, def: 4, spd: 252 } },
	{ species: 'Volcarona', ability: 'flamebody', moves: ['fierydance', 'bugbuzz', 'quiverdance', 'gigadrain'], evs: { hp: 4, spa: 252, spe: 252 } },
	{ species: 'Zapdos', ability: 'static', moves: ['discharge', 'hurricane', 'roost', 'heatwave'], evs: { hp: 252, spa: 252, spe: 4 } },
];
const TEAM_A_PACKED = Sim.Teams.pack(TEAM_A);
const TEAM_B_PACKED = Sim.Teams.pack(TEAM_B);

/**
 * Run a single battle between two players, returning the winning side
 * (`p1`, `p2`, or `null` for a draw / undecided).
 */
async function playGame(format, p1Factory, p2Factory, prngSeed) {
	const battleStream = new BattleStreams.BattleStream();
	const streams = BattleStreams.getPlayerStreams(battleStream);
	const spec = { formatid: format, seed: prngSeed };
	const p1 = p1Factory(streams.p1);
	const p2 = p2Factory(streams.p2);
	void p1.start();
	void p2.start();
	void streams.omniscient.write(
		`>start ${JSON.stringify(spec)}\n` +
		`>player p1 ${JSON.stringify({ name: 'P1', team: TEAM_A_PACKED })}\n` +
		`>player p2 ${JSON.stringify({ name: 'P2', team: TEAM_B_PACKED })}`
	);
	let winner = null;
	for await (const chunk of streams.omniscient) {
		// The protocol can emit `|win|<player name>` at the end.
		// Convert player names back to side ids.
		const lines = chunk.split('\n');
		for (const line of lines) {
			if (line.startsWith('|win|')) {
				const name = line.slice('|win|'.length).trim();
				winner = name === 'P1' ? 'p1' : name === 'P2' ? 'p2' : name.toLowerCase();
			}
			if (line === '|tie') {
				winner = 'tie';
			}
		}
	}
	return winner;
}

/**
 * Run `n` games of (p1Factory) vs (p2Factory) and return their wins.
 * `seedBase` is XORed into per-game seeds to keep batches deterministic
 * but distinct across runs.
 */
function makeSeed(a, b, c, d) {
	const cap = (n, m) => ((n % m) + m) % m;
	return [cap(a, 0x10000), cap(b, 0x10000), cap(c, 0x10000), cap(d, 0x10000)].join(',');
}

async function runMatches(n, p1Factory, p2Factory, seedBase = 1) {
	let p1Wins = 0;
	let p2Wins = 0;
	let draws = 0;
	for (let i = 0; i < n; i++) {
		const seed = makeSeed(seedBase + i, seedBase * 7 + i, seedBase * 13 + i, seedBase * 17 + i);
		const winner = await playGame(DEFAULT_FORMAT, p1Factory, p2Factory, seed);
		if (winner === 'p1') p1Wins++;
		else if (winner === 'p2') p2Wins++;
		else draws++;
	}
	return { p1Wins, p2Wins, draws };
}

describe('Strategic-AI smoke test', () => {
	it('every difficulty 1..5 plays a battle to completion', async function () {
		this.timeout(120000);
		for (let d = 1; d <= 5; d++) {
			const winner = await playGame(
				DEFAULT_FORMAT,
				s => new PlayerAI(s, { difficulty: d, seed: [1, 2, 3, 4] }),
				s => new PlayerAI(s, { difficulty: 1, seed: [5, 6, 7, 8] }),
				makeSeed(1000 + d, 2000 + d, 3000 + d, 4000 + d)
			);
			assert(winner === 'p1' || winner === 'p2',
				`difficulty ${d} battle should produce a winner; got ${winner}`);
		}
	});
});

describe('Strategic-AI difficulty gradient (slow)', () => {
	// We expect higher tiers to win more games against lower tiers.
	// This is a probabilistic claim, so we run a small batch and ask
	// for "non-trivially better than 50%" rather than a precise rate.
	it('difficulty 3 wins more often than difficulty 1 across 10 games', async function () {
		this.timeout(0);
		const N = 10;
		const result = await runMatches(
			N,
			s => new PlayerAI(s, { difficulty: 3, seed: [1, 2, 3, 4] }),
			s => new PlayerAI(s, { difficulty: 1, seed: [9, 10, 11, 12] }),
			101
		);
		assert(result.p1Wins >= Math.ceil(N * 0.55),
			`difficulty 3 should beat difficulty 1 in >=55% of ${N} games (got p1=${result.p1Wins} p2=${result.p2Wins} draws=${result.draws})`);
	});

	it('difficulty 5 wins more often than difficulty 2 across 10 games', async function () {
		this.timeout(0);
		const N = 10;
		const result = await runMatches(
			N,
			s => new PlayerAI(s, { difficulty: 5, seed: [1, 2, 3, 4] }),
			s => new PlayerAI(s, { difficulty: 2, seed: [9, 10, 11, 12] }),
			202
		);
		assert(result.p1Wins >= Math.ceil(N * 0.55),
			`difficulty 5 should beat difficulty 2 in >=55% of ${N} games (got p1=${result.p1Wins} p2=${result.p2Wins} draws=${result.draws})`);
	});
});

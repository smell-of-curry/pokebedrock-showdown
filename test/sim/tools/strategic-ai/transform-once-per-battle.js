'use strict';

const assert = require('../../../assert');

const { HeuristicEngine } =
	require('../../../../dist/sim/tools/strategic-ai/engines/HeuristicEngine');
const { OnePlySearchEngine } =
	require('../../../../dist/sim/tools/strategic-ai/engines/OnePlySearchEngine');
const { MctsEngine } =
	require('../../../../dist/sim/tools/strategic-ai/engines/MctsEngine');
const { RandomEngine } =
	require('../../../../dist/sim/tools/strategic-ai/engines/RandomEngine');
const { BattleStateTracker } =
	require('../../../../dist/sim/tools/strategic-ai/state/BattleStateTracker');
const { PRNG } = require('../../../../dist/sim');

/** Build a fake `PokemonSwitchRequestData` good enough for the engines. */
function mkReq(name, opts = {}) {
	return {
		ident: `${opts.position ?? 'p1'}: ${name}`,
		uuid: opts.uuid ?? `uuid-${name.toLowerCase()}`,
		details: `${name}, L100, M`,
		condition: opts.fainted ? '0 fnt' : (opts.condition ?? '100/100'),
		active: !!opts.active,
		stats: opts.stats ?? { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
		moves: opts.moves ?? [],
		baseAbility: opts.ability ?? '',
		item: opts.item ?? '',
		pokeball: 'pokeball',
		types: opts.types ?? ['Normal'],
		boosts: opts.boosts ?? {},
		status: opts.status ?? '',
	};
}

/** Build a fake active-slot `PokemonMoveRequestData` with mega available. */
function mkActive(moveIds) {
	return {
		moves: moveIds.map(id => ({
			move: id, id, pp: 16, maxpp: 16, target: 'normal', disabled: false,
		})),
		canMegaEvo: true,
	};
}

function engineCtx(tracker) {
	return {
		tracker,
		prng: PRNG.get(null),
		difficulty: 3,
		lastMoveByMon: new Map(),
		disabledMovesByMon: new Map(),
		trappedActiveByMon: new Set(),
		lastSwitchTurnByMon: new Map(),
		lastMoveFailedByMon: new Set(),
		noiseEpsilon: 0,
		infoForgetting: 0,
		randomMoveProb: 1,
		randomMegaProb: 1,
	};
}

describe('Strategic-AI once-per-battle transforms in doubles', () => {
	// Reproduces the production error loop: in a doubles battle both
	// active slots carry `canMegaEvo: true` on the same request (showdown
	// repeats the flag per slot when both mons hold a usable stone), and
	// the heuristic engine decided each slot independently, emitting
	// `move X mega, move Y mega`. `side.ts` rejects the second suffix
	// with `[Invalid choice] Can't move: You can only mega-evolve once
	// per battle`, and because the engine is mostly deterministic the
	// retry produced the same command until the force-tie valve fired.
	const engines = [
		['RandomEngine', () => new RandomEngine()],
		['HeuristicEngine', () => new HeuristicEngine()],
		['OnePlySearchEngine', () => new OnePlySearchEngine()],
		['MctsEngine', () => new MctsEngine()],
	];

	function mkDoublesMegaRequest() {
		return {
			active: [mkActive(['psychic']), mkActive(['dragonpulse'])],
			side: {
				id: 'p1',
				name: 'Trainer',
				pokemon: [
					mkReq('Gardevoir', { position: 'p1a', active: true, types: ['Psychic', 'Fairy'], moves: ['psychic'] }),
					mkReq('Salamence', { position: 'p1b', active: true, types: ['Dragon', 'Flying'], moves: ['dragonpulse'] }),
				],
				foePokemon: [
					mkReq('Venusaur', { position: 'p2a', active: true, types: ['Grass', 'Poison'] }),
					mkReq('Blastoise', { position: 'p2b', active: true, types: ['Water'] }),
				],
			},
		};
	}

	for (const [label, build] of engines) {
		it(`${label} claims mega on at most one slot per request`, () => {
			const engine = build();
			const tracker = new BattleStateTracker({ mySide: 'p1' });
			const request = mkDoublesMegaRequest();
			tracker.applyRequest(request);
			// Run several times: PRNG noise must never produce two megas.
			for (let i = 0; i < 25; i++) {
				const choice = engine.choose(request, engineCtx(tracker));
				const megaCount = choice.split(',').filter(part => / mega\b/.test(part)).length;
				assert(megaCount <= 1,
					`${label} emitted ${megaCount} mega suffixes in one request: ${JSON.stringify(choice)}`);
			}
		});
	}
});

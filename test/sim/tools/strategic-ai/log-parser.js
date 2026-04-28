'use strict';

const assert = require('../../../assert');

const { parseLine, parsePokemonRef, stripEffectPrefix } =
	require('../../../../dist/sim/tools/strategic-ai/state/LogParser');

describe('Strategic-AI LogParser', () => {
	describe('parsePokemonRef', () => {
		it('parses an active POKEMON ident', () => {
			const ref = parsePokemonRef('p1a: Garchomp');
			assert(ref);
			assert.equal(ref.side, 'p1');
			assert.equal(ref.position, 0);
			assert.equal(ref.name, 'Garchomp');
		});

		it('parses a benched POKEMON ident (no position letter)', () => {
			const ref = parsePokemonRef('p2: Tyranitar');
			assert(ref);
			assert.equal(ref.side, 'p2');
			assert.equal(ref.position, -1);
			assert.equal(ref.name, 'Tyranitar');
		});

		it('returns null on garbage input', () => {
			assert.equal(parsePokemonRef(undefined), null);
			assert.equal(parsePokemonRef(''), null);
			assert.equal(parsePokemonRef('not a pokemon ref'), null);
		});
	});

	describe('stripEffectPrefix', () => {
		it('strips known effect prefixes', () => {
			assert.equal(stripEffectPrefix('move: Stealth Rock'), 'Stealth Rock');
			assert.equal(stripEffectPrefix('ability: Drizzle'), 'Drizzle');
			assert.equal(stripEffectPrefix('item: Leftovers'), 'Leftovers');
		});

		it('passes through unprefixed effects', () => {
			assert.equal(stripEffectPrefix('Sandstorm'), 'Sandstorm');
		});
	});

	describe('parseLine - turn / structural events', () => {
		it('parses |turn|N|', () => {
			const ev = parseLine('|turn|5');
			assert.deepEqual(ev, { kind: 'turn', turn: 5 });
		});

		it('parses |gametype|doubles|', () => {
			const ev = parseLine('|gametype|doubles');
			assert.deepEqual(ev, { kind: 'gametype', gametype: 'doubles' });
		});

		it('parses |start|', () => {
			const ev = parseLine('|start');
			assert.deepEqual(ev, { kind: 'battlestart' });
		});

		it('parses |win|<side>| in normalised form', () => {
			const ev = parseLine('|win|p2');
			assert.equal(ev.kind, 'win');
			assert.equal(ev.side, 'p2');
			assert.equal(ev.name, 'p2');
		});

		it('parses |win|<player name>| from real Showdown logs', () => {
			const ev = parseLine('|win|Bot 1');
			assert.equal(ev.kind, 'win');
			assert.equal(ev.side, undefined);
			assert.equal(ev.name, 'Bot 1');
		});

		it('parses |tie|', () => {
			const ev = parseLine('|tie');
			assert.deepEqual(ev, { kind: 'tie' });
		});
	});

	describe('parseLine - move events', () => {
		it('captures the user, move name, target, and miss flag', () => {
			const ev = parseLine('|move|p1a: Garchomp|Earthquake|p2a: Heatran');
			assert(ev);
			assert.equal(ev.kind, 'move');
			assert.equal(ev.user.side, 'p1');
			assert.equal(ev.move, 'Earthquake');
			assert.equal(ev.target.side, 'p2');
			assert.equal(ev.missed, false);
		});

		it('captures [miss] suffix', () => {
			const ev = parseLine('|move|p1a: Pikachu|Hydro Pump|p2a: Tyranitar|[miss]');
			assert(ev);
			assert.equal(ev.missed, true);
		});
	});

	describe('parseLine - hp / status / boost events', () => {
		it('parses |-damage| with HP fraction', () => {
			const ev = parseLine('|-damage|p1a: Garchomp|123/261');
			assert.equal(ev.kind, 'damage');
			assert.equal(ev.hp, '123/261');
		});

		it('parses |-heal|', () => {
			const ev = parseLine('|-heal|p1a: Garchomp|261/261');
			assert.equal(ev.kind, 'heal');
		});

		it('parses |-status|', () => {
			const ev = parseLine('|-status|p1a: Garchomp|brn');
			assert.equal(ev.kind, 'status');
			assert.equal(ev.status, 'brn');
		});

		it('parses |-boost|', () => {
			const ev = parseLine('|-boost|p1a: Garchomp|atk|2');
			assert.equal(ev.kind, 'boost');
			assert.equal(ev.stat, 'atk');
			assert.equal(ev.amount, 2);
		});

		it('parses |-unboost|', () => {
			const ev = parseLine('|-unboost|p2a: Heatran|spe|1');
			assert.equal(ev.kind, 'unboost');
			assert.equal(ev.stat, 'spe');
			assert.equal(ev.amount, 1);
		});
	});

	describe('parseLine - field / side events', () => {
		it('parses |-weather| start', () => {
			const ev = parseLine('|-weather|RainDance');
			assert.equal(ev.kind, 'weather');
			assert.equal(ev.weather, 'RainDance');
			assert.equal(ev.upkeep, false);
		});

		it('parses |-weather| upkeep marker', () => {
			const ev = parseLine('|-weather|RainDance|[upkeep]');
			assert.equal(ev.kind, 'weather');
			assert.equal(ev.upkeep, true);
		});

		it('parses |-fieldstart| (Trick Room)', () => {
			const ev = parseLine('|-fieldstart|move: Trick Room');
			assert.equal(ev.kind, 'fieldstart');
			assert.equal(ev.condition, 'Trick Room');
		});

		it('parses |-sidestart| with hazards', () => {
			const ev = parseLine('|-sidestart|p2: My Side|move: Stealth Rock');
			assert.equal(ev.kind, 'sidestart');
			assert.equal(ev.side, 'p2');
		});

		it('parses |-sideend| (Defog removes hazards)', () => {
			const ev = parseLine('|-sideend|p1: Player|Spikes');
			assert.equal(ev.kind, 'sideend');
			assert.equal(ev.side, 'p1');
		});
	});

	describe('parseLine - reveal events', () => {
		it('parses |-ability| reveals', () => {
			const ev = parseLine('|-ability|p2a: Tyranitar|Sand Stream');
			assert.equal(ev.kind, 'ability');
			assert.equal(ev.ability, 'Sand Stream');
		});

		it('parses |-item| reveals', () => {
			const ev = parseLine('|-item|p2a: Heatran|Air Balloon');
			assert.equal(ev.kind, 'item');
			assert.equal(ev.item, 'Air Balloon');
		});

		it('parses |-enditem|', () => {
			const ev = parseLine('|-enditem|p2a: Heatran|Air Balloon');
			assert.equal(ev.kind, 'enditem');
			assert.equal(ev.item, 'Air Balloon');
		});

		it('parses |-terastallize|', () => {
			const ev = parseLine('|-terastallize|p1a: Garchomp|Steel');
			assert.equal(ev.kind, 'terastallize');
			assert.equal(ev.type, 'Steel');
		});
	});

	describe('parseLine - faint / cant', () => {
		it('parses |faint|', () => {
			const ev = parseLine('|faint|p2a: Heatran');
			assert.equal(ev.kind, 'faint');
			assert.equal(ev.pokemon.name, 'Heatran');
		});

		it('parses |cant| with reason and move', () => {
			const ev = parseLine('|cant|p1a: Garchomp|par');
			assert.equal(ev.kind, 'cant');
			assert.equal(ev.reason, 'par');
		});
	});

	describe('parseLine - tolerates unknown lines', () => {
		it('returns null for blank lines', () => {
			assert.equal(parseLine(''), null);
			assert.equal(parseLine('not a pipe line'), null);
		});

		it('returns null for unknown |kind|', () => {
			assert.equal(parseLine('|made-up-kind|whatever'), null);
		});
	});
});

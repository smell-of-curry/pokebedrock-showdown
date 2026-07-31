'use strict';

/**
 * `Teams.pack` and `Teams.unpack` must stay field-for-field symmetric.
 *
 * This fork adds four PokeBedrock fields to the packed format (`uuid`,
 * `currentHealth`, `status`, `movesInfo`). `unpack` read all four while
 * `pack` wrote none of them, so every field after the species shifted by
 * four positions on a round trip: `movesInfo` was parsed out of the EV
 * spread, every move came back on NaN PP, and battles opened with
 * `|cant|p1a: X|nopp` on all four slots and stalled until the turn cap.
 *
 * That failure is invisible in normal play (the client packs teams once
 * and the server unpacks the same string) and only shows up when
 * something round-trips a team — which is exactly what the AI self-play
 * harness does.
 */

const assert = require('../../assert');

const { Teams } = require('../../../dist/sim/teams');

/** A plain competitive set, as a client would submit it. */
function vanillaSet() {
	return {
		name: 'Pika',
		species: 'Pikachu',
		item: 'lightball',
		ability: 'static',
		moves: ['thunderbolt', 'voltswitch'],
		nature: 'Timid',
		evs: { spa: 252, spe: 252 },
		ivs: {},
		level: 100,
	};
}

/** The same set carrying mid-battle PokeBedrock state. */
function pokebedrockSet() {
	return {
		...vanillaSet(),
		uuid: 'abc-123',
		currentHealth: 87,
		status: 'par',
		movesInfo: [{ pp: 12, maxPp: 15 }, { pp: 20, maxPp: 20 }],
	};
}

describe('Teams.pack / Teams.unpack round trip', () => {
	it('preserves the PokeBedrock fields', () => {
		const set = Teams.unpack(Teams.pack([pokebedrockSet()]))[0];
		assert.equal(set.uuid, 'abc-123');
		assert.equal(set.currentHealth, 87);
		assert.equal(set.status, 'par');
		assert.deepEqual(set.movesInfo, [{ pp: 12, maxPp: 15 }, { pp: 20, maxPp: 20 }]);
	});

	it('keeps the standard fields aligned', () => {
		const set = Teams.unpack(Teams.pack([pokebedrockSet()]))[0];
		assert.equal(set.species, 'Pikachu');
		assert.equal(set.ability, 'Static');
		assert.equal(set.item, 'Light Ball');
		assert.deepEqual(set.moves, ['Thunderbolt', 'Volt Switch']);
		assert.equal(set.nature, 'Timid');
		// Level 100 is the format default and packs as empty, so it comes
		// back unset; a non-default level is asserted in the team case.
		assert.equal(set.level, undefined);
		assert.deepEqual(set.evs, { hp: 0, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 });
	});

	it('leaves a set without PokeBedrock state clean', () => {
		// `parseInt('')` is NaN, and a NaN currentHealth is one `??` away
		// from being applied as real HP (`Pokemon` reads it directly).
		const set = Teams.unpack(Teams.pack([vanillaSet()]))[0];
		assert.equal(set.currentHealth, undefined);
		assert.equal(set.movesInfo, undefined);
		assert.deepEqual(set.moves, ['Thunderbolt', 'Volt Switch']);
	});

	it('is stable across repeated round trips', () => {
		for (const mk of [vanillaSet, pokebedrockSet]) {
			const once = Teams.pack(Teams.unpack(Teams.pack([mk()])));
			const twice = Teams.pack(Teams.unpack(once));
			assert.equal(twice, once);
		}
	});

	it('survives a full six-member team', () => {
		const team = [
			pokebedrockSet(),
			{ ...vanillaSet(), name: 'Chomp', species: 'Garchomp', ability: 'roughskin', item: '', moves: ['earthquake'] },
			{ ...pokebedrockSet(), name: 'Tran', species: 'Heatran', ability: 'flashfire', currentHealth: 0, status: 'fnt' },
			{ ...vanillaSet(), name: 'Toxa', species: 'Toxapex', ability: 'regenerator', level: 50 },
			{ ...pokebedrockSet(), name: 'Moss', species: 'Amoonguss', ability: 'regenerator', movesInfo: [{ pp: 1, maxPp: 15 }] },
			{ ...vanillaSet(), name: 'Skarm', species: 'Skarmory', ability: 'sturdy' },
		];
		const back = Teams.unpack(Teams.pack(team));
		assert.equal(back.length, 6);
		assert.deepEqual(back.map(s => s.species),
			['Pikachu', 'Garchomp', 'Heatran', 'Toxapex', 'Amoonguss', 'Skarmory']);
		// A fainted mon's 0 HP must survive as 0, not fall back to undefined.
		assert.equal(back[2].currentHealth, 0);
		assert.equal(back[2].status, 'fnt');
		assert.equal(back[1].currentHealth, undefined);
		assert.equal(back[3].level, 50);
	});
});

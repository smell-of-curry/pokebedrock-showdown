import { Items } from './items';
import { type Pokemon } from '../sim/pokemon';

/**
 * @pokebedrock - Add bag items
 *
 * A map of bag items and their functions.
 */
export const bagItems = new Map<
	string,
	(battle: Battle, pokemon: Pokemon, moveName?: string) => void
>([
			['revive', (battle, pokemon) => pokemon.revive(pokemon.maxhp / 2)],
			['max_revive', (battle, pokemon) => pokemon.revive()],
			[
				'full_restore',
				(battle, pokemon) => {
					pokemon.heal(pokemon.maxhp);
					pokemon.cureStatus();
				},
			],
			['hyper_potion', (battle, pokemon) => pokemon.heal(120)],
			['max_potion', (battle, pokemon) => pokemon.heal(pokemon.maxhp)],
			['potion', (battle, pokemon) => pokemon.heal(20)],
			['super_potion', (battle, pokemon) => pokemon.heal(60)],
			['moomoo_milk', (battle, pokemon) => pokemon.heal(100)],
			['lemonade', (battle, pokemon) => pokemon.heal(70)],
			['ragecandybar', (battle, pokemon) => pokemon.heal(20)],
			['casteliacone', (battle, pokemon) => pokemon.heal(20)],
			['freshwater', (battle, pokemon) => pokemon.heal(30)],
			// Status healers
			[
				'antidote',
				(battle, pokemon) => {
					if (pokemon.status === 'psn' || pokemon.status === 'tox') {
						pokemon.cureStatus();
					}
				},
			],
			[
				'burn_heal',
				(battle, pokemon) => {
					if (pokemon.status === 'brn') pokemon.cureStatus();
				},
			],
			[
				'ice_heal',
				(battle, pokemon) => {
					if (pokemon.status === 'frz') pokemon.cureStatus();
				},
			],
			[
				'paralyze_heal',
				(battle, pokemon) => {
					if (pokemon.status === 'par') pokemon.cureStatus();
				},
			],
			[
				'awakening',
				(battle, pokemon) => {
					if (pokemon.status === 'slp') pokemon.cureStatus();
				},
			],
			['full_heal', (battle, pokemon) => pokemon.cureStatus()],
			// Regional treats cure all status conditions
			['big_malasada', (battle, pokemon) => pokemon.cureStatus()],
			['lava_cookie', (battle, pokemon) => pokemon.cureStatus()],
			['lumiose_galette', (battle, pokemon) => pokemon.cureStatus()],
			['old_gateau', (battle, pokemon) => pokemon.cureStatus()],
			['shalour_sable', (battle, pokemon) => pokemon.cureStatus()],
			// PP restore
			[
				'ether',
				(battle, pokemon, moveName) => {
					const moveSlot = pokemon.moveSlots.find(move => move.id === moveName);
					if (!moveSlot) return;
					moveSlot.pp = Math.min(moveSlot.pp + 10, moveSlot.maxpp);
				},
			],
			[
				'max_ether',
				(battle, pokemon, moveName) => {
					const moveSlot = pokemon.moveSlots.find(move => move.id === moveName);
					if (!moveSlot) return;
					moveSlot.pp = moveSlot.maxpp;
				},
			],
			[
				'elixir',
				(battle, pokemon) => {
					for (const moveSlot of pokemon.moveSlots) {
						moveSlot.pp = Math.min(moveSlot.pp + 10, moveSlot.maxpp);
					}
				},
			],
			[
				'max_elixir',
				(battle, pokemon) => {
					for (const moveSlot of pokemon.moveSlots) {
						moveSlot.pp = moveSlot.maxpp;
					}
				},
			],
			// Revives all fainted party members to full HP
			[
				'sacred_ash',
				(battle, pokemon) => {
					for (const ally of pokemon.side.pokemon) {
						if (ally.fainted) ally.revive();
					}
				},
			],
			[
				'aguav_berry',
				(battle, pokemon) => Items.aguavberry.onEat.call(battle, pokemon),
			],
			[
				'aspear_berry',
				(battle, pokemon) => Items.aspearberry.onEat.call(battle, pokemon),
			],
			[
				'cheri_berry',
				(battle, pokemon) => Items.cheriberry.onEat.call(battle, pokemon),
			],
			[
				'chesto_berry',
				(battle, pokemon) => Items.chestoberry.onEat.call(battle, pokemon),
			],
			[
				'figy_berry',
				(battle, pokemon) => Items.figyberry.onEat.call(battle, pokemon),
			],
			[
				'iapapa_berry',
				(battle, pokemon) => Items.iapapaberry.onEat.call(battle, pokemon),
			],
			[
				'leppa_berry',
				(battle, pokemon, moveName) => {
					const moveSlot = pokemon.moveSlots.find(move => move.id === moveName);
					if (!moveSlot) return;
					moveSlot.pp += 10;
					if (moveSlot.pp > moveSlot.maxpp) moveSlot.pp = moveSlot.maxpp;
					battle.add(
						'-activate',
						pokemon,
						'item: Leppa Berry',
						moveSlot.move,
						'[consumed]'
					);
				},
			],
			[
				'lum_berry',
				(battle, pokemon) => Items.lumberry.onEat.call(battle, pokemon),
			],
			[
				'mago_berry',
				(battle, pokemon) => Items.magoberry.onEat.call(battle, pokemon),
			],
			['nanab_berry', (battle, pokemon) => { }], // Makes wild Pokémon move less.
			[
				'oran_berry',
				(battle, pokemon) => Items.oranberry.onEat.call(battle, pokemon),
			],
			[
				'pecha_berry',
				(battle, pokemon) => Items.pechaberry.onEat.call(battle, pokemon),
			],
			[
				'persim_berry',
				(battle, pokemon) => Items.persimberry.onEat.call(battle, pokemon),
			],
			[
				'rawst_berry',
				(battle, pokemon) => Items.rawstberry.onEat.call(battle, pokemon),
			],
			['razz_berry', pokemon => { }], // Makes wild Pokémon easier to capture.
			[
				'sitrus_berry',
				(battle, pokemon) => Items.sitrusberry.onEat.call(battle, pokemon),
			],
			[
				'wiki_berry',
				(battle, pokemon) => Items.wikiberry.onEat.call(battle, pokemon),
			],
		]);

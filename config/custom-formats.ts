import { FormatList } from "../sim/dex-formats";

export const Formats: FormatList = [
	{
		name: "[Pokebedrock] Singles",
		mod: "gen9",
		gameType: "singles",
		ruleset: [
			"Obtainable"
		]
	},
	{
		name: "[Pokebedrock] Doubles",
		mod: "gen9",
		gameType: "doubles",
		ruleset: [
			"Obtainable",
		]
	},
	{
		name: "[Pokebedrock] Singles [Rated]",
		mod: "gen9",
		gameType: "singles",
		ruleset: [
			"Obtainable"
		]
	},
	{
		name: "[Pokebedrock] Doubles [Rated]",
		mod: "gen9",
		gameType: "doubles",
		ruleset: [
			"Obtainable",
			"Evasion Moves Clause",
			"Evasion Abilities Clause",
			"Species Clause",
			"OHKO Clause",
			"Endless Battle Clause",
			"Gravity Sleep Clause"
		],
		banlist: [
			"Dialga", "Dialga-Origin", "Giratina", "Giratina-Origin",
			"Palkia", "Palkia-Origin", "Rayquaza", "Reshiram", 
			"Kyurem-Black", "Kyurem-White", "Zekrom", "Zacian", 
			"Zacian-Crowned", "Zamazenta", "Zamazenta-Crowned",
			"Eternatus", "Ho-Oh", "Lugia", "Lunala", "Solgaleo", 
			"Koraidon", "Shadow Tag",
		]
	},
	{
		name: "[Pokebedrock] Anything Goes [Rated]",
		mod: "gen9",
		gameType: "singles",
		ruleset: [
			"Obtainable",
			"Endless Battle Clause",
			"Picked Team Size = 6"
		],
		banlist: [
			"Rayquaza-Mega",
		]
	},
	{
		name: "[Pokebedrock] Uber [Rated]",
		mod: 'gen9',
		gameType: "singles",
		ruleset: [
			"Obtainable",
			"Species Clause",
			"Sleep Clause Mod",
			"Evasion Moves Clause",
			"OHKO Clause",
			"Moody Clause",
			"Endless Battle Clause",
			"Swagger Clause",
			"Picked Team Size = 6"
		],
		banlist: [
			"Rayquaza-Mega"
		]
	},
];
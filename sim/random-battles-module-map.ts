export const getRandomBattlesModule = (mod: string): { default: any } | undefined => {
	switch (mod) {
	case 'gen9':
		// Standard Gen 9 Random Battles (singles/doubles variants are handled internally)
		return require('../data/random-battles/gen9/teams');
	default:
		return undefined;
	}
};

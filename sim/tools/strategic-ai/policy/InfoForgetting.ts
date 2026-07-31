/**
 * Strategic-AI information forgetting.
 *
 * Weak tiers need to play *worse*, not *wrongly*. The cheapest honest
 * way to do that is to take information away: a beginner forgets that
 * your Gyarados showed Ice Fang two turns ago and walks its Landorus
 * straight into it. Every decision it makes is still internally
 * coherent — it just reasons from a smaller set of facts.
 *
 * The previous implementation multiplied a move's score by 0.85 at
 * random, which modelled nothing and actively misranked: a negative
 * score (an immune or useless move) gets *closer to zero* when scaled
 * down, so forgetting could promote a do-nothing move above a working
 * one. That is precisely the behaviour players complained about.
 *
 * What we hide, in order of how quickly a real player loses track:
 *
 * 1. The foe's revealed moves — the biggest lever, and the one whose
 *    absence produces the classic beginner error (staying in on a
 *    threat you've already been shown).
 * 2. Its revealed item — forgetting a Choice Scarf or Life Orb.
 *
 * Boosts, HP, status, types, and species are never hidden: those are
 * on screen the whole time, and a player who "forgets" them isn't
 * weak, they're broken.
 *
 * **Ability is never hidden either**, even though a forgetful player
 * plausibly would. Ability is what decides immunity, so hiding it makes
 * the AI click Earthquake into a Levitate mon — measurably: an earlier
 * revision of this module that forgot abilities pushed avoidable
 * immune-move clicks from 0.0% to 0.6% of all moves at difficulty 3.
 * "Used a move I was immune to" is the single loudest complaint players
 * have about this AI, and it reads as a bug rather than as a weak
 * opponent, so no tier is allowed to generate it.
 *
 * @license MIT
 */
import type { PRNG } from "../../../prng";
import type { TrackedPokemon } from "../state/BattleStateTracker";

/**
 * Relative rate at which each fact is forgotten, as a multiple of the
 * tier's `infoForgetting` probability. Moves go first and fastest.
 */
const FORGET_WEIGHT = {
	moves: 1.0,
	item: 0.7,
} as const;

/**
 * Produce the view of `foe` that a given tier actually gets to reason
 * about.
 *
 * The result is a shallow copy: callers must treat it as read-only, and
 * must not write tracker state through it. Returns the original object
 * when nothing was forgotten so the common (full-information) path
 * allocates nothing.
 *
 * Call this **once per decision**, not once per candidate move — a
 * player who remembers Ice Fang while picking move 1 and forgets it
 * while picking move 2 is incoherent, and the resulting per-move noise
 * is what score jitter already does badly.
 *
 * @param foe The tracked foe as the tracker actually knows it.
 * @param forgetting Tier `infoForgetting` probability in [0, 1].
 * @param prng PRNG for the forgetting rolls.
 * @returns Either `foe` unchanged, or a shallow copy with some revealed
 * information removed.
 */
export function hazyView(
	foe: TrackedPokemon,
	forgetting: number,
	prng: PRNG
): TrackedPokemon {
	if (forgetting <= 0) return foe;
	const forgetMoves = foe.revealedMoves.size > 0 &&
		prng.random() < forgetting * FORGET_WEIGHT.moves;
	const forgetItem = !!foe.item && prng.random() < forgetting * FORGET_WEIGHT.item;
	if (!forgetMoves && !forgetItem) return foe;
	return {
		...foe,
		// Partial recall rather than total amnesia: keep each revealed
		// move with an independent coin flip, so a mid tier typically
		// remembers the foe's STAB but loses the coverage move.
		revealedMoves: forgetMoves ?
			new Set([...foe.revealedMoves].filter(() => prng.random() >= forgetting)) :
			foe.revealedMoves,
		item: forgetItem ? "" : foe.item,
	};
}

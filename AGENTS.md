## Learned User Preferences
- For gameplay QA and changelogs, inspect the exact commit or branch diff, distinguish changes already on the base branch, and omit CI, submodule, migration, and other developer-only noise.
- Keep player-facing changelogs concise and limited to changes players will notice; do not inflate optimization claims or include features absent from the diff.
- When asked to search Cursor chat history, search across all Cursor project workspaces rather than only the current repository.
- Keep Showdown edits surgical; avoid format-on-save or formatter churn that rewrites whole upstream files.
- For open PR review threads, verify each finding, fix valid issues or explain invalid ones, then resolve every thread.

## Learned Workspace Facts
- `pokebedrock-showdown` supplies the battle engine consumed by `pokebedrock-beh`. The behavior-pack bundle consumes compiled Showdown output, so after changing `sim/*.ts`, run `npm run build` here, rebuild the behavior pack with `build-dev.ts pre-commit`, and verify the generated `scripts/index.js` contains the fix.
- Optional native deps `better-sqlite3`/`sqlite3` are only for the standalone Pokémon Showdown server DB path; the BEH battle-engine embed does not use them, so consumer installs should disallow those package scripts and keep `esbuild` allowed.
- When adding new `this.add('-…')` protocol lines or `pseudoWeather`/field conditions in `sim/`/`data/`, update BEH `ShowdownInterpreter` handlers and `getFieldEffectIds` in lockstep — unhandled lines/conditions throw mid-battle (including cosmetic `-ohko` beside `-damage`, and fields like `wonderroom`/`fairylock`/`iondeluge`).
- Active battle arrays may contain `null` slots in doubles/triples. Code iterating `side.active` or `side.foe.active` must guard each slot before reading fields such as `volatiles`; `Pokemon.isSkyDropped()` follows this rule.
- Hidden trapping uses `maybeTrapped` to avoid leaking information. A valid switch attempt may be rejected once, after which Showdown updates the request to `trapped: true`; one rejection is expected (log below warning in the BEH interpreter), while repeated rejection or a hung battle indicates failed recovery.
- Embedded battles run with choice cancellation disabled: a second choice for the same request is rejected with `Can't undo` while the first choice remains active. BEH must block duplicate intentional submits, but clear that lock after recoverable invalid-choice rejections so players can retry; interpreter `default` recovery must bypass the UI submit lock.
- Evolution fields in `data/pokedex.ts` describe how `prevo` evolves into the current species, so conditions belong on the evolutee; preserve incoming conditions when an intermediate species also has outgoing evolutions. Basculegion's recoil evolution fires immediately in battle, without leveling.
- New evolution constraints belong on `Species` in `sim/dex-species.ts`, then on the target Pokédex entry and in the BEH generator mapping; do not add BEH-side evolution override maps.
- True-evolution identity updates must rename only default species names and preserve custom nicknames; capture or update identity before permanent `formeChange`, which replaces species state.
- Recharge choices must use the move index (`move 1`), then recurse so other doubles slots choose. Recover fainted/active switch desyncs with Showdown `default` instead of replaying the same illegal switch.

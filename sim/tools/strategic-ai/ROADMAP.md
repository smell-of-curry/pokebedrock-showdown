# Strategic-AI roadmap

Where the battle AI stands after the difficulty-ladder rework, what to
do next, and an honest assessment of the "just use a trained model"
option.

Read `policy/DifficultyPolicy.ts` first — it explains the tier model and
why the random and light engines were taken off the ladder.

## Where things stand

Measured over 200 mirrored `gen9randombattle` games per tier against the
`random` engine (see `baselines/README.md` for why that yardstick):

| tier | engine    | score vs random | Elo  | avoidable immune clicks | status-move rate |
|-----:|:----------|:----------------|:-----|:------------------------|:-----------------|
| 1    | Heuristic | 61.0%           | +78  | 0 / 5395                | 24.6%            |
| 2    | Heuristic | 78.0%           | +220 | 0 / 4930                | 21.8%            |
| 3    | Heuristic | 89.0%           | +363 | 0 / 3972                | 16.3%            |
| 4    | OnePly    | 91.5%           | +413 | 0 / 3886                | 15.0%            |
| 5    | MCTS      | 93.5%           | +463 | 0 / 3690                | 15.5%            |

Tiers 3-5 are saturated against random play and separate properly only
head-to-head. The random yardstick is a drift detector, not a top-end
ranking — a 2-point gap up here says little about which is stronger.

Tier 5's row is also the least repeatable one: MCTS is wall-clock
budgeted, so it does a different number of rollouts every run.

For comparison, the two engines that used to hold tiers 1 and 2 sat at
~3-4% avoidable immune clicks, and the light engine used status moves on
2.4% of its turns.

## Known gaps, roughly by value

### 1. Tier 5 does not clearly beat tier 4

MCTS wins by ~50 Elo head-to-head, which is a thin margin for something
running 200ms of rollouts against a 100ms one-ply search. Two likely
causes worth separating before tuning anything:

- **Rollout policy quality.** Rollouts use `greedyChoiceForSide`, which
  ranks moves by `BP x STAB x effectiveness` and therefore *never* picks
  a status move (base power 0). So every rollout plays out as a pure
  damage race, and the search systematically can't see lines that depend
  on a support turn.
- **Fork cost.** `Battle.toJSON`/`fromJSON` per rollout may be eating
  most of the budget, leaving too few playouts for the tree to mean
  anything. Instrument playouts-per-decision before assuming the search
  itself is the problem.

The fork path *is* exercised by self-play (`playGame` defines a `battle`
getter on the player sub-streams so `ctx.getBattle()` resolves, matching
what the production host provides). Worth re-checking if a refactor
touches stream setup: without it, `takeBattleSnapshot` silently returns
null, `sampleRollout` takes over, and tier 5 quietly degrades to a noisy
one-ply search while every test still passes.

### 2. Set inference for the foe is a placeholder

`bestAttackingDamage` assumes the foe has a generic 80 BP STAB in each
of its types. That is deliberately conservative (see the comment about
why probing all 18 coverage types is worse), but it means the AI is
blind to the actual metagame: in `gen9randombattle` the generator will
happily produce a set the AI never considers.

The right fix is to ask the format's own `randomSet` generator what sets
this species can roll, then maintain a posterior over them narrowed by
each revealed move and item. That gives calibrated coverage predictions
instead of either paranoia or blindness, and it is the single largest
remaining source of misplayed switches.

### 3. Evaluation is hand-tuned constants

`MoveEvaluator` and `SwitchEvaluator` are a few dozen weights picked by
hand. They are legible and debuggable, which is worth a lot, but they
are certainly not optimal.

Worth knowing how these are usually wrong, because the two found so far
were both *structural* rather than mis-tuned: status moves were scored
without ever multiplying through their accuracy (Hypnosis priced as
Spore), and sleep was flat-valued at 20 against poison's 16 despite
removing the target from the game for several turns. Neither shows up as
a bad constant — they show up as a missing term. Grep for a term the
damage path applies and the status path doesn't before reaching for a
tuner.

Two options, in increasing order of effort:

- **Tune the existing weights** against the self-play harness (SPRT
  gating is already wired up: `--sprt --elo1 10`). Cheap, no new
  concepts, and probably worth 30-60 Elo.
- **Learn a value function** from self-play positions and blend it with
  the heuristic score the way `MctsEngine` already blends rollout
  reward. Bigger lift, and it needs the position-dumping and training
  tooling built first.

### 4. Doubles is much weaker than singles

Target selection, spread-move handling, and partner coordination are all
thinner than the singles path, and none of it is measured — the harness
only runs singles formats. Anything here should start with a doubles
self-play ladder, because right now a doubles regression is invisible.

## On using a trained model

The short version: **not worth it for this project, and the reasons are
about deployment rather than model quality.**

### What exists

The open-source Pokemon-AI work worth knowing about:

- **`metamon`** (Stanford IRIS) — offline RL trained on years of real
  Showdown replays. The strongest publicly available learned agent, and
  genuinely good. Python, PyTorch, built around `poke-env`.
- **`poke-env`** — the standard Python interface for Showdown agents.
  The substrate most RL work sits on, not an agent itself.
- **`foul-play`** / **`poke-engine`** — a strong *non*-learned bot: a
  Rust battle engine plus expectiminimax search with set inference. The
  closest thing to "what we're building, done well."
- Assorted PPO/DQN projects. Most are student work that does not beat a
  decent heuristic; treat published win rates against "random" or
  "max damage" opponents as meaningless.

### Why it doesn't fit here

The blocker is where our AI has to run. `PlayerAI` executes **inside the
Minecraft Bedrock Script API sandbox**, in the same script thread as the
rest of the addon. That environment has no filesystem, no native
modules, no WASM/ONNX runtime, and a per-tick budget shared with
everything else the server is doing. A PyTorch policy cannot be shipped
into it at all.

That leaves two deployment shapes, and both cost more than they return:

**Remote inference over HTTP.** The server-only build could call out to a
hosted model. But a battle decision sits directly in the player's
interaction loop, so every turn now carries a network round trip, and
the failure modes are all bad: a slow response stalls the battle, a
failed one needs the heuristic engine as a fallback anyway (so we
maintain both), and the AI becomes unavailable whenever the inference
host is. We would be adding an operational dependency and a latency
budget to the most latency-sensitive part of the game, in exchange for
strength that tier 5 has not yet been shown to need.

**Distil into something shippable.** Train offline, then export a small
MLP as plain JS weight arrays — no runtime, no network, just arithmetic
the sandbox can do. This one is actually viable, and it is the honest
version of "use a trained model" for this codebase. But note what it
requires: a self-play/replay pipeline, a feature encoder that stays in
sync between training and inference, and a training loop — none of which
exist yet. And its natural first use is *gap 3 above*: a learned value
function blended into the existing search. So the work routes back to
the same place regardless.

### Recommendation

Do gaps 1-3 first, in order, because they are cheap, measurable with
tooling that already exists, and each one raises the ceiling for
anything learned that comes later. In particular, a learned value model
is only worth training once set inference is real — otherwise it learns
to evaluate positions described by features that are themselves wrong.

Revisit learned policies if and when tier 5 is clearly at the ceiling of
what hand-written evaluation plus search can do. It is not close to that
yet.

## Measuring anything you change

Do not trust a tier-vs-tier winrate from a handful of games. In
`gen9randombattle`, team quality swings results harder than a couple of
difficulty tiers, and an unmirrored 40-game series once reported tier 1
*above* tier 3.

```sh
# Is this change an improvement at all? (sequential test, stops early)
node dist/sim/tools/selfplay.js --a 3 --b 3 --games 2000 --mirror --sprt --elo1 10

# Did any tier regress?
npm run ai:baseline

# Did decision quality regress? (immune clicks, status usage, switch rate)
node dist/sim/tools/selfplay.js --a 3 --b 3 --games 200 --mirror --telemetry
```

`--mirror` is not optional. `--engine-b random` is how you tell absolute
strength from relative strength.

Two traps worth knowing:

- **Tier 5 is not reproducible.** MCTS is wall-clock budgeted, so the
  same seed gives a different number of rollouts run to run. Measure
  evaluator changes on tier 3 (deterministic) and use tier 5 only for
  end-to-end checks.
- **A rate near its threshold needs a big sample.** ~25 move decisions
  per game means an 8-game series can't resolve a status-move rate to
  better than a few points, which is how the tier-5 status assertion
  managed to both pass and fail on the same code.

To see *why* a move was picked rather than just what, the fastest probe
is to dump the sorted candidate list from `HeuristicEngine.decideForSlot`
right after the `scored.sort(...)` call and run 4 games at `--jobs 1`.
That is how both evaluator gaps above were found: status moves ranked
first in only ~19% of the decisions where one was legal.

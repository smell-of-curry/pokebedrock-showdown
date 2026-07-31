# Strategic-AI strength baselines

Each file records one difficulty tier's measured score against the
`random` engine over 200 mirrored `gen9randombattle` games, seeded
`11,22,33,44`.

## Why score against `random`?

Tier-vs-tier results only tell you the *ordering*. They can't tell you
whether a tier got stronger or weaker, because both sides move when you
retune — the whole ladder can sink while every adjacent comparison still
looks unchanged. The `random` engine has no knobs, so it can't drift,
which makes it the only reference that stays comparable across
revisions.

It does saturate at the top: once a tier is competent it wins ~90% of
games against random play, so d3/d4/d5 land close together here even
though they separate cleanly head-to-head. Treat these as a drift
detector for absolute strength, and use tier-vs-tier runs to compare the
top tiers with each other.

## Checking for a regression

```sh
node build
npm run ai:baseline          # all five tiers
```

Or one tier:

```sh
node dist/sim/tools/selfplay.js --a 3 --b 3 --engine-b random \
  --games 200 --mirror --quiet --seed 11,22,33,44 \
  --baseline sim/tools/strategic-ai/baselines/d3-vs-random.json
```

Exit code 1 means this run's 95% upper bound fell below the baseline's
95% lower bound — i.e. a regression the sample size can actually
support, not a noise blip. Overlapping intervals pass.

## Refreshing after an intentional change

```sh
node dist/sim/tools/selfplay.js --a 3 --b 3 --engine-b random \
  --games 200 --mirror --quiet --seed 11,22,33,44 \
  --write-baseline sim/tools/strategic-ai/baselines/d3-vs-random.json
```

Commit the new file with the change that caused it, and say in the
commit message why the number moved. A baseline refreshed on its own,
with no explanation, is how a regression gets ratcheted in permanently.

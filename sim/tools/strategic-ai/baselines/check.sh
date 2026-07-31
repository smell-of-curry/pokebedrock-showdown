#!/bin/sh
# Score every difficulty tier against the fixed `random` yardstick and
# fail if any tier regressed past its committed baseline.
#
# Assumes `node build` has already run. Takes a few minutes: each tier is
# 200 mirrored games, which is the sample size the baseline intervals
# were computed at. Running fewer games widens this run's interval and
# makes the gate pass on almost anything.
set -e

dir=$(dirname "$0")
status=0

for d in 1 2 3 4 5; do
	printf '\n--- difficulty %s ---\n' "$d"
	node dist/sim/tools/selfplay.js \
		--a "$d" --b 3 --engine-b random \
		--games 200 --mirror --quiet --seed 11,22,33,44 \
		--baseline "$dir/d$d-vs-random.json" || status=1
done

exit $status

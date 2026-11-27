# png-squeeze-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/alexchen950615/png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/alexchen950615/png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG re-encoder that squeezes 1280×720 screenshots into the
smallest PNG it can — an entry for the
[png-squeeze-01-run-20261127 bounty](https://make.fun/bounty/png-squeeze-01-run-20261127)
on [make.fun](https://make.fun).

`main.ts` answers a whole set of 8 screenshots in one run: it decodes each
stored PNG, picks the cheapest colour representation from the pixels
themselves (grey, palette + tRNS, RGB or RGBA), tries seven filter schemes
(one fixed PNG filter per image, plus two per-row minimum-sum choices),
deflates each at zlib level 9 and keeps the smallest stream. Everything is
deterministic — no clock, no randomness — so two runs write identical bytes.

On the practice set it scores **701,013** (house baseline fixed-paeth:
420,399), answering all 8 instances exactly, in about 12 seconds locally
(wall budget is 60 seconds).

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Layout

- `main.ts` — the whole entry (Node 22, built-ins only)
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE).

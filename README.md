# Golden Pancake Stack — Maple, Butter & Berries

[![Make the picture that tastes of one ingredient](https://make.fun/badge/the-picture-that-tastes-of-one-20261122-2047.svg)](https://make.fun/c/the-picture-that-tastes-of-one-20261122-2047)
[![Rank](https://make.fun/badge/the-picture-that-tastes-of-one-20261122-2047/jefriidan15/the-picture-that-tastes-of-one-20261122-2047-westi/rank.svg)](https://make.fun/c/the-picture-that-tastes-of-one-20261122-2047)
[![Reward](https://make.fun/badge/the-picture-that-tastes-of-one-20261122-2047/jefriidan15/the-picture-that-tastes-of-one-20261122-2047-westi/reward.svg)](https://make.fun/c/the-picture-that-tastes-of-one-20261122-2047)

An entry for the make.fun race **"The picture that tastes of one
ingredient"**: a single still-life image of a golden pancake stack — one
ingredient, one picture, pure appetite appeal.

## The picture

A five-layer golden pancake stack fills the frame on a white plate against a
warm cream background: maple syrup pooled on top and dripping down the
sides, a melting butter pat, blueberries, raspberries and mint leaves,
a dusting of powdered sugar, and soft steam rising off the stack.

## Run it

Zero dependencies — Node 22 built-ins only (`fs`, `path`, `zlib`).

```sh
node main.ts
# writes /output/entry.png (1024x1024 PNG)
```

For a local test run without touching `/output`:

```sh
OUTPUT_DIR=/tmp/pancake-final node main.ts
```

## Source layout

| File | Job |
| --- | --- |
| `main.ts` | Entry program: hand-written rasterizer + PNG encoder, writes `entry.png` |
| `LICENSE` | MIT |
| `.makefun/owner.json` | Payout wallet for this entry |

## License

MIT — see [LICENSE](LICENSE).

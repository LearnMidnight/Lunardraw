# Starfall v2 simulations

The Python models behind the v2 design decisions (docs/ADAPTIVE.md). Each runs on its own with
numpy: `python3 jackpot_share.py`. They model expected values, not the contracts; the contracts
are checked in `../v2-check`.

| Script | Question | Outcome |
|---|---|---|
| `cap.py` | What does a buyer of the whole board earn under a sales cap? | A cap removes the advantage of size, not jackpot-chasing |
| `ladder.py` | How often does a cap turn ordinary players away as volume grows? | A cap can trap the ladder |
| `both.py` | A buyer and growth together, with "a sold-out draw moves the ladder up" | The rule gives a big buyer a lever: the cap was dropped |
| `fixed.py` | A jackpot fixed before the draw's own sales, overflow to the smaller prizes | First version of the ceiling idea (it undercounted the buyer's gain) |
| `ceiling.py` | The same, with the buyer counting the overflow (variant A) | Safe only with a ceiling of about 0.35-0.40 x odds |
| `buffer.py` | Overflow to the Treasury, which refills later jackpots (variant B, built) | No purchase of any size is a winning bet |
| `jackpot_share.py` | A bigger Division 1 share with a higher ceiling, at real volumes; the first year | Division 1 at 50% with a ceiling of 0.71 (chosen 14 Nov 2026) |

The earlier scripts use the first draft's fee split and Division 1 share; their numbers are in
the history of the design, not the current settings.

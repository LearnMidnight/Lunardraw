# LunaSpin core rules

**LunaSpin** is Lunardraw's free, verifiable name draw, powered by Nightcast: *every spin, random, verifiable, fair.* This folder holds the rules every spin's certificate depends on, in two twins that must agree exactly:

- `src/core.js`: plain JavaScript for the browser and Node. `dist/lunaspin-core.js` is its browser build (`window.LunaSpinCore`, about 11 kB), which the lunardraw.io theme copies to `assets/js/lunaspin-core.js`.
- `php/lunaspin-core.php`: the PHP twin the theme's server side uses.

## The rules (scheme `lunaspin:v1`, tag `lunaspin|v1`)

| What | Rule |
|---|---|
| Tidy a name | Unicode NFC, trim, collapse runs of spaces (an explicit list, not `\s`) to one |
| Entries | 2–10,000, each 1–80 characters (code points); duplicates count twice |
| List fingerprint | Nightcast's `listCommitment`: SHA-256("nightcast:list:v1" ‖ u32be(count) ‖ for each: u32be(len) ‖ UTF-8) |
| Private-list entry | `SHA-256(pad32("lunaspin:entry:v1") ‖ salt16 ‖ u32be(len) ‖ UTF-8)`; the list fingerprint is then taken over these hashes (hex) |
| Rules | `listCommitment(["lunaspin:rules:v1", "mode=…", ("count=…" for pick-many), ("teams=…" for teams), "list=…", "title=…"])` |
| Seed | `SHA-256(pad32("lunaspin:v1") ‖ listFp ‖ rulesFp ‖ salt32)` |
| Word i | the contract's `randomWord`: `SHA-256(pad32("nightcast:word:v0") ‖ output ‖ u32le(i))` |
| Number in [0, n) | `@nightcast/sdk` `uniformInt` (no modulo bias) |
| Result | `pick` → `[pick]`; `pick-many` → the first k of a Fisher–Yates shuffle; `shuffle` → all of it, exactly as `@nightcast/sdk` `pick` / `pickMany` / `shuffle` on positions 0…n−1 |
| Teams | mode `teams` (2–50 teams, public lists only, no more teams than entries): the result is the whole shuffle, as for `shuffle`; teams are dealt from it round-robin (`teamsOf`: position i goes to team i mod t), so team sizes differ by at most one and the first teams get the extra entries |

`pad32(s)` is Compact's `pad(32, s)`: the UTF-8 bytes, then zeros. Results are 0-based positions; pages show them as entry #1, #2, …

## Checks

```
npm ci
npm test            # the JS rules against @nightcast/sdk 0.1.0 and the compiled @nightcast/contract 0.1.0
npm run vectors     # rewrite test/vectors.json (fixed inputs and answers, mostly from the SDK)
php test/php-vectors.php   # the PHP twin against the same values
npm run build       # dist/lunaspin-core.js
```

CI (`.github/workflows/lunaspin.yml`) runs all four and fails if `test/vectors.json` or the bundle is out of date.

LunaSpin is live at [lunardraw.io/spin](https://lunardraw.io/spin/); the site's pages aren't in this repository. Design and progress: [issue #98](https://github.com/LearnMidnight/Lunardraw/issues/98).

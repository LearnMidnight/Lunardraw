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
| Rules | `listCommitment(["lunaspin:rules:v1", "mode=…", ("count=…"), "list=…", "title=…"])` |
| Seed | `SHA-256(pad32("lunaspin:v1") ‖ listFp ‖ rulesFp ‖ salt32)` |
| Word i | the contract's `randomWord`: `SHA-256(pad32("nightcast:word:v0") ‖ output ‖ u32le(i))` |
| Number in [0, n) | `@nightcast/sdk` `uniformInt` (no modulo bias) |
| Result | `pick` → `[pick]`; `pick-many` → the first k of a Fisher–Yates shuffle; `shuffle` → all of it, exactly as `@nightcast/sdk` `pick` / `pickMany` / `shuffle` on positions 0…n−1 |

`pad32(s)` is Compact's `pad(32, s)`: the UTF-8 bytes, then zeros. Results are 0-based positions; pages show them as entry #1, #2, …

## The chain check (the certificate's second tick)

`src/chain.js` checks a spin against Midnight itself, in the visitor's browser: it reads the Nightcast contract's state from Midnight's own public node (`midnight_contractState` at the latest finalized block; no key, answers browsers) or from a Midnight indexer, decodes it with Midnight's on-chain runtime (`@midnightntwrk/onchain-runtime-v4` 4.0.0, WebAssembly), finds the request by its id and compares what the chain holds.

| Check | What it shows |
|---|---|
| Request id | `SHA-256(pad32("nightcast:alpha:v0") ‖ contract ‖ requester ‖ pad32(tag) ‖ seed)`, the contract's `requestId`, recomputed from the certificate's seed and the requester stored on chain: this is the request for this list, not another one |
| Fulfilled, with this output | the contract only stores an output whose VRF proof the network verified against the oracle key the request was bound to |
| Tag | `lunaspin|v1` |
| Oracle key and contract | the published Nightcast deployment (`DEPLOYMENTS`, from Nightcast's `deployments/preprod.json`) |

A request is stored as 14 values in the order of the contract's `Request` struct (v1): status, requester, tag, point (x, y), oracle key (x, y), deadline, output, fee, collateral, refund address, payout address, term. Each value is little-endian with its trailing zero bytes left off.

`dist/lunaspin-chain.js` is its browser build (`window.LunaSpinChain`, about 41 kB). It needs the runtime's `.wasm` file beside it (`npm run build` copies it to `dist/lunaspin-chain.wasm`, 1.6 MB, not committed; SHA-256 `a10579365a8bf303abdcedef906f4bdf4a159f189f19c86c654bd75d0a0c870d`, the package's own file, unchanged). The theme copies both to `assets/js/`.

`test/fixtures/preprod-state.json` is a real copy of the contract's state on Preprod (11 Nov 2026) with one real spin in it; `test/chain.test.mjs` checks that spin passes, and that a different output, seed, request, oracle key or contract fails.

What it doesn't show: that the node or indexer told the truth about the chain (ask another one, or run `./nightcast check`), or who runs the oracle.

## Checks

```
npm ci
npm test            # the JS rules against @nightcast/sdk 0.1.0 and the compiled @nightcast/contract 0.1.0, and the chain check against the saved state
npm run vectors     # rewrite test/vectors.json (fixed inputs and answers, mostly from the SDK)
php test/php-vectors.php   # the PHP twin against the same values
npm run build       # dist/lunaspin-core.js, dist/lunaspin-chain.js and the runtime's .wasm
```

CI (`.github/workflows/lunaspin.yml`) runs all four and fails if `test/vectors.json` or a bundle is out of date.

LunaSpin is live at [lunardraw.io/spin](https://lunardraw.io/spin/); the site's pages aren't in this repository. Design and progress: [issue #98](https://github.com/LearnMidnight/Lunardraw/issues/98).

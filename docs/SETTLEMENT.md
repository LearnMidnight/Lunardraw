# Starfall: private, automatic settlement

Status: 26 Oct 2026. Contract `contract/src/settlement.compact`, tested in the simulator (`contract/src/test/settlement.test.ts`). Trimmed to **12 circuits** so it can be deployed (see "The circuit budget"), with v0's security-review fixes ported. Not deployed yet. It sits next to the v0 contract (`lunardraw.compact`, [DESIGN.md](DESIGN.md)), which runs the Preprod soak and is unchanged.

The goal is the rule at the centre of Lunardraw:

> The blockchain must be able to verify that every winner has been counted and every prize calculated correctly, without learning the private numbers on each ticket.

v0 meets the privacy half by having winners **claim**: only a ticket's owner can prove it won. This contract removes the claim. A settler works through every ticket, and the contract checks each step, so nobody has to press a button and no ticket's numbers become public.

The game is Australian Powerball's, as the Starfall spec asks: 7 numbers from 35 plus a Moonball from 20, nine divisions, Powerball's prize-pool allocation and rollover rules, and QuickPick packages. A game costs 1.2 tNIGHT: 1 tNIGHT goes to the prize pool and 0.2 tNIGHT is the operator's fee, per game, so a ticket of several lines pays it once per line (a Mini QuickPick of 8 games costs 9.6 tNIGHT and pays 1.6 in fees). Syndicates are designed and tested but wait for a later contract (see "Syndicates").

## What happens to a ticket

1. **Purchase.** The buyer pays the ticket price in tNIGHT and publishes two things:
   - `C`, a commitment to the ticket (`SHA-256` over the draw, the line, up to three payees with their shares, and a random salt);
   - the same ticket **encrypted to the settlement key**.

   The purchase proof shows that both hold the same valid ticket: 7 increasing numbers in 1–35, a Moonball in 1–20, and shares adding up to 10,000 basis points. The buyer also names a public refund address. Tickets are numbered 0, 1, 2, … within the draw, in purchase order.

   `buyTickets(count, refundTo)` buys 1 to `maxGames()` = 3 games in one transaction, each with its own commitment, ciphertext and index, and returns the first index. A single game is `count = 1`. A QuickPick package (Single 1, Starter 4, Mini 8, Regular 12, Super 18, Mega 25, Jumbo 36, Maxi 50 games; `quickPickPackage` in the SDK) is a run of such purchases: a Maxi is 17 transactions. Choosing your own numbers is the same purchase with a chosen line.
2. **Sales close.** The count is frozen: no ticket can be added or removed.
3. **Draw.** As v0: the organiser's sealed seed, the oracle's VRF and the site's number rule. Each draw is bound to the active oracle key **when it opens**, so buyers can see which key will answer it. `requestDraw(n, seed, next)` reveals draw `n`'s seed and can open the next draw in the same transaction; `requestDraw(0, …, next)` just opens a draw. `computeNumbers(n, now)` puts the numbers in the ledger; its clock stamp may be up to **30 minutes** from block time, so a slow numbers proof still lands (v0 allows 10; Lunardraw #32).
4. **Settlement.** The settler decrypts every ticket with the settlement secret and calls `settleBatch` repeatedly. Each call covers the next 25 tickets in index order. For each ticket, the proof shows that the decrypted ticket hashes to the commitment stored at its index, then works out its division against the numbers stored in the ledger. Winning tickets become **entitlements** (division + payees) under the id `SHA-256(domain, C, salt)`. The salt is secret, so nobody can link an entitlement to a purchase.
5. **Finalise.** When the last ticket is settled, anyone calls `finaliseDraw`, which:
   - takes the operator fee off the sales to make the pool: `feePerGame` STAR for every ticket sold (0.2 tNIGHT of each 1.2 tNIGHT game, leaving 1 tNIGHT per game for prizes; the constructor requires the fee to be below the price), and **pays it to the operator address** in the same transaction;
   - gives each division its share of the pool, by Powerball's allocation (below), and adds the rollover to Division 1;
   - fixes each division's prize per winning ticket as `floor(division amount / winners)`;
   - applies Powerball's no-winner rules: an unwon Division 1 rolls over (the jackpot); an unwon Division 2–8 falls into the next lower division that has a winner; an unwon Division 9, all rounding remainders, and what the floored division shares leave of the pool (at most 8 STAR) roll over, so no STAR is ever stranded. Draws finalise in order.
6. **Payment.** Anyone calls `payEntitlement` for each entitlement (a keeper does it for all of them). Each payee after the first gets `floor(prize × share / 10000)` and the first gets the rest, so the prize is paid to the last STAR.
7. **Fail-safe.** If settlement isn't finalised by the settlement deadline (`settleWindow` after the numbers), anyone voids the draw and `refundTicket` sends every ticket's price to its refund address. Settling and finalising stop working at exactly the moment voiding becomes possible, so nobody can choose between the two. Entitlements recorded before a void are never paid. A draw is never redrawn.

## The nine divisions and the prize pool

The divisions and the pool allocation are Australian Powerball's. The allocation is the one [The Lott publishes](https://www.thelott.com/about/prize-pool) for draws from 1410 (25 May 2023) on; the no-winner rules are the Australian Powerball rules' (e.g. [WA Lotteries Commission (Powerball) Rules, rr. 22–24](https://www.legislation.wa.gov.au/legislation/prod/filestore.nsf/FileURL/mrdoc_29235.htm/$FILE/Lotteries%20Commission%20(Powerball)%20Rules%201996%20-%20%5B04-c0-01%5D.html), and the same in the SA rules): an unwon Division 1 jackpots; an unwon lower division goes to the next lower division with a winner; rounding surplus adjusts the Division 1 pool.

| Division | Winning combination | Share of the pool |
|---|---|---|
| 1 | 7 numbers + Moonball | 33.50% + rollover |
| 2 | 7 numbers | 1.85% |
| 3 | 6 numbers + Moonball | 2.30% |
| 4 | 6 numbers | 2.00% |
| 5 | 5 numbers + Moonball | 1.50% |
| 6 | 4 numbers + Moonball | 9.40% |
| 7 | 5 numbers | 7.30% |
| 8 | 3 numbers + Moonball | 15.50% |
| 9 | 2 numbers + Moonball | 26.65% |

Shares are stored in basis points (`shares()` in the contract, `POWERBALL_SHARES_BP` in the SDK) and sum to 10,000. Two things differ from Powerball, on purpose:
- **No guaranteed jackpot.** Powerball advertises a minimum Division 1; Starfall's jackpot is exactly 33.5% of the pool plus whatever rolled over, because the contract only pays what it holds. A guarantee would need a funded reserve.
- **No jackpot cap.** Powerball must pay out Division 1 after 25 rollovers. Starfall rolls over indefinitely; a cap (pay the jackpot down to the next division with a winner) is a small change to `finaliseDraw` once the product rule is decided.

The fee is a constructor parameter. A flat fee per game (decided 22 Oct 2026, replacing a 2% share of sales) means the operator's income scales with lines sold, and a multi-line ticket pays it once per line: price 1.2 tNIGHT = 1 tNIGHT to the pool + 0.2 tNIGHT to the operator. Whether 0.2 tNIGHT covers transaction fees and a keeper is still to be assessed.

**Site note:** the theme's `lunardraw_settle()` mirrors `finaliseDraw`; it must also add `pool − Σ floor(pool × bp / 10000)` to the carry (the rounding fix above).

## The oracle key and the organiser

v0's security-review fixes (Lunardraw #15, #16; merged for v0 in #20) apply here unchanged:
- **A draw is bound to the oracle key when it opens**, and no draw can open without an active key. A key change never reaches a draw that is selling or in progress.
- **A replacement key waits** `oracleKeyDelay` = `maxSales + revealWindow` from its proposal (`proposeOracleKey(key, now)`, `now` within 10 minutes of block time), longer than any draw can sell for, so a swap can't be slipped in quietly. Proposing again restarts the wait. The current oracle can approve a planned hand-over by calling `acceptOracleKey` itself, which lifts the wait. The first key is accepted at once.
- **The organiser can hand over and be recovered.** `changeOrganiser(commitment)`: the organiser proposes a successor, the successor accepts (passing its own commitment), or the **backup organiser** (a second secret set at deployment and kept offline) installs a new organiser at any time. The backup can never make itself the organiser.

## The circuit budget

A deploy transaction carries every circuit's verifier key and must fit Midnight's block limits: **12 circuits fit, 16 were rejected** (v0, 24 Oct 2026; node error `1010` with no custom code). The first version of this contract had 20. It now has exactly 12, merged by role as in v0:

| Circuit | Who calls it | Does |
|---|---|---|
| `acceptOracleKey` | proposed key's holder / current oracle | activate a proposed key / approve a hand-over |
| `proposeOracleKey` | organiser | propose a new oracle key (waits `oracleKeyDelay`) |
| `changeOrganiser` | organiser / successor / backup | propose / accept / recover |
| `requestDraw` | organiser | reveal a seed and open the next draw; `n = 0` only opens |
| `buyTickets` | anyone | buy 1–3 games (replaces `buyTicket`) |
| `fulfilDraw` | the draw's oracle | the VRF output |
| `computeNumbers` | anyone | the numbers |
| `settleBatch` | settlement key holder | settle the next 25 tickets |
| `finaliseDraw` | anyone | prizes and rollover, and pay the operator fee (replaces `withdrawFees`) |
| `payEntitlement` | anyone | pay a winning ticket's payees |
| `voidDraw` | anyone | void a draw past its deadline |
| `refundTicket` | anyone | refund a ticket of a void draw |

A test checks the list, and the CI `settlement-keys` job fails if the compiled contract has more than 12 verifier keys. Adding a circuit means merging another or dropping one. The 12 verifier keys come to **22,404 bytes** (1,351–2,311 each), about the same as v0's 12, which deployed.

## Syndicates

Syndicates (create, join, buy from pooled funds, pay members by shares, fill-or-refund, refund unspent, refund on void) are six more circuits, so they don't fit in this contract. The full design, contract and tests (the spec's 20-share, five-member example, unfilled and void refunds, and the four protections) are kept on branch `starfall-syndicates` (PR #2 as it was at 89f0228). Ways to bring them back:
- **When the limit rises or cross-contract calls arrive** (Compact 0.33+ / ledger 9, not on Preprod or Mainnet yet): a separate syndicate contract that holds members' funds and buys Starfall tickets as a player.
- **Off-chain, in the meantime:** a syndicate's games can already name up to three payees with shares, which covers small groups; larger groups need the contract.
- **Merging syndicate circuits by role** (one `syndicate` circuit for join/refund, folding member payments into `payEntitlement`) is possible but each merged circuit is as big as the largest of its parts, so it would cost every purchase and payment proof.

## What the contract guarantees, whoever settles

| Requirement | How |
|---|---|
| Every ticket counted | `finaliseDraw` needs the settlement pointer to equal the frozen ticket count |
| Each ticket exactly once, none invented | The pointer only moves forward, one index per slot; each slot's ticket must hash to the commitment stored at that index |
| Tickets not altered (numbers or payees) | Same hash check; changing anything changes the commitment |
| The right draw | The numbers are read from the ledger, set by the VRF and number rule; the settler doesn't supply them |
| The right oracle | Each draw keeps the key it opened with; a new key waits longer than any draw sells |
| Correct counts and prizes | Divisions are computed in the circuit; prizes follow from the counts, the shares and the pool; fee + prizes + rollover = sales, to the STAR |
| No double payment | Each entitlement has a `paid` flag; commitments can't be bought twice, so ids can't collide |
| Correct split between payees | `payEntitlement` arithmetic; the remainder goes to the first payee |
| Nothing stuck | Deadline → void → refunds by anyone, to addresses fixed at purchase |

The tests check each of these:
- 100 tickets, with winners in every division and split payees of 2 and 3, compared against an off-chain reference to the STAR, including the operator's fee payment;
- multi-game purchases and QuickPick packages, including a Maxi of 50 games;
- forged numbers, a redirected payee, swapped tickets, a missing ticket, a repeated ticket, a repeated batch, a wrong settlement key;
- finalising early, settling past the end, paying twice or before finalising;
- the deadline voiding with refunds, voiding a never-computed draw, and never voiding a settled one;
- rollover across draws, settlement order, an empty draw, the fee per game (1 + 8 + 3 lines pay 12 fees, and the rest of the price is the pool), a zero fee, and the fee-below-price rule;
- Powerball's rules: the allocation, the Division 1 rollover, the cascade of unwon Divisions 2–8, rounding to the carry, and the floored-share remainder (prizes paid + carry = pool + rollover for 200 random winner patterns, and in the contract with an awkward pool);
- the oracle key bound at opening, the key-change wait and approval, the organiser hand-over and backup recovery, the 30-minute clock tolerance, one draw selling at a time, no reused seed commitments, the sales-period limits;
- the circuit list (12).

## What stays private, and what doesn't

**Private:** every ticket's numbers and salt, and which purchase a winning entitlement belongs to.
- `settleBatch` reads the ledger the same way for every slot. All reads happen before any winner is recorded, so the transaction's public transcript shows how many winners a batch had, but not which slots they were.

**Public:**
- each purchase's buyer address (tNIGHT is unshielded on Preprod), refund address, commitment and ciphertext;
- each draw's numbers, ticket count and winner counts per division;
- each winning entitlement's division and payee addresses, at settlement;
- every payment.

**Known leaks:**
- **The settler sees every ticket.** This is stage 1: one key holder decrypts. That key is the only change needed for later stages. Stage 1b holds it inside an attested TEE (the MPS-0004 model). Stage 2 makes it a threshold key held by an MPC committee, which then also produces the batch proofs jointly. The ElGamal-style encryption already suits a threshold key. The contract doesn't change.
- **Batch-level linkage.** Winner counts per batch are public, so a winner is known to be one of the 25 tickets in that batch. Once Midnight supports proof recursion (roadmap Q4 2026, MPS-0014), folding the batches into one proof per draw removes this.
- **Payees are public at settlement**, and payments are visible: with unshielded tNIGHT a payout shows who received it. Shielded payouts (shielded contract tokens are on the Q4 2026 roadmap) fix this. One option then is to pay every ticket, losers getting zero.

## Encryption

The ticket is packed into 9 field elements:
- the 7 numbers, the Moonball and the three 2-byte shares (14 bytes, one element);
- each payee address in two 16-byte halves (six elements);
- the salt in two halves (two elements).

Encryption works like this:
- The buyer picks a random `r`.
- The ephemeral point is `R = r·G` on Jubjub (the curve Nightcast's VRF uses), and the shared point is `S = r·K`, where `K` is the settlement key.
- Each element is encrypted as `body[i] = packed[i] + Poseidon(S.x, S.y, i)`.

The settler recovers `S = k·R`. Both directions are pure circuits in the contract (`sealTicket`, `openTicket`), so off-chain code never re-implements them. The purchase proof computes the ciphertext from the same ticket it commits to, so a buyer can't publish a ticket the settler can't open. A buyer who chooses a weak `r` only exposes their own ticket.

## Circuit sizes (Compact 0.31.1)

Rows and k mock-compiled; proving keys built by the CI `settlement-keys` job (26 Oct 2026, 23 minutes for all 12).

| Circuit | k | Rows | Proving key |
|---|---|---|---|
| `buyTickets`, 3 games | 19 | 446,109 | about 145 MiB (4 games: k=20, 594,601 rows, 322 MiB) |
| `settleBatch`, 25 tickets | 19 | 353,320 | 145 MiB |
| `computeNumbers` (same as v0) | 19 | 323,756 | 145 MiB |
| `requestDraw` (reveal + open) | 16 | 62,325 | 20 MiB |
| `finaliseDraw` (Powerball rules, pays the fee) | 14 | 11,284 | 4 MiB |
| `fulfilDraw` | 13 | 5,816 | 2 MiB |
| `changeOrganiser` | 13 | 4,781 | 2 MiB |
| `proposeOracleKey` | 13 | 4,481 | 2 MiB |
| `payEntitlement` | 11 | 1,818 | < 1 MiB |
| `acceptOracleKey` | 10 | 922 | < 1 MiB |
| `refundTicket` | 9 | 271 | < 1 MiB |
| `voidDraw` | 9 | 252 | < 1 MiB |

A ticket costs about 14,000 rows of settlement and about 148,000 rows of purchase. The batch size and the games per purchase are fixed at compile time (`npm run gen:batch -w @lunardraw/contract -- <batch> <games>` regenerates `src/batch.compact`). Measured batches: 10 tickets k=18, 25 k=19, 50 k=20, 100 k=21. Purchases: **3 games would be k=19 (446,109 rows)**, 4 games k=20, 8 games k=21. Buyers prove their own purchases (Lace proves on the buyer's machine). **Decided 26 Oct 2026: 3 games per purchase (k=19).** With 4 games (k=20) the first end-to-end run's proof server used 13.8 GB proving one purchase and was killed for running out of memory on CI's 16 GB machine, while the k=19 `computeNumbers` proof peaks under 1 GB. So a purchase is k=19, like `settleBatch` and `computeNumbers`, at the cost of more transactions per package (a Maxi: 17 instead of 13). A 10,000-ticket draw takes 400 batch transactions until recursion is available.

### Proving on Midnight's proof server (CI, 27 Oct 2026)

Each circuit proved once on a fresh proof server 8.1.3 (the `prove-probe` CI job):

| Circuit | Time | Peak memory |
|---|---|---|
| `buyTickets`, 3 games | 115 s | 7.6 GB |
| `settleBatch`, 25 tickets | 104 s | 6.9 GB |
| `settleBatch`, 10 tickets | 54 s | 3.6 GB |
| `computeNumbers` | 102 s | 7.0 GB |
| `requestDraw` | 16 s | 1.0 GB |
| `finaliseDraw`, `fulfilDraw` | 2 s | 0.1 GB |
| `payEntitlement`, `voidDraw`, `acceptOracleKey` | < 1 s | ~0 |

The proof server keeps much of a proof's memory afterwards: on CI two purchases and the numbers left it big enough that the next settlement batch took it to 14 GB and it was killed. So the keeper proves one big proof at a time with a 30-second pause after each, and `./lunardraw proof-server` restarts the server whenever it has been idle for 10 seconds above its limit. **A machine that proves needs about 8 GB of memory free.** A player buying 3 games at a time needs the same on their own machine; one game per purchase (k=18) would need about half, at the cost of one transaction per game.

## Other limits

- **One line per ticket, four per transaction.** A package is several transactions. System and PowerHit-style entries (the spec's later stage) are many lines sharing numbers: they'd be bought as their underlying games, so a System 9 is 36 tickets and 9 transactions, with the commitment unchanged.
- **No subscriptions.** Multi-week entries need per-draw purchases, which an agent can do.
- **Purchases are sequential.** Each purchase takes the next index, so two purchases in the same block conflict and one must retry. Fine at prototype volume; a Merkle-tree set or per-block batching would lift it.
- **Settler liveness.** A settler who sees a result it dislikes can stop, and the draw voids and refunds. This is the same class of trust as the oracle's: a committee (stage 2) with t-of-n liveness reduces it.
- **Untested on a real network.** Block limits on a transaction's ledger operations (25 ticket lookups and up to 25 inserts in a batch, four sealed tickets in a purchase) are only known once it runs on Preprod. Next: the Starfall CLI (deploy with a test settlement key, keeper, buy), then a 100-ticket draw on Preprod.

## The keeper

`StarfallKeeper` (`keeper/src/starfall.ts`) runs every step above with nobody at the keyboard. Each pass it reads the contract and sends what's due, most urgent first:

| Draw is | The keeper sends |
|---|---|
| open, sales closed | `requestDraw`: reveal the seed and open the next draw |
| open, past the reveal deadline | `voidDraw` |
| requested, past the draw deadline | `voidDraw` (the oracle didn't answer) |
| fulfilled | `computeNumbers` (or `voidDraw` past the deadline) |
| drawn, tickets left to settle | decrypts the draw's tickets with the settlement secret (checking each against its commitment), then `settleBatch`, one batch of 25 a pass, in order |
| drawn, every ticket settled | `finaliseDraw`, once the draw before it is settled or void |
| drawn, past the settlement deadline | `voidDraw` |
| settled | `payEntitlement` for each unpaid entitlement |
| void | `refundTicket` for each ticket not refunded yet |

Payments and refunds are sent at most 5 a pass (`paymentsPerPass`), so a void draw with hundreds of tickets never holds up a reveal.

**Seeds** come from the organiser secret: draw *n*'s seed is SHA-256("starfall:seed:v1" ‖ organiser secret ‖ contract address ‖ *n*). There's no seeds file to lose or copy, and the contract never accepts a seed commitment twice, so no seed is revealed for two draws.

**Two keepers** (supported, not used yet: decided 26 Oct 2026 to run one keeper until real money is involved, since a missed reveal only voids and refunds a draw, and a standby means a second copy of the settlement secret). A *primary* (on the server) sends everything. A *standby* elsewhere, with its own wallet and copies of the organiser and settlement secrets, sends one of the primary's steps only after it has been due for `takeOverAfterSecs` (default 5 minutes) without the primary sending it. "Due" is per step: each settlement batch is a step of its own, so while the primary keeps settling, the standby keeps waiting; if the primary stops halfway, the standby carries on from the next batch. Once it has stepped in, the standby keeps sending the primary's steps (the next batches, the finalise, the payments) until there has been nothing to take over for the take-over time. Payments and refunds are **split**: with `split: { index, of }`, a payment belongs to share (first four bytes of the entitlement id) mod `of`, a refund to (ticket index) mod `of`. Each keeper sends its own share at once and the other's once it's overdue, so both wallets pay fees and either keeper alone still pays everyone. With two keepers: primary `{ index: 0, of: 2 }`, standby `{ index: 1, of: 2 }`. Keep the take-over time under the reveal window, or a standby can't save a reveal.

A keeper without the settlement secret skips settling; one without the organiser secret skips opening and revealing. One given the wrong settlement secret says so and doesn't settle.

## Files

| File | What it is |
|---|---|
| `contract/src/settlement.compact` | The contract |
| `contract/src/batch.compact` | Generated batch-size declarations (`scripts/gen-batch.py`) |
| `contract/src/settlement-tickets.ts` | Building tickets (`makeTicket` with payees), QuickPick packages, Powerball's prize rules (`prizesByPowerballRules`), the reference settlement (`expectedSettlement`), payee split |
| `contract/src/settlement-witnesses.ts` | Private state and witnesses: purchases, sealing randomness, settlement batches |
| `contract/src/settlement-simulator.ts` | In-memory simulator, including the settlement engine loop (`decryptDrawTickets`, `settleAll`), with v0's role helpers (`proposeOrganiser`, `acceptOrganiser`, `recoverOrganiser`, `approveOracleKey`) |
| `contract/src/test/settlement.test.ts` | Tests |
| `keeper/src/starfall.ts` | The Starfall keeper: chain view, plan, primary/standby roles and the payment split |
| `keeper/src/engine.ts` | Sending steps, retries and take-over, shared with v0's keeper |
| `keeper/src/test/starfall.test.ts` | The keeper's tests, on the simulator |

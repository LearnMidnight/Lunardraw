# Starfall: private, automatic settlement (prototype)

Status: prototype, 22 Oct 2026. Contract `contract/src/settlement.compact`, tested in the simulator (`contract/src/test/settlement.test.ts`). Not deployed. It sits next to the v0 contract (`lunardraw.compact`, [DESIGN.md](DESIGN.md)), which is unchanged.

The goal is the rule at the centre of Lunardraw:

> The blockchain must be able to verify that every winner has been counted and every prize calculated correctly, without learning the private numbers on each ticket.

v0 meets the privacy half by having winners **claim**: only a ticket's owner can prove it won. This contract removes the claim. A settler works through every ticket, and the contract checks each step, so nobody has to press a button and no ticket's numbers become public.

The game is Australian Powerball's, as the Starfall spec asks: 7 numbers from 35 plus a Moonball from 20, nine divisions, Powerball's prize-pool allocation and rollover rules, QuickPick packages, and syndicates that split their winnings by locked shares. A game costs 1.2 tNIGHT: 1 tNIGHT goes to the prize pool and 0.2 tNIGHT is the operator's fee, per game, so a ticket of several lines pays it once per line (a Mini QuickPick of 8 games costs 9.6 tNIGHT and pays 1.6 in fees). Every game, bought alone, in a package or by a syndicate, is the same kind of ticket and goes through the same settlement.

## What happens to a ticket

1. **Purchase.** The buyer pays the ticket price in tNIGHT and publishes two things:
   - `C`, a commitment to the ticket (`SHA-256` over the draw, the line, up to three payees with their shares, and a random salt);
   - the same ticket **encrypted to the settlement key**.

   The purchase proof shows that both hold the same valid ticket: 7 increasing numbers in 1–35, a Moonball in 1–20, and shares adding up to 10,000 basis points. The buyer also names a public refund address. Tickets are numbered 0, 1, 2, … within the draw, in purchase order.

   `buyTicket` buys one game; `buyTickets` buys up to `maxGames()` = 4 games in one transaction, each with its own commitment, ciphertext and index. A QuickPick package (Single 1, Starter 4, Mini 8, Regular 12, Super 18, Mega 25, Jumbo 36, Maxi 50 games; `quickPickPackage` in the SDK) is a run of such purchases: a Maxi is 13 transactions. Choosing your own numbers is the same purchase with a chosen line.
2. **Sales close.** The count is frozen: no ticket can be added or removed.
3. **Draw.** Same as v0: the organiser's sealed seed, the oracle's VRF and the site's number rule. The numbers end up in the ledger.
4. **Settlement.** The settler decrypts every ticket with the settlement secret and calls `settleBatch` repeatedly. Each call covers the next 25 tickets in index order. For each ticket, the proof shows that the decrypted ticket hashes to the commitment stored at its index, then works out its division against the numbers stored in the ledger. Winning tickets become **entitlements** (division + payees) under the id `SHA-256(domain, C, salt)`. The salt is secret, so nobody can link an entitlement to a purchase.
5. **Finalise.** When the last ticket is settled, anyone calls `finaliseDraw`, which:
   - takes the operator fee off the sales to make the pool: `feePerGame` STAR for every ticket sold (0.2 tNIGHT of each 1.2 tNIGHT game, leaving 1 tNIGHT per game for prizes; the constructor requires the fee to be below the price);
   - gives each division its share of the pool, by Powerball's allocation (below), and adds the rollover to Division 1;
   - fixes each division's prize per winning ticket as `floor(division amount / winners)`;
   - applies Powerball's no-winner rules: an unwon Division 1 rolls over (the jackpot); an unwon Division 2–8 falls into the next lower division that has a winner; an unwon Division 9 and all rounding remainders roll over. Draws finalise in order.
6. **Payment.** Anyone calls `payEntitlement` for each entitlement (a keeper does it for all of them). Each payee after the first gets `floor(prize × share / 10000)` and the first gets the rest, so the prize is paid to the last STAR. A payee that is a syndicate isn't paid directly: its part goes into a pot for that entitlement, and `paySyndicateMember` pays each member its share of the pot (below). `withdrawFees` sends collected fees to the operator address.
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
- **No jackpot cap.** Powerball must pay out Division 1 after 25 rollovers. The prototype rolls over indefinitely; a cap (pay the jackpot down to the next division with a winner) is a small change to `finaliseDraw` once the product rule is decided.

The fee is a constructor parameter. A flat fee per game (decided 22 Oct 2026, replacing a 2% share of sales) means the operator's income scales with lines sold, and a multi-line ticket pays it once per line: price 1.2 tNIGHT = 1 tNIGHT to the pool + 0.2 tNIGHT to the operator. Whether 0.2 tNIGHT covers transaction fees and a keeper is still to be assessed.

## Syndicates

A syndicate is a group that owns ordinary tickets together. It's not a different kind of ticket: its games go through the same purchase, settlement and payment as everyone else's, with the syndicate as the ticket's payee instead of an address.

1. **Create.** The creator calls `createSyndicate(draw, creatorCommitment, sharePrice, totalShares, games, joinDeadline)`. The contract checks `sharePrice × totalShares = ticketPrice × games` and that the join deadline is before sales close. The creator is identified by a commitment to a secret, not by an address, so an agent or a person can hold it. Who may join (public, invite-only, agents) is a front-end matter: the contract rule is the same for all three kinds in the spec.
2. **Join.** `joinSyndicate(syndicate, shares, payTo)` takes `sharePrice × shares` from the caller and records the member with its payout address. Members are numbered 0, 1, 2, … and can't be changed afterwards. When the last share sells the syndicate is **funded**.
3. **Buy.** Only the creator (with the secret) can call `buySyndicateTickets`, only once funded, only up to the funded number of games, and only with tickets whose single payee is the syndicate. No money moves: the games are paid from the members' contributions held by the contract.
4. **Win.** Settlement treats the tickets like any other. When an entitlement is paid, the syndicate's part is held in a pot, and anyone calls `paySyndicateMember` for each member: `floor(pot × shares / sharesSold)`, once per member per pot. The creator gets nothing unless it bought shares.
5. **Refund.** `refundSyndicateUnspent` returns a member's part of what wasn't spent: all of it if the syndicate hadn't filled by its join deadline (the spec's fill-or-refund rule: with 16 of 20 shares sold, all 16 contributions come back), or the unbought games' worth once sales close. `refundSyndicateVoid` returns a member's part of the tickets' price if the draw is voided; `refundTicket` marks a syndicate ticket refunded without sending anything, so the money can't go out twice.

The spec's four protections map to contract rules:

| Protection | Rule |
|---|---|
| No ownership changes after entry | Members and shares are append-only and joining stops at the deadline, before sales close |
| No secret tickets added | A syndicate's games are ordinary indexed tickets, so `finaliseDraw`'s "every ticket counted" covers them |
| No creator-controlled withdrawals | The only circuits that move a syndicate's funds buy agreed games (creator, bounded by `games`) or refund members by formula (anyone) |
| No double payouts | Pots are per entitlement payee; each member's payment and each refund kind is keyed and recorded once |

Rounding dust from `floor` stays in the contract (at most one STAR per member per payment). The members list, shares and payout addresses are public in this prototype; the spec's "private where supported" needs shielded membership, which is later work.

## What the contract guarantees, whoever settles

| Requirement | How |
|---|---|
| Every ticket counted | `finaliseDraw` needs the settlement pointer to equal the frozen ticket count |
| Each ticket exactly once, none invented | The pointer only moves forward, one index per slot; each slot's ticket must hash to the commitment stored at that index |
| Tickets not altered (numbers or payees) | Same hash check; changing anything changes the commitment |
| The right draw | The numbers are read from the ledger, set by the VRF and number rule; the settler doesn't supply them |
| Correct counts and prizes | Divisions are computed in the circuit; prizes follow from the counts, the shares and the pool |
| No double payment | Each entitlement has a `paid` flag; commitments can't be bought twice, so ids can't collide |
| Correct split between payees | `payEntitlement` arithmetic; the remainder goes to the first payee |
| Correct split within a syndicate | `paySyndicateMember` pays `floor(pot × shares / sharesSold)` from a pot the contract filled, once per member |
| Nothing stuck | Deadline → void → refunds by anyone, to addresses fixed at purchase (or to members, for a syndicate's tickets) |

The tests check each of these:
- 100 tickets, with winners in every division and split payees of 2 and 3, compared against an off-chain reference to the STAR;
- multi-game purchases and QuickPick packages, including a Maxi of 50 games;
- forged numbers, a redirected payee, swapped tickets, a missing ticket, a repeated ticket, a repeated batch, a wrong settlement key;
- finalising early, settling past the end, paying twice or before finalising;
- the deadline voiding with refunds, voiding a never-computed draw, and never voiding a settled one;
- rollover across draws, settlement order, an empty draw, the fee per game (1 + 8 + 3 lines pay 12 fees, and the rest of the price is the pool), a zero fee, and the fee-below-price rule;
- Powerball's rules: the allocation, the Division 1 rollover, the cascade of unwon Divisions 2–8, and rounding to the carry;
- syndicates: a 20-share syndicate of five members (the spec's example) that fills, buys its games, wins Division 1 and 8 and pays each member in proportion; an unfilled syndicate refunding every contribution; unspent funds and a voided draw refunded by shares; the creator-only, funded-only, agreed-games-only purchase rules; and the funding arithmetic at creation.

## What stays private, and what doesn't

**Private:** every ticket's numbers and salt, and which purchase a winning entitlement belongs to.
- `settleBatch` reads the ledger the same way for every slot. All reads happen before any winner is recorded, so the transaction's public transcript shows how many winners a batch had, but not which slots they were.

**Public:**
- each purchase's buyer address (tNIGHT is unshielded on Preprod), refund address, commitment and ciphertext;
- each draw's numbers, ticket count and winner counts per division;
- each winning entitlement's division and payee addresses (or syndicate id), at settlement;
- each syndicate's terms, members, shares and payout addresses, and which tickets it bought;
- every payment.

**Known leaks in this prototype:**
- **The settler sees every ticket.** This is stage 1: one key holder decrypts. That key is the only change needed for later stages. Stage 1b holds it inside an attested TEE (the MPS-0004 model). Stage 2 makes it a threshold key held by an MPC committee, which then also produces the batch proofs jointly. The ElGamal-style encryption already suits a threshold key. The contract doesn't change.
- **Batch-level linkage.** Winner counts per batch are public, so a winner is known to be one of the 25 tickets in that batch. Once Midnight supports proof recursion (roadmap Q4 2026, MPS-0014), folding the batches into one proof per draw removes this.
- **Payees are public at settlement**, and payments are visible: with unshielded tNIGHT a payout shows who received it. Shielded payouts (shielded contract tokens are on the Q4 2026 roadmap) fix this. One option then is to pay every ticket, losers getting zero.

## Encryption

The ticket is packed into 9 field elements:
- the 7 numbers, the Moonball and, per payee, a 2-byte share and a 4-byte syndicate id (26 bytes, one element);
- each payee address in two 16-byte halves (six elements);
- the salt in two halves (two elements).

Encryption works like this:
- The buyer picks a random `r`.
- The ephemeral point is `R = r·G` on Jubjub (the curve Nightcast's VRF uses), and the shared point is `S = r·K`, where `K` is the settlement key.
- Each element is encrypted as `body[i] = packed[i] + Poseidon(S.x, S.y, i)`.

The settler recovers `S = k·R`. Both directions are pure circuits in the contract (`sealTicket`, `openTicket`), so off-chain code never re-implements them. The purchase proof computes the ciphertext from the same ticket it commits to, so a buyer can't publish a ticket the settler can't open. A buyer who chooses a weak `r` only exposes their own ticket.

## Circuit sizes (mock-compiled, Compact 0.31.1)

| Circuit | k | Rows |
|---|---|---|
| `buyTickets` / `buySyndicateTickets`, 4 games | 20 | 628,105 / 632,075 |
| `settleBatch`, 25 tickets | 19 | 357,120 |
| `computeNumbers` (same as v0) | 19 | 323,756 |
| `buyTicket` (commitment + encryption) | 18 | 154,563 |
| `requestDraw` | 16 | 59,761 |
| `payEntitlement` | 14 | 13,617 |
| `finaliseDraw` (Powerball rules) | 14 | 9,982 |
| `paySyndicateMember` | 14 | 8,824 |
| `refundSyndicateUnspent` / `refundSyndicateVoid` | 13 | 3,176 / 2,913 |
| `createSyndicate` / `joinSyndicate` | 10 | 863 / 730 |
| `refundTicket` | 9 | 485 |

A ticket costs about 14,300 rows of settlement and about 155,000 rows of purchase. The batch size and the games per purchase are fixed at compile time (`npm run gen:batch -w @lunardraw/contract -- <batch> <games>` regenerates `src/batch.compact`). Measured batches: 10 tickets k=18, 25 k=19, 50 k=20, 100 k=21; purchases: 4 games k=20, 8 games k=21. 25 keeps settlement in the same size class as `computeNumbers`, which v0 already needs; 4 games keeps the purchase key around 300 MB. A 10,000-ticket draw takes 400 batch transactions until recursion is available. The CI `keys` job reports the real proving-key sizes.

## Other limits of the prototype

- **One line per ticket, four per transaction.** A package is several transactions. System and PowerHit-style entries (the spec's later stage) are many lines sharing numbers: they'd be bought as their underlying games, so a System 9 is 36 tickets and 9 transactions, with the commitment unchanged. A compact "System" purchase circuit that expands the combinations in-proof would cut that but multiply the purchase circuit.
- **No subscriptions.** Multi-week entries need per-draw purchases, which an agent can do; a standing-order circuit is later work.
- **Purchases are sequential.** Each purchase takes the next index, so two purchases in the same block conflict and one must retry. Fine at prototype volume; a Merkle-tree set or per-block batching would lift it.
- **Settler liveness.** A settler who sees a result it dislikes can stop, and the draw voids and refunds. This is the same class of trust as the oracle's: a committee (stage 2) with t-of-n liveness reduces it.
- **Not yet run on Preprod.** Next: deploy with a test settlement key, run a 100-ticket draw with a fixed seed, then with live Nightcast randomness.

## Files

| File | What it is |
|---|---|
| `contract/src/settlement.compact` | The contract |
| `contract/src/batch.compact` | Generated batch-size declarations (`scripts/gen-batch.py`) |
| `contract/src/settlement-tickets.ts` | Building tickets (`makeTicket` with payees or a syndicate), QuickPick packages, Powerball's prize rules (`prizesByPowerballRules`), the reference settlement (`expectedSettlement`), payee and member splits |
| `contract/src/settlement-witnesses.ts` | Private state and witnesses: purchases, sealing randomness, the syndicate creator's secret, settlement batches |
| `contract/src/settlement-simulator.ts` | In-memory simulator, including the settlement engine loop (`decryptDrawTickets`, `settleAll`) |
| `contract/src/test/settlement.test.ts` | Tests |

# Starfall: private, automatic settlement

Status: 27 Oct 2026 (entries: PR #41). Contract `contract/src/settlement.compact`, tested in the simulator (`contract/src/test/settlement.test.ts`). Trimmed to **12 circuits** so it can be deployed (see "The circuit budget"), with v0's security-review fixes ported. **Live on Preprod** since 27 Oct 2026; the current deployment is `8d9f297f…dc75` (7 Nov 2026, [deployments/starfall-preprod.json](../deployments/starfall-preprod.json)), where a game costs 1.3 tNIGHT. It sits next to the v0 contract (`lunardraw.compact`, [DESIGN.md](DESIGN.md)), which ran the first Preprod soak and is unchanged.

The goal is the rule at the centre of Lunardraw:

> The blockchain must be able to verify that every winner has been counted and every prize calculated correctly, without learning the private numbers on each ticket.

v0 meets the privacy half by having winners **claim**: only a ticket's owner can prove it won. This contract removes the claim. A settler works through every ticket, and the contract checks each step, so nobody has to press a button and no ticket's numbers become public.

The game is Australian Powerball's, as the Starfall spec asks: 7 numbers from 35 plus a Moonball from 20, nine divisions, Powerball's prize-pool allocation and rollover rules, QuickPick packages, and **System, Pick and Moonball Sweep entries, each one ticket however many games it holds** (see "Entries"). A game costs 1.3 tNIGHT: 1 tNIGHT goes to the prize pool and 0.3 tNIGHT is the operator's fee, per game, so a ticket of several games pays it once per game (a System 9 is 36 games: 46.8 tNIGHT, 10.8 in fees). Contracts deployed before 6 Nov 2026 charge 1.2 tNIGHT with a 0.2 fee; the price and fee are deploy settings, not code. Syndicates are designed and tested but wait for a later contract (see "Syndicates").

## What happens to a ticket

1. **Purchase.** The buyer pays the ticket price in tNIGHT and publishes two things:
   - `C`, a commitment to the ticket (Poseidon over the draw, the entry, its lines, up to three payees with their shares, and a random salt);
   - the same ticket **encrypted to the settlement key**.

   The purchase proof shows that both hold the same valid ticket (an entry of a type the contract knows, its numbers increasing in 1–35, a Moonball in 1–20 or Moonball Sweep, each line a standard game or empty, and shares adding up to 10,000 basis points) and charges the ticket's **games × the game price**. The buyer also names a public refund address. Tickets are numbered 0, 1, 2, … within the draw, in purchase order; each record stores its games, and the draw counts games sold.

   `buyTickets(count, refundTo)` buys 1 to `maxTickets()` = 7 tickets in one transaction, each with its own commitment, ciphertext and index, and returns the first index. A ticket holds its entry plus up to `maxLines()` = 11 extra standard games (see "Lines"), so standard games go 12 to a ticket: a QuickPick package (Single 1, Starter 4, Mini 8, Regular 12, Super 18, Mega 25, Jumbo 36, Maxi 50 games; `quickPickPackage` in the SDK, `ticketsFor` for any list of entries) is 1 to 5 tickets, and **every package is one transaction**. A purchase holds up to 84 standard games. A System, a Pick or a Moonball Sweep is one ticket: a Pick 5 with Moonball Sweep (8,700 games) is one transaction.
2. **Sales close.** The count is frozen: no ticket can be added or removed.
3. **Draw.** As v0: the organiser's sealed seed, the oracle's VRF and the site's number rule. Each draw is bound to the active oracle key **when it opens**, so buyers can see which key will answer it. `requestDraw(n, seed, next)` reveals draw `n`'s seed and can open the next draw in the same transaction; `requestDraw(0, …, next)` just opens a draw. `computeNumbers(n, now)` puts the numbers in the ledger; its clock stamp may be up to **30 minutes** from block time, so a slow numbers proof still lands (v0 allows 10; Lunardraw #32).
4. **Settlement.** The settler decrypts every ticket with the settlement secret and calls `settleBatch` repeatedly. Each call covers the next 14 tickets in index order (up to 168 QuickPick games). For each ticket, the proof shows that the decrypted ticket hashes to the commitment stored at its index, then counts its winning games per division against the numbers stored in the ledger (without listing them: see "Entries"). Winning tickets become **entitlements** (winning games per division + payees) under the id `Poseidon(domain, C, salt)`. The salt is secret, so nobody can link an entitlement to a purchase.
5. **Finalise.** When the last ticket is settled, anyone calls `finaliseDraw`, which:
   - takes the operator fee off the sales to make the pool: `feePerGame` STAR for every game sold (0.3 tNIGHT of each 1.3 tNIGHT game, leaving 1 tNIGHT per game for prizes; the constructor requires the fee to be below the price), and **pays it to the operator address** in the same transaction;
   - gives each division its share of the pool, by Powerball's allocation (below), and adds the rollover to Division 1;
   - fixes each division's prize per winning game as `floor(division amount / winning games)`;
   - applies Powerball's no-winner rules: an unwon Division 1 rolls over (the jackpot); an unwon Division 2–8 falls into the next lower division that has a winner; an unwon Division 9, all rounding remainders, and what the floored division shares leave of the pool (at most 8 STAR) roll over, so no STAR is ever stranded. Draws finalise in order.
6. **Payment.** Anyone calls `payEntitlement` for each entitlement (a keeper does it for all of them). The ticket's prize is its winning games times each division's prize per game. Each payee after the first gets `floor(prize × share / 10000)` and the first gets the rest, so the prize is paid to the last STAR.
7. **Fail-safe.** If settlement isn't finalised by the settlement deadline (`settleWindow` after the numbers), anyone voids the draw and `refundTicket` sends every ticket's price to its refund address. A ticket's refund is every game in it. Settling and finalising stop working at exactly the moment voiding becomes possible, so nobody can choose between the two. Entitlements recorded before a void are never paid. A draw is never redrawn.
8. **Ticket limit.** A draw sells at most `maxTicketsPerDraw` tickets (a deploy setting; purchases past it fail with "draw is full", all or nothing). Settlement goes through the tickets one batch at a time and must finish within `settleWindow`, so the limit is set below what can be settled in time: the defaults are a day to settle and 10,000 tickets, against roughly 15,000 settleable in a day (14 tickets a batch, about 70–90 s a batch). Without it, a flood of cheap purchases could push a draw past its deadline and void it, at no cost to the flooder (every ticket is refunded) but one refund transaction per ticket for whoever refunds; with it, the flood only fills the draw, with tickets that are real bets. Draws finalise in order, so a draw that can't be settled holds up the payouts of the draws after it until its deadline voids it; the one-day window keeps that to one daily draw.

## Entries: System, Pick and Moonball Sweep (27 Oct 2026)

A ticket is one **entry**, `Entry { kind, count, numbers[12], moonball, sweep }`:

| Entry | Numbers | Games | Price at 1.3 tNIGHT a game |
|---|---|---|---|
| Standard | 7 | 1 | 1.3 |
| System 8 / 9 / 10 / 11 / 12 | 8–12, every 7 of them | 8 / 36 / 120 / 330 / 792 | 10.4 / 46.8 / 156 / 429 / 1,029.6 |
| Pick 6 | 6, plus each of the other 29 | 29 | 37.7 |
| Pick 5 | 5, plus each pair of the other 30 | 435 | 565.5 |
| Moonball Sweep (any of the above) | every Moonball | × 20 | × 20 |

A PowerHit-style ticket is a standard game with Moonball Sweep (20 games). The largest entry, a System 12 with Moonball Sweep, is 15,840 games.

**Why one ticket.** When each game was its own ticket, a Pick 5 with Moonball Sweep meant 4,350 purchase transactions (each a proof and a wallet approval) and 348 settlement batches. Now any entry is one purchase slot and one settlement slot, so big entries cost a buyer one transaction and the keeper one batch slot.

**Settling an entry without listing its games.** Real lotteries settle systems the same way: if *h* of an entry's numbers are among the 7 drawn, the number of its games with exactly *m* main numbers right depends only on its type and *h*:
- System *n* (7 ≤ *n* ≤ 12): C(*h*, *m*) · C(*n* − *h*, 7 − *m*);
- Pick *f* (*f* = 5, 6): C(7 − *h*, *m* − *h*) · C(28 − *f* + *h*, 7 − *f* − (*m* − *h*)), for *m* ≥ *h*.

`gamesByDivision` counts *h*, looks up the row (type, *h*) in a 64-row table of those counts for *m* = 2..7 (`entries.compact`, generated by `scripts/gen-entries.py`, which checks every row against a brute-force listing of the games before writing it), and splits by Moonball: with one Moonball all of an entry's games match it or none do; with Moonball Sweep one Moonball in 20 matches, so each count goes once to "with Moonball" and 19 times to "without". Then the divisions: 1 = 7 + MB, 2 = 7, 3 = 6 + MB, 4 = 6, 5 = 5 + MB, 6 = 4 + MB, 7 = 5, 8 = 3 + MB, 9 = 2 + MB. The tests compare this with listing every game of every type, for every *h*, Moonball hit or miss, with and without Sweep.

**Prizes are unchanged.** Winner counts, sales and the fee are all in games, so `finaliseDraw`'s Powerball rules don't change: a System ticket with 18 games in Division 5 counts as 18 winners there, exactly as if those games had been bought one by one.

**What it shows.** A ticket record shows how many games it holds (the payment for it is public anyway), and a winning entitlement shows its winning games per division. A pattern such as 2 games in Division 3 and 27 in Division 5 says the ticket was a big entry, but neither shows its numbers.

## Lines: QuickPicks 12 to a ticket (6 Nov 2026)

Besides its entry, a ticket carries up to `maxLines()` = 11 **lines**, `Line { numbers[7], moonball }`: extra standard games, each 7 numbers increasing in 1–35 and a Moonball in 1–20, or all zero when unused. A ticket of standard games therefore holds up to 12 (its entry is the first), and `ticketsFor` packs a list of entries that way: standard games 12 to a ticket, every System, Pick or Sweep a ticket of its own (lines may also ride on one; the SDK doesn't do that). A ticket's games are its entry's plus one per used line; it pays and refunds for all of them, and its entitlement counts the winning games of its entry and its lines together.

**Why.** When each QuickPick game was its own ticket, a Maxi was 3 purchase transactions and 50 settlement slots, and each winning game its own payout. A ticket costs about 6,000 rows to buy and 5,000 to settle (two Jubjub multiplications, the commitment, the entry's table); a line costs about 250 to buy and 300 to settle. So:

| | One game a ticket (before) | 12 games a ticket |
|---|---|---|
| Tickets per purchase | 18 (18 games) | 7 (up to 84 games; 13 until 7 Nov 2026) |
| Transactions for a Maxi (50 games) | 3 | 1 |
| QuickPick games per settlement batch | 22 | 168 |
| Payouts for a ticket's winning games | one per game | one per ticket |
| Systems, Picks or Sweeps per purchase / per batch | 18 / 22 | 13 / 14 |
| `buyTickets` / `settleBatch` | k=17, 113,126 / k=17, 110,154 | k=17, 117,629 / k=17, 116,826 |

The proofs stay at k=17 with the same headroom, so buyers need the same ~1.3 GB. The one cost is that a big entry's slot now also carries 11 lines, so fewer Systems, Picks and Sweeps fit a purchase or a batch; they are few and costly, and QuickPicks are most of what's bought.

**How a line is scored.** `lineHits` counts a line's numbers among the drawn ones: x is drawn exactly when (x − n₁)(x − n₂)…(x − n₇) = 0 (a prime field, and every value is below 256), seven multiplications instead of seven comparisons. Its division then follows from the count and whether its Moonball is drawn, as for a standard game. `ticketDivisions` (generated by `scripts/gen-lines.py`) writes the sum over the lines out in full rather than folding, so the compiler knows each count is at most 11 and needs no range check per line: that took a line from about 870 rows to 300. An unused line counts nothing: 0 is never a drawn number, nor Moonball 0. The tests check every count of hits, with and without the Moonball, in each of the 11 line positions, against listing the games.

**What changes elsewhere.** Lines are packed three (24 bytes) to a field element, so a sealed ticket is 12 elements instead of 9 (the old 9th was unused), and the commitment hashes the lines in that packed form (one-to-one, since each byte is a `Uint<8>`; hashing 88 separate bytes cost about 70 rows more per line). Its domain tag is `starfall:ticket:v3`. Validation needs only the last number of a line checked against 35, since they increase from above 0. Prizes are unchanged: winners, sales and fees were already counted in games. A ticket of 12 QuickPicks shows 12 games, which a System 12 could not (792), but no numbers, as before.

Alternatives measured and rejected: proving more tickets per purchase (36 tickets would be k=18, ~3.6 GB, 50 about k=19, ~7 GB: too heavy for browsers and the player prover); deriving a QuickPick ticket's games from a seed inside the settlement proof (drawing 7 distinct numbers from a hash in a circuit costs far more than a line, and settlement would differ from what the buyer was shown); and sending several purchases behind one click (still a proof, a wallet approval and a fee each, and no lighter settlement).

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
- **A shorter jackpot cap.** Powerball must pay out Division 1 after 25 rollovers. Starfall's must be won after `mustBeWonAfter` rollovers in a row (5 by default, UK Lotto's rule), because at 1 in 134.5 million and Lunardraw's player numbers a jackpot would almost never be won (at 1,000 games a week, about once in 2,600 years). See "Must be won after 5 rollovers" below.

The fee is a constructor parameter. A flat fee per game (decided 22 Oct 2026, replacing a 2% share of sales) means the operator's income scales with lines sold, and a multi-line ticket pays it once per line: price 1.3 tNIGHT = 1 tNIGHT to the pool + 0.3 tNIGHT to the operator (since 6 Nov 2026; Jack's decision). The operator fee pays the running costs (NIGHT held to generate the keeper's and oracle's DUST, hosting, Blockfrost) and the creator's cut, taken from the operator wallet by hand. Whether 0.3 tNIGHT covers the running costs at scale is to be measured (DUST per transaction).

**Site note:** the theme's `lunardraw_settle()` mirrors `finaliseDraw`; it must also add `pool − Σ floor(pool × bp / 10000)` to the carry (the rounding fix above).

### Must be won after 5 rollovers (7 Nov 2026)

A decision taken after comparing real lotteries' rules (Nov 2026): after `mustBeWonAfter` jackpot rollovers in a row (a sealed deploy setting, 5 by default, `--must-be-won-after`, 0 for never), the next draw's jackpot must be won.

- **Counting.** The ledger's `rollovers` counts finalised draws in a row whose jackpot rolled over; void draws don't count.
- **The must-be-won draw.** Once `rollovers` reaches `mustBeWonAfter`, the next draw finalised drops an unwon Division 1 (its share and all the rollover) to the next division with a winner. That's the same rolldown the final draw uses. What no division takes rolls over as usual, so the game goes on.
- **Resetting.** A jackpot won, or given out to a lower division, sets the count back to 0. A must-be-won draw that found no winner anywhere keeps the count, so the next one must be won too.
- **Records.** `Draw.mustBeWon` records it when the draw is finalised.
- **Players know before they buy.** The feed's open draw says `must_be_won: "yes"`, or `"possible"` while the draw before it is still settling (its own result decides). Status and the agent kit say so too. With daily draws, an unwon jackpot is given out every 6th day.
- **Cost.** No new circuit: `finaliseDraw` is 12,171 rows (k=14) as deployed.

### Tickets per purchase: 7 (7 Nov 2026)

`maxTickets()` went from 13 to 7 (`gen-batch.py 14 7`), so `buyTickets` is in the k=16 class: **64,808 rows** as compiled with keys for the deployment `8d9f297f…` (it was k=17). That's about half the proving key and proving time for every purchase. The largest QuickPick package (Maxi, 50 games) is 5 tickets, so every package is still one transaction. Only 8 or more Systems, Picks or Sweeps at once take a second. **The margin to k=16's 65,536 rows is only 728 rows**, so almost any change to `buyTickets` goes back to k=17; measure with `compact compile` (the key build), not `zkir mock-compile`, which counted about 1,400 fewer.

### The final draw: the jackpot must be won (7 Nov 2026)

A contract can't send its rollover anywhere, so a game that just stopped would leave its unwon jackpot locked in it for good (the first Preprod deployment, `f868fc99…`, kept 17,729.5 tNIGHT that way). Starfall's last draw is therefore a **final draw** (Jack's decision, 7 Nov 2026):

- **Normal draws are unchanged:** an unwon jackpot rolls over, so it grows for the life of the game.
- **The final draw is marked before it sells.** `NextDraw.final` sets `Draw.final` when the draw opens, so the draw on sale is never changed mid-sale. It must sell for at least `finalSales` (sealed at deploy; 7 days by default), so everyone can see it coming and buy in. The feed (`final: true`), the site and the agent kit say so.
- **Its jackpot must be won.** In `finaliseDraw` an unwon Division 1 (its share plus all the rollover) falls to the next division with a winner, as unwon Divisions 2–8 already do.
- **Nothing is kept back.** What no division takes (an unwon Division 9 with whatever fell into it, rounding remainders, or everything if nobody won anything) is shared equally by every game sold: `Draw.finalShare` per game, paid to each ticket's refund address by `refundTicket` (which pays a void draw's refunds too). The last fraction of a STAR per game goes with the operator fee. The contract then holds no rollover, `ended` is set, and no draw opens again.
- **Edge cases.** A final draw that sold nothing keeps the rollover, and another final draw may follow. A void final draw is refunded at the ticket price as usual, and another final draw may follow. While a final draw runs, nothing else opens.
- **Why the notice period.** With few games in the final draw, its players share a large rollover. A week's notice on the site, the feed and in the kit lets anyone take part, so the operator can't quietly take it.
- **No new circuit.** It changes `requestDraw` (the flag), `finaliseDraw` (the rolldown and the share) and `refundTicket` (paying shares). `settleBatch` and `buyTickets` are unchanged in what they do.
- **The keeper.** `./lunardraw starfall last-draw` now makes the keeper's next draw the final draw (at the reveal of the draw on sale, or directly if nothing is selling and there's a rollover to give out). It pays every share like a refund, then reports "wound down". `status` says so too.

A redeploy still starts the next game's jackpot at zero. Redeploying rarely, and testing on Preprod first, keeps that rare. A treasury top-up of a new game's first jackpot needs a circuit slot (`seedJackpot`). Moving a rollover to a successor contract, possible with ledger 9's contract-to-contract calls, would mean trusting whoever names the successor, so it isn't done.

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
| `buyTickets` | anyone | buy 1–7 tickets of up to 12 standard games each, or Systems, Picks, Sweeps (replaces `buyTicket`) |
| `fulfilDraw` | the draw's oracle | the VRF output |
| `computeNumbers` | anyone | the numbers |
| `settleBatch` | settlement key holder | settle the next 14 tickets |
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
- each draw's numbers, ticket and game counts, and winning games per division;
- each ticket's number of games (so its entry's size; the payment shows it too);
- each winning entitlement's winning games per division and payee addresses, at settlement;
- every payment.

**Known leaks:**
- **The settler sees every ticket.** This is stage 1: one key holder decrypts. That key is the only change needed for later stages. Stage 1b holds it inside an attested TEE (the MPS-0004 model). Stage 2 makes it a threshold key held by an MPC committee, which then also produces the batch proofs jointly. The ElGamal-style encryption already suits a threshold key. The contract doesn't change.
- **Batch-level linkage.** Winner counts per batch are public, so a winner is known to be one of the 14 tickets in that batch. Once Midnight supports proof recursion (roadmap Q4 2026, MPS-0014), folding the batches into one proof per draw removes this.
- **Payees are public at settlement**, and payments are visible: with unshielded tNIGHT a payout shows who received it. Shielded payouts (shielded contract tokens are on the Q4 2026 roadmap) fix this. One option then is to pay every ticket, losers getting zero.

## Encryption

The ticket is packed into 9 field elements:
- the 7 numbers, the Moonball and the three 2-byte shares (14 bytes, one element);
- each payee address in two 16-byte halves (six elements), which the ticket carries as two `Uint<128>`s;
- the salt, a random field element (one element);
- one zero element.

Encryption works like this:
- The buyer picks a random `r`.
- The ephemeral point is `R = r·G` on Jubjub (the curve Nightcast's VRF uses), and the shared point is `S = r·K`, where `K` is the settlement key.
- Each element is encrypted as `body[i] = packed[i] + Poseidon(S.x, S.y, i)`.

The settler recovers `S = k·R`. Both directions are pure circuits in the contract (`sealTicket`, `openTicket`), so off-chain code never re-implements them. The purchase proof computes the ciphertext from the same ticket it commits to, so a buyer can't publish a ticket the settler can't open. A buyer who chooses a weak `r` only exposes their own ticket.

## Circuit sizes (Compact 0.31.1)

**As deployed (`8d9f297f…`, 7 Nov 2026, `compact compile` with keys):** acceptOracleKey k=10 (916 rows), buyTickets k=16 (64,808), changeOrganiser k=13 (4,790), computeNumbers k=19 (323,759), finaliseDraw k=14 (12,171), fulfilDraw k=13 (5,819), payEntitlement k=16 (65,382: 154 rows to spare), proposeOracleKey k=13 (4,481), refundTicket k=9 (496), requestDraw k=16 (62,595), settleBatch k=17 (125,233: about 5,800 to spare), voidDraw k=9 (255). The figures below are older measurements, some from `zkir mock-compile`, which counts fewer rows than the key build.

Mock-compiled with the zkir tool (27 Oct 2026, after the changes below; this tool version counts rows a little differently from the one used before). CI's `starfall-e2e` job builds the real keys and reports their sizes.

| Circuit | k | Rows |
|---|---|---|
| `computeNumbers` (same as v0) | 19 | 291,706 |
| `buyTickets`, 2 tickets (entries) | 17 | 107,142 |
| `settleBatch`, 25 tickets (before entries) | 17 | 70,381 |
| `requestDraw` (reveal + open) | 17 | 69,803 |
| `fulfilDraw` | 14 | 11,610 |
| `changeOrganiser` | 14 | 10,202 |
| `proposeOracleKey` | 14 | 9,869 |
| `finaliseDraw` (Powerball rules, pays the fee) | 13 | 4,232 |
| `payEntitlement` | 11 | 1,334 |
| `acceptOracleKey` | 11 | 1,076 |
| `voidDraw` | 10 | 306 |
| `refundTicket` | 10 | 186 |

**Making the proofs lighter (decided 27 Oct 2026).** The first end-to-end runs showed a k=19 proof needs about 7 GB on the proof server, and buyers prove their own purchases. Measuring variants of the contract showed where the rows went, and two changes took out most of them:

1. **Packing a ticket for encryption** split each 32-byte value (three payee addresses and the salt) with `slice<16>(b, …) as Field`, about 25,000 rows each. `lo16` / `hi16` now fold the value's bytes into a Field by hand (the same result). The encryption itself (two Jubjub multiplications and nine Poseidon hashes per game) was never the cost.
2. **Ticket commitments and entitlement ids use Poseidon** (`transientHash`), not SHA-256 (`persistentHash`). Settling a batch checks 25 commitments and works out up to 25 ids, and SHA-256 made the batch k=20 (758,210 rows); with Poseidon it's k=17 (70,381). Compact may change `transientHash` between compiler versions, but the contract is deployed locked, so its hash never changes; everyone buys and settles with its own compiled circuits anyway (the proving keys require it). The domain tags are now `starfall:ticket:v2` and `starfall:entitlement:v2`.

With both, a purchase is **2 games** (k=17, about 1 GB to prove: an ordinary laptop can), at the cost of more transactions per package (a Starter is 2, a Maxi 25). For comparison, the same purchase had been 3 games at k=19 (418,932 rows, 7.6 GB) and 4 games at k=20 (13.8 GB, killed on CI). One game would be k=16, three k=18. `computeNumbers` stays at k=19: it applies the published number rule, SHA-256 of the seed and the VRF output, which the site and anyone else can check with ordinary tools; it runs once per draw, on the keeper's server.

**With entries (27 Oct 2026),** measured with the workspace's zkir tool, which counts more rows than the one above, so compare like with like:

| Circuit | Before entries | With entries |
|---|---|---|
| `buyTickets`, 2 tickets | k=17, 108,203 | k=17, 101,340 (the 22-byte head is folded by hand) |
| `settleBatch`, 25 tickets | k=17, 87,245 | k=18, 139,985 |
| `settleBatch`, **22 tickets (chosen)** | | **k=17, 123,287** |
| `payEntitlement` | k=11, 1,818 | k=12, 2,937 |

An entry adds about 2,100 rows per settled ticket (counting hits, the table row, the Moonball split), so 25 tickets crossed into k=18, which would double each batch's proving time for 3 more tickets. 22 keeps settlement at k=17. Buyers' purchases are unaffected.

**Lighter tickets (28 Oct 2026).** Buying a QuickPick package took many transactions (a Maxi was 25), and wallets struggle to land that many in a row. Measuring `buyTickets` showed each ticket cost about 50,000 rows, and about 45,000 of those were still the byte folding of item 1 above: three payee addresses and the salt, each 32 bytes, turned into field elements. A ticket now carries each payee address as two `Uint<128>` halves and its salt as a `Field`, so packing it for encryption costs nothing, and only `payEntitlement` joins the halves back into an address to pay it. A ticket is now about 6,500 rows:

| Circuit | Before | Lighter tickets |
|---|---|---|
| `buyTickets` | 2 tickets, k=17, 101,340 | **18 tickets, k=17, 117,628** |
| `settleBatch`, 22 tickets | k=17, 123,287 | k=17, 117,787 |
| `payEntitlement` | k=12, 2,937 | k=16, 65,379 (joining three addresses; well under 1 GB) |

For comparison, 2 lighter tickets are k=14 (13,702), 10 are k=16 and 20 are k=17 with too little headroom (130,619), so 18 is the most that keeps a purchase at k=17 (about 1.3 GB to prove, the same as before). The address halves and the salt are part of the commitment, so this needs a new deployment.

**With lines (6 Nov 2026),** measured with the workspace's zkir tool (see "Lines" for the reasons):

| Circuit | One game a ticket | 11 lines a ticket |
|---|---|---|
| `buyTickets` | 18 tickets, k=17, 113,126 | **7 tickets, k=16, 64,808** (13 tickets were k=17) |
| `settleBatch` | 22 tickets, k=17, 110,154 | **14 tickets, k=17, 116,826** |
| `payEntitlement` | | k=16, 50,285 |
| `refundTicket` | | k=10, 222 |

One more of either (14 tickets a purchase, 15 a batch) is 126,651 / 125,141 rows, too close to k=17's 131,072. With 9 lines the best is 14 tickets a purchase and 16 a batch (119,190 / 124,048: 140 and 160 games), with 12 lines 13 and 14 (120,632 / 120,704: 169 and 182 games, less headroom); 11 lines gives tickets of 12 games, the size of a Regular package.

The batch size and the tickets per purchase are fixed at compile time (`npm run gen:batch -w @lunardraw/contract -- <batch> <tickets>` regenerates `src/batch.compact`), and so are the lines per ticket (`python3 contract/scripts/gen-lines.py <lines>` regenerates `src/lines.compact` and checks the vector lengths in `settlement.compact` that follow from it). A draw of 10,000 tickets takes 715 batch transactions until recursion is available, but a ticket can hold up to 15,840 games, and 10,000 QuickPick games are 834 tickets, 60 batches.

### Proving on Midnight's proof server (CI, 27 Oct 2026)

Each circuit proved once on a fresh proof server 8.1.3 (the `prove-probe` CI job):

| Circuit | Time | Peak memory |
|---|---|---|
| `buyTickets`, 3 games (before the changes above) | 115 s | 7.6 GB |
| `settleBatch`, 25 tickets (before) | 104 s | 6.9 GB |
| `settleBatch`, 10 tickets (before) | 54 s | 3.6 GB |
| `computeNumbers` | 102 s | 7.0 GB |
| `requestDraw` | 16 s | 1.0 GB |
| `finaliseDraw`, `fulfilDraw` | 2 s | 0.1 GB |
| `payEntitlement`, `voidDraw`, `acceptOracleKey` | < 1 s | ~0 |

The proof server keeps much of a proof's memory afterwards: on CI two purchases and the numbers left it big enough that the next settlement batch took it to 14 GB and it was killed. So the keeper proves one big proof at a time with a 30-second pause after each, and `./lunardraw proof-server` restarts the server whenever it has been idle for 10 seconds above its limit. **The keeper's machine needs about 8 GB free** for the numbers proof. With the changes above a purchase and a settlement batch are k=17, about the size of `requestDraw` (1 GB).

## Other limits

- **7 tickets per transaction** (13 until 7 Nov 2026, cut so the purchase proof is the half-size k=16 class: about half the proving key and time). Standard games go 12 to a ticket, so every QuickPick package is still one transaction (up to 84 games). A System, Pick or Moonball Sweep entry is one ticket.
- **No subscriptions.** Multi-week entries need per-draw purchases, which an agent can do.
- **Purchases are sequential.** Each purchase takes the next index, so two purchases in the same block conflict and one must retry. Fine at prototype volume; a Merkle-tree set or per-block batching would lift it.
- **Settler liveness.** A settler who sees a result it dislikes can stop, and the draw voids and refunds. This is the same class of trust as the oracle's: a committee (stage 2) with t-of-n liveness reduces it.
- **Untested on a real network.** Block limits on a transaction's ledger operations (14 ticket lookups and up to 14 inserts in a batch, 7 sealed tickets of 12 elements in a purchase) are only known once it runs on Preprod. Next: the Starfall CLI (deploy with a test settlement key, keeper, buy), then a 100-ticket draw on Preprod.

## The keeper

`StarfallKeeper` (`keeper/src/starfall.ts`) runs every step above with nobody at the keyboard. Each pass it reads the contract and sends what's due, most urgent first:

| Draw is | The keeper sends |
|---|---|
| open, sales closed | `requestDraw`: reveal the seed and open the next draw |
| open, past the reveal deadline | `voidDraw` |
| requested, past the draw deadline | `voidDraw` (the oracle didn't answer) |
| fulfilled | `computeNumbers` (or `voidDraw` past the deadline) |
| drawn, tickets left to settle | decrypts the draw's tickets with the settlement secret (checking each against its commitment), then `settleBatch`, one batch of 22 a pass, in order |
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
| `contract/src/entries.compact` | Generated table of each entry type's games by matches (`scripts/gen-entries.py`, every row checked by enumeration) |
| `contract/src/settlement-tickets.ts` | Building tickets (`makeTicket` with an entry and payees; `PlainEntry`, `ENTRY_TYPES`, `gamesOf`, `checkEntry`, `entryName`), listing an entry's games (`gamesIn`, `gamesByDivisionFor`), QuickPick packages, Powerball's prize rules (`prizesByPowerballRules`), the reference settlement (`expectedSettlement`, by listing every game), payee split |
| `contract/src/settlement-witnesses.ts` | Private state and witnesses: purchases, sealing randomness, settlement batches |
| `contract/src/settlement-simulator.ts` | In-memory simulator, including the settlement engine loop (`decryptDrawTickets`, `settleAll`), with v0's role helpers (`proposeOrganiser`, `acceptOrganiser`, `recoverOrganiser`, `approveOracleKey`) |
| `contract/src/test/settlement.test.ts` | Tests |
| `keeper/src/starfall.ts` | The Starfall keeper: chain view, plan, primary/standby roles and the payment split |
| `keeper/src/engine.ts` | Sending steps, retries and take-over, shared with v0's keeper |
| `keeper/src/test/starfall.test.ts` | The keeper's tests, on the simulator |

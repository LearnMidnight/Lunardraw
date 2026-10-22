# Starfall: private, automatic settlement (prototype)

Status: prototype, 22 Oct 2026. Contract `contract/src/settlement.compact`, tested in the simulator (`contract/src/test/settlement.test.ts`). Not deployed. It sits next to the v0 contract (`lunardraw.compact`, [DESIGN.md](DESIGN.md)), which is unchanged.

The goal is the rule at the centre of Lunardraw:

> The blockchain must be able to verify that every winner has been counted and every prize calculated correctly, without learning the private numbers on each ticket.

v0 meets the privacy half by having winners **claim**: only a ticket's owner can prove it won. This contract removes the claim. A settler works through every ticket, and the contract checks each step, so nobody has to press a button and no ticket's numbers become public.

## What happens to a ticket

1. **Purchase.** The buyer pays the ticket price in tNIGHT and publishes two things:
   - `C`, a commitment to the ticket (`SHA-256` over the draw, the line, up to three payees with their shares, and a random salt);
   - the same ticket **encrypted to the settlement key**.

   The purchase proof shows that both hold the same valid ticket: 7 increasing numbers in 1–35, a Moonball in 1–20, and shares adding up to 10,000 basis points. The buyer also names a public refund address. Tickets are numbered 0, 1, 2, … within the draw, in purchase order.
2. **Sales close.** The count is frozen: no ticket can be added or removed.
3. **Draw.** Same as v0: the organiser's sealed seed, the oracle's VRF and the site's number rule. The numbers end up in the ledger.
4. **Settlement.** The settler decrypts every ticket with the settlement secret and calls `settleBatch` repeatedly. Each call covers the next 25 tickets in index order. For each ticket, the proof shows that the decrypted ticket hashes to the commitment stored at its index, then works out its division against the numbers stored in the ledger. Winning tickets become **entitlements** (division + payees) under the id `SHA-256(domain, C, salt)`. The salt is secret, so nobody can link an entitlement to a purchase.
5. **Finalise.** When the last ticket is settled, anyone calls `finaliseDraw`, which:
   - takes the operator fee (`feeShare` basis points of sales, at most 30%) off the sales;
   - adds the rollover to make the pool;
   - fixes each division's prize per winning ticket, using v0's shares (30% jackpot, then 7 / 5.6 / 5.6 / 6.3 / 7 / 7 / 14 / 17.5%);
   - rolls unwon divisions and rounding remainders into the next draw. Draws finalise in order.
6. **Payment.** Anyone calls `payEntitlement` for each entitlement (a keeper does it for all of them). Each payee after the first gets `floor(prize × share / 10000)` and the first gets the rest, so the prize is paid to the last STAR. `withdrawFees` sends collected fees to the operator address.
7. **Fail-safe.** If settlement isn't finalised by the settlement deadline (`settleWindow` after the numbers), anyone voids the draw and `refundTicket` sends every ticket's price to its refund address. Settling and finalising stop working at exactly the moment voiding becomes possible, so nobody can choose between the two. Entitlements recorded before a void are never paid. A draw is never redrawn.

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
| Nothing stuck | Deadline → void → refunds by anyone, to addresses fixed at purchase |

The tests check each of these:
- 100 tickets, with winners in every division and syndicates of 2 and 3, compared against an off-chain reference to the STAR;
- forged numbers, a redirected payee, swapped tickets, a missing ticket, a repeated ticket, a repeated batch, a wrong settlement key;
- finalising early, settling past the end, paying twice or before finalising;
- the deadline voiding with refunds, voiding a never-computed draw, and never voiding a settled one;
- rollover across draws, settlement order, an empty draw, and the fee cap.

## What stays private, and what doesn't

**Private:** every ticket's numbers and salt, and which purchase a winning entitlement belongs to.
- `settleBatch` reads the ledger the same way for every slot. All reads happen before any winner is recorded, so the transaction's public transcript shows how many winners a batch had, but not which slots they were.

**Public:**
- each purchase's buyer address (tNIGHT is unshielded on Preprod), refund address, commitment and ciphertext;
- each draw's numbers, ticket count and winner counts per division;
- each winning entitlement's division and payee addresses, at settlement;
- every payment.

**Known leaks in this prototype:**
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

## Circuit sizes (mock-compiled, Compact 0.31.1)

| Circuit | k | Rows |
|---|---|---|
| `settleBatch`, 25 tickets | 19 | 353,320 |
| `computeNumbers` (same as v0) | 19 | 323,756 |
| `buyTicket` (commitment + encryption) | 18 | 147,234 |
| `requestDraw` | 16 | 59,761 |
| `finaliseDraw` | 13 | 8,158 |
| `payEntitlement` | 11 | 1,818 |

A ticket costs about 14,300 rows of settlement. The batch size is fixed at compile time (`npm run gen:batch -w @lunardraw/contract -- <size>` regenerates `src/batch.compact`). Measured: 10 tickets k=18, 25 k=19, 50 k=20, 100 k=21. 25 keeps settlement in the same size class as `computeNumbers`, which v0 already needs. A 10,000-ticket draw takes 400 batch transactions until recursion is available. The CI `keys` job reports the real proving-key sizes.

## Other limits of the prototype

- **One line per ticket.** Buy several tickets for several lines. Multi-line tickets multiply the batch circuit.
- **Purchases are sequential.** Each purchase takes the next index, so two purchases in the same block conflict and one must retry. Fine at prototype volume; a Merkle-tree set or per-block batching would lift it.
- **Settler liveness.** A settler who sees a result it dislikes can stop, and the draw voids and refunds. This is the same class of trust as the oracle's: a committee (stage 2) with t-of-n liveness reduces it.
- **Not yet run on Preprod.** Next: deploy with a test settlement key, run a 100-ticket draw with a fixed seed, then with live Nightcast randomness.

## Files

| File | What it is |
|---|---|
| `contract/src/settlement.compact` | The contract |
| `contract/src/batch.compact` | Generated batch-size declarations (`scripts/gen-batch.py`) |
| `contract/src/settlement-tickets.ts` | Building tickets (`makeTicket` with payees), the reference settlement (`expectedSettlement`), payee split |
| `contract/src/settlement-witnesses.ts` | Private state and witnesses: purchase, sealing randomness, settlement batches |
| `contract/src/settlement-simulator.ts` | In-memory simulator, including the settlement engine loop (`decryptDrawTickets`, `settleAll`) |
| `contract/src/test/settlement.test.ts` | Tests |

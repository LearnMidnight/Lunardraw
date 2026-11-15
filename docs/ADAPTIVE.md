# Starfall v2: the adaptive format, the fixed jackpot and the Treasury

Decided with Jack on 13–14 November 2026. This is what
`contract/src/settlement.compact` and `contract/src/treasury.compact` implement
for the Compact 0.36 / ledger 9 redeploy. Settlement itself (tickets,
encryption, batches, payouts) is unchanged: see [SETTLEMENT.md](SETTLEMENT.md).

## Why

How often a jackpot is won is the odds divided by the games sold per draw. How
big it can get is set by the odds too. So the format *is* the jackpot, and the
rhythm of jackpots depends only on the ratio of odds to volume. A fixed 7 from
35 with a Moonball from 20 (1 in 134 million) is never won at thousands of
games a draw.

Starfall v2 keeps the rhythm fixed and lets the size follow the players: a
lottery with difficulty adjustment. Per-ticket odds get harder as the field
grows, the field's chance of a win each draw stays about 1 in `targetDraws`,
and the rhythm is an average, not a clock.

## The ladder

Seven numbers always. The number range N and the Moonball range M are the
draw's, fixed when it opens from the current rung of a sealed ladder and kept
in the draw (`rung`, `format`). M = 1 means no Moonball.

| Rung | Format | Odds (1 in) | Suits about (games a draw) |
|---|---|---|---|
| 0 | 7 from 20 | 77,520 | 19,000 |
| 1 | 7 from 22 (start) | 170,544 | 43,000 |
| 2 | 7 from 25 | 480,700 | 120,000 |
| 3 | 7 from 27 | 888,030 | 222,000 |
| 4 | 7 from 30 | 2,035,800 | 509,000 |
| 5 | 7 from 30, Moonball 1–2 | 4,071,600 | 1.0 million |
| 6 | 7 from 30, Moonball 1–5 | 10,179,000 | 2.5 million |
| 7 | 7 from 35, Moonball 1–5 | 33,622,600 | 8.4 million |
| 8 | 7 from 35, Moonball 1–10 | 67,245,200 | 17 million |
| 9 | 7 from 35, Moonball 1–20 | 134,490,400 | 34 million |
| 10 | 7 from 40, Moonball 1–20 | 372,871,200 | 93 million |
| 11 | 7 from 45, Moonball 1–20 | 907,592,400 | 227 million |

Each rung carries `q = floor(65536 / N)` and `qm = floor(65536 / M)` for the
draw rule (a 16-bit sample is rejected at or above N × q, so every number is
equally likely), `odds = C(N, 7) × M`, `pick5 = C(N − 5, 2)` and its own prize
table. The constructor checks all of them.

## The retarget (in `finaliseDraw`)

Every `retargetEvery` finalised draws (void draws don't count) the target odds
are the window's average games per draw × `targetDraws`, and the floor becomes
target × `floorPerGame`.

- **Up: straight to the nearest rung** (a rung is nearer than the one below it
  once the target passes their midpoint). A harder format can't be taken
  advantage of.
- **Down: one rung**, when the target is below 80% of the midpoint with the
  rung below, and only if the jackpot standing fits under that rung's ceiling.
  Until it fits, `aim` records the rung the volume calls for: the jackpot stops
  growing past that rung's ceiling (one already above it is never cut back, it
  just stops growing), the Treasury's top-ups stop there, and the ladder steps
  down at the retarget after the jackpot is won.
- A draw already open keeps its format; a move applies from the next draw
  opened.

**At launch: daily draws** (Jack, 15 Nov 2026), `targetDraws = 28`,
`retargetEvery = 7`: a jackpot about monthly, the format checked every week,
and a result and smaller prizes every day. Weekly draws with `targetDraws = 4`,
`retargetEvery = 4` pick the same formats and give the same jackpots in time
(`contract/v2-sim/jackpot_share.py`: at 2,300, 16,000 and 42,000 games a week,
the jackpot is won about every 30, 7.5 and 7 weeks either way), but daily keeps
the game's rhythm and moves the format four times as often. The game starts on
7 from 20 (`startRung = 0`) so it only moves up as players arrive; at today's
volume (about 2,300 games a week, the house agents) it stays there. Opening
deposit: the treasury wallet's 10,000 tNIGHT; first floor 1,840 (28 draws x
about 330 games x 0.20), so the first jackpot is 8,160 and 1,840 stays in the
Treasury as its reserve (`daily.mjs`). Sales windows as v1's: a draw sells for
6 hours to 14 days (`minSales`, `maxSales`); the keeper opens each next draw
to close at the following 20:00 Brisbane.

## Prize tables

Each rung has its own table (`shares`, basis points, division 1 first;
Division 1's share is the same on every rung: **half the pool**, for bigger
jackpots, decided with Jack on 14 November). The divisions are as in v1: 1 =
7 + Moonball, 2 = 7, 3 = 6 + MB, 4 = 6, 5 = 5 + MB, 6 = 4 + MB, 7 = 5, 8 = 3 +
MB, 9 = 2 + MB. A division with no share pays nothing, records no winners and
passes what cascades into it on.

- **No Moonball (rungs 0–4):** every game's Moonball is 1 and so is the drawn
  one, so 7, 6, 5 and 4 right land in divisions 1, 3, 5 and 6. Four divisions
  pay: 50% (the jackpot share), 7.52%, 12.41%, 30.07% (the first plan's 10 :
  16.5 : 40 kept for the other half). On 7 from 20 a winning game expects
  about 64 tNIGHT for 6 right, 5.9 for 5 and 2.33 for 4 (1 game in 7.7); on 7
  from 22 about 122, 9.6 and 3.22 (1 in 10.7). Nothing for 3 or 2 right:
  on 7 from 22 a 3-right prize would be 1.2 tNIGHT for more than a quarter of
  all games, below the price of a game. No Moonball Sweep.
- **Moonball rungs 9 to 11:** Powerball's nine divisions with Division 1
  raised to half and the rest scaled (50.00 / 1.39 / 1.73 / 1.50 / 1.13 /
  7.07 / 5.49 / 11.65 / 20.04).
- **Moonball rungs 5 to 8** have their own tables: Powerball's split there
  would pay less than a game for 2 right + Moonball on 7 from 30 with a
  Moonball from 2, and less for 5 + Moonball than for 5. Each prize is about
  (1 / its chance)^0.6, scaled to the other half of the pool, so a rarer win
  always pays more; a division whose prize would come to under three games
  pays nothing; where two divisions are equally likely (Moonball 1–2), the one
  with the Moonball pays 20% more. Shares in basis points, in division order
  (7 + MB, 7, 6 + MB, 6, 5 + MB, 4 + MB, 5, 3 + MB, 2 + MB):

  | Rung | Format | Shares | Smallest prize paid |
  |---|---|---|---|
  | 5 | 7 from 30, Moonball 1–2 | 5000 / 30 / 272 / 227 / 1101 / 2452 / 918 / 0 / 0 | 4 + MB, about 16 tNIGHT (1 in 66) |
  | 6 | 7 from 30, Moonball 1–5 | 5000 / 25 / 110 / 191 / 445 / 1189 / 775 / 2265 / 0 | 3 + MB, about 7.4 (1 in 33) |
  | 7 | 7 from 35, Moonball 1–5 | 5000 / 19 / 92 / 160 / 404 / 1175 / 703 / 2447 / 0 | 3 + MB, about 11.5 (1 in 47) |
  | 8 | 7 from 35, Moonball 1–10 | 5000 / 15 / 51 / 122 / 223 / 648 / 536 / 1348 / 2057 | 2 + MB, about 6.7 (1 in 33) |

An unwon division falls to the next lower division with a winner. What none
takes, and rounding remainders, join the next jackpot.

## The fixed jackpot and its ceiling

**Division 1 pays the jackpot carried in**: the rollover as the previous
finalised draw left it, which the draw's own sales never change. The draw's
own Division 1 share joins the *next* jackpot. So a buyer's own money never
comes back through the jackpot they are playing for.

**The next jackpot is held to a ceiling**: `ceilingPerCombination` × the odds
of the draw it is for. What the ceiling can't hold goes to the Treasury.

Together they give a bound that needs no simulation. All a draw can return to
its players, on average and at any size of purchase, is the other divisions'
share of its pool plus a jackpot no bigger than the ceiling:

    most a game returns = (1 − division 1 share) × pool per game + ceilingPerCombination

and the constructor refuses a deployment where that reaches the price of a
game. With 1.0 to the pool, Division 1 at half of it and a ceiling of 0.71:
0.50 + 0.71 = 1.21 of 1.3. Buying more of a draw, even every combination, never pays; the same holds
across draws, since later jackpots are capped too. (The one exception is an
announced final draw, which gives everything away on purpose.)

History: a sales cap was considered first and dropped (a cap either lets a
buyer push the ladder up by selling a draw out, or hides demand so the ladder
gets stuck). Paying the overflow to that draw's smaller prizes instead of the
Treasury would need a ceiling of about 0.35–0.40 × odds to stay safe (at a
33.5% Division 1 share).

**Why half the pool.** The ceiling can only rise as far as the other
divisions' return falls, so a bigger Division 1 share is what makes a bigger
jackpot safe. The first plan (33.5%, ceiling 0.55) and this one return the
same 84.6% to players overall; this one puts more of it in the jackpot. In
simulation (`sim/jackpot_share.py`, kept on Jack's PC) the average jackpot
won is about 45–60% bigger at every volume tried, and at 42,000 games a draw
the jackpot is won about every 6.8 draws instead of 5.8 (a bigger jackpot
waits longer to fit under a lower rung's ceiling). Biggest jackpot: 55,039
tNIGHT on 7 from 20, 121,086 on 7 from 22.

## Money: 1.3 tNIGHT a game

1.0 to the prize pool, 0.10 to the Treasury (`treasuryPerGame`), 0.20 to the
operator (`feePerGame`). Deploy settings, sealed. Players get back about 85%
(1.0 + 0.10 of every 1.3), against 77% in v1.

## The Treasury contract (`treasury.compact`)

Holds its share of every game, what the ceiling couldn't hold, and anything
paid in with `deposit`. Its one outflow is to the game it is bound to, which
calls `release` across contracts when its first draw opens and each time it
finalises a draw:

- the game pays in its Treasury share and the overflow in the same call (a
  contract only gains tokens in a call of its own that receives them);
- the Treasury pays the next jackpot **up to the floor**, as far as it can;
- and **on towards the ceiling** with what it holds above a reserve of one
  floor, kept back so it can pay the floor after the next win.

So the jackpot is usually at or near its ceiling, and is refilled after a win.
The game records what it sent (`overflow`, `treasuryFee`) and received
(`refill`) in each draw.

Nobody controls the Treasury: no withdrawal, no operator, no successor. It is
deployed first, the game is deployed with its address, and `bind` (the
deployer, once) ties it to the game. When the game's final draw is finalised
it takes everything the Treasury holds into that draw's jackpot, and the
Treasury answers nothing afterwards.

`release` uses no witness (a cross-contract callee may not) and never reads its
exact balance, only compares it with amounts in whole tNIGHT: a transaction
that reads an exact balance fails if the balance changes before it is applied,
so a few STAR deposited at the right moment could stall a draw.

## The final draw

Opened as such by the organiser, selling for at least `finalSales`. It takes
everything the Treasury holds into its jackpot, which must be won: unwon, it
falls to the next division with a winner, together with the draw's own
Division 1 share and Treasury share (there is no later draw for them). What no
division takes is shared by every game sold, through `refundTicket`. The
contract then holds nothing and opens no more draws.

## Syndicates

A group buying games together for one draw, as in a real lottery
(`createSyndicate`, `joinSyndicate`, `buySyndicateTickets`,
`paySyndicateMember`, `refundSyndicate`):

- **Anyone opens one** for an open draw (not a final draw): share price,
  number of shares, number of games, and a join deadline no later than sales
  close. Shares × share price must equal games × the ticket price.
- **Members pay for their shares** into the game contract, naming where their
  winnings and refunds go. The last share sold funds the syndicate.
- **The creator buys the games** from the syndicate's funds before sales close,
  proving it holds the secret behind the creator commitment. Each ticket names
  the syndicate as its only payee and has no refund address. They are ordinary
  tickets of the draw (any entry, lines, Systems or Picks), sealed and settled
  like any other, and count in the draw's sales and the retarget. The creator
  never holds the money and can't spend more than the syndicate funded.
- **A payee can be a syndicate:** `hi` all ones (2^128 − 1, which no real
  address half is) and `lo` the syndicate's id. `payEntitlement` keeps a
  syndicate payee's part (`syndicatePots`, per entitlement) instead of sending
  it, and `paySyndicateMember` pays each member floor(part × shares / shares
  sold), once per member and prize. Naming a syndicate on an ordinary ticket is
  a gift to its members; naming one that doesn't exist loses the prize, as a
  wrong address would.
- **Refunds of what wasn't played** (`refundSyndicate`, by shares, anyone may
  call it): everything if the syndicate never filled (after the join deadline)
  or the draw is void; otherwise what the creator didn't spend (after sales
  close). A member called again is paid only what has become due since (a draw
  voided after the unspent money was refunded). `refundTicket` on a syndicate's
  ticket sends nothing: its money stays for the members.
- **Rounding dust** (under one STAR per member and prize) stays in the
  contract.

**Deploying with them.** One ledger 9 deploy carries 12 circuits of this size
(Preprod, 14 Nov 2026; 15 were refused). The game's 12 circuits go in the
deploy with a single-use maintenance key held only in memory; the 5 syndicate
circuits' verifier keys are added by maintenance transactions; then the
maintenance authority is replaced by an empty committee (nobody can ever change
the contract), the chain is checked to show all 17 circuits and the empty
committee, and only then is the Treasury bound and the first draw opened.
Tested on Preprod on 15 Nov 2026 with 18 circuits (`contract/v2-probe`,
`probe-upgrade.mjs`). Anyone can check that every verifier key on chain matches
the published compiled contract.

## Picks follow the number range

A standard game or a System only uses its own numbers, so the table in
`entries.compact` still serves. A Pick is completed from the rest of the range,
so its games are worked out in the circuit: a Pick 6 is N − 6 games, a Pick 5
is C(N − 5, 2), and with d = 7 − h of the other numbers drawn a Pick 6 has d
games with h + 1 right and N − 6 − d with h; a Pick 5 has C(d, 2) with h + 2,
d × (N − 5 − d) with h + 1 and the rest with h. `gen-entries.py` checks this
against every game listed, for every N from 14 to 60.

## Sizes (Compact 0.36.0, `zkir-v3 mock-compile`, which reads 2–7% low)

10 tickets a purchase and 20 a settlement batch (v1: 7 and 14).

| Circuit | k | Rows |
|---|---|---|
| buyTickets | 16 | 55,317 of 65,536 |
| settleBatch | 17 | 107,417 of 131,072 |
| computeNumbers | 18 | 152,060 |
| requestDraw | 16 | 34,779 |
| payEntitlement | 15 | 28,068 |
| buySyndicateTickets | 16 | 59,380 of 65,536 (real key build: k = 16) |
| paySyndicateMember | 13 | 4,406 |
| createSyndicate / joinSyndicate / refundSyndicate | 10 | 586 / 603 / 732 |
| finaliseDraw | 13 | 7,122 of 8,192 |
| Treasury: release / bind / deposit | 14 / 13 / 7 | 7,989 / 3,980 / 92 |

## Checks

`contract/v2-check/` runs both compiled contracts together in memory
(compact-runtime 0.21, the real cross-contract call) and applies the chain's
rule for unshielded tokens to every transaction:

- `pure.mjs`: formats, divisions, and Picks against every game listed for ten
  number ranges;
- `game.mjs`: the opening jackpot, a win, rollovers to the ceiling, overflow,
  the refill, a retarget up, waiting to step down and stepping down, a jump of
  four rungs, the final draw; after every stage nothing has been created or
  lost;
- `daily.mjs`: the launch settings (7 from 20, 10,000 deposit, daily
  draws), and a week of busy draws moving the ladder up at the seventh;
- `syndicate.mjs`: a syndicate that wins (the jackpot and a 4-right prize,
  split 2/5 and 3/5), the creator's checks, unspent money refunded after sales
  close, a syndicate that never fills, a void draw after a partial refund, and
  no syndicate in a final draw.

`bash contract/v2-check/run.sh` (needs `compactc` 0.36.0).

Seen on Preprod (`contract/v2-probe`, 14–15 Nov 2026): the cross-contract call
with unshielded payments both ways in one transaction works; one deploy carries
12 circuits; deploying with 12 and adding the rest before locking works.

## Not in this contract

Pay for outside keepers, and any way to change the settlement key, the price or
the fees.

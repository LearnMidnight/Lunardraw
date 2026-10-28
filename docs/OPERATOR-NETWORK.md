# Stage 3: a decentralised operator network

*Jack's idea, 28 Oct 2026, written up with Claude. A design note, not a plan with dates: it waits for Midnight's hosted proving and threshold-friendly primitives, and for the single-operator Starfall to be boringly reliable first.*

## The problem it solves

Starfall's remaining trust sits in two secrets on one machine: the **settlement key** (decrypts every ticket to settle a draw) and the **oracle key** (Nightcast's VRF, which fixes the draw's numbers). Whoever controls that machine can read tickets before the draw, or stall and void a draw they dislike. The contract already limits the damage (a stalled draw refunds everyone; the oracle key is bound to a draw before sales open), but it can't remove the fact that one party holds both keys. Every other guarantee in [SETTLEMENT.md](SETTLEMENT.md) is enforced by proofs; this one is enforced by trusting the operator.

## The idea

Run the keeper and the oracle not as one service but as a **network of independent operators**, rewarded from the fee pool for keeping Starfall live and honest. The natural operators are **Cardano stake pool operators**: they already run reliable infrastructure, understand bonds and rewards, and already produce Midnight's blocks (Midnight is a Cardano partner chain whose block producers are SPOs). Starfall would use the same pattern one level up.

Jack's first framing was "a blockchain on top of a blockchain". The useful core of that is the operator set and its incentives, **not a second chain**: Starfall's state (tickets, draws, prizes) already lives on Midnight, which already orders transactions and keeps the history. A separate chain would rebuild what Midnight gives for free and is the most expensive, failure-prone thing to build. What's needed is an operator network, which has three parts.

### 1. Threshold keys: no single operator can read or rig

Split the settlement key and the oracle key across *n* operators so that any *t* of them can act together and no *t − 1* can.

- **Settlement:** tickets are already encrypted ElGamal-style to a public key (see "Encryption" in SETTLEMENT.md), which is exactly the shape threshold decryption needs. A batch is decrypted by *t* operators each contributing a partial decryption; none of them sees a ticket alone. The contract's `settleBatch` doesn't change: it checks commitments and counts winners from whatever plaintext the settlers present, so the proof is the same whether one key or a committee produced the plaintext.
- **Draw numbers:** Nightcast's VRF key becomes a threshold VRF, as drand runs in production for public randomness. The oracle's answer is assembled from *t* partial evaluations; no operator knows the output early, and no *t − 1* can bias or withhold it.
- The key generation is a one-off distributed ceremony (DKG); operator churn is handled by resharing, not a new key.

### 2. Anyone can turn the handle

Reveal, compute, settle, finalise, pay and void are all deterministic: given the chain state there is exactly one correct next transaction. Rather than one keeper, **any registered operator may submit the next step**, and the first valid one lands; the contract already rejects a wrong or duplicate step. This is the cheapest part and mostly keeper code: it removes the single point of failure for liveness before any threshold cryptography exists.

### 3. Bonds and rewards from the fee

Operators **stake** (tNIGHT now, NIGHT later) to register. Each draw's operator fee (0.2 tNIGHT a game today, all to the organiser) is split between the organiser and the operators who did that draw's work: contributed a partial decryption or VRF share, or landed a step. An operator who goes dark during a draw, or submits a bad share, **loses bond**. That is what makes "decentralised" more than a word: honesty and uptime have money behind them, and a draw's cost of corruption is *t* operators' bonds, not one person's conscience.

## What it does and doesn't change

- **Players** see nothing different: same contract interface, same tickets, same prizes. Privacy improves (no single party can read tickets) and liveness improves (one operator down doesn't stall a draw).
- **Legal exposure does not shrink.** Regulators ask who runs and profits from a lottery; a reward pool for operators makes *more* parties liable, not fewer. This design is about trust and liveness, never a route around licensing.
- **Not a new blockchain.** No consensus, no blocks, no token of its own. Operator registration, bonds and reward accounting can live in a small Midnight contract beside Starfall.

## Order of work

1. **Single operator, boringly reliable** on Preprod: the current stage. Watchdogs, soak, 100-ticket draws, the website buying through the player prover.
2. **Any operator can turn the handle:** register operators; the keeper becomes "submit the next step if nobody has"; two keepers on two machines.
3. **Second oracle on a different machine** from the keeper (the two-secrets-one-box problem), or the oracle key in an attested TEE (stage 1b in SETTLEMENT.md).
4. **Threshold keys** for settlement and the VRF, with DKG, resharing and bonded operators. Needs hosted proving (MPS-0004) so operators don't each carry 7 GB proofs, and Compact support for the group operations the partial decryptions and shares need.
5. **Recruit SPOs** as the operator set, reward split and bond sizes set from real draw volumes.

Each step is useful on its own and none requires undoing the one before. The contract deployed today needs no change for steps 2 and 3; step 4 is a new settlement-key format and so a new deployment, like every ticket-format change has been.

# Bigger jackpots for Starfall v2 (14 Nov 2026): what changes if Division 1 takes a bigger share of
# the pool and the ceiling rises with it, at the volumes Preprod really has.
#
# Built on sim/buffer.py (variant B: overflow to the Treasury, Treasury tops up to the floor and on
# toward the ceiling above a reserve of one floor). Added: the Division 1 share (JP) as a setting,
# the starting rung, an opening deposit, "refill only to the floor" (option 3), the small prizes per
# winning game, and a first-year view averaged over many runs.
import numpy as np, math
from math import comb

PRICE = 1.3; POOL = 1.0; TRE = 0.10; T = R = 4; FLOOR_F = 0.20
FORMATS = [(20,1),(22,1),(25,1),(27,1),(30,1),(30,2),(30,5),(35,5),(35,10),(35,20),(40,20),(45,20)]
ODDS = [comb(n,7)*m for n,m in FORMATS]
GRID = (0.005,0.01,0.02,0.05,0.1,0.2,0.3,0.5,0.75,1.0)
share = lambda lam: (1-math.exp(-lam))/lam if lam > 1e-12 else 1.0

def p_right(n, k):
    return comb(7,k)*comb(n-7,7-k)/comb(n,7)

def small_prizes(jp, n):
    # No-Moonball rungs: 6, 5, 4 right share what Division 1 doesn't, in the planned 10 : 16.5 : 40.
    lower = 1 - jp
    sh = {6: lower*10/66.5, 5: lower*16.5/66.5, 4: lower*40/66.5}
    return {k: sh[k]*POOL/p_right(n,k) for k in (6,5,4)}

def run(jp, ceil, base, start=1, deposit=0.0, refill_to_ceiling=True, vol='walk', draws=100_000, seed=11, track=0):
    rng = np.random.default_rng(seed)
    r_this = r_next = cur = start
    carry = 0.0; treasury = deposit; floor = T*base*FLOOR_F; wd = 0; wg = 0.0; level = 0.0
    o_sp = o_rt = 0.0; wins = played = 0; jsum = 0.0; atcap = 0; below = 0; path = []
    # The first draw is seeded by the Treasury, as the contract does when it opens.
    cap0 = ceil*ODDS[r_next]
    got = min(min(floor, cap0), treasury); treasury -= got; carry += got
    if refill_to_ceiling:
        extra = min(cap0 - carry, max(0.0, treasury - floor)); treasury -= extra; carry += extra
    for i in range(draws):
        N = ODDS[r_this]; cap = ceil*ODDS[r_next]
        if vol == 'walk': level = 0.97*level + rng.normal(0, 0.12)
        S = base*math.exp(level + rng.normal(0, 0.2)); C = carry; sh = share(S/N)
        if track: path.append((C, r_this))
        if C >= 0.995*ceil*N: atcap += 1
        if C < 0.999*min(floor, ceil*N): below += 1
        ev = lambda x: (x/N)*C*sh + (1-jp)*POOL*x - PRICE*x
        best = max(GRID, key=lambda f: ev(f*N)); x = best*N if ev(best*N) > 0 else 0.0
        if x: played += 1
        pool = S + x; sn = jp*POOL*pool; low = (1-jp)*POOL*pool
        k = rng.poisson(S/N); hit = rng.random() < x/N
        if hit or k:
            wins += 1; wp = C/(1+k) if hit else 0.0
            o_rt += C - wp; jsum += C; carry = sn
        else:
            carry = C + sn
        treasury += TRE*pool
        if carry > cap: treasury += carry - cap; carry = cap
        need = max(0.0, min(floor, cap) - carry); got = min(need, treasury); treasury -= got; carry += got
        if refill_to_ceiling:
            extra = min(cap - carry, max(0.0, treasury - floor)); treasury -= extra; carry += extra
        o_sp += PRICE*S; o_rt += low*S/pool
        wd += 1; wg += pool; r_this = r_next; r_next = cur
        if wd == R:
            target = wg/R*T; floor = target*FLOOR_F
            up = [j for j in range(cur+1, len(ODDS)) if target*2 >= ODDS[j-1]+ODDS[j]]
            if up: cur = up[-1]
            elif cur > 0 and target*5 < (ODDS[cur-1]+ODDS[cur])*2 and carry <= ceil*ODDS[cur-1]: cur -= 1
            wd, wg = 0, 0.0
    if track: return path
    return dict(played=played/draws, back=o_rt/o_sp, every=draws/max(wins,1), avg=jsum/max(wins,1),
                atcap=atcap/draws, below=below/draws, treasury=treasury)

def first_year(jp, ceil, base, start, deposit, refill_to_ceiling, runs=300):
    paths = []; wins = []
    for s in range(runs):
        p = [c for c, _ in run(jp, ceil, base, start, deposit, refill_to_ceiling, draws=52, seed=1000+s, track=1)]
        paths.append(p); wins.append(sum(1 for i in range(1, len(p)) if p[i] < 0.9*p[i-1]))
    return np.median(np.array(paths), axis=0), float(np.mean(wins))

SETTINGS = [
    ("A. as built",                0.335, 0.55),
    ("B. ceiling 0.60",            0.335, 0.60),
    ("C. jackpot 50%, ceiling .71", 0.50,  0.71),
    ("D. jackpot 60%, ceiling .81", 0.60,  0.81),
]

print("Most a game can return (must stay below 1.3):")
for name, jp, c in SETTINGS:
    print(f"  {name:30s} {(1-jp)*POOL + c:.3f}")

print("\nSmall prizes per winning game (tNIGHT, expected; a game costs 1.3):")
for name, jp, c in SETTINGS:
    for n in (20, 22):
        p = small_prizes(jp, n)
        print(f"  {name:30s} 7 from {n}: 6 right {p[6]:7.1f} | 5 right {p[5]:5.1f} | 4 right {p[4]:4.2f} (1 game in {1/p_right(n,4):.1f} has 4 right)")

print("\nBiggest jackpot (the ceiling):")
for name, jp, c in SETTINGS:
    print(f"  {name:30s} 7 from 20: {c*ODDS[0]:8,.0f} | 7 from 22: {c*ODDS[1]:8,.0f}")

print("\nLong run (100,000 draws, volume wandering about the base), Treasury refills toward the ceiling:")
for base, start in ((42_000, 1), (16_000, 0), (2_300, 0)):
    print(f"-- {base:,} games a week, starting on 7 from {FORMATS[start][0]}")
    for name, jp, c in SETTINGS:
        r = run(jp, c, base, start)
        print(f"   {name:30s} whale plays {r['played']:4.1%} | players get back {r['back']:5.1%} | jackpot every {r['every']:5.1f} draws, "
              f"avg when won {r['avg']:8,.0f} | at the ceiling {r['atcap']:4.0%} of draws | below floor {r['below']:4.1%}")

print("\nOption 3: Treasury refills only to the floor (so the jackpot climbs week by week), 2,300 games a week, start 7 from 20:")
for name, jp, c in SETTINGS:
    r = run(jp, c, 2_300, 0, refill_to_ceiling=False)
    print(f"   {name:30s} whale plays {r['played']:4.1%} | players get back {r['back']:5.1%} | jackpot every {r['every']:5.1f} draws, "
          f"avg when won {r['avg']:8,.0f} | at the ceiling {r['atcap']:4.0%} of draws")

print("\nFirst year at 2,300 games a week, start 7 from 20 (median of 300 runs; jackpot in tNIGHT at weeks 1, 4, 13, 26, 52; jackpots won in the year):")
for dep in (0, 30_000):
    for refill in (True, False):
        print(f"-- opening deposit {dep:,}, Treasury refills {'toward the ceiling' if refill else 'only to the floor'}")
        for name, jp, c in SETTINGS:
            med, w = first_year(jp, c, 2_300, 0, dep, refill)
            print(f"   {name:30s} " + " | ".join(f"wk {k}: {med[k-1]:7,.0f}" for k in (1, 4, 13, 26, 52)) + f" | won {w:.1f} times")

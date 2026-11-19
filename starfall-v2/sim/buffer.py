# Variant B: what the ceiling can't hold goes to the Treasury (not to that draw's prizes), and the
# Treasury tops the jackpot up toward the ceiling whenever it holds more than a reserve of one floor
# (and always up to the floor if it can). A draw then never returns more than 0.665 x pool + the
# fixed jackpot, so with ceiling < (price - 0.665 x pool) no purchase of any size is a winning bet.
import numpy as np, math
from math import comb
JP = 0.335; T = R = 4; PRICE = 1.3
ODDS = [comb(n,7)*m for n,m in [(20,1),(22,1),(25,1),(27,1),(30,1),(30,2),(30,5),(35,5),(35,10),(35,20),(40,20),(45,20)]]
GRID = (0.005,0.01,0.02,0.05,0.1,0.2,0.3,0.5,0.75,1.0)
share = lambda lam: (1-math.exp(-lam))/lam if lam > 1e-12 else 1.0
def run(pool_s, tre, ceil, floor_f=0.20, vol='steady', draws=100_000, base=42_000, seed=11):
    rng = np.random.default_rng(seed)
    r_this = r_next = cur = 1; carry = treasury = 0.0; floor = T*base*floor_f; wd = 0; wg = 0.0; level = 0.0
    o_sp=o_rt=w_sp=w_rt=jw=jo=jsum=0.0; wins=played=0; js=[]; below=0; tmax=0.0
    for i in range(draws):
        N = ODDS[r_this]; cap = ceil*ODDS[r_next]
        if vol == 'walk': level = 0.97*level + rng.normal(0, 0.12)
        S = base*math.exp(level + rng.normal(0, 0.2)); C = carry; sh = share(S/N); js.append(C/N)
        if C < 0.999*min(floor, ceil*N): below += 1
        ev = lambda x: (x/N)*C*sh + (1-JP)*pool_s*x - PRICE*x
        best = max(GRID, key=lambda f: ev(f*N)); x = best*N if ev(best*N) > 0 else 0.0
        if x: played += 1
        pool = S+x; sn = JP*pool_s*pool; low = (1-JP)*pool_s*pool
        k = rng.poisson(S/N); hit = rng.random() < x/N
        if hit or k:
            wins += 1; wp = C/(1+k) if hit else 0.0
            w_rt += wp; o_rt += C-wp; jw += wp; jo += C-wp; jsum += C; carry = sn
        else: carry = C + sn
        treasury += tre*pool
        if carry > cap: treasury += carry-cap; carry = cap
        need = max(0.0, min(floor, cap) - carry); got = min(need, treasury); treasury -= got; carry += got
        extra = min(cap - carry, max(0.0, treasury - floor)); treasury -= extra; carry += extra
        tmax = max(tmax, treasury)
        o_sp += PRICE*S; w_sp += PRICE*x; o_rt += low*S/pool; w_rt += low*x/pool
        wd += 1; wg += pool; r_this = r_next; r_next = cur
        if wd == R:
            target = wg/R*T; floor = target*floor_f
            up = [j for j in range(cur+1, len(ODDS)) if target*2 >= ODDS[j-1]+ODDS[j]]
            if up: cur = up[-1]
            elif cur > 0 and target*5 < (ODDS[cur-1]+ODDS[cur])*2 and carry <= ceil*ODDS[cur-1]: cur -= 1
            wd, wg = 0, 0.0
    j = np.array(js)
    return (f"buyer plays {played/draws:4.1%} | players get back {o_rt/o_sp:5.1%} | jackpot every {draws/max(wins,1):.1f} draws, avg when won {jsum/max(wins,1):7,.0f} | "
            f"jackpot as a share of the board: 10% of draws below {np.percentile(j,10):.2f}, median {np.percentile(j,50):.2f}, top {j.max():.2f} | below floor {below/draws:4.1%} | "
            f"Treasury: {treasury:9,.0f} at the end, peak {tmax:9,.0f}")
for pool_s, tre, op, ceil in ((1.0,0.10,0.20,0.60),(1.0,0.10,0.20,0.55),(1.0,0.05,0.25,0.60),(1.05,0.10,0.15,0.55),(1.1,0.10,0.10,0.50)):
    print(f"== {pool_s} / {tre} / {op}, ceiling {ceil} (a game can never return more than {(1-JP)*pool_s+ceil:.3f} of its 1.3)")
    print("   steady   :", run(pool_s,tre,ceil))
    print("   wandering:", run(pool_s,tre,ceil,vol='walk'))

# Fixed jackpot + ceiling, modelled as it would be built, with a buyer who also counts the overflow.
#  - Division 1 of draw n pays the jackpot carried in (fixed before n's own sales count).
#  - Draw n's jackpot share joins the next jackpot. What would take it past the ceiling of the NEXT
#    draw's format is paid to draw n's smaller prizes, pro rata.
#  - Down the ladder only if the jackpot standing fits under the lower rung's ceiling.
#  - The buyer knows all of this and picks the size (0.5% .. 100% of the board) with the best expected profit.
import numpy as np, math, sys
from math import comb
JP = 0.335; T = R = 4; PRICE = 1.3
ODDS = [comb(n,7)*m for n,m in [(20,1),(22,1),(25,1),(27,1),(30,1),(30,2),(30,5),(35,5),(35,10),(35,20),(40,20),(45,20)]]
GRID = (0.005,0.01,0.02,0.05,0.08,0.1,0.15,0.2,0.25,0.3,0.4,0.5,0.75,1.0)
share = lambda lam: (1-math.exp(-lam))/lam if lam > 1e-12 else 1.0
def run(pool_s, tre, ceil, floor_f=0.20, whale=True, vol='steady', draws=100_000, base=42_000, seed=11):
    rng = np.random.default_rng(seed)
    r_this = r_next = cur = 1; carry = treasury = 0.0; floor = T*base*floor_f; wd = 0; wg = 0.0; level = 0.0
    o_sp=o_rt=w_sp=w_rt=jw=jo=jsum=jmax=0.0; wins=played=atceil=0
    for i in range(draws):
        N = ODDS[r_this]; cap = ceil*ODDS[r_next]
        if vol == 'walk': level = 0.97*level + rng.normal(0, 0.12)
        S = base*math.exp(level + rng.normal(0, 0.2)); C = carry; sh = share(S/N)
        def ev(x):
            pool = S+x; sn = JP*pool_s*pool; pnone = (1-x/N)*math.exp(-S/N)
            o_none = max(0.0, C+sn-cap); o_win = max(0.0, sn-cap)
            return (x/N)*C*sh + (x/pool)*((1-JP)*pool_s*pool + pnone*o_none + (1-pnone)*o_win) - PRICE*x
        x = 0.0
        if whale:
            best = max(GRID, key=lambda f: ev(f*N))
            if ev(best*N) > 0: x = best*N; played += 1
        pool = S+x; sn = JP*pool_s*pool; low = (1-JP)*pool_s*pool
        k = rng.poisson(S/N); hit = rng.random() < x/N
        if hit or k:
            wins += 1; wp = C/(1+k) if hit else 0.0
            w_rt += wp; o_rt += C-wp; jw += wp; jo += C-wp; jsum += C; jmax = max(jmax, C); carry = sn
        else: carry = C + sn
        if carry > cap: low += carry-cap; carry = cap; atceil += 1
        o_sp += PRICE*S; w_sp += PRICE*x; o_rt += low*S/pool; w_rt += low*x/pool
        treasury += tre*pool
        want = min(floor, cap) - carry
        if want > 0:
            got = min(want, treasury); treasury -= got; carry += got
        wd += 1; wg += pool
        r_this = r_next; r_next = cur
        if wd == R:
            target = wg/R*T; floor = target*floor_f
            up = [j for j in range(cur+1, len(ODDS)) if target*2 >= ODDS[j-1]+ODDS[j]]
            if up: cur = up[-1]
            elif cur > 0 and target*5 < (ODDS[cur-1]+ODDS[cur])*2 and carry <= ceil*ODDS[cur-1]: cur -= 1
            wd, wg = 0, 0.0
    n = draws
    return (f"buyer plays {played/n:5.1%}, {(w_rt-w_sp)/n:6,.0f}/draw, {jw/(jw+jo) if jw+jo else 0:4.0%} of jackpot money | players get back {o_rt/o_sp:5.1%} | "
            f"jackpot every {n/max(wins,1):.1f} draws, avg {jsum/max(wins,1):7,.0f}, max {jmax:9,.0f} | at ceiling {atceil/n:4.0%} of draws | stuck in Treasury {treasury/n:6,.0f}/draw")
for pool_s, tre, op in ((1.0,0.10,0.20),(1.05,0.10,0.15),(1.1,0.10,0.10)):
    print(f"== {pool_s} pool / {tre} Treasury / {op} operator; fees on a full board = {PRICE-pool_s:.2f} x odds")
    for ceil in (0.30,0.35,0.40,0.45,0.50,0.60):
        print(f"  ceiling {ceil:.2f} steady: {run(pool_s,tre,ceil)}")
    for ceil in (0.30,0.40,0.50):
        print(f"  ceiling {ceil:.2f} volume wandering: {run(pool_s,tre,ceil,vol='walk')}")

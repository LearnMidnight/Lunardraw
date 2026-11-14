# Starfall v2: what a board-buyer earns under a cap on games per draw (as a share of the odds).
# 1.3 a game: 1.0 pool, 0.20 Treasury, 0.10 operator. T = 4, R = 4, weekly draws.
# One rational buyer with unlimited capital who buys as many distinct combinations as the cap
# allows whenever the expected profit is positive (it is all-or-nothing: profit is convex in size).
# Ordinary players: 42,000 games a draw with ±20% noise. Lower divisions are paid pro rata (expected).
import numpy as np, math, sys
from math import comb
POOL, TRE, OP = 1.0, 0.20, 0.10
PRICE = POOL + TRE + OP
JP = 0.335
T, R = 4, 4
spec = [(20,1),(22,1),(25,1),(27,1),(30,1),(30,2),(30,5),(35,5),(35,10),(35,20),(40,20),(45,20)]
ODDS = [comb(n,7)*m for n,m in spec]

def share(lam):  # E[1/(1+k)], k ~ Poisson(lam): the buyer's expected share of a jackpot it hits
    return (1-math.exp(-lam))/lam if lam > 1e-12 else 1.0

def run(cap, draws=200_000, base=42_000, whale=True, seed=1):
    rng = np.random.default_rng(seed)
    rung, carry, treasury, floor = 1, 0.0, 0.0, 4*base*TRE
    wd, wg = 0, 0.0
    o_spent=o_ret=w_spent=w_ret=0.0; played=full=0; jw=jo=0.0; rungs=np.zeros(len(ODDS)); wins=0
    for _ in range(draws):
        N = ODDS[rung]; rungs[rung]+=1
        S = base*math.exp(rng.normal(0,0.2))
        limit = cap*N if cap else float('inf')
        if S > limit: S = limit; full += 1
        x = 0.0
        if whale:
            xmax = min(N, limit - S)
            if xmax > 0:
                f = xmax/N; pool = S+xmax
                exp_ret = f*(carry+JP*pool)*share(S/N) + (1-JP)*pool*xmax/(S+xmax)
                if exp_ret > PRICE*xmax: x = xmax
        pool = S+x; J = carry + JP*pool
        low = (1-JP)*pool
        o_spent += PRICE*S; w_spent += PRICE*x
        o_ret += low*S/pool; w_ret += low*x/pool
        if x: played += 1
        k = rng.poisson(S/N); hit = rng.random() < x/N
        if hit or k:
            wins += 1
            wpart = J/(1+k) if hit else 0.0
            w_ret += wpart; o_ret += J-wpart; jw += wpart; jo += J-wpart
            carry = 0.0
        else:
            carry = J
        treasury += TRE*pool
        if carry < floor:
            got = min(floor-carry, treasury); treasury -= got; carry += got
        wd += 1; wg += pool
        if wd == R:
            target = wg/R*T; floor = target*TRE
            best = min(range(len(ODDS)), key=lambda i: abs(ODDS[i]-target))
            if best > rung: rung = best                       # up: straight to the nearest rung
            elif rung > 0 and target*5 < (ODDS[rung-1]+ODDS[rung])*2 and ODDS[rung-1]*0.3 >= 0: 
                if ODDS[rung-1]*POOL >= carry+floor: rung -= 1  # down: one rung, with the guard
            wd, wg = 0, 0.0
    return dict(cap=cap or 'none', played=played/draws, whale_profit_per_draw=(w_ret-w_spent)/draws,
                whale_roi=(w_ret-w_spent)/w_spent if w_spent else 0.0, ord_rtp=o_ret/o_spent,
                whale_jackpot_share=jw/(jw+jo) if jw+jo else 0, full=full/draws,
                draws_per_jackpot=draws/max(wins,1), top=int(rungs.argmax()), top_share=rungs.max()/draws)

print("baseline, no buyer:", {k:(round(v,4) if isinstance(v,float) else v) for k,v in run(None, whale=False).items()})
for cap in [None, 1.0, 0.75, 0.6, 0.5, 0.4]:
    r = run(cap)
    print({k:(round(v,4) if isinstance(v,float) else v) for k,v in r.items()})

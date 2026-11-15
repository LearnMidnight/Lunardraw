# Alternative to a sales cap: the jackpot is fixed when the draw opens. This draw's 33.5% jackpot
# share goes to the NEXT jackpot, so a buyer's own money never comes back through this draw's jackpot.
# Optional ceiling: the carried jackpot never exceeds c x odds; the overflow is paid to this draw's
# smaller prizes. Same worst-case buyer as before (buys whenever the expected profit is positive).
import numpy as np, math
from math import comb
POOL, TRE, OP = 1.0, 0.20, 0.10; PRICE = 1.3; JP = 0.335; T = R = 4
ODDS = [comb(n,7)*m for n,m in [(20,1),(22,1),(25,1),(27,1),(30,1),(30,2),(30,5),(35,5),(35,10),(35,20),(40,20),(45,20)]]
share = lambda lam: (1-math.exp(-lam))/lam if lam > 1e-12 else 1.0
def run(mode, ceiling=None, cap=None, whale=True, growth=0.0, draws=100_000, base=42_000, seed=7):
    rng = np.random.default_rng(seed); rung=1; carry=treasury=0.0; floor=T*base*TRE; wd=0; wg=0.0
    o_sp=o_rt=w_sp=w_rt=jw=jo=0.0; wins=n=played=0; jsum=0.0; jmax=0.0
    for i in range(draws):
        N = ODDS[rung]; S = base*(1+growth)**i*math.exp(rng.normal(0,0.2))
        if S > 0.3*ODDS[-1]: break
        n += 1; limit = cap*N if cap else float('inf'); S = min(S, limit)
        best_x, best_p = 0.0, 0.0
        if whale:
            for f in (0.05,0.1,0.2,0.3,0.5,0.75,1.0):
                x = min(f*N, limit-S)
                if x <= 0: continue
                pool = S+x
                J = carry + (JP*pool if mode == 'now' else 0.0)
                p = (x/N)*J*share(S/N) + (1-JP)*pool*x/pool - PRICE*x
                if p > best_p: best_x, best_p = x, p
        x = best_x; pool = S+x
        if x: played += 1
        J = carry + (JP*pool if mode == 'now' else 0.0)
        low = (1-JP)*pool
        k = rng.poisson(S/N); hit = rng.random() < x/N
        nxt = JP*pool if mode == 'next' else 0.0        # what this draw adds to the next jackpot
        if hit or k:
            wins += 1; wp = J/(1+k) if hit else 0.0
            w_rt += wp; o_rt += J-wp; jw += wp; jo += J-wp; jsum += J; jmax = max(jmax, J)
            carry = nxt
        else:
            carry = J + nxt
        if ceiling and carry > ceiling*N:                # overflow to this draw's smaller prizes
            low += carry - ceiling*N; carry = ceiling*N
        o_sp += PRICE*S; w_sp += PRICE*x; o_rt += low*S/pool; w_rt += low*x/pool
        treasury += TRE*pool
        if carry < floor:
            got = min(floor-carry, treasury); treasury -= got; carry += got
        wd += 1; wg += pool
        if wd == R:
            target = wg/R*T; floor = target*TRE
            up = [j for j in range(rung+1, len(ODDS)) if target*2 >= ODDS[j-1]+ODDS[j]]
            if up: rung = up[-1]
            elif rung > 0 and target*5 < (ODDS[rung-1]+ODDS[rung])*2 and ODDS[rung-1]*POOL >= carry+floor: rung -= 1
            wd, wg = 0, 0.0
    return (f"buyer plays {played/n:5.1%} of draws, {(w_rt-w_sp)/n:7,.0f}/draw, takes {jw/(jw+jo) if jw+jo else 0:4.0%} of jackpot money | "
            f"players get back {o_rt/o_sp:5.1%} | jackpot every {n/max(wins,1):.1f} draws, average {jsum/max(wins,1):8,.0f}, biggest {jmax:10,.0f} | treasury left {treasury:10,.0f}")
print("today's rule, no buyer            :", run('now', whale=False))
print("today's rule, buyer, no cap       :", run('now'))
print("today's rule, buyer, cap 40%      :", run('now', cap=0.4))
print("fixed jackpot, no buyer           :", run('next', whale=False))
print("fixed jackpot, buyer              :", run('next'))
print("fixed jackpot, ceiling 60%, buyer :", run('next', ceiling=0.6))
print("fixed jackpot, ceiling 50%, buyer :", run('next', ceiling=0.5))
print("fixed jackpot, ceiling 50%, no buyer:", run('next', ceiling=0.5, whale=False))
print("fixed jackpot, ceiling 50%, buyer, +3%/draw:", run('next', ceiling=0.5, growth=0.03, draws=4000))

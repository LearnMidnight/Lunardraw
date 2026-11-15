# Board-buyer + growth together, with the rule "a sold-out draw moves the ladder up one rung at once".
import numpy as np, math
from math import comb
POOL, TRE, OP = 1.0, 0.20, 0.10; PRICE = 1.3; JP = 0.335; T = R = 4
coarse = [comb(n,7)*m for n,m in [(20,1),(22,1),(25,1),(27,1),(30,1),(30,2),(30,5),(35,5),(35,10),(35,20),(40,20),(45,20)]]
fine_spec = [(20,1),(21,1),(22,1),(23,1),(24,1),(25,1),(27,1),(29,1),(30,1),(30,2),(32,2),(34,2),(33,4),(32,8),(34,8),(41,3),(42,4),(36,20),(41,12),(41,20),(45,15)]
fine = [comb(n,7)*m for n,m in fine_spec]
share = lambda lam: (1-math.exp(-lam))/lam if lam > 1e-12 else 1.0
def run(odds, cap, bump, growth, whale, draws, base=42_000, seed=5):
    rng = np.random.default_rng(seed)
    rung = min(range(len(odds)), key=lambda j: abs(math.log(odds[j]/(base*T))))
    carry=treasury=0.0; floor=T*base*TRE; wd=0; wg=0.0
    o_sp=o_rt=w_sp=w_rt=0.0; full=0; lost=0.0; want_tot=0.0; wins=0; n=0; jw=jo=0.0
    for i in range(draws):
        N = odds[rung]; want = base*(1+growth)**i*math.exp(rng.normal(0,0.2))
        if want > 0.5*odds[-1]: break
        n += 1; want_tot += want; limit = cap*N if cap else float('inf')
        S = min(want, limit)
        if want > limit: full += 1; lost += want-limit
        x = 0.0
        if whale:
            xmax = min(N, limit-S)
            if xmax > 0:
                pool = S+xmax
                if (xmax/N)*(carry+JP*pool)*share(S/N) + (1-JP)*pool*xmax/pool > PRICE*xmax: x = xmax
        pool = S+x; J = carry+JP*pool; low = (1-JP)*pool
        o_sp += PRICE*S; w_sp += PRICE*x; o_rt += low*S/pool; w_rt += low*x/pool
        k = rng.poisson(S/N); hit = rng.random() < x/N
        if hit or k:
            wins += 1; wp = J/(1+k) if hit else 0.0
            w_rt += wp; o_rt += J-wp; jw += wp; jo += J-wp; carry = 0.0
        else: carry = J
        treasury += TRE*pool
        if carry < floor:
            got = min(floor-carry, treasury); treasury -= got; carry += got
        wd += 1; wg += pool
        soldout = cap and pool >= limit*0.999
        if bump and soldout and rung+1 < len(odds):
            rung += 1; wd, wg = 0, 0.0
        elif wd == R:
            target = wg/R*T; floor = target*TRE
            up = [j for j in range(rung+1, len(odds)) if target*2 >= odds[j-1]+odds[j]]
            if up: rung = up[-1]
            elif rung > 0 and target*5 < (odds[rung-1]+odds[rung])*2 and odds[rung-1]*POOL >= carry+floor: rung -= 1
            wd, wg = 0, 0.0
    return (f"buyer {((w_rt-w_sp)/n):7,.0f}/draw, takes {jw/(jw+jo) if jw+jo else 0:4.0%} of jackpot money | "
            f"players get back {o_rt/o_sp:5.1%} | sold out {full/n:5.1%} of draws, {lost/want_tot:5.1%} of games turned away | jackpot every {n/max(wins,1):.1f} draws")
for growth,label,draws in [(0.0,"steady",100_000),(0.03,"+3% a draw",4000)]:
    print(f"== {label}")
    print(f"  no buyer, no cap, 12 rungs        : {run(coarse,None,False,growth,False,draws)}")
    print(f"  buyer, no cap, 12 rungs           : {run(coarse,None,False,growth,True,draws)}")
    for name,od in (("12",coarse),("21",fine)):
        for cap in (0.5,0.4,0.33):
            print(f"  buyer, cap {cap}, {name} rungs, bump   : {run(od,cap,True,growth,True,draws)}")

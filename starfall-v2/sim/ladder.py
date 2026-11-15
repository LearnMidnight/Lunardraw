# How often a cap of c x odds turns ordinary players away while volume grows, for the 12-rung
# ladder and for a finer one (steps of about x1.6). No board-buyer here: this is the cost of the cap.
import numpy as np, math
from math import comb
T, R, TRE = 4, 4, 0.20
coarse = [comb(n,7)*m for n,m in [(20,1),(22,1),(25,1),(27,1),(30,1),(30,2),(30,5),(35,5),(35,10),(35,20),(40,20),(45,20)]]
# finer: pick formats closest to a x1.6 geometric series; no Moonball up to 7/30, then Moonball 2..20
cands = sorted({(comb(n,7)*m, n, m) for n in range(20,46) for m in (1,2,3,4,5,6,8,10,12,15,20) if (m == 1) == (n <= 30) or (m > 1 and n >= 30)})
fine, want = [], 77520.0
while want < 1.0e9:
    o,n,m = min(cands, key=lambda c: abs(math.log(c[0]/want)))
    if not fine or o > fine[-1][0]: fine.append((o,n,m))
    want = fine[-1][0]*1.6
print(len(fine), "rungs:", " ".join(f"7/{n}" + (f"x{m}" if m>1 else "") for o,n,m in fine))
print("steps:", " ".join(f"{b[0]/a[0]:.2f}" for a,b in zip(fine,fine[1:])))
def run(odds, cap, growth, draws=4000, base=42_000, seed=3):
    rng = np.random.default_rng(seed); rung=1 if odds is coarse else 2; wd=0; wg=0.0; full=0; lost=0.0; tot=0.0; gaps=[]
    for i in range(draws):
        N = odds[rung]; S = base*(1+growth)**i*math.exp(rng.normal(0,0.2))
        if S > 0.9*odds[-1]: break
        tot += S
        if S > cap*N: full += 1; lost += S-cap*N; S = cap*N
        gaps.append(N/S)
        wd += 1; wg += S
        if wd == R:
            target = wg/R*T
            best = min(range(len(odds)), key=lambda j: abs(math.log(odds[j]/target)))
            if best > rung: rung = best
            elif best < rung: rung -= 1
            wd, wg = 0, 0.0
    g = np.array(gaps)
    return f"full {full/len(g):6.1%} of draws, {lost/tot:5.1%} of games turned away; a jackpot every {np.percentile(g,5):.1f} to {np.percentile(g,95):.1f} draws"
for growth,label in [(0.0,"steady"),(0.01,"+1% a draw (x1.7 a year)"),(0.03,"+3% a draw (x4.6 a year)"),(0.10,"+10% a draw (x140 a year)")]:
    for name,od in [("12 rungs",coarse),(f"{len(fine)} rungs",[o for o,_,_ in fine])]:
        for cap in (0.4,0.5):
            print(f"{label:28s} {name:9s} cap {cap}: {run(od,cap,growth)}")

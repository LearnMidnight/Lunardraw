/**
 * A limit on how long a long-running service (the keeper, the oracle) waits
 * for DUST when it starts.
 *
 * Opening the wallet syncs it, then waits until it holds DUST to pay fees, and
 * that wait has no end of its own. On the Starfall Preprod soak (27–28 Oct
 * 2026) the oracle restarted and then logged "Waiting for DUST: 0 coin(s)
 * available … synced" for five hours, going silent after two and a half,
 * while 8 draws were cancelled for want of its answer. A plain restart found
 * the DUST within a minute. The transaction and sync watchdogs only start
 * once the wallet is open, so they never saw it.
 *
 * The clock starts when the wallet has synced and begins waiting for DUST, so
 * a long first sync (hours on a public network, saved every 2 minutes) isn't
 * cut short.
 */

/** `--dust-wait <min>`: 20 by default, 0 waits forever. */
export const dustWait = (value: string | undefined): number => {
  // 20 minutes: a restart resumes from the saved wallet state in about a
  // minute, while one Starfall draw step allows 10–15 minutes.
  const m = value === undefined ? 20 : Number(value);
  if (!(m >= 0)) throw new Error('--dust-wait must be a number of minutes (0 to wait forever)');
  return m;
};

/**
 * A deadline that starts when `start()` is first called. `late` resolves with
 * undefined (after `onLate`) once `minutes` have passed; it never resolves if
 * `minutes` is 0, `start()` is never called, or `cancel()` comes first.
 *
 *   const dust = deadline(m, () => logger.error(...));
 *   const wallet = await Promise.race([openWallet(session, { seed, onWaitingForDust: dust.start }), dust.late]);
 *   dust.cancel();
 *   if (!wallet) return RESTART;
 */
export const deadline = (
  minutes: number,
  onLate: () => void,
): { start: () => void; late: Promise<undefined>; cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let fire: (v: undefined) => void = () => undefined;
  const late = new Promise<undefined>((resolve) => {
    fire = resolve;
  });
  return {
    late,
    start: () => {
      if (done || timer || !(minutes > 0)) return;
      timer = setTimeout(() => {
        done = true;
        onLate();
        fire(undefined);
      }, minutes * 60_000);
    },
    cancel: () => {
      done = true;
      if (timer) clearTimeout(timer);
    },
  };
};

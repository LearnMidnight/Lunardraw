/**
 * When each draw's sales close.
 *
 * A schedule turns "now" into the next sales-close time, in seconds since the
 * epoch, leaving at least the contract's minimum sales period plus a margin
 * (the transaction that opens the draw has to land first).
 */
export type Schedule = (nowSecs: number, minSalesSecs: number) => bigint;

/** Seconds added to the minimum sales period, for the opening transaction to land. */
export const OPENING_MARGIN_SECS = 300;

const DAY = 86_400;

/**
 * Weekly at a fixed UTC time. `weekday` is 0 for Sunday to 6 for Saturday.
 * Starfall closes on Thursday at 20:00 Brisbane, which is 10:00 UTC
 * (Queensland has no daylight saving): `weekly({ weekday: 4, hour: 10 })`.
 */
export const weekly =
  ({ weekday, hour, minute = 0 }: { weekday: number; hour: number; minute?: number }): Schedule =>
  (nowSecs, minSalesSecs) => {
    if (weekday < 0 || weekday > 6 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error('weekly: weekday 0-6, hour 0-23, minute 0-59');
    }
    const earliest = nowSecs + minSalesSecs + OPENING_MARGIN_SECS;
    const startOfDay = Math.floor(earliest / DAY) * DAY;
    for (let d = 0; d <= 8; d++) {
      const day = startOfDay + d * DAY;
      const t = day + hour * 3600 + minute * 60;
      if (new Date(day * 1000).getUTCDay() === weekday && t >= earliest) return BigInt(t);
    }
    throw new Error('weekly: no close time found'); // unreachable
  };

/**
 * Every `periodSecs`, on multiples of the period (e.g. every 30 minutes on the
 * hour and half hour). For test networks.
 */
export const every =
  (periodSecs: number): Schedule =>
  (nowSecs, minSalesSecs) => {
    if (!(periodSecs >= 60)) throw new Error('every: the period must be at least 60 seconds');
    const earliest = nowSecs + minSalesSecs + OPENING_MARGIN_SECS;
    return BigInt(Math.ceil(earliest / periodSecs) * periodSecs);
  };

/** The Starfall schedule: Thursdays 20:00 Brisbane (10:00 UTC). */
export const STARFALL_WEEKLY = weekly({ weekday: 4, hour: 10 });

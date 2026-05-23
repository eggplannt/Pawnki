/**
 * SM-2 (SuperMemo 2) spaced-repetition algorithm. Pure function: takes the
 * current card state + a quality grade, returns the next state.
 *
 * Quality scale:
 *   1 = Again  (complete blackout / wrong)
 *   2 = Hard   (recalled with serious difficulty)
 *   4 = Good   (recalled correctly)
 *   5 = Easy   (perfect, effortless)
 *
 * Rules:
 *   - quality < 3        → reset: repetitions=0, interval=1
 *   - quality >= 3, rep0 → interval=1
 *   - quality >= 3, rep1 → interval=6
 *   - quality >= 3, rep>=2 → interval = round(prev_interval * ease_factor)
 *   - ease_factor += 0.1 - (5-q)*0.08 + (5-q)*(5-q)*0.02, clamped to >= 1.3
 *   - on success, repetitions++
 */

export type Quality = 1 | 2 | 4 | 5;

export interface CardState {
  interval: number;
  ease_factor: number;
  repetitions: number;
}

export interface NextCardState extends CardState {
  /** Days from today the card is next due. Equal to `interval`. */
  intervalDays: number;
}

export function applySm2(prev: CardState, quality: Quality): NextCardState {
  const q = quality;

  let ease = prev.ease_factor + (0.1 - (5 - q) * 0.08 + (5 - q) * (5 - q) * 0.02);
  if (ease < 1.3) ease = 1.3;
  ease = Math.round(ease * 100) / 100;

  let repetitions: number;
  let interval: number;

  if (q < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    repetitions = prev.repetitions + 1;
    if (repetitions === 1) interval = 2;
    else if (repetitions === 2) interval = 6;
    else interval = Math.max(1, Math.round(prev.interval * ease));
  }

  return { interval, ease_factor: ease, repetitions, intervalDays: interval };
}

/** Today's date as YYYY-MM-DD in local time. */
export function todayYmd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add `days` to a YYYY-MM-DD date string, returning YYYY-MM-DD. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return todayYmd(dt);
}

/** Human-readable "next due" label. */
export function intervalLabel(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 30) return `${days} days`;
  if (days < 60) return '1 month';
  if (days < 365) return `${Math.round(days / 30)} months`;
  if (days < 730) return '1 year';
  return `${Math.round(days / 365)} years`;
}

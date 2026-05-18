import { getDb } from './db';
import { addDays, todayYmd } from './sm2';

export interface Streak {
  current: number;
  longest: number;
  lastDate: string | null;
  /** Derived: did the user already log activity today? */
  activeToday: boolean;
  /** Derived: streak still alive but no activity yet today (last activity was yesterday). */
  atRisk: boolean;
}

function deriveFlags(current: number, lastDate: string | null): Pick<Streak, 'activeToday' | 'atRisk'> {
  const today = todayYmd();
  if (lastDate === today) return { activeToday: true, atRisk: false };
  if (current > 0 && lastDate === addDays(today, -1)) return { activeToday: false, atRisk: true };
  return { activeToday: false, atRisk: false };
}

export async function getStreak(): Promise<Streak> {
  const db = getDb();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data, error } = await db
    .from('profiles')
    .select('current_streak, longest_streak, last_review_date')
    .eq('id', user.id)
    .single();
  if (error) throw error;
  const lastDate = (data?.last_review_date as string | null) ?? null;
  const current = (data?.current_streak as number | null) ?? 0;
  const longest = (data?.longest_streak as number | null) ?? 0;
  // If a day was skipped, the stored current_streak is stale until the next
  // bump. Report a fresh view to the UI.
  const today = todayYmd();
  const yesterday = addDays(today, -1);
  const effectiveCurrent =
    lastDate === today || lastDate === yesterday ? current : 0;
  return {
    current: effectiveCurrent,
    longest,
    lastDate,
    ...deriveFlags(effectiveCurrent, lastDate),
  };
}

/**
 * Record review activity for today. Idempotent within a single day:
 *   - lastDate === today: no-op.
 *   - lastDate === yesterday: current += 1.
 *   - else: current = 1 (new streak).
 * longest_streak is updated to max(longest, current).
 */
export async function bumpStreak(): Promise<Streak> {
  const db = getDb();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const today = todayYmd();
  const prev = await getStreak();
  if (prev.lastDate === today) return prev;

  const yesterday = addDays(today, -1);
  const nextCurrent = prev.lastDate === yesterday ? prev.current + 1 : 1;
  const nextLongest = Math.max(prev.longest, nextCurrent);

  const { error } = await db
    .from('profiles')
    .update({
      current_streak: nextCurrent,
      longest_streak: nextLongest,
      last_review_date: today,
    })
    .eq('id', user.id);
  if (error) throw error;
  return {
    current: nextCurrent,
    longest: nextLongest,
    lastDate: today,
    ...deriveFlags(nextCurrent, today),
  };
}

import { getDb } from './db';

/**
 * Permanently delete the authenticated user's account. Deletes their
 * auth.users row; ON DELETE CASCADE on every app table wipes profile,
 * openings, nodes, and review_cards. Caller should sign out afterwards.
 *
 * Backed by the `public.delete_my_account()` SQL function (SECURITY DEFINER).
 */
export async function deleteMyAccount(): Promise<void> {
  const { error } = await getDb().rpc('delete_my_account');
  if (error) throw error;
}

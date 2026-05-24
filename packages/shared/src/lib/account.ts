import { getDb } from './db';

/**
 * Permanently delete the authenticated user's account. Cancels any active
 * Stripe subscription first, then deletes the auth.users row which cascades
 * to wipe profile, openings, nodes, and review_cards.
 */
export async function deleteMyAccount(): Promise<void> {
  const db = getDb();
  const { error } = await db.functions.invoke('delete-account');
  if (error) throw error;
}

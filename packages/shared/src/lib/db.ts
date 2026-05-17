import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types';

let _db: SupabaseClient<Database> | null = null;

export function initDb(client: SupabaseClient<Database>) {
  _db = client;
}

export function getDb(): SupabaseClient<Database> {
  if (!_db) throw new Error('[pawntree/shared] Call initDb() before using DB functions');
  return _db;
}

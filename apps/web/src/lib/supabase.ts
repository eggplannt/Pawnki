import { Database } from '@/types/database.types'
import { createClient } from '@supabase/supabase-js'
import { initDb } from '@pawntree/shared'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

export const supabase = createClient<Database>(supabaseUrl, supabasePublishableKey)
initDb(supabase)

-- Lets the authenticated user delete their own auth.users row. All app data
-- (profiles, openings, nodes, review_cards) has ON DELETE CASCADE pointing at
-- auth.users, so a single delete here wipes everything for the user.
--
-- SECURITY DEFINER + revoke-from-public + grant-to-authenticated is the
-- standard Supabase pattern for self-serve account deletion.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

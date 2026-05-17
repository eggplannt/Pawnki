-- The full FEN includes halfmove clock + fullmove number, which differ
-- across move orders that reach the same position. Transposition detection
-- needs to compare only the first 4 FEN fields: piece placement, active
-- color, castling rights, and en passant target.

alter table "public"."nodes"
  add column "position_key" text
  generated always as (substring(fen from '^([^ ]+ [^ ]+ [^ ]+ [^ ]+)')) stored;

-- Drop the old FEN index (no longer used for lookups).
drop index if exists public.idx_nodes_fen;

create index idx_nodes_position_key
  on public.nodes (position_key);

-- Transposition links: a node may "link to" another node (in the same
-- opening or a different one). A linked node carries no continuations
-- of its own; navigation follows the link to the canonical node.

alter table "public"."nodes"
  add column "transposes_to_node_id" uuid;

alter table "public"."nodes"
  add constraint "nodes_transposes_to_node_id_fkey"
  foreign key ("transposes_to_node_id")
  references "public"."nodes"("id")
  on delete set null
  not valid;

alter table "public"."nodes"
  validate constraint "nodes_transposes_to_node_id_fkey";

create index idx_nodes_transposes_to
  on public.nodes (transposes_to_node_id)
  where transposes_to_node_id is not null;

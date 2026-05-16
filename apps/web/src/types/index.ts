export interface Profile {
  id: string;
  display_name: string | null;
  created_at: string;
}

export interface Opening {
  id: string;
  user_id: string;
  name: string;
  color: 'white' | 'black';
  description: string | null;
  created_at: string;
}

export interface Node {
  id: string;
  opening_id: string;
  parent_id: string | null;
  move_san: string | null;
  move_uci: string | null;
  fen: string;
  position_key: string;
  annotation: string | null;
  sort_order: number;
  created_at: string;
  transposes_to_node_id: string | null;
  children?: Node[];
}

/** Resolved transposition target for a link node. */
export interface TranspositionTarget {
  node: Node;
  opening: Pick<Opening, 'id' | 'name' | 'color'>;
  sameOpening: boolean;
}

export interface ReviewCard {
  id: string;
  user_id: string;
  node_id: string;
  interval: number;
  ease_factor: number;
  repetitions: number;
  due_date: string;
  last_reviewed: string | null;
  node?: Node;
  opening?: Opening;
}

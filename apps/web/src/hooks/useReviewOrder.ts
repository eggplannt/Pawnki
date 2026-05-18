import { useCallback, useState } from 'react';
import { DEFAULT_REVIEW_ORDER, REVIEW_ORDERS, type ReviewOrder } from '@pawntree/shared';

export type { ReviewOrder };

const STORAGE_KEY = 'pawntree-review-order';

function getInitial(): ReviewOrder {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && (REVIEW_ORDERS as readonly string[]).includes(stored)) {
    return stored as ReviewOrder;
  }
  return DEFAULT_REVIEW_ORDER;
}

export function useReviewOrder(): [ReviewOrder, (o: ReviewOrder) => void] {
  const [order, setOrderState] = useState<ReviewOrder>(getInitial);
  const setOrder = useCallback((o: ReviewOrder) => {
    setOrderState(o);
    localStorage.setItem(STORAGE_KEY, o);
  }, []);
  return [order, setOrder];
}

/** Read the saved review order without subscribing (for one-off calls). */
export function readReviewOrder(): ReviewOrder {
  return getInitial();
}

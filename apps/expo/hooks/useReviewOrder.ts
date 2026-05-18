import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_REVIEW_ORDER, REVIEW_ORDERS, type ReviewOrder } from '@pawntree/shared';

export type { ReviewOrder };

const STORAGE_KEY = 'pawntree-review-order';

export function useReviewOrder(): [ReviewOrder, (o: ReviewOrder) => void] {
  const [order, setOrderState] = useState<ReviewOrder>(DEFAULT_REVIEW_ORDER);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v && (REVIEW_ORDERS as readonly string[]).includes(v)) {
        setOrderState(v as ReviewOrder);
      }
    });
  }, []);

  const setOrder = useCallback((o: ReviewOrder) => {
    setOrderState(o);
    AsyncStorage.setItem(STORAGE_KEY, o).catch(() => {});
  }, []);

  return [order, setOrder];
}

/** Read the saved review order (async, for one-off calls). */
export async function readReviewOrder(): Promise<ReviewOrder> {
  const v = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  if (v && (REVIEW_ORDERS as readonly string[]).includes(v)) {
    return v as ReviewOrder;
  }
  return DEFAULT_REVIEW_ORDER;
}

import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';

export interface NavLocation {
  openingId: string;
  nodeId: string;
}

export interface NavEntry {
  /** Where the user was. */
  from: NavLocation;
  /** Where they ended up after the jump — used to validate that popping
   *  this entry makes sense for the current location. */
  to: NavLocation;
}

interface NavHistoryAPI {
  push: (entry: NavEntry) => void;
  popIfArrivedAt: (current: NavLocation) => NavEntry | null;
  peek: () => NavEntry | null;
  clear: () => void;
}

function sameLoc(a: NavLocation, b: NavLocation) {
  return a.openingId === b.openingId && a.nodeId === b.nodeId;
}

const NavHistoryContext = createContext<NavHistoryAPI | null>(null);

export function NavHistoryProvider({ children }: { children: ReactNode }) {
  const stack = useRef<NavEntry[]>([]);

  const push = useCallback((entry: NavEntry) => {
    stack.current.push(entry);
  }, []);
  const popIfArrivedAt = useCallback((current: NavLocation) => {
    const top = stack.current[stack.current.length - 1];
    if (top && sameLoc(top.to, current)) {
      stack.current.pop();
      return top;
    }
    return null;
  }, []);
  const peek = useCallback(() => stack.current[stack.current.length - 1] ?? null, []);
  const clear = useCallback(() => { stack.current = []; }, []);

  return (
    <NavHistoryContext.Provider value={{ push, popIfArrivedAt, peek, clear }}>
      {children}
    </NavHistoryContext.Provider>
  );
}

export function useNavHistory(): NavHistoryAPI {
  const ctx = useContext(NavHistoryContext);
  if (!ctx) throw new Error('useNavHistory must be used inside <NavHistoryProvider>');
  return ctx;
}

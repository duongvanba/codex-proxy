import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

function readLocalStorageValue<T>(key: string, initialState: T | (() => T)): T {
  const fallback = typeof initialState === "function" ? (initialState as () => T)() : initialState;
  if (typeof window === "undefined") return fallback;

  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

function writeLocalStorageValue<T>(key: string, value: T) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota/private-mode failures; React state remains the source for this render.
  }
}

export function useLocalStorageState<T>(
  key: string,
  initialState: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => readLocalStorageValue(key, initialState));

  const setLocalStorageState = useCallback<Dispatch<SetStateAction<T>>>((nextState) => {
    setState((prevState) => {
      const nextValue = typeof nextState === "function"
        ? (nextState as (prevState: T) => T)(prevState)
        : nextState;
      if (Object.is(prevState, nextValue)) return prevState;
      writeLocalStorageValue(key, nextValue);
      return nextValue;
    });
  }, [key]);

  return [state, setLocalStorageState];
}

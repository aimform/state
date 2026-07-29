import { create } from "zustand";

export interface LoadingContext {
  setKey: (path: string | string[], value: unknown) => void;
  setError: (msg: string | null) => void;
}

/**
 * Creates a Zustand store. Automatically adds loading/errors state
 * managed by withLoading. Uses immer internally for setKey deep updates.
 */
export function createStore<T extends Record<string, unknown>>(
  initial: T,
  actionsFn: (
    set: (p: Partial<T>) => void,
    get: () => T,
  ) => Record<string, (...args: never[]) => unknown>,
) {
  type FullState = T & { loading: Record<string, boolean>; errors: Record<string, string | null> };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return create<FullState>()((set: any, get: any) => {
    const immerSet = (partial: Partial<FullState> | ((s: FullState) => void)) => {
      if (typeof partial === "function") {
        set((s: FullState) => {
          const next = { ...s };
          partial(next);
          return next;
        });
      } else {
        set((s: FullState) => ({ ...s, ...partial }));
      }
    };

    const rawActions = actionsFn(
      immerSet as unknown as (p: Partial<T>) => void,
      get as () => T,
    );

    // Pre-bind set/get to each action so consumers call store.fetchItems(args)
    // instead of store.fetchItems(set, get, args)
    const boundActions: Record<string, (...args: never[]) => unknown> = {};
    for (const [key, action] of Object.entries(rawActions)) {
      boundActions[key] = (...args: unknown[]) => (action as (...a: unknown[]) => unknown)(immerSet as unknown as (p: Partial<T>) => void, get as () => T, ...args);
    }

    return {
      ...initial,
      loading: ((initial as Record<string, unknown>).loading as Record<string, boolean>) ?? {},
      errors: ((initial as Record<string, unknown>).errors as Record<string, string | null>) ?? {},
      ...boundActions,
    } as FullState;
  });
}

/**
 * Wraps an async action with loading/error state management.
 * The returned function receives (set, get, ...userArgs).
 */
export function withLoading<TArgs extends unknown[]>(
  key: string,
  fn: (ctx: LoadingContext, ...args: TArgs) => Promise<void>,
) {
  return (
    set: (p: Record<string, unknown>) => void,
    get: () => Record<string, unknown>,
    ...args: TArgs
  ): Promise<void> => {
    const begin = (s: Record<string, unknown>) => {
      const ld = { ...(s.loading as Record<string, boolean> ?? {}), [key]: true };
      const er = { ...(s.errors as Record<string, string | null> ?? {}), [key]: null };
      return { loading: ld, errors: er };
    };
    const end = (s: Record<string, unknown>, error?: string) => {
      const ld = { ...(s.loading as Record<string, boolean> ?? {}), [key]: false };
      const er = { ...(s.errors as Record<string, string | null> ?? {}), [key]: error ?? null };
      return { loading: ld, errors: er };
    };

    set(begin(get() as Record<string, unknown>));

    let caught: Error | null = null;

    const ctx: LoadingContext = {
      setKey(path: string | string[], value: unknown) {
        const keys = Array.isArray(path) ? path : path.split(".");
        if (keys.length === 1) {
          set({ [keys[0]]: value } as Record<string, unknown>);
        } else {
          const current = get() as Record<string, unknown>;
          const neu = { ...current };
          let obj: Record<string, unknown> = neu;
          for (let i = 0; i < keys.length - 1; i++) {
            obj[keys[i]] = { ...(obj[keys[i]] as Record<string, unknown> ?? {}) };
            obj = obj[keys[i]] as Record<string, unknown>;
          }
          obj[keys[keys.length - 1]] = value;
          set(neu);
        }
      },
      setError(msg: string | null) {
        const s = get() as Record<string, unknown>;
        const e = { ...(s.errors as Record<string, string | null> ?? {}), [key]: msg };
        set({ errors: e } as Record<string, unknown>);
      },
    };

    return fn(ctx, ...args)
      .catch((e) => { caught = e as Error; })
      .finally(() => {
        set(end(get() as Record<string, unknown>, caught?.message));
      });
  };
}

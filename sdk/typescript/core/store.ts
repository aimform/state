import { createStore as createVanillaStore } from "zustand/vanilla";
import {
  createAnonymousStoreName,
  getRealtimeCoordinator,
  inferResourcesForAction,
  isRealtimeQueryAction,
  STORE_ACTION_RUNTIME,
  type StoreActionRuntime,
  serializeRealtimeQueryArgs,
} from "./realtime";

export interface LoadingContext {
  setKey: (path: string | string[], value: unknown) => void;
  setError: (msg: string | null) => void;
}

export interface CreateStoreOptions {
  /** Unique name for the SSR-safe singleton registry. Required for SSR. */
  name?: string;
}

export type StateOf<T> = T & { loading: Record<string, boolean>; errors: Record<string, string | null> } & Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: preserve the existing action-call compatibility surface
    (...args: any[]) => any
  >;

// Shared internal: build a setter + getter pair for vanilla stores.
export function buildActions<T extends Record<string, unknown>>(
  _initial: T,
  actionsFn: (set: (p: Partial<T>) => void, get: () => T) => Record<string, (...args: never[]) => unknown>,
  set: (p: Partial<T>) => void,
  get: () => T,
  storeName?: string,
  realtimeEnabled = false,
): Record<string, (...args: never[]) => unknown> {
  const effectiveStoreName = storeName ?? createAnonymousStoreName();
  const rawActions = actionsFn(set, get);
  const boundActions: Record<string, (...args: never[]) => unknown> = {};
  for (const [key, action] of Object.entries(rawActions)) {
    boundActions[key] = (...args: unknown[]) => {
      const isQuery = realtimeEnabled && isRealtimeQueryAction(key);
      const trackedResources = inferResourcesForAction(key);
      const coordinator = isQuery ? getRealtimeCoordinator() : undefined;
      const registration = isQuery
        ? coordinator?.registerQuery({
            key: [effectiveStoreName, key, serializeRealtimeQueryArgs(args)].join(":"),
            actionName: key,
            args,
            resources: [...trackedResources],
            refresh: () => (boundActions[key] as (...a: unknown[]) => unknown)(...args),
          })
        : undefined;
      const runtime: StoreActionRuntime = {
        actionName: key,
        trackResource: (resource) => registration?.updateResources([resource]),
      };
      const runtimeGet = Object.assign(() => get(), { [STORE_ACTION_RUNTIME]: runtime });
      return (action as (...a: unknown[]) => unknown)(set, runtimeGet, ...args);
    };
  }
  return boundActions;
}

export function makeSet<T extends Record<string, unknown>>(
  rawSet: (fn: (s: T) => T) => void,
  _get: () => T,
): (p: Partial<T>) => void {
  return (partial) => {
    if (typeof partial === "function") {
      rawSet((s) => {
        const next = { ...s };
        (partial as (s: T) => void)(next);
        return next as T;
      });
    } else {
      rawSet((s) => ({ ...s, ...partial }) as T);
    }
  };
}

/**
 * Creates a vanilla Zustand store — no React hooks, works in any JS
 * environment (Cloudflare Workers, Node.js, Deno, tests).
 *
 * Used for SSR: the Worker creates per-request stores, pre-fetches data,
 * serializes state, and the client hydrates React stores from the result.
 *
 * API identical to the React-bound `createStore` — the same withLoading
 * actions work on both.
 */
export function createServerStore<T extends Record<string, unknown>>(
  initial: T,
  actionsFn: (set: (p: Partial<T>) => void, get: () => T) => Record<string, (...args: never[]) => unknown>,
) {
  const store = createVanillaStore<StateOf<T>>(() => {
    const vSet = (fn: (s: StateOf<T>) => StateOf<T>) => store.setState(fn(store.getState()));
    const vGet = () => store.getState();

    const immerSet = makeSet(
      vSet as unknown as (fn: (s: T) => T) => void,
      vGet as unknown as () => T,
    );
    const boundActions = buildActions(
      initial as T,
      actionsFn,
      immerSet as unknown as (p: Partial<T>) => void,
      vGet as () => T,
      undefined,
      false,
    );

    return {
      ...initial,
      loading: ((initial as Record<string, unknown>).loading as Record<string, boolean>) ?? {},
      errors: ((initial as Record<string, unknown>).errors as Record<string, string | null>) ?? {},
      ...boundActions,
    } as StateOf<T>;
  });

  return store;
}

/**
 * Wraps an async action with loading/error state management.
 * Works identically in both `createStore` (React) and `createServerStore`
 * (vanilla).
 */
export function withLoading<TArgs extends unknown[], TResult = void>(
  key: string,
  fn: (ctx: LoadingContext, ...args: TArgs) => Promise<TResult>,
) {
  return (
    set: (p: Record<string, unknown>) => void,
    get: () => Record<string, unknown>,
    ...args: TArgs
  ): Promise<TResult | undefined> => {
    const begin = (s: Record<string, unknown>) => {
      const ld = { ...((s.loading as Record<string, boolean>) ?? {}), [key]: true };
      const er = { ...((s.errors as Record<string, string | null>) ?? {}), [key]: null };
      return { loading: ld, errors: er };
    };
    const end = (s: Record<string, unknown>, error?: string) => {
      const ld = { ...((s.loading as Record<string, boolean>) ?? {}), [key]: false };
      const er = { ...((s.errors as Record<string, string | null>) ?? {}), [key]: error ?? null };
      return { loading: ld, errors: er };
    };

    set(begin(get() as Record<string, unknown>));

    let caught: Error | null = null;
    let result: TResult | undefined;

    const runtime = (get as (() => Record<string, unknown>) & { [STORE_ACTION_RUNTIME]?: StoreActionRuntime })[
      STORE_ACTION_RUNTIME
    ];
    const ctx: LoadingContext = {
      setKey(path: string | string[], value: unknown) {
        const keys = Array.isArray(path) ? path : path.split(".");
        runtime?.trackResource(keys[0]);
        if (keys.length === 1) {
          set({ [keys[0]]: value } as Record<string, unknown>);
        } else {
          const current = get() as Record<string, unknown>;
          const neu = { ...current };
          let obj: Record<string, unknown> = neu;
          for (let i = 0; i < keys.length - 1; i++) {
            obj[keys[i]] = { ...((obj[keys[i]] as Record<string, unknown>) ?? {}) };
            obj = obj[keys[i]] as Record<string, unknown>;
          }
          obj[keys[keys.length - 1]] = value;
          set(neu);
        }
      },
      setError(msg: string | null) {
        const s = get() as Record<string, unknown>;
        const e = { ...((s.errors as Record<string, string | null>) ?? {}), [key]: msg };
        set({ errors: e } as Record<string, unknown>);
      },
    };

    return fn(ctx, ...args)
      .then((r) => {
        result = r;
      })
      .catch((e) => {
        caught = e as Error;
      })
      .finally(() => {
        set(end(get() as Record<string, unknown>, caught?.message));
      })
      .then(() => result);
  };
}

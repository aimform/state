import type { StoreApi, UseBoundStore } from "zustand";
import { useStore as useZustandStore } from "zustand/react";
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
import { getScoped } from "./request-scope";

export interface LoadingContext {
  setKey: (path: string | string[], value: unknown) => void;
  setError: (msg: string | null) => void;
}

export interface CreateStoreOptions {
  /** Unique name for the SSR-safe singleton registry. Required for SSR. */
  name?: string;
}

// Shared internal: build a setter + getter pair for vanilla stores.
function buildActions<T extends Record<string, unknown>>(
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

function makeSet<T extends Record<string, unknown>>(
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

type FullStateOf<T> = T & { loading: Record<string, boolean>; errors: Record<string, string | null> };
// biome-ignore lint/complexity/noBannedTypes: index signature must use any — unknown breaks Partial<T> compatibility
// biome-ignore lint/suspicious/noExplicitAny: index signature must use any — unknown breaks Partial<T> compatibility
type StateOf<T> = FullStateOf<T> & Record<string, (...args: any[]) => any>;

function buildBoundStore<T extends Record<string, unknown>>(
  initial: T,
  actionsFn: (set: (p: Partial<T>) => void, get: () => T) => Record<string, (...args: never[]) => unknown>,
  storeName?: string,
): UseBoundStore<StoreApi<StateOf<T>>> {
  // Build the vanilla store ourselves (instead of going through zustand's
  // `create()`) so we keep a direct reference to `api`. Zustand's `create()`
  // returns a bound hook function with `api`'s methods copied onto it via
  // `Object.assign` — a one-time copy, not a live binding. Overriding
  // `boundStore.getInitialState` afterwards has no effect on the hook,
  // because `zustand/react`'s `useStore(api, selector)` closes over the
  // original `api` object and always reads `api.getInitialState` from that
  // closure. We need to mutate `api` itself for the override to take effect.
  const api = createVanillaStore<StateOf<T>>((set, get) => {
    const immerSet = makeSet(
      set as unknown as (fn: (s: T) => T) => void,
      get as () => T,
    );
    const boundActions = buildActions(
      initial as T,
      actionsFn,
      immerSet as unknown as (p: Partial<T>) => void,
      get as () => T,
      storeName,
      typeof window !== "undefined",
    );

    return {
      ...initial,
      loading: ((initial as Record<string, unknown>).loading as Record<string, boolean>) ?? {},
      errors: ((initial as Record<string, unknown>).errors as Record<string, string | null>) ?? {},
      ...boundActions,
    } as unknown as StateOf<T>;
  });

  // Fix SSR: React always calls useSyncExternalStore's third argument
  // (getServerSnapshot) during renderToString — never getSnapshot. Zustand's
  // useStore passes api.getInitialState as that argument, which is frozen at
  // create() time, before any pre-fetch runs. Override it on `api` itself so
  // renderToString sees the live, pre-fetched state.
  api.getInitialState = () => api.getState();

  const useBoundStore = ((selector?: (s: StateOf<T>) => unknown) =>
    useZustandStore(api, selector as never)) as UseBoundStore<StoreApi<StateOf<T>>>;
  Object.assign(useBoundStore, api);
  return useBoundStore;
}

/**
 * Creates a Zustand store with React hook integration (useSyncExternalStore).
 * Automatically adds loading/errors state managed by withLoading.
 * Use this in React components.
 *
 * Pass `{ name }` to get a singleton — the SAME store instance every time
 * `createStore` is called with that name. Required for SSR (survives
 * bundler module duplication) AND per-request isolated in a Cloudflare
 * Worker (see `./request-scope.ts`): each request gets its own instance,
 * so concurrent requests never see another user's data through it. Without
 * `name`, a fresh, unshared store is created on every call.
 */
export function createStore<T extends Record<string, unknown>>(
  initial: T,
  actionsFn: (set: (p: Partial<T>) => void, get: () => T) => Record<string, (...args: never[]) => unknown>,
  opts?: CreateStoreOptions,
): UseBoundStore<StoreApi<StateOf<T>>> {
  if (opts?.name) {
    return getScoped(opts.name, () => buildBoundStore(initial, actionsFn, opts.name));
  }
  return buildBoundStore(initial, actionsFn);
}

/**
 * Drop-in, SSR-safe replacement for zustand's own `create()` — same flat
 * `(set, get) => ({ ...state, ...actions })` shape, no `loading`/`errors`
 * scaffolding or withLoading conventions layered on top (unlike
 * `createStore`). Use this for stores that need direct control over their
 * own fields (e.g. auth, theme) instead of the data-fetching convention
 * `createStore` is built for.
 *
 * Exists because plain `zustand.create()` is NOT SSR-safe: during
 * `renderToString`, `useSyncExternalStore` always reads the third
 * (`getServerSnapshot`) argument, which zustand's React binding wires to
 * `api.getInitialState()` — frozen at module-eval time. Any `setState()`
 * call made before rendering (e.g. seeding auth/theme from the Worker's
 * request data) updates `getState()` but never reaches the hook during
 * SSR, so `useStore(selector)` renders stale/default data. See
 * `buildBoundStore`'s internal comment for why overriding `getInitialState`
 * only works when applied to the real vanilla `api` object, not the
 * bound hook `create()` returns.
 *
 * Pass a `name` to get a per-request-isolated singleton in a Cloudflare
 * Worker (see `./request-scope.ts`) — required for any store seeded with
 * per-request data (auth token, user, theme, ...) that's read during SSR;
 * otherwise concurrent requests on the same warm Worker isolate can read
 * or clobber each other's state through the shared module singleton.
 * Without `name`, this is a plain persistent module singleton (correct for
 * pure client-side, single-user-per-tab stores).
 */
export function createSSRSafeStore<T extends object>(
  stateCreator: (
    set: (partial: T | Partial<T> | ((s: T) => T | Partial<T>), replace?: boolean) => void,
    get: () => T,
  ) => T,
  opts?: CreateStoreOptions,
): UseBoundStore<StoreApi<T>> {
  const build = () => {
    const api = createVanillaStore<T>(stateCreator as never);
    api.getInitialState = () => api.getState();

    const useBoundStore = ((selector?: (s: T) => unknown) => useZustandStore(api, selector as never)) as UseBoundStore<
      StoreApi<T>
    >;
    Object.assign(useBoundStore, api);
    return useBoundStore;
  };

  return opts?.name ? getScoped(opts.name, build) : build();
}

/**
 * Creates a vanilla Zustand store — no React hooks, works in any JS
 * environment (Cloudflare Workers, Node.js, Deno, tests).
 *
 * Used for SSR: the Worker creates per-request stores, pre-fetches data,
 * serializes state, and the client hydrates React stores from the result.
 *
 * API identical to `createStore` — same withLoading actions work on both.
 */
export function createServerStore<T extends Record<string, unknown>>(
  initial: T,
  actionsFn: (set: (p: Partial<T>) => void, get: () => T) => Record<string, (...args: never[]) => unknown>,
) {
  type FullState = T & { loading: Record<string, boolean>; errors: Record<string, string | null> };

  // biome-ignore lint/complexity/noBannedTypes: index signature must use any for setState compatibility
  // biome-ignore lint/suspicious/noExplicitAny: index signature must use any — unknown breaks Partial<T> compatibility
  const store = createVanillaStore<FullState & Record<string, (...args: any[]) => any>>(() => {
    // vanila store's set/get
    const vSet = (fn: (s: FullState) => FullState) =>
      // biome-ignore lint/complexity/noBannedTypes: index signature must use any for setState compatibility
      // biome-ignore lint/suspicious/noExplicitAny: index signature must use any — unknown breaks Partial<T> compatibility
      store.setState(fn(store.getState()) as FullState & Record<string, (...args: any[]) => any>);
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
    // biome-ignore lint/suspicious/noExplicitAny: index signature must use any — unknown breaks Partial<T> compatibility
    } as unknown as FullState & Record<string, (...args: any[]) => any>;
  });

  return store;
}

/**
 * Wraps an async action with loading/error state management.
 * Works identically in both `createStore` (React) and `createServerStore` (vanilla).
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

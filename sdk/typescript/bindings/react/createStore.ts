import type { StoreApi, UseBoundStore } from "zustand";
import { useStore as useZustandStore } from "zustand/react";
import { createStore as createVanillaStore } from "zustand/vanilla";
import {
  buildActions,
  makeSet,
  type CreateStoreOptions,
  type StateOf,
} from "../../core/store";
import { getScoped } from "../../runtime/request-scope";

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
 * request data) updates `getState()` but never reaches the hook during SSR,
 * so `useStore(selector)` renders stale/default data. See
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

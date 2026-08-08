# @aimform/state — AGENTS.md

## Package Purpose

`@aimform/state` is the **only allowed** state management layer in Aimform. It wraps Zustand 5 + Immer 11 behind a single API. Services and packages **must never** import `zustand` or `immer` directly.

## Exports

| Export | Kind | Purpose |
|--------|------|---------|
| `createStore(initialData, actionsFactory)` | function | Creates a Zustand store with Immer-powered immutable updates |
| `withLoading(key, fn)` | function | Wraps an async action — manages `loading` and `errors` automatically |
| `LoadingContext` | interface | Context object passed to `withLoading` callbacks |
| `AsyncState` | type | `{ loading, errors }` shape |
| `StoreHook` | type | Hook type for store consumers |

## Usage

```ts
import { createStore, withLoading } from "@aimform/state";

const useStore = createStore({
  items: [] as Item[],
  filter: "",
}, (set, get) => ({
  fetchItems: withLoading("fetchItems", async ({ setKey }, orgId: string) => {
    const items = await api.fetchItems(orgId);
    setKey("items", items);
  }),
  setFilter: (filter: string) => set({ filter }),
}));
```

## The `withLoading` Contract

Every `withLoading` callback receives a `LoadingContext`:
```ts
interface LoadingContext {
  setKey: (path: string | string[], value: unknown) => void;
  setError: (msg: string | null) => void;
}
```

**State guarantees after calling `withLoading(key, fn)`:**
- `loading[key]: true` — set before `fn` executes
- `errors[key]: null` — cleared before `fn` executes
- `loading[key]: false` — set after `fn` completes (success or failure)
- If `fn` throws: `errors[key]` is set to the error message, then the error is re-thrown

## Best Practices

1. **Every async action uses `withLoading`** — no exceptions
2. **Unique action keys** — use descriptive keys (`"fetchSpaces"`, `"createEntity"`)
3. **`loading` and `errors` are NEVER persisted** — they are transient UI state
4. **Hooks wrap each action** — expose `{ data, isLoading, error, run }`
5. **Components never import state management tools directly** — only `@aimform/state`
6. **`setKey` for nested updates** — `setKey("spaces.selected.entityType", value)`

## Anti-patterns

```
❌ import { create } from "zustand";
❌ import { produce } from "immer";
❌ Manually managing loading/errors state
❌ Persisting loading or errors to localStorage
❌ Components accessing store.loading["key"] directly (use hooks)
```

## Type Contract

```ts
function createStore<T extends Record<string, unknown>>(
  initialData: T,
  actionsFactory: (set: SetFn, get: GetFn) => Record<string, unknown>
): StoreWithState & HookType;

function withLoading<Args extends unknown[]>(
  key: string,
  fn: (ctx: LoadingContext, ...args: Args) => Promise<void>
): (set: SetFn, get: GetFn, ...args: Args) => Promise<void>;
```

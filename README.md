# @aimform/state

> Complete Zustand + Immer abstraction. Create stores, async actions, and hooks without importing `zustand` or `immer` directly.

```sh
npm install @aimform/state
```

No other state dependencies needed — `zustand` and `immer` are bundled.

## Usage

### `createStore(initialData, actionsFactory)`

Creates a Zustand store with Immer-powered immutable updates and built-in `loading`/`errors` state.

```ts
import { createStore, withLoading } from "@aimform/state";

const useStore = createStore({
  items: [] as Item[],
  filter: "" as string,
}, (set, get) => ({
  fetchItems: withLoading("fetchItems", async ({ setKey }, orgId: string) => {
    const items = await api.fetchItems(orgId);
    setKey("items", items);
  }),

  addItem: withLoading("addItem", async ({ setKey }, item: Item) => {
    const created = await api.createItem(item);
    setKey("items", [created, ...get().items]);
  }),

  setFilter: (filter: string) => set({ filter }),
}));
```

### `withLoading(key, fn)`

Wraps an async action. Returns a function that receives the store context and the action's own arguments.

| Field | Description |
|-------|-------------|
| `key` | Unique action key stored in `loading` and `errors` maps |
| `fn` | `(ctx, ...args) => Promise<T>` — async function with `ctx.setKey` and `ctx.setError` |

**State contract:** Every store using `createStore` automatically gets:
- `loading: Record<string, boolean>` — `true` while action runs, `false` after
- `errors: Record<string, string | null>` — error message on failure, `null` otherwise
- Both managed entirely by `withLoading` — you never set them manually

### `LoadingContext`

```ts
interface LoadingContext {
  setKey: (path: string | string[], value: unknown) => void;  // deep set via immer
  setError: (msg: string | null) => void;                      // set error for this action
}
```

### Hooks

Write hooks manually to expose `{ data, isLoading, error, run }`:

```ts
export function useItems() {
  const data = useStore((s) => s.items);
  const isLoading = useStore((s) => s.loading["fetchItems"] ?? false);
  const error = useStore((s) => s.errors["fetchItems"] ?? null);
  return { data, isLoading, error, run: (orgId: string) => useStore.getState().fetchItems(orgId) };
}
```

## Full example — store + hooks

```ts
// store.ts
import { createStore, withLoading } from "@aimform/state";
import * as api from "./api";

export const useSpacesStore = createStore({
  spaces: [] as Space[],
}, (set, get) => ({
  fetchSpaces: withLoading("fetchSpaces", async ({ setKey }, orgId: string) => {
    setKey("spaces", await api.listSpaces(orgId));
  }),
  createSpace: withLoading("createSpace", async ({ setKey }, name: string) => {
    const space = await api.createSpace(name);
    setKey("spaces", [space, ...get().spaces]);
  }),
}));

// hooks.ts
export function useSpaces() {
  const data = useSpacesStore((s) => s.spaces);
  const isLoading = useSpacesStore((s) => s.loading["fetchSpaces"] ?? false);
  return { data, isLoading, run: (orgId: string) => useSpacesStore.getState().fetchSpaces(orgId) };
}
```

## Why not use zustand directly?

- No manual `loading`/`errors` boilerplate — `withLoading` handles it
- Immer baked in — `setKey("items", [...get().items, newItem])` works without spread operators
- Consistent action pattern across every store in your project
- One dependency (`@aimform/state`) instead of three (`zustand`, `immer`, `@aimform/state`)

## License

MIT © Universal Reason LLC

# @aimform/state

> Zustand utilities for the Aimform platform — `withLoading`, async wrappers, and standardized store types.

## Install

```sh
npm install @aimform/state immer
```

## Usage

```ts
import { create } from "zustand";
import { withLoading } from "@aimform/state";
import type { AsyncState } from "@aimform/state";
import * as api from "./my-api";

interface MyState extends AsyncState {
  items: Item[];
  fetchItems: () => Promise<void>;
}

export const useMyStore = create<MyState>()((set, get) => ({
  items: [],
  loading: {},
  errors: {},

  fetchItems: async () => {
    return withLoading("fetchItems", async (_set, _get, setKey, setError) => {
      const items = await api.fetchItems();
      setKey("items", items);
    }, set as never, get as never);
  },
}));

// Hook
export function useFetchItems() {
  const items = useMyStore((s) => s.items);
  const isLoading = useMyStore((s) => s.loading["fetchItems"] ?? false);
  const error = useMyStore((s) => s.errors["fetchItems"]);
  const fetchItems = useMyStore((s) => s.fetchItems);
  return { data: items, isLoading, error, run: fetchItems };
}
```

## API

### `withLoading(key, fn, set, get, ...args)`

Generic async wrapper that manages `loading[key]` and `errors[key]` state.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | Unique action key (e.g. `"fetchItems"`) |
| `fn` | `(set, get, setKey, setError, ...args) => Promise<void>` | Async function to execute |
| `set` | `(partial) => void` | Zustand `set` |
| `get` | `() => state` | Zustand `get` |
| `...args` | `T` | Passed through to `fn` |

**Inside `fn`:**
- `setKey(path, value)` — update nested state (deep path via immer)
- `setError(msg)` — set error for the action key

**State contract:**
- `loading[key]` set to `true` before, `false` after
- `errors[key]` set to `null` before, error message on failure
- Errors are caught and stored; function does not throw

### `AsyncState` interface

```ts
interface AsyncState {
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
}
```

Extend your store with `AsyncState` to get typed loading/errors.

### `StoreHook<T>` type

```ts
interface StoreHook<T> {
  data: T;
  isLoading: boolean;
  error: string | null;
  run: (...args: unknown[]) => Promise<void>;
}
```

Standard shape for hooks that wrap store actions.

→ [Building custom stores](../docs/standards/zustand-standards.md)

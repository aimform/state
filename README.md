# @aimform/state

> Complete Zustand + Immer abstraction. Create stores, async actions, and hooks without importing `zustand` or `immer` directly.

```sh
npm install @aimform/state
```

No other state dependencies needed — `zustand` and `immer` are bundled.

The SDK exposes vanilla store construction, `withLoading`, and realtime
coordination from `@aimform/state/core`, request-scoped host support from
`@aimform/state/runtime`, and React store construction from
`@aimform/state/bindings/react`. The root export remains stable for existing
applications.

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

For server, worker, test, or other non-React code, import
`createServerStore` and `withLoading` from `@aimform/state/core`. This entry
point does not load React:

```ts
import { createServerStore, withLoading } from "@aimform/state/core";
```

### `LoadingContext`

```ts
interface LoadingContext {
  setKey: (path: string | string[], value: unknown) => void;  // deep set via immer
  setError: (msg: string | null) => void;                      // set error for this action
}
```

### Automatic realtime synchronization

Browser `createStore` queries are registered automatically when an action name
starts with `fetch`, `load`, `list`, `get`, `resolve`, `search`, `refresh`, or
`hydrate`. `withLoading` also observes the top-level keys passed to `setKey`,
so the state package can match a server mutation to the data the action fetched.
Matching created, updated, deleted, changed, and domain events coalesce into a
safe refetch of the original arguments. No store-specific WebSocket code or
manual invalidation callback is required.

Transport adapters stay provider-neutral and outside the coordinator. Use
`createRealtimeManager` to keep one app-lifetime subscription and route any
transport into the same state coordinator:

```ts
import { createRealtimeManager } from "@aimform/state";

const manager = createRealtimeManager(myWebSocketOrSseAdapter);
manager.start([{ id: "organization", request: { streamUrl, token } }]);
```

`myWebSocketOrSseAdapter` can be implemented with Cloudflare Durable Objects,
AWS API Gateway, Redis, SSE, polling, or another provider. The state package
does not import or depend on any of them.

The event should identify a resource with `event.model`, `event.table`,
`event.metadata.resources`, `resource`, or `resources`. Payload snapshots are
not required; refetching through the normal authenticated API keeps filters,
pagination, and row-level ACLs authoritative. The coordinator deduplicates
sequenced events, coalesces bursts, and prevents overlapping refreshes.

Provider transports may mark retained history with `isReplay: true`. Managers
deliver those events to listeners but do not send them through the query
invalidator: the initial authenticated fetch has already hydrated the store,
so treating a replay window as new writes would cause a refetch storm. Live
events remain unmarked and continue to invalidate matching queries normally.

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
- Consistent action pattern across every store in your project
- One dependency (`@aimform/state`) instead of three (`zustand`, `immer`, `@aimform/state`)
- **SSR-ready** — `createServerStore` works in Workers, Node.js, and tests without React

## SSR (Server-Side Rendering)

Uses `createServerStore` — a vanilla Zustand store (no React hooks). Same `withLoading` actions run on both server and client.

```ts
import { createServerStore, withLoading } from "@aimform/state";

// Server: isolated per-request store
const serverStore = createServerStore(
  { items: [] as Item[] },
  (set, get) => ({
    fetchItems: withLoading("fetchItems", async ({ setKey }) => {
      setKey("items", await api.list());
    }),
  }),
);

// Worker: pre-fetch → serialize → inject
await serverStore.getState().fetchItems();
const { loading, errors, ...data } = serverStore.getState();
const html = template.replace("</head>",
  `<script>window.__SSR_STATE__=${JSON.stringify(data)}</script></head>`
);

// Client: hydrate React store from server state
import { useItemsStore } from "./items-store";
useItemsStore.setState(JSON.parse(window.__SSR_STATE__));
createRoot(root).render(<App />);
```

### Key rules
1. `createServerStore` on server, `createStore` on client — same `withLoading` actions
2. Never serialize `loading`/`errors` — hydration mismatch
3. One store per request — `createServerStore` creates isolated instances
4. Pre-fetch all data before `renderToString` — SSR is synchronous

## License

MIT © Universal Reason LLC

## Conformance

`conformance/manifest.json` and `conformance/core.json` define the portable
store contract. The owner-local runner verifies vanilla server-store behavior,
loading/error ordering, and deterministic realtime query serialization without
loading React. React binding behavior remains covered by the binding tests.

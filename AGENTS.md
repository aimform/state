# @aimform/state — AGENTS.md

## Package Purpose

`@aimform/state` is the **only allowed** state management layer in Aimform. It wraps Zustand 5 + Immer 11 behind a single API. Services and packages **must never** import `zustand` or `immer` directly.

## SDK layer layout

Vanilla store construction, `withLoading`, and realtime contracts live under
`sdk/typescript/core`, request-scoped host support under
`sdk/typescript/runtime`, and React store construction under
`sdk/typescript/bindings/react`. Use the root package export for compatibility;
new framework-neutral integrations should depend on the `core` entrypoint.

## Exports

| Export | Kind | Purpose |
|--------|------|---------|
| `createStore(initialData, actionsFactory)` | function | Creates a Zustand React hook store |
| `createServerStore(initialData, actionsFactory)` | function | Creates a vanilla Zustand store (no React) — for SSR/tests |
| `withLoading(key, fn)` | function | Wraps an async action — manages `loading` and `errors` automatically |
| `LoadingContext` | interface | Context object passed to `withLoading` callbacks |
| `AsyncState` | type | `{ loading, errors }` shape |
| `StoreHook` | type | Hook type for store consumers |
| `StateRealtimeEvent` / `RealtimeTransportEvent` | types | Provider-neutral realtime envelopes; retained history may set `isReplay` |

For a React-free import, use:

```ts
import { createServerStore, withLoading } from "@aimform/state/core";
```

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

## SSR (Server-Side Rendering)

`@aimform/state` supports SSR via `createServerStore` — a vanilla Zustand store that works without React. The same `withLoading` actions run on both server and client.

### Architecture

```
Server (Cloudflare Worker, per-request):
  1. createServerStore() → fresh isolated store
  2. store.getState().fetchData() → pre-fetch all data
  3. strip loading/errors → serialize to JSON
  4. Inject as window.__SSR_STATE__ into HTML
  5. renderToString(<App />) → SSR HTML with real data

Client (Browser):
  1. Parse window.__SSR_STATE__ → hydrate React stores
  2. createRoot/hydrateRoot(<App />) → render with pre-filled data
  3. Components see data immediately — no spinners, no API calls
```

### Server-Side Example

```ts
import { createServerStore, withLoading } from "@aimform/state";

// Same store definition as client, but using createServerStore
const conversationsStore = createServerStore(
  { conversations: [] as Conversation[] },
  (set, get) => ({
    fetchConversations: withLoading("fetchConversations", async ({ setKey }, orgId, userId) => {
      const result = await api.listConversations(orgId, userId);
      setKey("conversations", result);
    }),
  }),
);

// Worker fetch handler
export default {
  async fetch(request: Request) {
    const orgId = "d335a596-...";
    const userId = "6d92ce99-...";

    // Pre-fetch data — same withLoading action as the client uses
    await conversationsStore.getState().fetchConversations(orgId, userId);

    // Serialize state (strip loading/errors — they're transient UI state)
    const full = conversationsStore.getState();
    const { loading, errors, ...serializable } = full;
    const stateJson = JSON.stringify(serializable);

    // Inject into HTML
    const html = template.replace(
      "</head>",
      `<script>window.__SSR_STATE__={"conversations":${stateJson}}</script></head>`,
    );

    return new Response(html, { headers: { "content-type": "text/html" } });
  },
};
```

### Client-Side Hydration

```ts
// entry-client.tsx
import { useConversationsStore } from "../store/conversations-store";

if (window.__SSR_STATE__) {
  const state = JSON.parse(window.__SSR_STATE__);
  // Hydrate React stores from server state
  useConversationsStore.setState(state.conversations);
  // Component selectors now return pre-filled data — no loading spinner
}

createRoot(document.getElementById("root")!).render(<App />);
```

### Key Rules for SSR

1. **Use `createServerStore` on the server** — never `createStore` (which creates React hooks)
2. **Same `withLoading` actions work everywhere** — the action code is identical; only the store creation differs
3. **Never serialize `loading` or `errors`** — they are transient UI state; stripping them prevents hydration mismatches
4. **One store instance per request** — `createServerStore` creates isolated instances; don't share state across requests
5. **Pre-fetch all data before `renderToString`** — SSR is synchronous; all API calls must complete first
6. **Hydrate stores before `createRoot`/`hydrateRoot`** — stores must have data before React renders

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

## Conformance

The package-local `conformance/manifest.json` declares the State contract and
`conformance/core.json` is run by `sdk/typescript/conformance.test.ts`. Keep
vanilla store, loading/error, deterministic serialization, and realtime
transport invariants there; React-specific behavior belongs in the binding
tests.
```

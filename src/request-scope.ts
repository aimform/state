/// <reference types="node" />

import { AsyncLocalStorage } from "node:async_hooks";

// Per-request isolation for server/Worker environments. In the browser
// there's only ever one user per tab, so a persistent, lazily-created
// singleton (the `persistentScope` fallback below) is correct and desired.
//
// In a Cloudflare Worker, though, a single isolate can interleave multiple
// concurrent requests on its event loop — anything awaited between seeding
// a store/client with one user's data (auth token, org id, conversations,
// theme, ...) and that data actually being read is a window where a
// DIFFERENT request's code can run on the very same shared module state
// and clobber it. Without isolation, that means one user's auth token or
// private data can end up rendered into a completely different user's
// SSR'd page.
//
// `runInRequestScope()` (called once per request, wrapping the whole
// `fetch` handler in `worker-entry.ts`) gives each request its own
// isolated bag of named singletons — `getScoped()` reads/writes to
// whichever bag is active for the currently-running request, so concurrent
// requests never see each other's instances.
// Anchored on `globalThis`, not a plain module-level variable — if a
// bundler (Rollup, in the SSR build) ends up with more than one copy of
// this module in its graph, each copy must still resolve to the SAME
// underlying AsyncLocalStorage/map, or request-scoping (and the
// pre-existing singleton-store behavior it replaces) silently breaks per
// duplicate.
const g = globalThis as unknown as {
  __aimform_request_scope__?: AsyncLocalStorage<Map<string, unknown>>;
  __aimform_persistent_scope__?: Map<string, unknown>;
};

if (!g.__aimform_request_scope__) g.__aimform_request_scope__ = new AsyncLocalStorage<Map<string, unknown>>();
const requestScope = g.__aimform_request_scope__;

// Used when there's no active request scope — the browser (single user per
// tab, no concurrency risk), tests, or any code that runs outside
// `runInRequestScope`. Matches the pre-existing singleton behavior other
// code in this package already relied on.
if (!g.__aimform_persistent_scope__) g.__aimform_persistent_scope__ = new Map<string, unknown>();
const persistentScope = g.__aimform_persistent_scope__;

export function runInRequestScope<T>(fn: () => T): T {
  return requestScope.run(new Map(), fn);
}

export function getScoped<T>(key: string, create: () => T): T {
  const scope = requestScope.getStore() ?? persistentScope;
  if (scope.has(key)) return scope.get(key) as T;
  const value = create();
  scope.set(key, value);
  return value;
}

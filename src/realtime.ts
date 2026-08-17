export type RealtimeMutationOperation = "created" | "updated" | "deleted";

export interface StateRealtimeMutation {
  id?: string;
  version?: number;
  model?: string;
  table?: string;
  operation?: RealtimeMutationOperation;
  recordId?: string;
  changedFields?: string[];
  tenantId?: string;
  actorId?: string;
  commitId?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StateRealtimeEvent {
  type: string;
  sequence?: number;
  event?: StateRealtimeMutation | Record<string, unknown>;
  resource?: string;
  resources?: string[];
  entityType?: string;
  payload?: unknown;
}

/** Raw event shape emitted by a realtime provider adapter. */
export interface RealtimeTransportEvent {
  type: string;
  [key: string]: unknown;
}

export interface RealtimeTransportSubscriptionRequest {
  streamUrl: string;
  replayUrl?: string;
  token: string;
  after?: number;
  /** Optional provider protocol handshake, recalculated after reconnect. */
  openMessage?: unknown | ((after: number) => unknown);
}

export interface RealtimeTransportSubscription {
  close: () => void;
}

/** Provider-neutral client transport. WebSockets, SSE, polling, and vendor SDKs can implement it. */
export interface RealtimeTransportAdapter {
  readonly provider: string;
  subscribe: (
    request: RealtimeTransportSubscriptionRequest,
    onEvent: (event: RealtimeTransportEvent) => void,
  ) => RealtimeTransportSubscription;
}

export interface RealtimeStream {
  id: string;
  request: RealtimeTransportSubscriptionRequest;
  mapEvent?: (event: RealtimeTransportEvent) => StateRealtimeEvent | readonly StateRealtimeEvent[] | undefined;
}

export interface RealtimeManager {
  start: (streams: readonly RealtimeStream[]) => void;
  stop: () => void;
  subscribe: (listener: (event: StateRealtimeEvent) => void) => () => void;
  getActiveStreamCount: () => number;
}

export interface RealtimeQuery {
  /** Stable key for one store/action/argument tuple. */
  key: string;
  actionName: string;
  args: readonly unknown[];
  resources?: readonly string[];
  refresh: () => Promise<unknown> | unknown;
}

export interface RealtimeQueryRegistration {
  updateResources: (resources: Iterable<string>) => void;
  dispose: () => void;
}

export interface RealtimeCoordinatorOptions {
  /** Coalesces bursts such as a streamed write or a multi-row commit. */
  debounceMs?: number;
  /** Maximum number of event identities retained for duplicate suppression. */
  maxSeenEvents?: number;
}

export interface RealtimeCoordinator {
  registerQuery: (query: RealtimeQuery) => RealtimeQueryRegistration;
  ingest: (event: StateRealtimeEvent) => void;
  subscribe: (listener: (event: StateRealtimeEvent) => void) => () => void;
  clear: () => void;
  getQueryCount: () => number;
}

/**
 * Owns provider subscriptions for an application lifetime and routes their
 * normalized events into the state coordinator. It deliberately contains no
 * browser, WebSocket, React, or Cloudflare code.
 */
export function createRealtimeManager(
  adapter: RealtimeTransportAdapter,
  coordinator: RealtimeCoordinator = getRealtimeCoordinator(),
): RealtimeManager {
  const listeners = new Set<(event: StateRealtimeEvent) => void>();
  let subscriptions = new Map<string, RealtimeTransportSubscription>();

  const emit = (event: StateRealtimeEvent): void => {
    coordinator.ingest(event);
    for (const listener of listeners) listener(event);
  };

  const stop = (): void => {
    for (const subscription of subscriptions.values()) subscription.close();
    subscriptions = new Map();
  };

  const start = (streams: readonly RealtimeStream[]): void => {
    stop();
    for (const stream of streams) {
      const subscription = adapter.subscribe(stream.request, (rawEvent) => {
        const mapped = stream.mapEvent ? stream.mapEvent(rawEvent) : (rawEvent as StateRealtimeEvent);
        if (!mapped) return;
        for (const event of Array.isArray(mapped) ? mapped : [mapped]) emit(event);
      });
      subscriptions.set(stream.id, subscription);
    }
  };

  return {
    start,
    stop,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getActiveStreamCount: () => subscriptions.size,
  };
}

const QUERY_PREFIXES = /^(fetch|load|list|get|resolve|search|refresh|hydrate|subscribe)/i;
const RESOURCE_SUFFIXES = /^(data|result|results|detail|details)$/i;
const DEFAULT_DEBOUNCE_MS = 30;
const DEFAULT_MAX_SEEN_EVENTS = 2_000;
let nextAnonymousStoreId = 1;

function normalizeResource(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase()
    .replace(/_+$/, "");
}

function resourceVariants(value: string): Set<string> {
  const normalized = normalizeResource(value);
  if (!normalized) return new Set();
  const variants = new Set([normalized]);
  const compact = normalized.replaceAll("_", "");
  variants.add(compact);
  if (normalized.endsWith("ies")) variants.add(`${normalized.slice(0, -3)}y`);
  if (normalized.endsWith("s") && !normalized.endsWith("ss")) variants.add(normalized.slice(0, -1));
  else variants.add(`${normalized}s`);

  // Common API naming differences are intentionally kept small and explicit.
  const aliases: Record<string, string[]> = {
    orgs: ["organizations"],
    organization: ["organizations"],
    conversations: ["conversation"],
    conversation_messages: ["messages", "message"],
    functions: ["function"],
    workflows: ["workflow"],
    invocations: ["invocation"],
    triggers: ["trigger"],
    endpoints: ["endpoint"],
    members: ["org_members"],
    collections: ["entity_type_configs", "entitytypeconfigs"],
    page_entity: ["entities", "entity"],
    current_function: ["functions", "function", "entities", "entity"],
    current_workflow: ["workflows", "workflow", "entities", "entity"],
    current_view: ["views", "view"],
    invocation_logs: ["invocations", "invocation"],
    entity_results: ["entities", "entity"],
    member_results: ["members", "org_members"],
    my_providers: ["providers", "app_providers"],
    app_usage: ["usage_events", "usage"],
  };
  for (const alias of aliases[normalized] ?? []) variants.add(normalizeResource(alias));
  return variants;
}

export function inferResourcesForAction(actionName: string): Set<string> {
  const withoutPrefix = actionName.replace(QUERY_PREFIXES, "");
  if (!withoutPrefix || withoutPrefix.toLowerCase() === actionName.toLowerCase()) return new Set();
  const normalized = normalizeResource(withoutPrefix);
  if (!normalized || RESOURCE_SUFFIXES.test(normalized)) return new Set();
  return new Set([normalized]);
}

export function isRealtimeQueryAction(actionName: string): boolean {
  return QUERY_PREFIXES.test(actionName);
}

function stableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") return typeof value;
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableValue(record[key], seen);
      return result;
    }, {});
}

export function serializeRealtimeQueryArgs(args: readonly unknown[]): string {
  try {
    return JSON.stringify(stableValue(args, new WeakSet())) ?? "[]";
  } catch {
    return args.map((arg) => String(arg)).join("|");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function eventResources(event: StateRealtimeEvent): Set<string> {
  const resources = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const variant of resourceVariants(value)) resources.add(variant);
  };

  add(event.resource);
  for (const resource of event.resources ?? []) add(resource);
  add(event.entityType);

  const mutation = asRecord(event.event);
  add(mutation?.model);
  add(mutation?.table);
  add(mutation?.resource);
  for (const resource of (mutation?.resources as unknown[]) ?? []) add(resource);
  const metadata = asRecord(mutation?.metadata);
  add(metadata?.resource);
  add(metadata?.entityType);
  for (const resource of (metadata?.resources as unknown[]) ?? []) add(resource);

  // A domain event such as `conversation_updated` still needs to invalidate a
  // query even when the producer does not send a separate resource field.
  if (event.type !== "mutation") add(event.type.replace(/^(changed|domain)[_:.-]?/i, ""));
  return resources;
}

function eventIdentity(event: StateRealtimeEvent): string | undefined {
  if (typeof event.sequence === "number" && Number.isFinite(event.sequence)) return `sequence:${event.sequence}`;
  const mutation = asRecord(event.event);
  if (typeof mutation?.id === "string") return `id:${mutation.id}`;
  return undefined;
}

function queryMatches(query: RealtimeQuery & { _resources: Set<string> }, event: StateRealtimeEvent): boolean {
  const incoming = eventResources(event);
  if (incoming.size === 0) return false;
  for (const resource of query._resources) {
    if (incoming.has(resource)) return true;
  }
  return false;
}

/**
 * Framework-neutral realtime invalidation coordinator. It knows nothing about
 * WebSockets, HTTP, React, Zustand, or a particular backend. A transport
 * adapter only needs to call `ingest`; stores register their last successful
 * query invocation through `createStore`.
 */
export function createRealtimeCoordinator(options: RealtimeCoordinatorOptions = {}): RealtimeCoordinator {
  const debounceMs = Math.max(options.debounceMs ?? DEFAULT_DEBOUNCE_MS, 0);
  const maxSeenEvents = Math.max(options.maxSeenEvents ?? DEFAULT_MAX_SEEN_EVENTS, 100);
  const queries = new Map<
    string,
    RealtimeQuery & {
      _resources: Set<string>;
      timer?: ReturnType<typeof setTimeout>;
      refreshing?: boolean;
      dirty?: boolean;
    }
  >();
  const listeners = new Set<(event: StateRealtimeEvent) => void>();
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  const remember = (identity: string) => {
    if (seen.has(identity)) return false;
    seen.add(identity);
    seenOrder.push(identity);
    while (seenOrder.length > maxSeenEvents) {
      const oldest = seenOrder.shift();
      if (oldest) seen.delete(oldest);
    }
    return true;
  };

  const registerQuery = (query: RealtimeQuery): RealtimeQueryRegistration => {
    const inferred = inferResourcesForAction(query.actionName);
    for (const resource of query.resources ?? []) inferred.add(normalizeResource(resource));
    const existing = queries.get(query.key);
    if (existing) {
      existing.actionName = query.actionName;
      existing.args = query.args;
      existing.refresh = query.refresh;
      for (const resource of inferred) existing._resources.add(resource);
      return {
        updateResources: (resources) => {
          for (const resource of resources) existing._resources.add(normalizeResource(resource));
        },
        dispose: () => {
          if (queries.get(query.key) === existing) queries.delete(query.key);
        },
      };
    }

    const entry = { ...query, _resources: inferred };
    queries.set(query.key, entry);
    return {
      updateResources: (resources) => {
        for (const resource of resources) entry._resources.add(normalizeResource(resource));
      },
      dispose: () => {
        if (queries.get(query.key) === entry) queries.delete(query.key);
      },
    };
  };

  const scheduleRefresh = (
    query: RealtimeQuery & {
      _resources: Set<string>;
      timer?: ReturnType<typeof setTimeout>;
      refreshing?: boolean;
      dirty?: boolean;
    },
  ) => {
    if (query.timer || query.refreshing) return;
    query.timer = setTimeout(() => {
      query.timer = undefined;
      query.refreshing = true;
      Promise.resolve(query.refresh())
        .catch(() => {
          // The next event or the next foreground fetch can retry. Realtime
          // delivery must never create an unhandled rejection in the app.
        })
        .finally(() => {
          query.refreshing = false;
          if (query.dirty) {
            query.dirty = false;
            scheduleRefresh(query);
          }
        });
    }, debounceMs);
  };

  const ingest = (event: StateRealtimeEvent) => {
    const identity = eventIdentity(event);
    if (identity && !remember(identity)) return;
    for (const listener of listeners) listener(event);

    for (const query of queries.values()) {
      if (!queryMatches(query, event)) continue;
      if (query.refreshing) {
        query.dirty = true;
        continue;
      }
      scheduleRefresh(query);
    }
  };

  return {
    registerQuery,
    ingest,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear: () => {
      for (const query of queries.values()) {
        if (query.timer) clearTimeout(query.timer);
        query.dirty = false;
      }
      queries.clear();
      seen.clear();
      seenOrder.length = 0;
    },
    getQueryCount: () => queries.size,
  };
}

let browserCoordinator: RealtimeCoordinator | undefined;

/** Returns the browser-local coordinator. Server runtimes get a fresh inert coordinator. */
export function getRealtimeCoordinator(): RealtimeCoordinator {
  if (typeof window === "undefined") return createRealtimeCoordinator();
  browserCoordinator ??= createRealtimeCoordinator();
  return browserCoordinator;
}

export function ingestRealtimeEvent(event: StateRealtimeEvent): void {
  getRealtimeCoordinator().ingest(event);
}

export interface StoreActionRuntime {
  actionName: string;
  trackResource: (resource: string) => void;
}

export const STORE_ACTION_RUNTIME = Symbol.for("@aimform/state/action-runtime");

export function createAnonymousStoreName(): string {
  return `anonymous:${nextAnonymousStoreId++}`;
}

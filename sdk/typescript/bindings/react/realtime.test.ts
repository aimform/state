import { describe, expect, it, vi } from "vitest";
import { createStore } from "./createStore";
import { withLoading } from "../../core/store";
import { createRealtimeCoordinator, createRealtimeManager, ingestRealtimeEvent, type StateRealtimeEvent } from "../../core/realtime";

function waitForTimers(delay = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

describe("realtime coordinator", () => {
  it("routes provider events through one manager and closes subscriptions together", async () => {
    const refresh = vi.fn();
    const received: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
    const closed: string[] = [];
    const coordinator = createRealtimeCoordinator({ debounceMs: 0 });
    coordinator.registerQuery({
      key: "conversations:org-1",
      actionName: "fetchConversations",
      args: ["org-1", "profile-1"],
      refresh,
    });
    const manager = createRealtimeManager(
      {
        provider: "test",
        subscribe: ({ streamUrl }, onEvent) => {
          received.push(onEvent);
          return { close: () => closed.push(streamUrl) };
        },
      },
      coordinator,
    );

    manager.start([{ id: "org", request: { streamUrl: "wss://example.test/org", token: "token" } }]);
    received[0]({
      type: "mutation",
      sequence: 99,
      event: { id: "mutation-99", model: "conversations", operation: "created" },
    });
    await waitForTimers();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(manager.getActiveStreamCount()).toBe(1);
    manager.stop();
    expect(closed).toEqual(["wss://example.test/org"]);
    expect(manager.getActiveStreamCount()).toBe(0);
  });

  it("refreshes matching fetched resources and coalesces duplicate delivery", async () => {
    const refresh = vi.fn();
    const coordinator = createRealtimeCoordinator({ debounceMs: 0 });
    coordinator.registerQuery({
      key: "conversations:org-1",
      actionName: "fetchConversations",
      args: ["org-1", "profile-1"],
      refresh,
    });

    const event = {
      type: "mutation",
      sequence: 12,
      event: {
        id: "mutation-12",
        model: "conversations",
        table: "conversations",
        operation: "created" as const,
        tenantId: "org-1",
      },
    };
    coordinator.ingest(event);
    coordinator.ingest(event);
    await waitForTimers();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uses safe entity collection hints for shared entity tables", async () => {
    const refresh = vi.fn();
    const coordinator = createRealtimeCoordinator({ debounceMs: 0 });
    coordinator.registerQuery({
      key: "functions:org-1",
      actionName: "fetchFunctions",
      args: ["org-1"],
      refresh,
    });

    coordinator.ingest({
      type: "mutation",
      sequence: 13,
      event: {
        id: "mutation-13",
        model: "entities",
        table: "entities",
        operation: "updated",
        metadata: { entityType: "function", resources: ["entities", "function"] },
      },
    });
    await waitForTimers();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("supports domain events without coupling the state package to a transport", async () => {
    const refresh = vi.fn();
    const coordinator = createRealtimeCoordinator({ debounceMs: 0 });
    coordinator.registerQuery({
      key: "conversations:org-1",
      actionName: "fetchConversations",
      args: ["org-1", "profile-1"],
      refresh,
    });

    coordinator.ingest({
      type: "domain",
      resource: "conversations",
      event: { id: "conversation-updated-1", operation: "updated" },
    });
    await waitForTimers();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("automatically registers and refreshes a createStore query from setKey", async () => {
    vi.stubGlobal("window", {});
    const fetchItems = vi.fn(async () => [{ id: "item-1" }]);
    const store = createStore({ items: [] as Array<{ id: string }> }, () => ({
      fetchItems: withLoading("fetchItems", async ({ setKey }) => {
        setKey("items", await fetchItems());
      }),
    }));

    await store.getState().fetchItems();
    expect(fetchItems).toHaveBeenCalledTimes(1);

    ingestRealtimeEvent({
      type: "mutation",
      sequence: 14,
      event: { id: "mutation-14", model: "items", operation: "updated" },
    });
    await waitForTimers(50);

    expect(fetchItems).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("delivers initial replay events without invalidating already hydrated queries", async () => {
    const refresh = vi.fn();
    const received: StateRealtimeEvent[] = [];
    const coordinator = createRealtimeCoordinator({ debounceMs: 0 });
    coordinator.registerQuery({
      key: "spaces:org-1",
      actionName: "fetchSpaces",
      args: ["org-1"],
      refresh,
    });
    const manager = createRealtimeManager(
      {
        provider: "test",
        subscribe: (_request, onEvent) => {
          onEvent({
            type: "mutation",
            isReplay: true,
            sequence: 1,
            event: { model: "spaces", operation: "updated" },
          });
          return { close: () => {} };
        },
      },
      coordinator,
    );
    manager.subscribe((event) => received.push(event));
    manager.start([{ id: "org", request: { streamUrl: "wss://example.test/org", token: "token" } }]);
    await waitForTimers(50);

    expect(received).toHaveLength(1);
    expect(received[0]?.isReplay).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    manager.stop();
  });

  it("buffers ordinary events while idle but keeps notification listeners live", async () => {
    const refresh = vi.fn();
    const ordinary: StateRealtimeEvent[] = [];
    const notifications: StateRealtimeEvent[] = [];
    const received: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
    const coordinator = createRealtimeCoordinator({ debounceMs: 0 });
    coordinator.registerQuery({
      key: "spaces:org-1",
      actionName: "fetchSpaces",
      args: ["org-1"],
      refresh,
    });
    const manager = createRealtimeManager(
      {
        provider: "test",
        subscribe: (_request, onEvent) => {
          received.push(onEvent);
          return { close: () => {} };
        },
      },
      coordinator,
    );
    manager.subscribe((event) => ordinary.push(event));
    manager.subscribe((event) => notifications.push(event), { deliverWhileIdle: true });
    manager.start([{ id: "org", request: { streamUrl: "wss://example.test/org", token: "token" } }]);
    manager.setActivityState("idle");
    received[0]({ type: "mutation", sequence: 20, event: { model: "spaces", operation: "updated" } });

    expect(manager.getActivityState()).toBe("idle");
    expect(manager.getQueuedEventCount()).toBe(1);
    expect(ordinary).toHaveLength(0);
    expect(notifications).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();

    manager.setActivityState("active");
    await waitForTimers();

    expect(manager.getQueuedEventCount()).toBe(0);
    expect(ordinary).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    manager.stop();
  });
});

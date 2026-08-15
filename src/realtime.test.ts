import { describe, expect, it, vi } from "vitest";
import { createStore, withLoading } from "./createStore";
import { createRealtimeCoordinator, createRealtimeManager, ingestRealtimeEvent } from "./realtime";

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
});

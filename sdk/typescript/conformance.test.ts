import { describe, expect, it } from "vitest";
import fixture from "../../conformance/core.json";
import { serializeRealtimeQueryArgs } from "./core/realtime";
import { createServerStore, withLoading } from "./core/store";

describe("State conformance", () => {
  it("keeps the vanilla store contract portable and loading state ordered", async () => {
    const store = createServerStore({ items: fixture.inputItems }, () => ({
      fetchItems: withLoading("fetchItems", async ({ setKey }) => {
        setKey("items", fixture.outputItems);
      }),
    }));

    expect(store.getState().loading.fetchItems).toBeUndefined();
    await store.getState().fetchItems();
    expect(store.getState().items).toEqual(fixture.outputItems);
    expect(store.getState().loading.fetchItems).toBe(false);
    expect(store.getState().errors.fetchItems).toBeNull();
  });

  it("records provider failures and serializes query arguments deterministically", async () => {
    const store = createServerStore({ items: fixture.inputItems }, () => ({
      fetchItems: withLoading("fetchItems", async () => {
        throw new Error(fixture.failureMessage);
      }),
    }));

    await store.getState().fetchItems();
    expect(store.getState().loading.fetchItems).toBe(false);
    expect(store.getState().errors.fetchItems).toBe(fixture.failureMessage);
    expect(serializeRealtimeQueryArgs(fixture.queryArgs)).toBe(fixture.expectedSerializedQueryArgs);
  });
});

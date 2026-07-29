import { produce } from "immer";

type ZustandSet = (partial: Record<string, unknown> | ((state: Record<string, unknown>) => Partial<Record<string, unknown>>)) => void;
type ZustandGet = () => Record<string, unknown>;

export async function withLoading<T extends unknown[]>(
  key: string,
  fn: (
    set: ZustandSet,
    get: ZustandGet,
    setKey: (path: string | string[], value: unknown) => void,
    setError: (msg: string | null) => void,
    ...args: T
  ) => Promise<void>,
  set: ZustandSet,
  get: ZustandGet,
  ...args: T
) {
  set((state: Record<string, unknown>) => ({
    loading: { ...(state.loading as Record<string, boolean>), [key]: true },
    errors: { ...(state.errors as Record<string, string | null>), [key]: null },
  }));

  const setError = (msg: string | null) => {
    set((state: Record<string, unknown>) => ({
      errors: { ...(state.errors as Record<string, string | null>), [key]: msg },
    }));
  };

  const setKey = (path: string | string[], value: unknown) => {
    set(
      produce((draft: Record<string, unknown>) => {
        const keys = Array.isArray(path) ? path : path.split(".");
        let obj: Record<string, unknown> = draft;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!obj[keys[i]]) obj[keys[i]] = {};
          obj = obj[keys[i]] as Record<string, unknown>;
        }
        obj[keys[keys.length - 1]] = value;
      }) as unknown as Record<string, unknown>
    );
  };

  try {
    await fn(set, get, setKey, setError, ...args);
    set((state: Record<string, unknown>) => ({
      errors: { ...(state.errors as Record<string, string | null>), [key]: null },
    }));
  } catch (error: unknown) {
    const err = error as Error;
    setError(err?.message || String(error));
  } finally {
    set((state: Record<string, unknown>) => ({
      loading: { ...(state.loading as Record<string, boolean>), [key]: false },
    }));
  }
}

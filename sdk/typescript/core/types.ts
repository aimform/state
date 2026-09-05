export interface AsyncState {
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
}

export interface StoreHook<T> {
  data: T;
  isLoading: boolean;
  error: string | null;
  run: (...args: unknown[]) => Promise<void>;
}

/** Lifecycle boundary for a platform HTTP transport implementation. */
export interface PlatformHttpHost {
  close(): Promise<void>;
  start(): Promise<void>;
}

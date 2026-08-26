interface TraceForgeDesktopBridge {
  platform: string;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  onUpdateState(listener: (state: { status?: string; version?: string; percent?: number; message?: string }) => void): () => void;
}

interface Window { traceforgeDesktop?: TraceForgeDesktopBridge }

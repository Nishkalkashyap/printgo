export type TunnelConfig =
  | { mode: 'quick' }
  | { mode: 'named'; hostname: string; tunnelId: string; credentialsFile: string }
  | { mode: 'token'; hostname: string; tokenFile: string };

export interface CloudflaredOptions {
  stateDir?: string;
  cloudflaredPath?: string;
  /** Explicitly approve downloading a verified official release; false disables downloads. */
  downloadCloudflared?: boolean;
  /** Called only when no usable binary is found and downloadCloudflared is unset. */
  confirmCloudflaredDownload?: () => Promise<boolean>;
}

export interface StartOptions extends CloudflaredOptions {
  /** Defaults to a random account-free Quick Tunnel. */
  tunnel?: TunnelConfig;
  /** 0 chooses an available loopback port. */
  port?: number;
  startupTimeoutMs?: number;
  /** Windows PDF printing requires a current SumatraPDF executable. */
  sumatraPdfPath?: string;
  /** Markdown/HTML rendering can use an explicit Chromium/Chrome executable. */
  browserExecutablePath?: string;
}

export interface StartResult {
  status: 'started' | 'already_running';
  message: string;
  password: string;
  mcpConnectionURL: string;
  authHeader: 'Authorization';
  pid: number;
  tunnelMode: TunnelConfig['mode'];
}

export interface DaemonStatus {
  status: 'running' | 'starting' | 'stopped' | 'unreachable';
  pid?: number;
  mcpConnectionURL?: string;
  tunnelMode?: TunnelConfig['mode'];
  startedAt?: string;
  localURL?: string;
}

export interface NamedTunnelOptions extends CloudflaredOptions {
  hostname: string;
  tunnelName?: string;
  /** Login may launch a browser. Enabled by the CLI's custom-domain flow. */
  login?: boolean;
}

export interface RuntimeConfig {
  stateDir: string;
  tunnel: TunnelConfig;
  port: number;
  cloudflaredPath: string;
  startupTimeoutMs: number;
  sumatraPdfPath?: string;
  browserExecutablePath?: string;
  password: string;
  adminToken: string;
  instanceId: string;
}

export interface RuntimeState {
  instanceId: string;
  pid: number;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  localURL: string;
  password: string;
  adminToken: string;
  tunnelMode: TunnelConfig['mode'];
  startedAt: string;
  mcpConnectionURL?: string;
  error?: string;
}

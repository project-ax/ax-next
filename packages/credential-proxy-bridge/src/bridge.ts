export interface WebProxyBridge {
  port: number;
  stop(): void;
}

export async function startWebProxyBridge(_unixSocketPath: string): Promise<WebProxyBridge> {
  throw new Error('not implemented');
}

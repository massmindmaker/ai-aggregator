import { registerEgressExecutor } from '@aiag/shared/server';
import { fetchViaProxy } from './proxy/index';

/** Register the gateway's transport for already-vetted proxied destinations. */
export function registerGatewayEgressExecutor(): void {
  registerEgressExecutor((url, init, proxyUrl, connectAddr, maxBufferedResponseBytes) =>
    fetchViaProxy(url, init, proxyUrl, { connectAddr, maxBufferedResponseBytes }),
  );
}

type FetchRpc = typeof fetch;

/** Read-only connection checks. Never includes wallet keys, invoices or auth headers. */
export async function checkEvmRpc(endpoint: string, request: FetchRpc = fetch) {
  const startedAt = new Date().toISOString();
  const checks = [];
  for (const params of [null, []]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await request(endpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params, id: 1 }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { payload = null; }
      const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
      const result = typeof object?.result === 'string' && /^0x[0-9a-f]+$/i.test(object.result) ? object.result : null;
      const rpcError = object?.error && typeof object.error === 'object'
        ? object.error as Record<string, unknown> : null;
      checks.push({
        params: params === null ? 'null (native RGB-lib request)' : '[]',
        status: response.status,
        contentType: response.headers.get('content-type'),
        responseFormat: object ? 'JSON object' : /^\s*</.test(text) ? 'HTML/XML' : text.length ? 'Non-JSON' : 'Empty body',
        chainId: result,
        expectedChain: result?.toLowerCase() === '0xa4b1',
        rpcErrorCode: typeof rpcError?.code === 'number' ? rpcError.code : null,
      });
    } catch (error) {
      checks.push({ params: params === null ? 'null (native RGB-lib request)' : '[]',
        transportError: error instanceof Error ? error.name : 'Request failed' });
    } finally { clearTimeout(timer); }
  }
  return { format: 'utexo-rpc-connection', version: 1, startedAt, endpoint, checks };
}

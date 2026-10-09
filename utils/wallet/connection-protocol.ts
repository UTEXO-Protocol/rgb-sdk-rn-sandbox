/** Pure helpers shared by the scanner and session dispatcher. */
export function parseWalletConnectUri(input: string): string {
  let uri = input.trim();
  if (!uri.startsWith('wc:')) {
    try {
      const link = new URL(uri);
      if (link.protocol !== 'myapp:' || link.hostname !== 'wallet')
        throw new Error('Invalid wallet link');
      uri = link.searchParams.get('uri') ?? '';
    } catch {
      uri = '';
    }
  }
  if (uri.length > 16_384 || !/^wc:[a-fA-F0-9]{64}@2\?/.test(uri)) {
    throw new Error(
      'Paste a WalletConnect connection URI (wc:…), not an RGB or Lightning invoice.',
    );
  }
  const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
  if (
    params.getAll('symKey').length !== 1 ||
    params.getAll('relay-protocol').length !== 1 ||
    params.getAll('expiryTimestamp').length > 1 ||
    !/^[a-fA-F0-9]{64}$/.test(params.get('symKey') ?? '') ||
    params.get('relay-protocol') !== 'irn'
  ) {
    throw new Error('Invalid WalletConnect pairing parameters.');
  }
  const expiry = params.get('expiryTimestamp');
  if (
    expiry &&
    (!/^\d+$/.test(expiry) ||
      !Number.isSafeInteger(Number(expiry)) ||
      Number(expiry) <= Date.now() / 1000)
  ) {
    throw new Error('This QR has expired. Create a new connection in Mint UI.');
  }
  return uri;
}

export function sessionOrigin(url: string): string {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('Invalid website URL');
  return parsed.origin;
}

type Session = {
  sessionProperties?: Record<string, string>;
  expiry: number;
  namespaces: Record<string, { accounts: string[]; methods: string[] }>;
};
export function isRgbSession(
  session: Session,
  account: string,
  methods: readonly string[],
): boolean {
  const chain = account.split(':').slice(0, 2).join(':');
  const namespace = session.namespaces.rgb ?? session.namespaces[chain];
  return (
    !!account &&
    session.sessionProperties?.webrgb === 'webrgb:1' &&
    session.expiry > Date.now() / 1000 &&
    !!namespace?.accounts.includes(account) &&
    namespace.methods.every((method) => methods.includes(method))
  );
}

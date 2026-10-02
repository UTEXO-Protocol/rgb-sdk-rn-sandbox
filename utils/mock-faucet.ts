const URL = process.env.EXPO_PUBLIC_DEMO_MOCK_FAUCET_URL?.trim().replace(/\/$/, '') || '';

export function mockFaucetEnabled(network: string) {
  return network === 'regtest' && !!URL;
}

export async function mockFaucetRequest(
  path: '/fund' | '/mine',
  body: Record<string, unknown>
) {
  if (!URL) throw new Error('Configure EXPO_PUBLIC_DEMO_MOCK_FAUCET_URL');
  const config = await fetch(`${URL}/config`).then((response) => response.json());
  if (config.mock !== true || config.network !== 'regtest')
    throw new Error('Expected the regtest mock faucet');
  const response = await fetch(`${URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mock-Faucet': 'regtest' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Mock faucet request failed');
  return result;
}

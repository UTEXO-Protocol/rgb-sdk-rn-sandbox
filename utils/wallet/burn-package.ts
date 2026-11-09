import { base64 } from '@scure/base';
import { burnDestinationHash, type BurnDestination } from '@utexo/rgb-sdk-rn/webrgb';
export function createBurnPackage(data: string, destination: BurnDestination): string {
  const limit = 10 * 1024 * 1024;
  if (!data || data.length > 4 * Math.ceil(limit / 3)) throw new Error('Invalid burn proof size.');
  const bytes = base64.decode(data);
  const header = [0x52, 0x47, 0x42, 0, 0x54, 0x46, 0x52];
  if (bytes.length <= header.length || bytes.length > limit || base64.encode(bytes) !== data ||
      !header.every((byte, index) => bytes[index] === byte)) throw new Error('Invalid RGB transfer proof for burn export.');
  burnDestinationHash(destination);
  return JSON.stringify({ format: 'utexo-burn', version: 1,
    consignment: { encoding: 'base64', byteLength: bytes.length, data }, burnDestination: destination });
}

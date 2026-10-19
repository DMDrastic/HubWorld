import { decodeAccountID, parseNFTokenID } from 'xrpl'

/**
 * A structurally valid NFTokenID for `issuer` and `taxon`.
 *
 * Layout: flags (2 bytes) · transfer fee (2) · issuer AccountID (20) ·
 * scrambled taxon (4) · serial (4). The taxon is scrambled with the serial so
 * that sequential mints do not cluster, which is why it cannot simply be written
 * in. Round-trips through xrpl.js's own parser, so a wrong layout fails loudly
 * here rather than quietly passing a guard that reads the same bytes.
 */
export function makeNftId(issuer: string, taxon: number, serial = 1): string {
  const scramble = (384160001n * BigInt(serial) + 2459n) & 0xffffffffn
  const scrambled = (BigInt(taxon) ^ scramble) & 0xffffffffn
  const hex = (n: bigint, bytes: number) => n.toString(16).padStart(bytes * 2, '0')
  const id = (
    hex(0x0018n, 2) + // transferable | mutable
    hex(0x1388n, 2) + // 5% transfer fee
    Buffer.from(decodeAccountID(issuer)).toString('hex') +
    hex(scrambled, 4) +
    hex(BigInt(serial), 4)
  ).toUpperCase()

  const parsed = parseNFTokenID(id)
  if (parsed.Issuer !== issuer || parsed.Taxon !== taxon) {
    throw new Error('makeNftId produced an id that does not round-trip')
  }
  return id
}

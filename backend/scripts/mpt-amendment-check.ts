/**
 * SPIKE (follow-up): is the `temDISABLED` on OfferCreate-with-MPT an amendment
 * that has not activated yet, or is MPT DEX trading simply not implemented?
 *
 * It matters because the two have opposite consequences. Amendment-gated means
 * "wait, then reconsider" — MPT-backed tickets could get a secondary market and
 * the whole thousands-scale conclusion changes. Not implemented means the MPT
 * tier is primary-sale-and-door only for the foreseeable future.
 *
 * `temDISABLED` is rippled's code for "this transaction needs functionality that
 * is currently switched off", which is the wording used for amendment gating —
 * so the hypothesis is worth testing rather than assuming either way.
 *
 * Checks BOTH testnet and mainnet, because the amendment sets differ and the
 * earlier spike only ever saw testnet.
 *
 * Read-only. No wallets, no funding, no credentials. Run:
 *   npx tsx scripts/mpt-amendment-check.ts
 */
import { Client } from 'xrpl'

/** The well-known ledger index of the Amendments singleton object. */
const AMENDMENTS_INDEX = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4'

const NETWORKS = [
  ['testnet', 'wss://s.altnet.rippletest.net:51233'],
  // Devnet activates amendments ahead of testnet, so it is where a
  // not-yet-live feature can actually be exercised rather than only read about.
  ['devnet', 'wss://s.devnet.rippletest.net:51233'],
  ['mainnet', 'wss://xrplcluster.com'],
] as const

async function inspect(label: string, url: string) {
  const client = new Client(url)
  await client.connect()
  console.log(`\n${'='.repeat(70)}\n${label}  (${url})\n${'='.repeat(70)}`)

  const info = await client.request({ command: 'server_info' })
  console.log(`  rippled build: ${info.result.info.build_version}`)

  // `feature` is normally admin-only. If the server answers, it gives NAMES,
  // which is the decisive evidence — an amendment that exists but is not
  // enabled proves gating rather than absence.
  let named = false
  try {
    const feat = (await client.request({ command: 'feature' } as never)) as {
      result: { features?: Record<string, { name?: string; enabled?: boolean; supported?: boolean }> }
    }
    const features = feat.result.features
    if (features) {
      named = true
      // Case-sensitive 'MPT': /MPT/i also matches "fixE-mpt-yDID", which is
      // unrelated and makes the list look longer than it is.
      const mpt = Object.entries(features).filter(([, v]) => (v.name ?? '').includes('MPT'))
      console.log(`\n  MPT amendments known to this server (${mpt.length}):`)
      for (const [id, v] of mpt) {
        console.log(
          `    ${(v.name ?? id).padEnd(28)} enabled=${String(v.enabled).padEnd(5)} supported=${v.supported}`,
        )
      }
      if (mpt.length === 0) console.log('    (none)')

      // CROSS-CHECK, and it matters: `feature`'s `enabled` field reported
      // Escrow, MultiSign and PayChan as false, which cannot be true — they are
      // foundational and long activated. So the field is not a reliable answer
      // to "is this live on this network". The Amendments ledger object is: it
      // is the actual on-ledger set of activated amendment IDs.
      const entry = (await client.request({
        command: 'ledger_entry',
        index: AMENDMENTS_INDEX,
        ledger_index: 'validated',
      } as never)) as { result: { node?: { Amendments?: string[] } } }
      const active = new Set(entry.result.node?.Amendments ?? [])
      console.log(`\n  on-ledger activated amendments: ${active.size}`)

      const truth = (id: string) => (active.has(id.toUpperCase()) ? 'ACTIVE' : 'not active')
      console.log('\n  sanity check against known-foundational amendments:')
      for (const probe of ['Escrow', 'MultiSign', 'PayChan', 'MPTokensV1']) {
        const hit = Object.entries(features).find(([, v]) => v.name === probe)
        console.log(
          `    ${probe.padEnd(14)} feature.enabled=${String(hit?.[1].enabled).padEnd(5)}  on-ledger=${hit ? truth(hit[0]) : '?'}`,
        )
      }

      // The decisive list, now using on-ledger truth rather than the `enabled`
      // field. If MPT DEX trading were merely gated, an amendment enabling it
      // must appear here under some name.
      const pending = Object.entries(features).filter(([id]) => !active.has(id.toUpperCase()))
      console.log(`\n  NOT on-ledger yet (${pending.length}) — the only real gating candidates:`)
      for (const [, v] of pending) console.log(`    ${v.name}`)
    }
  } catch (e) {
    console.log(`\n  'feature' command unavailable (${(e as Error).message.slice(0, 60)})`)
  }

  if (!named) {
    // Fall back to the on-ledger Amendments object. This gives enabled
    // amendment IDs only — no names — so it can confirm how many are active
    // but cannot by itself say whether an MPT-DEX amendment exists.
    const entry = (await client.request({
      command: 'ledger_entry',
      index: AMENDMENTS_INDEX,
      ledger_index: 'validated',
    } as never)) as { result: { node?: { Amendments?: string[] } } }
    const enabled = entry.result.node?.Amendments ?? []
    console.log(`  enabled amendments on-ledger: ${enabled.length} (IDs only, no names)`)
  }

  await client.disconnect()
}

async function main() {
  for (const [label, url] of NETWORKS) {
    try {
      await inspect(label, url)
    } catch (e) {
      console.log(`\n${label}: FAILED — ${(e as Error).message.slice(0, 100)}`)
    }
  }
  console.log(
    '\nReading: an amendment present but enabled=false means GATED (revisit later).\n' +
      'No such amendment at all means MPT DEX trading is NOT IMPLEMENTED, and the\n' +
      'MPT tier stays primary-sale-and-door only.',
  )
}

main().catch((e) => {
  console.error('CHECK FAILED:', e)
  process.exit(1)
})

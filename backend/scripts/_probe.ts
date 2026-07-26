import { Client, dropsToXrp } from 'xrpl'
const ADDR = 'r4wQCYU7VRdsTXB9GhQj5dMptmwAZDBjcf'
async function main() {
  const c = new Client('wss://s.altnet.rippletest.net:51233')
  await c.connect()
  for (let i = 1; i <= 20; i++) {
    try {
      const a = await c.request({ command: 'account_info', account: ADDR, ledger_index: 'validated' })
      const drops = a.result.account_data.Balance
      console.log(`funded after ${i} check(s): ${drops} drops = ${dropsToXrp(drops)} XRP`)
      const nfts = await c.request({ command: 'account_nfts', account: ADDR })
      console.log('NFTs currently held:', nfts.result.account_nfts.length)
      await c.disconnect()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  console.log('still unfunded after 20 checks')
  await c.disconnect()
}
main().catch((e) => { console.error('FAILED:', e?.message ?? e); process.exit(1) })

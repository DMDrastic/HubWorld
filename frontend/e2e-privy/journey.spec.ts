/**
 * The Privy journey, end to end, on the real test network: sign in with email, buy at the box office, give the ticket
 * to someone, and see them accept it. Run with `npm run e2e:privy` against the local stack (see the config).
 *
 * Everything a person does here is real: Privy's sign-in, the embedded wallet signing in the browser, the purchase and
 * the gift settling on the test network. The one stand-in is the gift's RECIPIENT (`local-stack.sh recipient`), because
 * Privy gives one test account per app and a gift needs two people. It accepts by signing a real transaction.
 *
 * It needs an event with tickets left: `scripts/local-stack.sh event` makes one (5 tickets; each run buys one).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { API } from '../playwright.privy.config'

const BACKEND = path.resolve(import.meta.dirname, '../../backend')
const HANDLE = 'e2e_privy'

/** Runs a local-stack command and returns its last line, which the recipient script prints as JSON. */
function stack(...args: string[]): Record<string, unknown> {
  const out = execFileSync('zsh', ['scripts/local-stack.sh', ...args], { cwd: BACKEND, encoding: 'utf8', env: process.env })
  const last = out.trim().split('\n').pop() ?? ''
  return JSON.parse(last) as Record<string, unknown>
}

async function approve(page: Page) {
  // Our own approval screen: it says what is being signed; Privy then signs in the browser.
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
}

test('email sign-in, box-office purchase, and a gift that the recipient accepts', async ({ page, request }) => {
  const email = process.env.PRIVY_TEST_EMAIL
  const otp = process.env.PRIVY_TEST_OTP
  test.skip(!email || !otp, 'PRIVY_TEST_EMAIL and PRIVY_TEST_OTP are not in ~/.hubworld-privy.env')

  // Preconditions, said plainly rather than discovered as a timeout halfway through.
  const health = await (await request.get(`${API}/health`)).json()
  expect(health.network, 'the local stack must be on the test network').toBe('testnet')
  const { events } = await (await request.get(`${API}/events`)).json()
  const event = (events as Array<{ title: string; ticketsForSale?: number; primaryPriceDrops?: string | null }>).find(
    (e) => (e.ticketsForSale ?? 0) > 0 && e.primaryPriceDrops,
  )
  expect(event, 'no event with tickets left: run `scripts/local-stack.sh event` in backend/').toBeTruthy()
  const recipient = stack('recipient', 'create') as { username: string }

  await test.step('sign in with the Privy test account', async () => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Continue with email' }).click()
    const emailField = page.locator('input[type="email"], #email-input').first()
    await emailField.fill(email!)
    await emailField.press('Enter')
    const firstCode = page.locator('input[autocomplete="one-time-code"], input[name^="code"]').first()
    await firstCode.click()
    await page.keyboard.type(otp!)
    // A first run claims a handle; later runs land signed in.
    const claim = page.getByLabel('choose a username')
    const signedIn = page.getByRole('link', { name: 'Tickets', exact: true })
    await expect(claim.or(signedIn).first()).toBeVisible({ timeout: 60_000 })
    if (await claim.isVisible()) {
      await claim.fill(HANDLE)
      await page.getByRole('button', { name: 'Claim', exact: true }).click()
    }
    await expect(signedIn).toBeVisible({ timeout: 60_000 })
  })

  await test.step('buy a ticket at the box office', async () => {
    await page.goto('/events')
    await page.getByRole('button', { name: new RegExp(`^Buy a ticket to ${event!.title}`) }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Buy a ticket/ }).click()
    // A new wallet needs test XRP first; the faucet button is on the page for that.
    const approveButton = dialog.getByRole('button', { name: 'Approve', exact: true })
    const faucet = dialog.getByRole('button', { name: 'Get test XRP' })
    await expect(approveButton.or(faucet).first()).toBeVisible({ timeout: 60_000 })
    if (await faucet.isVisible()) {
      await faucet.click()
      // "Try again" before the funding screen learned to wait (#145), "Continue" once it has (it then opens by itself).
      const retry = dialog.getByRole('button', { name: /^(Try again|Continue)$/ })
      await expect(retry).toBeVisible({ timeout: 90_000 })
      // "On its way" is not "arrived": wait until the ledger shows the money, or the retry finds 0 XRP and the screen
      // goes back to the faucet button (pressing that again would spend another of the day's three).
      await expect
        .poll(async () => (await (await page.request.get('/api/wallet/status')).json()).spendableDrops ?? null, {
          timeout: 90_000,
          intervals: [2_000],
          message: 'the test XRP never arrived in the wallet',
        })
        .not.toBeNull()
      await expect(retry).toBeEnabled({ timeout: 90_000 })
      await retry.click()
    }
    await approve(page)
    await expect(dialog.getByText('The ticket is yours.')).toBeVisible({ timeout: 3 * 60_000 })
    // Two controls are named "Close" (the button and the corner ✕); Escape closes the dialog without choosing.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  await test.step(`give it to @${recipient.username}`, async () => {
    await page.goto('/tickets')
    const which = page.getByLabel('Ticket', { exact: true }).or(page.locator('#gift-ticket'))
    const option = which.locator('option', { hasText: event!.title }).first()
    await which.selectOption({ value: (await option.getAttribute('value'))! })
    await page.getByLabel('recipient handle').fill(`@${recipient.username}`)
    await page.getByRole('button', { name: 'Gift', exact: true }).click()
    await approve(page)
    await expect(page.getByText(/Offer is live on-ledger/)).toBeVisible({ timeout: 2 * 60_000 })
  })

  await test.step('the recipient accepts it, signed for real on the test network', async () => {
    const accepted = stack('recipient', 'accept')
    expect(accepted.state).toBe('accepted')
    expect(accepted.hash).toMatch(/^[0-9A-F]{64}$/)
  })
})

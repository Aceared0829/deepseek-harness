// @vitest-environment jsdom
/** Subscription cards display reported allowances and retain usable readings during outages. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatGptAccountView, ChatGptSignInEvent, ChatGptSignInAnswer, RemoteStreamHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { ChatGptAccountCard } from '../src/client/ChatGptAccountCard.tsx'
import { en, zh, type AccountKey } from '../src/client/locales.ts'
import type { ChatGptAccountCardProps } from '../src/client/ChatGptAccountCard.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const view: ChatGptAccountView = {
  status: 'ready', email: 'user@example.test', plan: 'pro',
  quotas: [{ name: 'codex', primary: { usedPercent: 14, windowSeconds: 604800, resetsAt: null }, secondary: null }],
  credits: { unlimited: false, balance: '12.5' },
}
function translator(copy: typeof en | typeof zh): ChatGptAccountCardProps['t'] {
  return (key, values) => {
    let text: string = key in copy ? copy[key as AccountKey] : key
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

it.each(['ready', 'unavailable'] as const)('hides sign-in for a stored login with %s usage', async (status) => {
  const signIn = vi.fn<NonNullable<ChatGptAccountCardProps['signIn']>>()
  render(<ChatGptAccountCard read={async () => ({ ...view, status })} signIn={signIn} signOut={async () => {}} t={translator(en)} />)
  await screen.findByRole('button', { name: en.signOut })
  expect(screen.queryByRole('button', { name: en.chatGptSignIn })).toBeNull()
  expect(signIn).not.toHaveBeenCalled()
})

it.each([['en', en], ['zh', zh]] as const)('switches from sign-out to sign-in after removing the %s login', async (language, copy) => {
  let signedIn = true
  const read = async (): Promise<ChatGptAccountView> => signedIn ? view : { status: 'signed-out', email: null, plan: null, quotas: [], credits: null }
  const signOut = vi.fn(async () => { signedIn = false })
  const signIn = vi.fn<NonNullable<ChatGptAccountCardProps['signIn']>>()
  const { container } = render(<ChatGptAccountCard read={read} signIn={signIn} signOut={signOut} t={translator(copy)} />)
  await screen.findByText('user@example.test')
  await expect(container.textContent).toMatchFileSnapshot(`./expected/chatgpt-actions-${language}.txt`)
  fireEvent.click(screen.getByRole('button', { name: copy.signOut }))
  await screen.findByRole('button', { name: copy.chatGptSignIn })
  expect(screen.queryByText('user@example.test')).toBeNull()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(signOut).toHaveBeenCalledOnce()
})

it('retains the login and quota when sign-out fails', async () => {
  render(<ChatGptAccountCard read={async () => view} signOut={async () => { throw new Error('private issuer error') }} t={translator(en)} />)
  fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
  await screen.findByText(en.failed)
  expect(screen.getByText('86% remaining')).toBeTruthy()
  expect(screen.queryByText('private issuer error')).toBeNull()
})

it('opens browser authorization, submits only the current answer, and reloads the signed-in card', async () => {
  const browser = vi.spyOn(window, 'open').mockReturnValue(null)
  const complete = Promise.withResolvers<undefined>()
  let signedIn = false
  const send = vi.fn<(value: ChatGptSignInAnswer) => void>(() => { signedIn = true; complete.resolve(undefined) })
  const dispose = vi.fn()
  const stream: RemoteStreamHandle<ChatGptSignInEvent, ChatGptSignInAnswer> = {
    send, end() {}, dispose,
    async *[Symbol.asyncIterator]() {
      yield { type: 'browser', url: 'https://example.test/authorize' }
      yield { type: 'prompt', question: 1, kind: 'secret', options: [] }
      await complete.promise
      yield { type: 'complete', status: 'authorized' }
    },
  }
  const read = async (): Promise<ChatGptAccountView> => signedIn ? view : { status: 'signed-out', email: null, plan: null, quotas: [], credits: null }
  render(<ChatGptAccountCard read={read} signIn={() => stream} signOut={async () => {}} t={translator(en)} />)
  fireEvent.click(await screen.findByRole('button', { name: en.chatGptSignIn }))
  const input = await screen.findByLabelText(en.chatGptCode)
  expect(input.getAttribute('type')).toBe('password')
  expect(browser).toHaveBeenCalledWith('https://example.test/authorize', '_blank', 'noopener,noreferrer')
  fireEvent.change(input, { target: { value: 'private-code' } })
  fireEvent.click(screen.getByRole('button', { name: en.chatGptSubmit }))
  await screen.findByText('user@example.test')
  expect(send).toHaveBeenCalledWith({ question: 1, answer: 'private-code' })
  expect(screen.queryByRole('button', { name: en.chatGptSignIn })).toBeNull()
  expect(dispose).toHaveBeenCalled()
})

it('cancels the initiating authorization when its account card is closed', async () => {
  const closed = Promise.withResolvers<undefined>()
  let signal: AbortSignal | undefined
  const dispose = vi.fn(() => { closed.resolve(undefined) })
  const stream: RemoteStreamHandle<ChatGptSignInEvent, ChatGptSignInAnswer> = {
    send() {}, end() {}, dispose,
    async *[Symbol.asyncIterator]() { await closed.promise },
  }
  const { unmount } = render(<ChatGptAccountCard read={async () => ({ status: 'signed-out', email: null, plan: null, quotas: [], credits: null })}
    signIn={(value) => { signal = value; return stream }} t={translator(en)} />)
  fireEvent.click(await screen.findByRole('button', { name: en.chatGptSignIn }))
  expect(signal?.aborted).toBe(false)
  unmount()
  expect(signal?.aborted).toBe(true)
  expect(dispose).toHaveBeenCalledOnce()
})

it('offers another login when the carrier refuses authorization before opening', async () => {
  render(<ChatGptAccountCard read={async () => ({ status: 'signed-out', email: null, plan: null, quotas: [], credits: null })}
    signIn={() => { throw new Error('private transport diagnostic') }} t={translator(en)} />)
  fireEvent.click(await screen.findByRole('button', { name: en.chatGptSignIn }))
  await screen.findByText(en.failed)
  expect(screen.getByRole('button', { name: en.chatGptSignIn })).toBeTruthy()
  expect(screen.queryByText('private transport diagnostic')).toBeNull()
})

it('withdraws authorization and offers another login when an answer cannot be sent', async () => {
  const closed = Promise.withResolvers<undefined>()
  const dispose = vi.fn(() => { closed.resolve(undefined) })
  const stream: RemoteStreamHandle<ChatGptSignInEvent, ChatGptSignInAnswer> = {
    send() { throw new Error('private carrier error') }, end() {}, dispose,
    async *[Symbol.asyncIterator]() {
      yield { type: 'prompt', question: 1, kind: 'text', options: [] }
      await closed.promise
    },
  }
  render(<ChatGptAccountCard read={async () => ({ status: 'signed-out', email: null, plan: null, quotas: [], credits: null })}
    signIn={() => stream} t={translator(en)} />)
  fireEvent.click(await screen.findByRole('button', { name: en.chatGptSignIn }))
  fireEvent.change(await screen.findByLabelText(en.chatGptCode), { target: { value: 'manual-code' } })
  fireEvent.click(screen.getByRole('button', { name: en.chatGptSubmit }))
  await screen.findByText(en.failed)
  expect(screen.getByRole('button', { name: en.chatGptSignIn })).toBeTruthy()
  expect(screen.queryByText('private carrier error')).toBeNull()
  expect(dispose).toHaveBeenCalled()
})

it.each([['en', en], ['zh', zh]] as const)('renders the %s subscription allowance in an owner-local snapshot', async (language, copy) => {
  const { container } = render(<ChatGptAccountCard read={async () => view} t={translator(copy)} />)
  await screen.findByText('user@example.test')
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('86')
  await expect(container.textContent).toMatchFileSnapshot(`./expected/chatgpt-${language}.txt`)
})

it('retains the last quota when refreshing fails and replaces it on sign-out', async () => {
  const read = vi.fn<ChatGptAccountCardProps['read']>().mockResolvedValueOnce(view)
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 'signed-out', email: null, plan: null, quotas: [], credits: null })
  render(<ChatGptAccountCard read={read} t={translator(en)} />)
  await screen.findByText('86% remaining')
  fireEvent.click(screen.getByRole('button', { name: en.chatGptRefresh }))
  await screen.findByText(en.chatGptStale)
  expect(screen.getByText('86% remaining')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.chatGptRefresh }))
  await screen.findByText(en.chatGptSignedOut)
  expect(screen.queryByText('86% remaining')).toBeNull()
})

it('shows an unavailable state and offers another read after the initial request fails', async () => {
  const read = vi.fn<ChatGptAccountCardProps['read']>().mockRejectedValue(new Error('offline'))
  render(<ChatGptAccountCard read={read} t={translator(en)} />)
  await screen.findByText(en.chatGptUnavailable)
  expect(screen.queryByRole('progressbar')).toBeNull()
  await waitFor(() => { expect(screen.getByRole('button', { name: en.chatGptRefresh }).hasAttribute('disabled')).toBe(false) })
})

it('ignores a late account reading after the reader is replaced', async () => {
  const old = Promise.withResolvers<ChatGptAccountView>()
  const { rerender } = render(<ChatGptAccountCard read={() => old.promise} t={translator(en)} />)
  const signedOut: ChatGptAccountView = { status: 'signed-out', email: null, plan: null, quotas: [], credits: null }
  rerender(<ChatGptAccountCard read={async () => signedOut} t={translator(en)} />)
  await screen.findByText(en.chatGptSignedOut)
  await act(async () => { old.resolve(view) })
  expect(screen.queryByText('user@example.test')).toBeNull()
  expect(screen.getByText(en.chatGptSignedOut)).toBeTruthy()
})

it('keeps the last good reading for an unavailable refresh and updates on credential notifications', async () => {
  const read = vi.fn<ChatGptAccountCardProps['read']>().mockResolvedValueOnce(view)
    .mockResolvedValueOnce({ ...view, status: 'unavailable' }).mockResolvedValue({ status: 'signed-out', email: null, plan: null, quotas: [], credits: null })
  let changed: (() => void) | undefined
  const stop = vi.fn()
  render(<ChatGptAccountCard read={read} subscribe={(callback) => { changed = callback; return stop }} t={translator(en)} />)
  await screen.findByText('user@example.test')
  fireEvent.click(screen.getByRole('button', { name: en.chatGptRefresh }))
  await screen.findByText(en.chatGptStale)
  expect(screen.getByText('86% remaining')).toBeTruthy()
  await act(async () => { changed?.() })
  await screen.findByText(en.chatGptSignedOut)
  cleanup()
  expect(stop).toHaveBeenCalled()
})

it('ignores a late failed request after the account card is closed', async () => {
  const response = Promise.withResolvers<ChatGptAccountView>()
  const { unmount } = render(<ChatGptAccountCard read={() => response.promise} t={translator(en)} />)
  unmount()
  await act(async () => { response.reject(new Error('late failure')) })
  expect(screen.queryByText(en.chatGptUnavailable)).toBeNull()
})

it('displays reported quota periods, reset dates, and unknown credits without inventing values', async () => {
  render(<ChatGptAccountCard read={async () => ({ ...view, email: null, plan: null, credits: { unlimited: false, balance: null }, quotas: [
    { name: 'code-review', primary: null, secondary: { usedPercent: 101, windowSeconds: 3600, resetsAt: 1791580402 } },
    { name: 'gpt-reserve', primary: { usedPercent: 0, windowSeconds: 120, resetsAt: null }, secondary: null },
    { name: 'custom', primary: { usedPercent: 0, windowSeconds: null, resetsAt: null }, secondary: null },
  ] })} t={translator(en)} />)
  await screen.findByText('0% remaining')
  expect(screen.getByText('Code review · 1-hour quota')).toBeTruthy()
  expect(screen.getByText('GPT reserve · 2-minute quota')).toBeTruthy()
  expect(screen.getByText('custom · Usage quota')).toBeTruthy()
  expect(screen.getByText(/^Resets/)).toBeTruthy()
  expect(screen.getByText(en.chatGptUnknown)).toBeTruthy()
})

it('reports unlimited credits and an absent quota window explicitly', async () => {
  render(<ChatGptAccountCard read={async () => ({ ...view, quotas: [], credits: { unlimited: true, balance: null } })}
    t={translator(en)} />)
  await screen.findByText(en.chatGptNoQuotas)
  expect(screen.getByText(en.chatGptUnlimited)).toBeTruthy()
})

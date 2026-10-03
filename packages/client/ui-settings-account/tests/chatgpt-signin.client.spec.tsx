// @vitest-environment jsdom
/** Authorization controls withdraw stale questions and stop updates after their stream closes. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatGptSignInEvent, ChatGptSignInAnswer, RemoteStreamHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { ChatGptSignIn, type ChatGptSignInProps } from '../src/client/ChatGptSignIn.tsx'
import { en, type AccountKey } from '../src/client/locales.ts'

const stops: (() => void)[] = []
afterEach(async () => { cleanup(); await act(async () => { stops.splice(0).forEach((stop) => { stop() }) }); vi.restoreAllMocks() })
const t: ChatGptSignInProps['t'] = (key, values) => {
  let text: string = key in en ? en[key as AccountKey] : key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function channel() {
  type Frame = { event: ChatGptSignInEvent } | { end: true } | { error: Error }
  const frames: Frame[] = []
  let pending = Promise.withResolvers<undefined>()
  const push = (frame: Frame) => { frames.push(frame); pending.resolve(undefined) }
  stops.push(() => { push({ end: true }) })
  const send = vi.fn<(value: ChatGptSignInAnswer) => void>()
  const dispose = vi.fn()
  const stream: RemoteStreamHandle<ChatGptSignInEvent, ChatGptSignInAnswer> = {
    send, end() {}, dispose,
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (frames.length === 0) await pending.promise
        pending = Promise.withResolvers<undefined>()
        const frame = frames.shift()!
        if ('end' in frame) return
        if ('error' in frame) throw frame.error
        yield frame.event
      }
    },
  }
  return { stream, send, dispose, async emit(event: ChatGptSignInEvent) { await act(async () => { push({ event }) }) },
    async end() { await act(async () => { push({ end: true }) }) },
    async fail() { await act(async () => { push({ error: new Error('private transport detail') }) }) },
  }
}

it('shows the verification code, closes only its question and sends one nonempty selection', async () => {
  const source = channel()
  vi.spyOn(window, 'open').mockReturnValue(null)
  const finished = vi.fn()
  const { container } = render(<ChatGptSignIn start={() => source.stream} finished={finished} t={t} />)
  await source.emit({ type: 'browser', url: 'https://example.test/', code: '1234' })
  expect(screen.getByText(/1234/)).toBeTruthy()
  await source.emit({ type: 'prompt', question: 1, kind: 'select', options: [{ id: 'personal', label: 'Personal' }] })
  fireEvent.submit(container.querySelector('form')!)
  expect(source.send).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'personal' } })
  fireEvent.submit(container.querySelector('form')!)
  fireEvent.submit(container.querySelector('form')!)
  expect(source.send).toHaveBeenCalledExactlyOnceWith({ question: 1, answer: 'personal' })
  await source.emit({ type: 'prompt-closed', question: 99 })
  expect(screen.getByRole('combobox')).toBeTruthy()
  await source.emit({ type: 'prompt-closed', question: 1 })
  expect(screen.queryByRole('combobox')).toBeNull()
  await source.emit({ type: 'prompt-closed', question: 1 })
  await source.emit({ type: 'complete', status: 'authorized' })
  expect(finished).toHaveBeenCalledExactlyOnceWith('authorized')
})

it('cancels its stream and refuses an answer after cancellation', async () => {
  const source = channel()
  const finished = vi.fn()
  const { container } = render(<ChatGptSignIn start={() => source.stream} finished={finished} t={t} />)
  await source.emit({ type: 'prompt', question: 1, kind: 'text', options: [] })
  fireEvent.change(screen.getByLabelText(en.chatGptCode), { target: { value: 'code' } })
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  fireEvent.submit(container.querySelector('form')!)
  expect(source.send).not.toHaveBeenCalled()
  expect(source.dispose).toHaveBeenCalledOnce()
  expect(finished).toHaveBeenCalledExactlyOnceWith('cancelled')
  await source.emit({ type: 'complete', status: 'authorized' })
  expect(finished).toHaveBeenCalledOnce()
})

it('refuses an old prompt after the replacement carrier cannot start', async () => {
  const source = channel()
  const finished = vi.fn()
  const start = () => source.stream
  const { container, rerender } = render(<ChatGptSignIn start={start} finished={finished} t={t} />)
  await source.emit({ type: 'prompt', question: 1, kind: 'text', options: [] })
  fireEvent.change(screen.getByLabelText(en.chatGptCode), { target: { value: 'code' } })
  rerender(<ChatGptSignIn start={() => { throw new Error('closed') }} finished={finished} t={t} />)
  fireEvent.submit(container.querySelector('form')!)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(source.send).not.toHaveBeenCalled()
  expect(finished.mock.calls).toEqual([['failed'], ['cancelled']])
})

it.each(['end', 'fail'] as const)('reports a live stream %s without exposing diagnostics', async (method) => {
  const source = channel()
  const finished = vi.fn()
  render(<ChatGptSignIn start={() => source.stream} finished={finished} t={t} />)
  await source[method]()
  expect(finished).toHaveBeenCalledExactlyOnceWith('failed')
  expect(screen.queryByText('private transport detail')).toBeNull()
})

it.each(['end', 'fail'] as const)('ignores a late stream %s after closing the card', async (method) => {
  const source = channel()
  const finished = vi.fn()
  const { unmount } = render(<ChatGptSignIn start={() => source.stream} finished={finished} t={t} />)
  unmount()
  await source[method]()
  expect(finished).not.toHaveBeenCalled()
})

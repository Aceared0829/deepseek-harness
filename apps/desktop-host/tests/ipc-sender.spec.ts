import { expect, it } from 'vitest'
import { createIpcSender } from '../src/index.ts'

type IpcProcess = Parameters<typeof createIpcSender>[0]

it('writes with the IPC process as receiver', async () => {
  const owner: IpcProcess & { sent: object[] } = {
    connected: true,
    sent: [] as object[],
    send(message, callback) {
      expect(this).toBe(owner)
      owner.sent.push(message)
      callback(null)
      return true
    },
  }
  const send = createIpcSender(owner)

  await expect(send({ type: 'ready' })).resolves.toBeUndefined()
  expect(owner.sent).toEqual([{ type: 'ready' }])
})

it('resolves without a connected IPC channel and reports write errors', async () => {
  const send = createIpcSender({ connected: false })
  await expect(send({ type: 'ready' })).resolves.toBeUndefined()

  const failure = new Error('channel closed')
  const failingTarget: IpcProcess = {
    connected: true,
    send(_message, callback) {
      callback(failure)
      return true
    },
  }
  const failing = createIpcSender(failingTarget)
  await expect(failing({ type: 'ready' })).rejects.toBe(failure)
})

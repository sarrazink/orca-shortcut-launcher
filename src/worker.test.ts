// The worker's token handling over a mock host; Shortcut is a stubbed global fetch.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { TOKEN_KEY } from './protocol'
import * as main from './worker'

const CAPABILITIES = ['storage:own', 'secrets:own', 'workspace:read', 'workspace:write']
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const stubFetch = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

test('asks for a token before calling Shortcut', async () => {
  const worker = await mountWorker(main, { host: mockHost({ capabilities: CAPABILITIES }) })
  assert.deepEqual(await worker.request('board.load', { projectId: 'p' }), { kind: 'no-token' })
  await worker.deactivate()
})

test('stores a token only once Shortcut accepts it', async () => {
  const host = mockHost({ capabilities: CAPABILITIES })
  const worker = await mountWorker(main, { host })
  stubFetch(401, { message: 'Unauthorized' })
  const refused = await worker.request('token.set', { token: 'bad' })
  assert.equal(refused.ok, false)
  assert.equal(host.data().secrets?.[TOKEN_KEY], undefined)
  stubFetch(200, { mention_name: 'kevin' })
  assert.deepEqual(await worker.request('token.set', { token: ' good ' }), { ok: true, viewer: 'kevin' })
  assert.equal(host.data().secrets?.[TOKEN_KEY], 'good')
  await worker.request('token.clear')
  assert.equal(host.data().secrets?.[TOKEN_KEY], undefined)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('refuses a blank token without calling Shortcut', async () => {
  const worker = await mountWorker(main, { host: mockHost({ capabilities: CAPABILITIES }) })
  globalThis.fetch = (async () => {
    throw new Error('should not be called')
  }) as typeof fetch
  assert.deepEqual(await worker.request('token.set', { token: '   ' }), { ok: false, message: 'Paste a token first.' })
  await worker.deactivate()
})

test('opens a worktree by its CLI id, or by its path', async () => {
  const host = mockHost({
    capabilities: CAPABILITIES,
    results: {
      'workspace.list': { workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'sc-1', path: '/w/sc-1', branch: 'sc-1', hostId: 'local' }], truncated: false },
      'workspace.open': { opened: true }
    }
  })
  const worker = await mountWorker(main, { host })
  await worker.request('worktree.open', { worktreeId: 'repo::/w/sc-1' })
  assert.deepEqual(host.calls.filter((c) => c.method === 'workspace.open').map((c) => c.params), [{ workspaceId: 'ws-1' }])
  const missing = await worker.request('worktree.open', { worktreeId: 'repo::/w/none' }).catch((e: unknown) => e)
  assert.ok(missing instanceof Error)
  await worker.deactivate()
})

test('loads a story detail and moves a story with the stored token', async () => {
  const host = mockHost({ capabilities: CAPABILITIES, secrets: { [TOKEN_KEY]: 'tok' } })
  const worker = await mountWorker(main, { host })
  const calls: string[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${new URL(url).pathname}`)
    const body = url.endsWith('/members')
      ? [{ id: 'u1', profile: { mention_name: 'alice' } }]
      : { description: 'Hello', comments: [{ author_id: 'u1', text: 'hi', created_at: '2026-11-01T00:00:00Z' }] }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  const detail = await worker.request('story.detail', { storyId: 5 })
  assert.equal(detail.comments[0].author, 'alice')
  await worker.request('story.detail', { storyId: 6 })
  await worker.request('story.update', { storyId: 5, patch: { stateId: 11 } })
  assert.equal(calls.filter((c) => c.endsWith('/members')).length, 1)
  assert.ok(calls.includes('PUT /api/v3/stories/5'))
  await worker.deactivate()
})

test('says why a move failed', async () => {
  const host = mockHost({ capabilities: CAPABILITIES, secrets: { [TOKEN_KEY]: 'tok' } })
  const worker = await mountWorker(main, { host })
  stubFetch(422, { message: 'Invalid state' })
  const error = await worker.request('story.update', { storyId: 5, patch: { stateId: 99 } }).catch((e: unknown) => e)
  assert.match((error as Error).message, /refused the change: Invalid state/)
  await worker.deactivate()
})

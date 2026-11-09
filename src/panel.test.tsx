// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import { BUG, DETAIL, OPTIONS, PROJECT, READY, STARTED, STORY } from './fixtures'
import type { Board } from './protocol'
import * as panel from './panel'
import { forPanel, linkLabel } from './panel'

const CAPABILITIES = ['storage:own', 'secrets:own', 'workspace:read', 'workspace:write']

function host(board: Board) {
  const starts: unknown[] = []
  const tokens: unknown[] = []
  const moves: unknown[] = []
  let current = board
  return {
    starts,
    tokens,
    moves,
    host: mockHost({
      capabilities: CAPABILITIES,
      requests: {
        'project.active': () => PROJECT,
        'board.load': () => current,
        'story.start': (input: unknown) => {
          starts.push(input)
          current = STARTED
          return { reused: 'feature/sc-13873/old', moved: null, warning: null }
        },
        'story.comment': (input: unknown) => {
          moves.push(input)
          return { author: 'kevin', text: (input as { text: string }).text, at: '2026-11-09T10:00:00Z' }
        },
        'story.task': (input: unknown) => {
          moves.push(input)
          return null
        },
        'worktree.open': () => null,
        'story.detail': () => DETAIL,
        'story.options': () => OPTIONS,
        'story.update': (input: unknown) => {
          moves.push(input)
          return null
        },
        'token.set': (input: unknown) => {
          tokens.push(input)
          current = READY
          return { ok: true, viewer: 'kevin' }
        },
        'token.clear': () => null
      }
    })
  }
}

test('asks for a token first, then shows the stories', async () => {
  const h = host({ kind: 'no-token' })
  const p = await mount(panel, { host: h.host })
  assert.ok(p.find({ text: /Connect Shortcut/ }))
  await p.type({ label: 'Shortcut API token' }, 'tok')
  await p.press({ text: 'Save token' })
  assert.deepEqual(h.tokens, [{ token: 'tok' }])
  assert.ok(p.find({ label: `Start sc-${STORY.id}` }))
  assert.deepEqual(p.errors, [])
})

test('starts a story and then links its worktree', async () => {
  const h = host(READY)
  const p = await mount(panel, { host: h.host })
  await p.press({ label: `Start sc-${STORY.id}` })
  assert.equal(h.starts.length, 1)
  assert.equal((h.starts[0] as { story: { id: number } }).story.id, STORY.id)
  assert.equal(p.find({ label: `Start sc-${STORY.id}` }), null)
  assert.ok(p.find({ text: 'sc-13873-acme-billing-receive-heat' }))
  assert.ok(p.find({ label: `Start sc-${BUG.id}` }))
  assert.ok(p.find({ text: 'Existing branch: bug/sc-11801/gas-share' }))
})

test('filters by type', async () => {
  const p = await mount(panel, { host: host(READY).host })
  await p.toggle({ text: 'Filter' })
  await p.select({ label: 'Type' }, '=bug')
  assert.equal(p.find({ label: `Start sc-${STORY.id}` }), null)
  assert.ok(p.find({ label: `Start sc-${BUG.id}` }))
})

test('saves a project search and reloads', async () => {
  const h = host(READY)
  const p = await mount(panel, { host: h.host })
  await p.toggle({ text: /^Search/ })
  await p.type({ label: 'api Shortcut search' }, 'label:back', { replace: true })
  await new Promise((resolve) => setTimeout(resolve, 700))
  await p.settled()
  const saved = h.host.data().storage?.prefs as { projects: Record<string, { query?: string }> }
  assert.equal(saved.projects[PROJECT.id].query, 'label:back')
})

test('opens a story detail and moves the story', async () => {
  const h = host(READY)
  const p = await mount(panel, { host: h.host })
  await p.toggle(p.findAll({ text: 'Details' })[0])
  assert.ok(p.find({ text: /heat pump/ }))
  assert.ok(p.find({ text: /@alice/ }))
  await p.select({ label: `State of sc-${STORY.id}` }, '12')
  assert.deepEqual(h.moves, [{ storyId: STORY.id, patch: { stateId: 12 } }])
  assert.ok(p.find({ text: 'Done' }))
  assert.deepEqual(p.errors, [])
})

test('changes and clears an estimate', async () => {
  const h = host(READY)
  const p = await mount(panel, { host: h.host })
  await p.toggle(p.findAll({ text: 'Details' })[0])
  await p.select({ label: `Estimate of sc-${STORY.id}` }, '5')
  assert.ok(p.find({ text: '5 pt' }))
  await p.select({ label: `Estimate of sc-${STORY.id}` }, 'none')
  assert.deepEqual(h.moves.map((m) => (m as { patch: unknown }).patch), [{ estimate: 5 }, { estimate: null }])
  assert.equal(p.find({ text: '5 pt' }), null)
})

test('edits priority, epic, iteration, requester and owners', async () => {
  const h = host(READY)
  const p = await mount(panel, { host: h.host })
  assert.ok(p.find({ text: 'High' }))
  await p.toggle(p.findAll({ text: 'Details' })[0])
  await p.select({ label: `Priority of sc-${STORY.id}` }, 'p-highest')
  await p.select({ label: `Epic of sc-${STORY.id}` }, 'none')
  await p.select({ label: `Iteration of sc-${STORY.id}` }, '201')
  await p.select({ label: `Requester of sc-${STORY.id}` }, 'u-bob')
  await p.select({ label: `Add owner to sc-${STORY.id}` }, 'u-alice')
  await p.press({ label: `Remove @kevin from sc-${STORY.id} owners` })
  assert.deepEqual(
    h.moves.map((m) => (m as { patch: unknown }).patch),
    [{ priorityId: 'p-highest' }, { epicId: null }, { iterationId: 201 }, { requesterId: 'u-bob' }, { ownerIds: ['u-kevin', 'u-alice'] }, { ownerIds: ['u-alice'] }]
  )
  assert.ok(p.find({ text: 'Highest' }))
  assert.deepEqual(p.errors, [])
})

test('turns Markdown headings into bold lines, outside code', () => {
  assert.equal(forPanel('# Contexte\ntext\n## Done ##\n```\n# comment\n```'), '**Contexte**\ntext\n**Done**\n```\n# comment\n```')
  assert.equal(forPanel('#hashtag'), '#hashtag')
})

test('shortens long links the way their host writes them', () => {
  assert.equal(linkLabel('https://gitlab.com/acme/platform/api/-/merge_requests/838'), 'api!838')
  assert.equal(linkLabel('https://gitlab.com/acme/infra/compose/-/issues/63'), 'compose#63')
  assert.equal(linkLabel('https://github.com/stablyai/orca/pull/12'), 'orca#12')
  assert.equal(linkLabel('https://app.shortcut.com/acme/story/13873/acme-billing'), 'sc-13873')
  assert.equal(linkLabel('https://www.example.com/docs/guide'), 'example.com/…/guide')
  assert.equal(linkLabel('https://www.figma.com/design/AbC123/App-Acme-%E2%80%94-V2?node-id=1-2'), 'Figma · App Acme — V2')
  assert.equal(linkLabel('https://www.figma.com/board/AbC123/Atelier-onboarding'), 'FigJam · Atelier onboarding')
  assert.equal(linkLabel('https://www.figma.com/file/AbC123'), 'Figma file')
  assert.equal(linkLabel('https://www.notion.so/acme/Dashboard-rules-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'), 'Notion · Dashboard rules')
  assert.equal(linkLabel('https://www.notion.so/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?pvs=4'), 'Notion page')
  assert.equal(linkLabel('https://acme.slack.com/archives/C0123/p1699999999000100'), 'Slack message')
  assert.equal(linkLabel('https://acme.slack.com/archives/C0123/p1699999999000100?thread_ts=1699999999.000100&cid=C0123'), 'Slack thread')
  assert.equal(linkLabel('https://acme.slack.com/archives/C0123'), 'Slack channel')
  assert.equal(
    forPanel('- MR : https://gitlab.com/w/api/-/merge_requests/838 et https://gitlab.com/w/compose/-/merge_requests/63.'),
    '- MR : [api!838](https://gitlab.com/w/api/-/merge_requests/838) et [compose!63](https://gitlab.com/w/compose/-/merge_requests/63).'
  )
  assert.equal(forPanel('[the MR](https://gitlab.com/a/b/-/merge_requests/1)'), '[the MR](https://gitlab.com/a/b/-/merge_requests/1)')
  assert.equal(forPanel('[https://x.io/a](https://x.io/a)'), '[x.io/…/a](https://x.io/a)')
  assert.equal(forPanel('`curl https://x.io/a`'), '`curl https://x.io/a`')
  assert.equal(forPanel('(see https://x.io/a)'), '(see [x.io/…/a](https://x.io/a))')
})

test('ticks a task and posts a comment', async () => {
  const h = host(READY)
  const p = await mount(panel, { host: h.host })
  await p.toggle(p.findAll({ text: 'Details' })[0])
  assert.ok(p.find({ text: 'Tasks 1/2' }))
  await p.toggle({ label: 'Alert on failures' })
  assert.ok(p.find({ text: 'Tasks 2/2' }))
  await p.type({ label: `Comment on sc-${STORY.id}` }, 'Estimated!')
  await p.press({ text: 'Comment' })
  assert.ok(p.find({ text: /Estimated!/ }))
  assert.deepEqual(h.moves, [{ storyId: STORY.id, taskId: 2, complete: true }, { storyId: STORY.id, text: 'Estimated!' }])
  assert.deepEqual(p.errors, [])
})

test('shows a blocked story, sorts by priority, and says which branch a Start took up', async () => {
  const h = host(READY)
  const p = await mount(panel, { host: h.host })
  assert.ok(p.find({ text: 'Blocked' }))
  await p.toggle({ text: 'Filter' })
  await p.select({ label: 'Sort by' }, 'priority')
  const order = () => p.findAll({ label: /^Start sc-/ }).map((e) => e.label)
  assert.deepEqual(order(), [`Start sc-${STORY.id}`, `Start sc-${BUG.id}`])
  await p.select({ label: 'Sort by' }, 'state')
  assert.deepEqual(order(), [`Start sc-${BUG.id}`, `Start sc-${STORY.id}`])
  await p.press({ label: `Start sc-${STORY.id}` })
  assert.ok(p.find({ text: 'On the existing branch feature/sc-13873/old.' }))
})

test('saves the state Start moves stories to', async () => {
  const h = host(READY)
  const p = await mount(panel, { host: h.host })
  await p.toggle({ text: /^On Start/ })
  await p.select({ label: 'Move the story to' }, 'none')
  await p.settled()
  const saved = h.host.data().storage?.prefs as { projects: Record<string, { startState?: string }> }
  assert.equal(saved.projects[PROJECT.id].startState, 'none')
})

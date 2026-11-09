// The Shortcut client against a fake fetch: headers, parsing and error messages.
import { assert, test } from 'orca/testing'
import { errorMessage, mentionsById, storyUrl, parseDetail, parseEpics, parseIterations, parseMembers, parsePriority, updateBody, parseStories, parseWorkflows, renderQuery, ShortcutClient, ShortcutError } from './shortcut'

const WORKFLOWS = [
  { id: 1, states: [
    { id: 11, name: 'In Progress', type: 'started', position: 2 },
    { id: 10, name: 'To Do', type: 'unstarted', position: 1 },
    { id: 12, name: 'Done', type: 'done', position: 3 }
  ] },
  { id: 2, states: [{ id: 20, name: 'To Do', type: 'unstarted', position: 1 }] }
]
const PAGE = { total: 3, next: null, data: [
  { id: 5, name: 'Fix login', app_url: 'https://app.shortcut.com/w/story/5', story_type: 'bug', workflow_id: 1, workflow_state_id: 11,
    labels: [{ name: 'back' }], estimate: 2, formatted_vcs_branch_name: 'bug/sc-5/fix-login',
    branches: [
      { name: 'bug/sc-5/old', updated_at: '2026-01-01T00:00:00Z' },
      { name: 'bug/sc-5/gone', deleted: true, updated_at: '2026-09-01T00:00:00Z' },
      { name: 'bug/sc-5/new', updated_at: '2026-06-01T00:00:00Z' },
      { name: 'bug/sc-5/new', updated_at: '2026-05-01T00:00:00Z' }
    ] },
  { id: 6, name: 'Old', app_url: 'https://app.shortcut.com/w/story/6', archived: true },
  { id: 7, name: 'No state', app_url: 'https://app.shortcut.com/w/story/7', workflow_state_id: 999, formatted_vcs_branch_name: '' }
] }

test('orders states by workflow position without duplicates', () => {
  const workflows = parseWorkflows(WORKFLOWS)
  assert.deepEqual(workflows.order, ['To Do', 'In Progress', 'Done'])
  assert.deepEqual(workflows.states.get(11), { name: 'In Progress', type: 'started' })
  assert.deepEqual(workflows.byWorkflow[1].map((s) => s.id), [10, 11, 12])
  assert.deepEqual(workflows.byWorkflow[2], [{ id: 20, name: 'To Do', type: 'unstarted' }])
  assert.deepEqual(parseWorkflows(null).order, [])
})

test('parses stories, skips archived ones and resolves states', () => {
  const { stories, total } = parseStories(PAGE, parseWorkflows(WORKFLOWS))
  assert.equal(total, 3)
  assert.deepEqual(stories.map((s) => s.id), [5, 7])
  assert.deepEqual(stories[0], {
    id: 5, name: 'Fix login', url: 'https://app.shortcut.com/w/story/5', type: 'bug', state: 'In Progress',
    stateType: 'started', workflowId: 1, stateId: 11, labels: ['back'],
    epicId: null, iterationId: null, requesterId: null, ownerIds: [], priorityId: null, blocked: false, estimate: 2, branch: 'bug/sc-5/fix-login',
    existingBranches: ['bug/sc-5/new', 'bug/sc-5/old']
  })
  assert.equal(stories[1].state, null)
  assert.equal(stories[1].stateId, null)
  assert.equal(stories[1].branch, null)
})

test('fills {{me}} in searches', () => {
  assert.equal(renderQuery(' owner:{{me}} !is:done ', 'kevin'), 'owner:kevin !is:done')
})

test('sends the token header and the search parameters', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const fake = async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> })
    return new Response(JSON.stringify(url.includes('/member') ? { mention_name: 'kevin' } : PAGE), { status: 200 })
  }
  const client = new ShortcutClient('tok', fake)
  assert.equal(await client.me(), 'kevin')
  await client.search('owner:kevin !is:done', parseWorkflows(WORKFLOWS))
  assert.equal(seen[0].headers['Shortcut-Token'], 'tok')
  const search = new URL(seen[1].url)
  assert.equal(search.pathname, '/api/v3/search/stories')
  assert.equal(search.searchParams.get('query'), 'owner:kevin !is:done')
  assert.equal(search.searchParams.get('detail'), 'full')
})

test('turns API failures into messages a person can act on', async () => {
  const fake = async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })
  const error = await new ShortcutClient('bad', fake).me().catch((e: unknown) => e)
  assert.ok(error instanceof ShortcutError)
  assert.match(errorMessage(error), /refused the token/)
  assert.match(errorMessage(new ShortcutError('slow down', 429)), /rate limit/)
  assert.match(errorMessage(new ShortcutError('bad query', 400)), /did not accept the search: bad query/)
  assert.match(errorMessage(new Error('offline')), /Could not reach Shortcut: offline/)
})

test('parses a story detail: live comments oldest first, authors by mention name', () => {
  const members = mentionsById(parseMembers([{ id: 'u1', profile: { mention_name: 'alice' } }, { id: 'u2' }]))
  const detail = parseDetail(
    {
      description: 'Do **it**',
      comments: [
        { author_id: 'u2', text: 'second', created_at: '2026-11-03T00:00:00Z' },
        { author_id: 'u1', text: 'first', created_at: '2026-11-01T00:00:00Z' },
        { author_id: 'u1', text: 'gone', created_at: '2026-11-02T00:00:00Z', deleted: true }
      ]
    },
    members
  )
  assert.equal(detail.description, 'Do **it**')
  assert.deepEqual(detail.comments.map((c) => [c.author, c.text]), [['alice', 'first'], ['someone', 'second']])
  assert.ok(parseDetail({ description: 'x'.repeat(30000) }, members).description.length < 20010)
  assert.deepEqual(parseDetail(null, members), { description: '', comments: [], tasks: [], blockers: [] })
})

test('reads the estimate scale from the member, and sends estimates', async () => {
  const sent: unknown[] = []
  const fake = async (url: string, init: RequestInit) => {
    if (init.method === 'PUT') {
      sent.push(JSON.parse(init.body as string))
      return new Response('{}', { status: 200 })
    }
    return new Response(JSON.stringify({ mention_name: 'kevin', workspace2: { estimate_scale: [0, 1, 2, 3, 5, 8] } }), { status: 200 })
  }
  const client = new ShortcutClient('tok', fake)
  assert.deepEqual(await client.member(), { me: 'kevin', meId: '', estimateScale: [0, 1, 2, 3, 5, 8] })
  const bare = new ShortcutClient('tok', async () => new Response(JSON.stringify({ mention_name: 'kevin' }), { status: 200 }))
  assert.deepEqual((await bare.member()).estimateScale, [0, 1, 2, 4, 8])
  await client.update(5, { estimate: 3 }, null)
  await client.update(5, { estimate: null, stateId: 11 }, null)
  assert.deepEqual(sent, [{ estimate: 3 }, { estimate: null, workflow_state_id: 11 }])
})

const PRIORITY = { fieldId: 'fp', values: [{ id: 'v-high', name: 'High' }] }

test('reads the Priority field, epics, iterations and members', () => {
  assert.deepEqual(
    parsePriority([
      { id: 'fs', canonical_name: 'severity', values: [] },
      { id: 'fp', canonical_name: 'priority', enabled: true, values: [
        { id: 'v-low', value: 'Low', position: 2 }, { id: 'v-high', value: 'High', position: 0 }, { id: 'v-off', value: 'Off', enabled: false }
      ] }
    ]),
    { fieldId: 'fp', values: [{ id: 'v-high', name: 'High' }, { id: 'v-low', name: 'Low' }] }
  )
  assert.equal(parsePriority([{ id: 'fp', canonical_name: 'priority', enabled: false }]), null)
  assert.deepEqual(parseEpics({ data: [{ id: 2, name: 'Onboarding' }, { id: 1, name: 'Onboarding' }, { id: 3, name: 'Emails' }] }).map((e) => e.name),
    ['Emails', 'Onboarding · #1', 'Onboarding · #2'].sort((a, b) => a.localeCompare(b)))
  assert.deepEqual(
    parseIterations([{ id: 2, name: 'S2', status: 'unstarted', start_date: '2026-11-23' }, { id: 1, name: 'S1', status: 'done', start_date: '2026-11-09' }]),
    [{ id: 1, name: 'S1', done: true }, { id: 2, name: 'S2', done: false }]
  )
  assert.deepEqual(parseMembers([{ id: 'a', disabled: true, profile: { mention_name: 'old' } }]), [{ id: 'a', mention: 'old', active: false }])
})

test('maps a patch to Shortcut fields', () => {
  assert.deepEqual(
    updateBody({ type: 'bug', epicId: null, iterationId: 3, requesterId: 'u1', ownerIds: ['u1', 'u2'] }, null, null),
    { story_type: 'bug', epic_id: null, iteration_id: 3, requested_by_id: 'u1', owner_ids: ['u1', 'u2'] }
  )
})

test('a priority change keeps the story\'s other custom fields', async () => {
  const current = [{ field_id: 'fs', value_id: 'sev-2' }, { field_id: 'fp', value_id: 'v-low' }, { field_id: 'ft', value_id: 'api' }]
  assert.deepEqual(updateBody({ priorityId: 'v-high' }, current, PRIORITY).custom_fields, [
    { field_id: 'fs', value_id: 'sev-2' }, { field_id: 'ft', value_id: 'api' }, { field_id: 'fp', value_id: 'v-high' }
  ])
  assert.deepEqual(updateBody({ priorityId: null }, current, PRIORITY).custom_fields, [
    { field_id: 'fs', value_id: 'sev-2' }, { field_id: 'ft', value_id: 'api' }
  ])
  const calls: { method?: string; body?: unknown }[] = []
  const fake = async (_url: string, init: RequestInit) => {
    calls.push({ method: init.method, body: init.body && JSON.parse(init.body as string) })
    return new Response(JSON.stringify({ custom_fields: current }), { status: 200 })
  }
  await new ShortcutClient('tok', fake).update(5, { priorityId: 'v-high' }, PRIORITY)
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT'])
  assert.equal((calls[1].body as { custom_fields: unknown[] }).custom_fields.length, 3)
})

test('reads tasks and blockers, and posts comments', async () => {
  const detail = parseDetail(
    {
      id: 5,
      app_url: 'https://app.shortcut.com/w/story/5/fix-login',
      tasks: [{ id: 2, description: 'b', position: 2 }, { id: 1, description: 'a', complete: true, position: 1 }],
      story_links: [
        { verb: 'blocks', subject_id: 9, object_id: 5 },
        { verb: 'blocks', subject_id: 5, object_id: 7 },
        { verb: 'relates to', subject_id: 8, object_id: 5 }
      ]
    },
    new Map()
  )
  assert.deepEqual(detail.tasks, [{ id: 1, description: 'a', complete: true }, { id: 2, description: 'b', complete: false }])
  assert.deepEqual(detail.blockers, [{ id: 9, url: 'https://app.shortcut.com/w/story/9' }])
  assert.equal(storyUrl('https://app.shortcut.com/w/story/5', 6), 'https://app.shortcut.com/w/story/6')
  const calls: { method?: string; url: string; body?: unknown }[] = []
  const fake = async (url: string, init: RequestInit) => {
    calls.push({ method: init.method, url, body: init.body && JSON.parse(init.body as string) })
    return new Response(JSON.stringify({ text: 'hi', created_at: '2026-11-09T10:00:00Z' }), { status: 201 })
  }
  const client = new ShortcutClient('tok', fake)
  assert.deepEqual(await client.comment(5, 'hi'), { text: 'hi', at: '2026-11-09T10:00:00Z' })
  await client.setTask(5, 2, true)
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ['POST /api/v3/stories/5/comments', 'PUT /api/v3/stories/5/tasks/2'])
  assert.deepEqual(calls[1].body, { complete: true })
})

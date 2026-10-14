const test = require('node:test')
const assert = require('node:assert/strict')
const { runTask, validateTask, createRequestGuard } = require('../index')
const { startFixturePortal, taskFor, USERNAME, PASSWORD, SECRET } = require('./fixture-portal')
let portal
const logs = []
const restoreStreams = []
const clientId = '0a0b0c0d-0000-4000-8000-000000009876'
function task(scenario) {
  const result = taskFor(portal.origin, scenario)
  result.details = {
    linkSelector: 'a', pathPrefix: `/${scenario}/integration-clients/`, markers: ['h1'],
    pgid: { selector: '#pgid', value: true }, integrationId: { selector: '#integration', value: true },
    expect: { field: { selector: '#clientId', value: true }, sensitiveInput: 'expectedClientId' },
    clientSecret: { selector: '#clientSecret', value: true },
    actions: [
      { type: 'click', selector: '#reset' }, { type: 'waitFor', selector: '#confirmation' },
      { type: 'click', selector: '#confirm', mutation: true },
      { type: 'waitFor', selector: '#success' }, { type: 'dismiss', selector: '#close' },
    ],
  }
  result.requestPolicy.action = [{ origin: portal.origin, methods: ['GET'], pathTemplate: `/${scenario}/api/integrations/{integrationId}/clients/{pgid}`, resourceTypes: ['fetch', 'xhr'], emptyQuery: true, maxCount: 1 }]
  result.output = { name: 'clientSecret', field: 'clientSecret', source: 'details', format: { exactLength: 32, rejectValues: ['*************'] } }
  result.limits.actionTimeoutMs = 1200
  return result
}
async function run(scenario, extra = {}) {
  const outputs = []
  const stages = []
  const document = task(scenario)
  extra.modifyTask?.(document)
  const result = await runTask({
    task: document, execution: { runId: scenario, taskDigest: 'fixture' }, parameters: { PGID: '9876' },
    sensitiveInputs: { PORTAL_USERNAME: USERNAME, PORTAL_PASSWORD: PASSWORD, expectedClientId: extra.expectedClientId || clientId },
    signal: extra.signal,
    hooks: {
      onEvent: event => { stages.push(event.stage); extra.onEvent?.(event) },
      onBeforeAction: extra.onBeforeAction,
      onBeforeMutation: extra.missingMutationHook ? undefined : extra.onBeforeMutation || (async () => {}),
      onSensitiveOutput: async output => { await extra.onOutput?.(); outputs.push(output.value) },
    },
  })
  assert.ok(!JSON.stringify(result).includes(SECRET))
  assert.ok(!JSON.stringify(result).includes(clientId))
  return { result, outputs, stages }
}
test.before(async () => {
  portal = await startFixturePortal()
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write
    restoreStreams.push(() => { stream.write = original })
    stream.write = function(chunk, ...rest) { logs.push(String(chunk)); return original.call(this, chunk, ...rest) }
  }
})
test.after(async () => { restoreStreams.forEach(restore => restore()); await portal.close() })
test('validates action tasks and rejects missing guard, checkpoints and screenshots', () => {
  validateTask(task('action_success'))
  for (const modify of [t => { delete t.requestPolicy.action }, t => { t.checkpoint = 'authenticated_list' }, t => { t.screenshots = {} }, t => { t.requestPolicy.action[0].maxCount = 2 }, t => { t.requestPolicy.action[0].methods = ['POST'] }, t => { delete t.details.expect }]) {
    const invalid = task('action_success'); modify(invalid); assert.throws(() => validateTask(invalid))
  }
})
test('mutating GET is denied before arming, wrong bindings/query/type and repeated dispatch', () => {
  const policy = task('action_success').requestPolicy
  policy.list.push({ origin: portal.origin, methods: ['GET'], pathPrefix: '/action_success/api/' })
  const request = { url: `${portal.origin}/action_success/api/integrations/target/clients/9876`, method: 'GET', resourceType: 'fetch' }
  const armed = () => { const guard = createRequestGuard(policy); guard.setActionBindings({ integrationId: 'target', pgid: '9876' }); guard.setPhase('action'); guard.armAction(); return guard }
  assert.equal(createRequestGuard(policy).decide(request).allow, false)
  for (const changed of [{ url: request.url + '?' }, { url: request.url + '?x=1' }, { url: request.url.replace('9876', '999') }, { url: request.url.replace('/target/', '/other/') }, { resourceType: 'document' }, { method: 'POST' }, { url: request.url.replace('/target/', '/%74arget/') }]) assert.equal(armed().decide({ ...request, ...changed }).allow, false)
  const guard = armed(); assert.equal(guard.decide(request).mutation, true); assert.equal(guard.decide(request).allow, false)
})
test('both dialogs finish and output goes only to callback after awaited authorization', async () => {
  let acked = false
  const before = portal.events.filter(e => e.kind === 'reset').length
  const { result, outputs } = await run('action_success', { onBeforeMutation: async () => {
    assert.equal(portal.events.filter(e => e.kind === 'reset').length, before)
    await new Promise(resolve => setTimeout(resolve, 100)); acked = true
  }, onEvent: event => { if (event.stage === 'mutation_dispatched') assert.equal(acked, true) } })
  assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.equal(result.mutationDispatched, true); assert.deepEqual(outputs, [SECRET])
})
test('the detail record ID may differ from its integration ID', async () => {
  const { result, outputs } = await run('action_distinct_ids')
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.deepEqual(outputs, [SECRET])
  assert.equal(portal.events.filter(event => event.scenario === 'action_distinct_ids' && event.kind === 'reset' && event.path.endsWith('/integrations/integration-42/clients/9876')).length, 1)
})
for (const [scenario, code, extra] of [
  ['action_wrong_pgid', 'detail_pgid_mismatch'], ['action_invalid_integration', 'detail_integration_mismatch'],
  ['action_changed_integration', 'detail_expected_mismatch', { onBeforeMutation: async () => { await new Promise(resolve => setTimeout(resolve, 300)) } }],
  ['action_success', 'detail_expected_mismatch', { expectedClientId: 'wrong' }],
  ['action_before_block', 'prohibited_request_attempted'],
  ['action_success', 'mutation_authorization_failed', { missingMutationHook: true }],
  ['action_success', 'mutation_authorization_failed', { onBeforeMutation: async () => { throw new Error(SECRET) } }],
]) test(`pre-dispatch ${code} prevents reset`, async () => {
  const before = portal.events.filter(e => e.kind === 'reset').length
  const { result, outputs } = await run(scenario, extra)
  assert.equal(result.code, code, JSON.stringify(result)); assert.deepEqual(outputs, []); assert.equal(portal.events.filter(e => e.kind === 'reset').length, before)
})
for (const scenario of ['action_later_block', 'action_twice', 'action_missing_dialog']) test(`${scenario} preserves delivery after dispatch`, async () => {
  const { result, outputs } = await run(scenario)
  assert.equal(result.status, scenario === 'action_missing_dialog' ? 'failed' : 'succeeded', JSON.stringify(result)); assert.deepEqual(outputs, [SECRET])
  if (scenario === 'action_missing_dialog') assert.equal(result.code, 'action_failed')
  assert.equal(portal.events.filter(e => e.scenario === scenario && e.kind === 'reset').length, 1)
  if (scenario !== 'action_missing_dialog') assert.ok(result.blockedRequests.attempted > 0)
})
for (const scenario of ['action_wrong_path', 'action_wrong_query', 'action_placeholder', 'action_padded']) test(`${scenario} never delivers an invalid secret`, async () => {
  const { result, outputs } = await run(scenario)
  assert.equal(result.status, 'failed'); assert.deepEqual(outputs, [])
  if (!['action_placeholder', 'action_padded'].includes(scenario)) assert.equal(portal.events.filter(e => e.scenario === scenario && e.kind === 'reset').length, 0)
})
test('cancellation after dispatch completes delivery; before ack prevents dispatch', async () => {
  const controller = new AbortController()
  const after = await run('action_success', { signal: controller.signal, onEvent: event => { if (event.stage === 'mutation_dispatched') controller.abort() } })
  assert.equal(after.result.status, 'succeeded', JSON.stringify(after.result)); assert.deepEqual(after.outputs, [SECRET])
  const early = new AbortController()
  const before = await run('action_success', { signal: early.signal, onBeforeMutation: async () => { early.abort() } })
  assert.equal(before.result.status, 'cancelled'); assert.equal(before.result.mutationDispatched, false); assert.deepEqual(before.outputs, [])
})

test('sensitive values never reach runner stdout or stderr', () => {
  const text = logs.join('')
  for (const value of [SECRET, clientId, PASSWORD]) assert.equal(text.includes(value), false)
})

test('an expired authorization callback cannot dispatch after the action timed out', async () => {
  let ackFinished = false
  const before = portal.events.filter(event => event.kind === 'reset').length
  const { result, outputs } = await run('action_success', {
    onBeforeMutation: async () => { await new Promise(resolve => setTimeout(resolve, 1500)); ackFinished = true },
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(ackFinished, true)
  assert.equal(result.code, 'action_failed')
  assert.equal(portal.events.filter(event => event.kind === 'reset').length, before)
  assert.deepEqual(outputs, [])
})
test('the total deadline grants bounded delivery time after an actual mutation', async () => {
  const { result, outputs } = await run('action_success', {
    modifyTask: document => { document.limits.totalTimeoutMs = 2000 },
    onOutput: async () => { await new Promise(resolve => setTimeout(resolve, 2200)) },
  })
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.ok(result.elapsedMs > 2000)
  assert.deepEqual(outputs, [SECRET])
})

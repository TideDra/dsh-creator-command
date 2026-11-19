import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import * as creatorPlugin from '../index.js';

function resolveDshRuntimeRoot() {
  const candidates = [];
  if (process.env.DSH_RUNTIME_ROOT) {
    candidates.push(process.env.DSH_RUNTIME_ROOT);
  }
  try {
    const binPath = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    if (binPath) {
      const realBin = realpathSync(binPath);
      candidates.push(dirname(dirname(realBin)), dirname(realBin));
    }
  } catch {}
  candidates.push(
    join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  );
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
  }
  throw new Error('Cannot locate @deepseek-ai/dsh installation; set DSH_RUNTIME_ROOT');
}

const DSH_ROOT = resolveDshRuntimeRoot();
const hostReq = createRequire(join(DSH_ROOT, 'package.json'));

async function importFromDsh(specifier) {
  for (const anchor of [
    hostReq,
    createRequire(hostReq.resolve('@deepseek-ai/dsh-web-app/package.json')),
    createRequire(hostReq.resolve('@deepseek-ai/dsh-base/package.json')),
  ]) {
    try {
      return await import(pathToFileURL(anchor.resolve(specifier)).href);
    } catch {}
  }
  throw new Error(`Cannot resolve ${specifier}`);
}

async function createTestHarness({ withMarket = true } = {}) {
  const [
    { Context, Service },
    { createScope, bindScopeParent, scopeTarget },
    { Session },
    sessionProjectionMod,
    systemPromptMod,
    toolsMod,
    nativeExecutorMod,
    skillMod,
    commandsMod,
    typertMod,
  ] = await Promise.all([
    importFromDsh('@deepseek-ai/cordis'),
    importFromDsh('@deepseek-ai/dsh-scope'),
    importFromDsh('@deepseek-ai/dsh-session'),
    importFromDsh('@deepseek-ai/dsh-session-projection'),
    importFromDsh('@deepseek-ai/dsh-system-prompt'),
    importFromDsh('@deepseek-ai/dsh-tools'),
    importFromDsh('@deepseek-ai/dsh-tool-executor-native'),
    importFromDsh('@deepseek-ai/dsh-skill'),
    importFromDsh('@deepseek-ai/dsh-commands'),
    importFromDsh('@deepseek-ai/dsh-typert-registry'),
  ]);

  const root = new Context();

  // Mock lightweight Host services required by tool-cordis, plugin-manager/tools, plugin-market/tools, tool-skill
  class MockAgents extends Service {
    live = new Map();
    constructor(ctx) {
      super(ctx, 'agents');
    }
    list() {
      return [...this.live.values()];
    }
    get(id) {
      return this.live.get(id);
    }
  }

  class MockWorkingDirectory extends Service {
    defaultDirectory = '/tmp';
    constructor(ctx) {
      super(ctx, 'workingDirectory');
    }
    get(session) {
      return session.header.cwd ?? '/tmp';
    }
    async ensure(agent) {
      return agent.session.header.cwd ?? '/tmp';
    }
  }

  class MockCordisInspect extends Service {
    constructor(ctx) {
      super(ctx, 'cordisInspect');
    }
    list() {
      return [{ platform: 'host', id: 'Service', description: 'mock', methods: [] }];
    }
    async query(platform, provider, method) {
      return { ok: true, platform, provider, method };
    }
  }

  class MockProfileContext extends Service {
    name = 'web';
    installAnchor = join(DSH_ROOT, 'package.json');
    constructor(ctx) {
      super(ctx, 'profileContext');
    }
  }

  class MockSandboxPolicy extends Service {
    constructor(ctx) {
      super(ctx, 'sandboxPolicy');
    }
    resolve() {
      return { mode: 'danger-full-access', writableRoots: [] };
    }
  }

  class MockPluginManager extends Service {
    constructor(ctx) {
      super(ctx, 'pluginManager');
    }
    async listPlugins() {
      return [];
    }
    async listBundles() {
      return [];
    }
    listVersionExemptions() {
      return { exemptions: [] };
    }
  }

  class MockPluginMarket extends Service {
    constructor(ctx) {
      super(ctx, 'pluginMarket');
    }
    listIndexes() {
      return [];
    }
  }

  class MockAgentPresets extends Service {
    presetsByAgent = new WeakMap();
    constructor(ctx) {
      super(ctx, 'agentPresets');
    }
    composedPreset(agentCtx) {
      return this.presetsByAgent.get(agentCtx);
    }
    presetForSession(session) {
      return session.header.agentPreset ?? null;
    }
  }

  await root.plugin(typertMod.default ?? typertMod);
  await root.plugin(sessionProjectionMod.default ?? sessionProjectionMod);
  await root.plugin(systemPromptMod.default ?? systemPromptMod);
  await root.plugin(toolsMod.default ?? toolsMod);
  await root.plugin(nativeExecutorMod.default ?? nativeExecutorMod);
  await root.plugin(skillMod.default ?? skillMod);
  await root.plugin(commandsMod.default ?? commandsMod);
  await root.plugin(MockAgents);
  await root.plugin(MockWorkingDirectory);
  await root.plugin(MockCordisInspect);
  await root.plugin(MockProfileContext);
  await root.plugin(MockSandboxPolicy);
  await root.plugin(MockPluginManager);
  await root.plugin(MockAgentPresets);
  if (withMarket) {
    await root.plugin(MockPluginMarket);
  }

  // Forward session.append events to `session/event` so `sessionProjections` folds them just like `dsh-session`
  function attachSessionEvents(session) {
    const origAppend = session.append.bind(session);
    session.append = (type, data, ...rest) => {
      const event = origAppend(type, data, ...rest);
      root.emit(scopeTarget(session, session), 'session/event', session, event);
      return event;
    };
    return session;
  }

  let loopCtx = root;
  await root.plugin({
    name: 'mock-agent-loop-context',
    inject: ['agents', 'tools', 'systemPrompt', 'sessionProjections'],
    apply(ctx) {
      loopCtx = ctx;
    },
  });

  function createMockAgent(id, { preset = 'standard', parentPresetScope } = {}) {
    const session = attachSessionEvents(
      Session.create(id, [], {
        version: 4,
        id,
        createdAt: Date.now(),
        cwd: tmpdir(),
        isSeeded: false,
        agentPreset: preset,
      }),
    );
    const steered = [];
    const agent = {
      id,
      session,
      status: 'idle',
      ctx: null,
      scope: null,
      steered,
      steer(msg) {
        steered.push(msg);
      },
      inject(msg) {
        steered.push(msg);
      },
    };
    const scope = createScope(
      loopCtx,
      agent,
      parentPresetScope ? { parent: parentPresetScope } : undefined,
    );
    agent.scope = scope;
    agent.ctx = scope.ctx;
    root.agentPresets.presetsByAgent.set(agent.ctx, preset);
    root.agents.live.set(id, agent);
    return { agent, session, steered, bindScopeParent, scopeTarget, createScope };
  }

  return { root, Session, attachSessionEvents, createMockAgent, createScope, scopeTarget };
}

test('unit: parseCreatorCommand and resolveConfig validate inputs cleanly', () => {
  assert.deepEqual(creatorPlugin.parseCreatorCommand(''), { kind: 'on', message: '' });
  assert.deepEqual(creatorPlugin.parseCreatorCommand('  on  '), { kind: 'on', message: '' });
  assert.deepEqual(creatorPlugin.parseCreatorCommand('OFF'), { kind: 'off' });
  assert.deepEqual(creatorPlugin.parseCreatorCommand('status'), { kind: 'status' });
  assert.deepEqual(creatorPlugin.parseCreatorCommand('  build a clock widget  '), {
    kind: 'on',
    message: 'build a clock widget',
  });

  const cfg = creatorPlugin.resolveConfig({});
  assert.equal(cfg.commandName, 'creator');
  assert.equal(cfg.includeFsTools, false);
  assert.throws(() => creatorPlugin.resolveConfig({ unknownOption: 1 }), /unknown key/);
  assert.throws(() => creatorPlugin.resolveConfig({ commandName: 'BAD NAME' }), /must match/);
});

test('integration: /creator adds Creator skills & tools to isolated/restricted preset agent without leaking to other sessions, and /creator off removes them', async () => {
  const { root, createMockAgent, createScope, scopeTarget } = await createTestHarness();
  const pluginFiber = await root.plugin(creatorPlugin);

  // Register one global dummy tool and create a preset scope that restricts global tools (like preset-agy!)
  const { defineTool } = await importFromDsh('@deepseek-ai/dsh-tools');
  root.tools.register(
    defineTool({
      name: 'global_dummy',
      description: 'dummy',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        return 'ok';
      },
    }),
  );
  const presetKey = {};
  const presetScope = createScope(root, presetKey);
  await presetScope.ctx.plugin({
    name: 'mock-preset-restrict',
    inject: ['tools'],
    apply(ctx) {
      ctx.tools.restrict({ deny: ['global_dummy'] });
    },
  });

  const { agent: agentA } = createMockAgent('session-a', {
    preset: 'agy',
    parentPresetScope: presetKey,
  });
  const { agent: agentB } = createMockAgent('session-b', {
    preset: 'standard',
  });

  // Verify `/creator` is listed in commands
  const cmds = root.commands.list(agentA);
  assert.ok(cmds.some((c) => c.name === 'creator'), '/creator command should be registered');

  // Before `/creator`, agentA has NO Creator tools and NO Creator skills
  assert.deepEqual(
    root.tools.schemas(agentA).map((s) => s.name),
    [],
  );
  const beforeSkills = await root.skills.list({ cwd: '/tmp', scope: agentA });
  assert.ok(!beforeSkills.some((s) => s.name === 'cordis-plugin-development'));

  // Execute `/creator` on agentA
  const abort = new AbortController();
  const execOn = await root.commands.execute(agentA, '/creator', [], abort.signal);
  assert.equal(execOn?.result.kind, 'success');
  assert.match(execOn.result.text, /Creator mode enabled/);

  // Verify agentA now has all 5 Creator tools!
  const schemasA = root.tools.schemas(agentA).map((s) => s.name).sort();
  assert.deepEqual(schemasA, [
    'cordis_inspect_list',
    'cordis_inspect_query',
    'plugin_manager',
    'plugin_market',
    'skill',
  ]);

  // Verify agentB in the same Host remains completely untouched!
  assert.deepEqual(
    root.tools.schemas(agentB).map((s) => s.name),
    ['global_dummy'],
  );

  // Verify agentA now sees all 4 official Creator skills and can load their full SKILL.md bodies!
  const afterSkills = await root.skills.list({ cwd: '/tmp', scope: agentA });
  const skillNames = afterSkills.map((s) => s.name);
  for (const expected of [
    'agent-experience',
    'cordis-composition-reference',
    'cordis-plugin-development',
    'editing-cordis-compositions',
  ]) {
    assert.ok(skillNames.includes(expected), `expected Creator skill "${expected}" to be visible`);
  }
  const loadedSkill = await root.skills.get('cordis-plugin-development', {
    cwd: '/tmp',
    scope: agentA,
  });
  assert.ok(loadedSkill?.content.includes('Persistent Harness plugins'));

  // Verify `agent/pre-step` injects `<available_skills>` via the mounted `dsh-tool-skill`!
  const receiverA = scopeTarget(agentA, agentA);
  const preStep1 = await root.waterfall(
    receiverA,
    'agent/pre-step',
    {
      agent: agentA,
      messages: [],
      turn: 1,
      step: 1,
      signal: abort.signal,
      modelSelection: { provider: 'deepseek', model: 'deepseek-chat' },
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(preStep1.kind, 'enter');
  const catalogMsg = preStep1.messages.find((m) => m.source?.kind === 'skill-catalog');
  assert.ok(catalogMsg, 'dsh-tool-skill should inject <available_skills> catalog on pre-step');
  assert.match(catalogMsg.content[0].text, /cordis-plugin-development/);

  // Simulate Step 1 starting (`step/start`), then `/creator off`, then Step 2 `agent/pre-step`
  agentA.session.append('step/start', { turn: 1, step: 1 });

  const statusExec = await root.commands.execute(agentA, '/creator status', [], abort.signal);
  assert.equal(statusExec?.result.kind, 'success');
  assert.match(statusExec.result.text, /Creator mode is active/);

  const execOff = await root.commands.execute(agentA, '/creator off', [], abort.signal);
  assert.equal(execOff?.result.kind, 'success');
  assert.match(execOff.result.text, /Creator mode off/);

  // Creator tools and skills are completely removed from agentA!
  assert.deepEqual(
    root.tools.schemas(agentA).map((s) => s.name),
    [],
  );
  const offSkills = await root.skills.list({ cwd: '/tmp', scope: agentA });
  assert.ok(!offSkills.some((s) => s.name === 'cordis-plugin-development'));

  // Step 2 `agent/pre-step` receives the one-line disable notice!
  const preStep2 = await root.waterfall(
    receiverA,
    'agent/pre-step',
    {
      agent: agentA,
      messages: [],
      turn: 2,
      step: 1,
      signal: abort.signal,
      modelSelection: { provider: 'deepseek', model: 'deepseek-chat' },
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
  const noticeMsg = preStep2.messages.find((m) => m.source?.kind === 'creator-command');
  assert.ok(noticeMsg, 'mid-session switch should emit a notice');
  assert.match(noticeMsg.content[0].text, /disabled DSH Creator mode/);

  await pluginFiber.dispose();
});

test('integration: /creator <message> steers prompt after mounting, and session resume restores Creator capabilities automatically', async () => {
  const { root, Session, attachSessionEvents, createScope, scopeTarget } =
    await createTestHarness();
  await root.plugin(creatorPlugin);

  const session = attachSessionEvents(
    Session.create('session-resume-1', [], {
      version: 4,
      id: 'session-resume-1',
      createdAt: Date.now(),
      cwd: '/tmp',
      isSeeded: false,
      agentPreset: 'standard',
    }),
  );

  const steered = [];
  const agent1 = {
    id: 'session-resume-1',
    session,
    status: 'idle',
    ctx: null,
    scope: null,
    steer(msg) {
      // Verify tools are ALREADY mounted at the moment `agent.steer` is called!
      assert.ok(root.tools.get('cordis_inspect_list', agent1) !== undefined);
      steered.push(msg);
    },
  };
  agent1.scope = createScope(root, agent1);
  agent1.ctx = agent1.scope.ctx;
  root.agentPresets.presetsByAgent.set(agent1.ctx, 'standard');
  root.agents.live.set(agent1.id, agent1);

  const abort = new AbortController();
  const res = await root.commands.execute(
    agent1,
    '/creator 实现一个天气插件',
    [],
    abort.signal,
  );
  assert.equal(res?.result.kind, 'success');
  assert.equal(steered.length, 1);
  assert.equal(steered[0].content[0].text, '实现一个天气插件');

  // Dispose agent1, then simulate cold session resume with `Session.fromRestore` over the saved events!
  await agent1.scope.dispose();
  root.agents.live.delete(agent1.id);

  const savedEvents = session.snapshotEvents();
  const restoredSession = attachSessionEvents(
    Session.fromRestore('session-resume-1', savedEvents, session.header, 0, 'detached'),
  );
  const agent2 = {
    id: 'session-resume-1',
    session: restoredSession,
    status: 'idle',
    ctx: null,
    scope: null,
    steer() {},
  };
  agent2.scope = createScope(root, agent2);
  agent2.ctx = agent2.scope.ctx;
  root.agentPresets.presetsByAgent.set(agent2.ctx, 'standard');
  root.agents.live.set(agent2.id, agent2);

  // Fire `agent/created` serial lifecycle event just like `AgentLoop`
  await root.serial(scopeTarget(agent2, agent2), 'agent/created', {
    agent: agent2,
    source: 'resume',
    signal: abort.signal,
  });

  // Resumed agent2 automatically has Creator tools and Creator skills!
  assert.ok(root.tools.get('cordis_inspect_list', agent2) !== undefined);
  assert.ok(root.tools.get('cordis_inspect_query', agent2) !== undefined);
  assert.ok(root.tools.get('plugin_manager', agent2) !== undefined);
  const restoredSkills = await root.skills.list({ cwd: '/tmp', scope: agent2 });
  assert.ok(restoredSkills.some((s) => s.name === 'cordis-plugin-development'));
});

test('integration: /creator on standard preset preserves existing skill & plugin_manager while adding missing Creator tools & skills', async () => {
  const { root, createMockAgent, createScope, scopeTarget } = await createTestHarness();
  await root.plugin(creatorPlugin);

  const [toolSkillMod, pluginManagerToolsMod] = await Promise.all([
    importFromDsh('@deepseek-ai/dsh-tool-skill'),
    importFromDsh('@deepseek-ai/dsh-plugin-manager/tools'),
  ]);

  const standardPresetKey = {};
  const standardPresetScope = createScope(root, standardPresetKey);
  await standardPresetScope.ctx.plugin(toolSkillMod);
  await standardPresetScope.ctx.plugin(pluginManagerToolsMod);

  const { agent } = createMockAgent('session-standard-1', {
    preset: 'standard',
    parentPresetScope: standardPresetKey,
  });

  // Before `/creator`, standard agent has `skill` and `plugin_manager`, NOT `cordis_inspect_*` or Creator skills
  assert.deepEqual(
    root.tools.schemas(agent).map((s) => s.name).sort(),
    ['plugin_manager', 'skill'],
  );

  const abort = new AbortController();
  const resOn = await root.commands.execute(agent, '/creator', [], abort.signal);
  assert.equal(resOn?.result.kind, 'success');

  // After `/creator`, standard agent has all 5 Creator tools
  assert.deepEqual(
    root.tools.schemas(agent).map((s) => s.name).sort(),
    ['cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager', 'plugin_market', 'skill'],
  );

  // And standard preset's existing `dsh-tool-skill` publishes `<available_skills>` with Creator skills!
  const receiver = scopeTarget(agent, agent);
  const preStep = await root.waterfall(
    receiver,
    'agent/pre-step',
    {
      agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: abort.signal,
      modelSelection: { provider: 'deepseek', model: 'deepseek-chat' },
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
  const catalog = preStep.messages.find((m) => m.source?.kind === 'skill-catalog');
  assert.ok(catalog);
  assert.match(catalog.content[0].text, /editing-cordis-compositions/);

  // After `/creator off`, `skill` and `plugin_manager` from standard preset remain intact!
  const resOff = await root.commands.execute(agent, '/creator off', [], abort.signal);
  assert.equal(resOff?.result.kind, 'success');
  assert.deepEqual(
    root.tools.schemas(agent).map((s) => s.name).sort(),
    ['plugin_manager', 'skill'],
  );
});


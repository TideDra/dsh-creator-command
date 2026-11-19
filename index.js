import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'creator-command';
export const inject = ['agents', 'tools', 'skills', 'sessionProjections'];

const COMMAND_NAME_RE = /^[a-z][a-z0-9_-]*$/u;
const PROJECTION_KEY = 'dshCreatorCommand';
const CREATOR_SKILL_PROVIDER_NAME = 'dsh-creator-skills';
const CREATOR_TOOL_NAMES = Object.freeze([
  'skill',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'plugin_manager',
  'plugin_market',
]);

/**
 * Validate plugin configuration at load time.
 * @param {Record<string, unknown>} [rawConfig]
 */
export function resolveConfig(rawConfig = {}) {
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new TypeError('creator-command config must be a plain object');
  }
  const allowed = new Set(['commandName', 'customSkillDirs', 'includeFsTools']);
  const unknown = Object.keys(rawConfig).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `creator-command config has unknown key(s): ${unknown.join(', ')} (expected commandName, customSkillDirs, includeFsTools)`,
    );
  }

  const commandName = rawConfig.commandName ?? 'creator';
  if (typeof commandName !== 'string' || !COMMAND_NAME_RE.test(commandName)) {
    throw new TypeError(`creator-command commandName "${String(commandName)}" must match ${String(COMMAND_NAME_RE)}`);
  }

  const rawDirs = rawConfig.customSkillDirs ?? [];
  if (!Array.isArray(rawDirs) || rawDirs.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TypeError('creator-command customSkillDirs must be an array of non-empty strings');
  }

  const includeFsTools = rawConfig.includeFsTools ?? false;
  if (typeof includeFsTools !== 'boolean') {
    throw new TypeError('creator-command includeFsTools must be a boolean');
  }

  return Object.freeze({
    commandName,
    customSkillDirs: Object.freeze(rawDirs.map((dir) => resolve(dir.trim()))),
    includeFsTools,
  });
}

/**
 * Parse raw input passed after `/creator`.
 * - `""`, `"on"`, `"enable"` -> `{ kind: "on", message: "" }`
 * - `"off"`, `"disable"` -> `{ kind: "off" }`
 * - `"status"` -> `{ kind: "status" }`
 * - `<any other text>` -> `{ kind: "on", message: trimmed }`
 *
 * @param {string | undefined} rawInput
 */
export function parseCreatorCommand(rawInput) {
  const trimmed = String(rawInput ?? '').trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === '' || lower === 'on' || lower === 'enable') {
    return { kind: 'on', message: '' };
  }
  if (lower === 'off' || lower === 'disable') {
    return { kind: 'off' };
  }
  if (lower === 'status') {
    return { kind: 'status' };
  }
  return { kind: 'on', message: trimmed };
}

function getHostRequire(ctx) {
  const installAnchor = ctx?.get?.('profileContext')?.installAnchor;
  if (typeof installAnchor === 'string' && installAnchor.length > 0) {
    return createRequire(installAnchor);
  }
  const envRoot = process.env.DSH_RUNTIME_ROOT;
  if (typeof envRoot === 'string' && envRoot.length > 0) {
    return createRequire(join(envRoot, 'package.json'));
  }
  const argvAnchor = process.argv[1];
  if (typeof argvAnchor === 'string' && argvAnchor.length > 0) {
    return createRequire(argvAnchor);
  }
  return createRequire(import.meta.url);
}

function resolveFromHost(specifier, ctx) {
  const hostReq = getHostRequire(ctx);
  const anchors = [hostReq];
  for (const bridgePkg of [
    '@deepseek-ai/dsh-web-app/package.json',
    '@deepseek-ai/dsh-app-boot/package.json',
    '@deepseek-ai/dsh-base/package.json',
  ]) {
    try {
      anchors.push(createRequire(hostReq.resolve(bridgePkg)));
    } catch {}
  }
  for (const req of anchors) {
    try {
      return req.resolve(specifier);
    } catch {}
  }
  return createRequire(import.meta.url).resolve(specifier);
}

async function importDshPackage(specifier, ctx) {
  try {
    return await import(specifier);
  } catch {
    const resolved = resolveFromHost(specifier, ctx);
    return await import(pathToFileURL(resolved).href);
  }
}

function resolveBuiltinCreatorSkillsDir(ctx) {
  try {
    const presetPkgJson = resolveFromHost('@deepseek-ai/dsh-agent-preset/package.json', ctx);
    return join(dirname(presetPkgJson), 'skills');
  } catch {
    return undefined;
  }
}

function isFiberClosing(fiber) {
  // Cordis FiberState: DISPOSED = 4, UNLOADING = 5
  return fiber === undefined || fiber.state === 4 || fiber.state === 5;
}

async function quiesceFiber(fiber) {
  if (!fiber) return;
  try {
    await Promise.resolve(fiber.dispose?.());
    while (fiber.inertia !== undefined) {
      await fiber.inertia;
    }
  } catch {}
}

function currentPresetOf(ctx, agent) {
  const presets = ctx.get('agentPresets');
  return (
    presets?.composedPreset?.(agent.ctx) ??
    (agent.session ? presets?.presetForSession?.(agent.session) : undefined) ??
    agent.session?.header?.agentPreset ??
    undefined
  );
}

function isNativeCreatorPreset(ctx, agent) {
  return currentPresetOf(ctx, agent) === 'cordis';
}

function notifyClientSkillCatalog(ctx, agent) {
  const presetId = currentPresetOf(ctx, agent);
  if (typeof presetId === 'string' && presetId.length > 0) {
    try {
      ctx.emit('agent-preset/selected', agent.id, presetId);
    } catch {}
  }
}

function visibleCreatorTools(ctx, agent) {
  return CREATOR_TOOL_NAMES.filter((toolName) => ctx.tools.get(toolName, agent) !== undefined);
}

export async function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const { commandName } = config;

  const [
    { z },
    { brandString },
    { createUserMessage },
    skillFilesystemMod,
    toolSkillMod,
    toolCordisMod,
    pluginManagerToolsMod,
    pluginMarketToolsMod,
    toolFsMod,
  ] = await Promise.all([
    importDshPackage('zod', ctx),
    importDshPackage('@deepseek-ai/dsh-brand', ctx),
    importDshPackage('@deepseek-ai/dsh-llm', ctx),
    importDshPackage('@deepseek-ai/dsh-skill-filesystem', ctx),
    importDshPackage('@deepseek-ai/dsh-tool-skill', ctx),
    importDshPackage('@deepseek-ai/dsh-tool-cordis', ctx),
    importDshPackage('@deepseek-ai/dsh-plugin-manager/tools', ctx),
    importDshPackage('@deepseek-ai/dsh-plugin-market/tools', ctx),
    config.includeFsTools ? importDshPackage('@deepseek-ai/dsh-tool-fs', ctx) : Promise.resolve(null),
  ]);

  if (isFiberClosing(ctx.fiber)) return;

  const builtinCreatorSkillsDir = resolveBuiltinCreatorSkillsDir(ctx);
  const skillDirs = [
    ...(builtinCreatorSkillsDir !== undefined ? [builtinCreatorSkillsDir] : []),
    ...config.customSkillDirs,
  ];
  const uniqueSkillDirs = [...new Set(skillDirs)];

  const projectionStateSchema = z
    .object({
      active: z.boolean(),
      running: z
        .object({
          commandId: z.string(),
          nextActive: z.boolean(),
        })
        .strict()
        .nullable(),
      activeAtLastStep: z.boolean().nullable(),
    })
    .strict();

  const projectionHandle = await ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: projectionStateSchema,
    init: () => ({
      active: false,
      running: null,
      activeAtLastStep: null,
    }),
    apply(state, event) {
      if (event.type === 'command/run' && event.data?.name === commandName) {
        const parsed = parseCreatorCommand(event.data.args);
        if (parsed.kind === 'status') return state;
        const nextActive = parsed.kind === 'on';
        return {
          ...state,
          running: {
            commandId: String(event.data.commandId),
            nextActive,
          },
        };
      }
      if (
        event.type === 'command/done' &&
        state.running !== null &&
        String(event.data?.commandId) === state.running.commandId
      ) {
        if (event.data?.kind === 'success') {
          return {
            ...state,
            active: state.running.nextActive,
            running: null,
          };
        }
        return {
          ...state,
          running: null,
        };
      }
      if (event.type === 'step/start') {
        const effective = state.running?.nextActive ?? state.active;
        if (state.activeAtLastStep === effective) return state;
        return {
          ...state,
          activeAtLastStep: effective,
        };
      }
      return state;
    },
  });

  if (isFiberClosing(ctx.fiber)) return;

  let pluginDisposed = false;
  /** @type {Map<object, { fiber: any, ready: Promise<any>, addedTools: string[] }>} */
  const agentMounts = new Map();

  function effectiveActive(session) {
    const state = projectionHandle.stateOf(session);
    return state.running?.nextActive ?? state.active;
  }

  async function ensureAgentCreatorMount(agent) {
    if (pluginDisposed || !agent?.ctx || isFiberClosing(agent.ctx.fiber)) {
      return { mounted: false, addedTools: [] };
    }
    if (isNativeCreatorPreset(ctx, agent)) {
      return { mounted: false, nativeCreator: true, addedTools: [] };
    }

    const existing = agentMounts.get(agent);
    if (existing !== undefined) {
      await existing.ready;
      return { mounted: true, alreadyActive: true, addedTools: existing.addedTools };
    }

    const addedTools = [];
    const hadSkillTool = ctx.tools.get('skill', agent) !== undefined;
    const hadCordisInspect =
      ctx.tools.get('cordis_inspect_list', agent) !== undefined &&
      ctx.tools.get('cordis_inspect_query', agent) !== undefined;
    const hadPluginManager = ctx.tools.get('plugin_manager', agent) !== undefined;
    const hadPluginMarket = ctx.tools.get('plugin_market', agent) !== undefined;
    const hadReadTool =
      ctx.tools.get('read', agent) !== undefined || ctx.tools.get('read_file', agent) !== undefined;

    let fiber;
    const ready = (async () => {
      fiber = agent.ctx.plugin({
        name: 'creator-command-agent-scope',
        inject: ['tools'],
        async apply(subCtx) {
          const childFibers = [];
          const toolsSvc = subCtx.tools;

          // 1. Mount Creator mode skills (`@deepseek-ai/dsh-agent-preset/skills` + any configured dirs)
          if (uniqueSkillDirs.length > 0 && subCtx.get('skills') !== undefined) {
            childFibers.push(
              subCtx.plugin(skillFilesystemMod, {
                providerName: CREATOR_SKILL_PROVIDER_NAME,
                includeDefaultRoots: !hadSkillTool,
                watch: false,
                customSkillDirs: uniqueSkillDirs,
              }),
            );
          }

          // 2. Mount `skill` tool + durable `<available_skills>` catalog when absent on this agent
          if (
            !hadSkillTool &&
            subCtx.get('skills') !== undefined &&
            subCtx.get('workingDirectory') !== undefined &&
            subCtx.get('agents') !== undefined
          ) {
            childFibers.push(subCtx.plugin(toolSkillMod));
            addedTools.push('skill');
          }

          // 3. Mount `cordis_inspect_list` + `cordis_inspect_query`
          if (!hadCordisInspect) {
            if (subCtx.get('cordisInspect') !== undefined) {
              childFibers.push(subCtx.plugin(toolCordisMod));
              addedTools.push('cordis_inspect_list', 'cordis_inspect_query');
            } else {
              subCtx.inject(['cordisInspect'], (inspectCtx) => {
                inspectCtx.plugin(toolCordisMod);
              });
            }
          }

          // 4. Mount `plugin_manager` when running in a profile context and absent on this agent
          if (
            !hadPluginManager &&
            subCtx.get('profileContext') !== undefined &&
            subCtx.get('pluginManager') !== undefined &&
            subCtx.get('sandboxPolicy') !== undefined
          ) {
            childFibers.push(subCtx.plugin(pluginManagerToolsMod));
            addedTools.push('plugin_manager');
          }

          // 5. Mount `plugin_market` when running in a profile context and absent on this agent
          if (!hadPluginMarket && subCtx.get('profileContext') !== undefined) {
            childFibers.push(subCtx.plugin(pluginMarketToolsMod));
            if (subCtx.get('pluginMarket') !== undefined) {
              addedTools.push('plugin_market');
            }
          }

          // 6. Optional: ensure filesystem tools in presets without file read/write tools
          if (
            config.includeFsTools &&
            toolFsMod !== null &&
            !hadReadTool &&
            subCtx.get('fs') !== undefined &&
            subCtx.get('systemPrompt') !== undefined &&
            subCtx.get('workingDirectory') !== undefined
          ) {
            const addWrite =
              toolsSvc.get('write', agent) === undefined &&
              toolsSvc.get('apply_patch', agent) === undefined;
            const addEdit =
              toolsSvc.get('edit', agent) === undefined &&
              toolsSvc.get('apply_patch', agent) === undefined;
            childFibers.push(
              subCtx.plugin(toolFsMod, {
                read: true,
                readImage: toolsSvc.get('read_image', agent) === undefined,
                write: addWrite,
                edit: addEdit,
                applyPatch: false,
              }),
            );
            addedTools.push('read');
            if (addWrite) addedTools.push('write');
            if (addEdit) addedTools.push('edit');
          }

          await Promise.all(childFibers);
        },
      });

      await fiber;
    })();

    const record = { fiber: null, ready, addedTools };
    agentMounts.set(agent, record);

    // Ensure map entry cleans up when the agent itself disposes
    agent.ctx.effect(() => () => {
      if (agentMounts.get(agent) === record) {
        agentMounts.delete(agent);
      }
    }, 'creator-command: agent teardown');

    try {
      await ready;
      record.fiber = fiber;
      if (pluginDisposed || isFiberClosing(agent.ctx.fiber)) {
        agentMounts.delete(agent);
        await quiesceFiber(fiber);
        return { mounted: false, addedTools: [] };
      }
      return { mounted: true, alreadyActive: false, addedTools };
    } catch (error) {
      if (agentMounts.get(agent) === record) {
        agentMounts.delete(agent);
      }
      await quiesceFiber(fiber);
      throw error;
    }
  }

  async function disposeAgentCreatorMount(agent) {
    const existing = agentMounts.get(agent);
    if (existing === undefined) return false;
    agentMounts.delete(agent);
    await existing.ready.catch(() => {});
    await quiesceFiber(existing.fiber);
    return true;
  }

  async function listVisibleCreatorSkillNames(agent, signal) {
    try {
      const workdirSvc = ctx.get('workingDirectory');
      const cwd = workdirSvc ? await workdirSvc.ensure(agent, signal) : agent.session?.header?.cwd;
      const skills = await ctx.skills.list({ cwd, scope: agent, signal });
      const creatorSkills = skills.filter(
        (s) =>
          s.provider === CREATOR_SKILL_PROVIDER_NAME ||
          (builtinCreatorSkillsDir !== undefined &&
            s.resourceBase?.kind === 'directory' &&
            s.resourceBase.path.startsWith(builtinCreatorSkillsDir)),
      );
      return creatorSkills.map((s) => s.name);
    } catch {
      return [];
    }
  }

  // Restore Creator capabilities on resumed / forked sessions whose log has `/creator` active
  ctx.on('agent/created', async ({ agent }) => {
    if (effectiveActive(agent.session)) {
      try {
        await ensureAgentCreatorMount(agent);
      } catch (error) {
        ctx.logger.warn('creator-command: failed to restore Creator mount for session %s: %o', agent.id, error);
      }
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    agentMounts.delete(agent);
  });

  // Also reconcile any already-live agents on HMR load
  for (const agent of ctx.agents.list()) {
    if (effectiveActive(agent.session)) {
      void ensureAgentCreatorMount(agent)
        .then(() => notifyClientSkillCatalog(ctx, agent))
        .catch((error) => {
          ctx.logger.warn('creator-command: failed to sync live session %s: %o', agent.id, error);
        });
    }
  }

  // Narrate mid-session mode switches cleanly without polluting system prompt KV cache
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted || isNativeCreatorPreset(ctx, agent)) {
      return decision;
    }
    const state = projectionHandle.stateOf(agent.session);
    const currentActive = state.running?.nextActive ?? state.active;
    if (state.activeAtLastStep === null || state.activeAtLastStep === currentActive) {
      return decision;
    }
    const text = currentActive
      ? `The user enabled DSH Creator mode (/${commandName}) for this session. Creator skills and plugin/Cordis inspection tools are now available.`
      : `The user disabled DSH Creator mode (/${commandName} off) for this session. Dynamic Creator skills and tools are no longer active.`;
    const notice = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'creator-command',
        form: 'notice',
        summary: text,
      },
    });
    return {
      ...decision,
      messages: [...decision.messages, notice],
    };
  });

  // Unmount all dynamic per-agent fibers when this Host plugin unloads
  ctx.effect(() => {
    return async () => {
      pluginDisposed = true;
      const entries = [...agentMounts.entries()];
      agentMounts.clear();
      await Promise.all(
        entries.map(async ([agent, record]) => {
          await record.ready.catch(() => {});
          await quiesceFiber(record.fiber);
          notifyClientSkillCatalog(ctx, agent);
        }),
      );
    };
  }, 'creator-command: unmount agent fibers');

  // Register `/creator` slash command when `commands` service is present
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: brandString(`@local/dsh-creator-command:${commandName}`),
      name: commandName,
      description: 'Add DSH Creator mode skills and plugin/Cordis tools to this session',
      input: {
        hint: '[off|status|message]',
        attachments: true,
      },
      handler: async ({ agent, rawInput, attachments, signal }) => {
        const parsed = parseCreatorCommand(rawInput);

        if (parsed.kind === 'off') {
          if (attachments.length > 0) {
            return {
              kind: 'error',
              text: `Attachments cannot accompany /${commandName} off.`,
            };
          }
          if (isNativeCreatorPreset(ctx, agent)) {
            return {
              kind: 'error',
              text: 'This session uses the built-in Creator preset; its skills and tools belong to the preset and cannot be turned off.',
            };
          }
          const wasMounted = await disposeAgentCreatorMount(agent);
          const wasLogged = projectionHandle.stateOf(agent.session).active;
          if (wasMounted) {
            notifyClientSkillCatalog(ctx, agent);
          }
          return {
            kind: 'success',
            text:
              wasMounted || wasLogged
                ? `Creator mode off — removed dynamic Creator skills and tools.`
                : 'Creator mode is already inactive.',
          };
        }

        if (parsed.kind === 'status') {
          if (attachments.length > 0) {
            return {
              kind: 'error',
              text: `Attachments cannot accompany /${commandName} status.`,
            };
          }
          const native = isNativeCreatorPreset(ctx, agent);
          const active = native || projectionHandle.stateOf(agent.session).active || agentMounts.has(agent);
          const tools = visibleCreatorTools(ctx, agent);
          const skillNames = await listVisibleCreatorSkillNames(agent, signal);
          if (!active) {
            return {
              kind: 'success',
              text: `Creator mode is inactive in this session. Run /${commandName} to add Creator skills and tools.`,
            };
          }
          return {
            kind: 'success',
            text: [
              native
                ? 'Creator mode is active (built-in Creator preset).'
                : `Creator mode is active (enabled via /${commandName}).`,
              `Skills: ${skillNames.length > 0 ? skillNames.join(', ') : '(none)'}`,
              `Tools: ${tools.length > 0 ? tools.join(', ') : '(none)'}`,
            ].join(' | '),
          };
        }

        // `parsed.kind === 'on'` (bare `/creator`, `/creator on`, or `/creator <message>`)
        if (isNativeCreatorPreset(ctx, agent)) {
          if (parsed.message !== '' || attachments.length > 0) {
            agent.steer(
              createUserMessage({
                content: [
                  ...attachments,
                  ...(parsed.message === '' ? [] : [{ type: 'text', text: parsed.message }]),
                ],
                source: { kind: 'user' },
              }),
            );
          }
          return {
            kind: 'success',
            text: 'This session is already in Creator mode — Creator skills and tools are active.',
          };
        }

        const mountOutcome = await ensureAgentCreatorMount(agent);
        notifyClientSkillCatalog(ctx, agent);

        const tools = visibleCreatorTools(ctx, agent);
        const skillNames = await listVisibleCreatorSkillNames(agent, signal);

        if (parsed.message !== '' || attachments.length > 0) {
          agent.steer(
            createUserMessage({
              content: [
                ...attachments,
                ...(parsed.message === '' ? [] : [{ type: 'text', text: parsed.message }]),
              ],
              source: { kind: 'user' },
            }),
          );
        }

        const skillsLabel = skillNames.length > 0 ? skillNames.join(', ') : 'none';
        const toolsLabel = tools.length > 0 ? tools.join(', ') : 'none';

        return {
          kind: 'success',
          text: mountOutcome.alreadyActive
            ? `Creator mode is already active (skills: ${skillsLabel}; tools: ${toolsLabel}). Use /${commandName} off to disable.`
            : `Creator mode enabled — skills: ${skillsLabel}; tools: ${toolsLabel}. Use /${commandName} off to disable.`,
        };
      },
    });
  });
}

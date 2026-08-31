#!/usr/bin/env node
// MCP server that never touches a project's files or a browser itself -- every operation is
// forwarded over the bridge (bridge.js) to an already-connected side panel, which performs it
// (File System Access API for data CRUD, its own live chrome.debugger session for replay) and
// reports back. This process is a thin relay: it holds no fs adapter and spawns no browser/test
// process of its own, so an assistant connected via MCP can only ever ask the extension to do
// something, never do that thing in its place.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');
const { startBridgeServer } = require('./bridge.js');

// Ported from lib/codegen.js's own extractPoParams (easy-spec-extension) -- everything else in
// that file is code generation this server never runs (the panel writes its own files), so it
// isn't worth pulling in as a dependency just for this one regex scan.
function extractPoParams(selector) {
  const s = String(selector ?? '');
  const re = /\$\{([^}]*)\}/g;
  const params = [];
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return { params: [], error: `Parameter "\${${m[1]}}" must be a plain name, not an expression.` };
    if (!params.includes(name)) params.push(name);
  }
  return { params, error: null };
}

// This process both hosts the live bridge (see bridge.js) and is the one place every
// file-based tool below resolves its target project -- so a connected side panel is reachable
// in-process, no network hop needed the way a short-lived CLI invocation's best-effort ping is.
// startBridgeServer is async now (see its own comment -- it retries across a small port range
// instead of crashing when another agent's MCP server already owns the default one), so `bridge`
// itself isn't assigned until main() awaits it below, before the transport ever connects -- every
// tool handler that closes over `bridge` only ever runs after that, once a client can actually
// reach this server at all.
let bridge;

// Every tool takes `project` (an absolute or cwd-relative path to an Easy Spec - Playwright
// project root -- the same folder the side panel's "Connect Folder" points at), falling back to
// EASYSPEC_PROJECT when omitted -- set that once wherever this server is registered and every tool
// call can omit `project` entirely.
const projectArg = {
  project: z.string().optional().describe('Path to the project root (same folder the side panel connects to). Defaults to the EASYSPEC_PROJECT environment variable if omitted.'),
};

// Sibling of projectArg for the live_* tools specifically (see bridge.js's sendRequest) --
// disambiguates WHICH connected side panel to target when more than one is connected to the same
// project (see sidepanel.js's SESSION_NAME / live_status's own "sessions" list for the names).
const liveArg = {
  ...projectArg,
  session: z.string().optional().describe('Which connected side panel to target, by its short session name (e.g. "eager-beaver", see live_status) -- only needed when more than one side panel is connected to the same project.'),
};

function soleConnectedName() {
  const names = bridge.connectedProjectNames();
  return names.length === 1 ? names[0] : null;
}

// Forwards one ProjectCore method call over the bridge to the one connected side panel, which
// runs it against its own live instance (see sidepanel.js's handleBridgeProjectOp) -- same class,
// same method, just executing in the browser instead of this process.
async function bridgeCall(liveName, method, args) {
  const { ok, value, error } = await bridge.sendRequest(liveName, 'projectOp', { method, args });
  if (!ok) throw new Error(error || `${method} failed`);
  return value;
}

// Resolves `project` to a proxy with ProjectCore's exact method surface, every call forwarded
// over the bridge to a live, already-connected side panel (matched by folder *name*, the only
// identity a browser FileSystemDirectoryHandle can ever expose -- see bridge.js's own
// comment). This server holds no fs adapter of its own and never reads a project's files
// directly -- with no matching panel connected, there is nothing this can fall back to, so it
// throws instead.
async function resolveCore(project) {
  const dir = project || process.env.EASYSPEC_PROJECT || null;
  const liveName = dir ? path.basename(path.resolve(dir)) : soleConnectedName();
  if (liveName && bridge.connectedProjectNames().includes(liveName)) {
    return new Proxy({}, {
      get(_, prop) {
        // 'then'/symbols must resolve to undefined, not a callable -- otherwise `await
        // resolveCore(...)` treats this proxy as a thenable and "assimilates" it, calling
        // proxy.then(resolve, reject) as if `then` were a real ProjectCore method.
        if (prop === 'then' || typeof prop !== 'string') return undefined;
        return (...args) => bridgeCall(liveName, prop, args);
      },
    });
  }
  throw new Error('No project specified, or no side panel is connected for it -- pass `project`, set EASYSPEC_PROJECT, or open the extension and connect a folder (check with live_status). This server never reads project files itself; every operation is forwarded to a connected side panel.');
}

// The live_* tools below route through the bridge to an already-connected side panel, which
// identifies itself purely by folder *name* (see bridge.js's own comment: a browser
// FileSystemDirectoryHandle exposes no real filesystem path, not even to the extension itself --
// a name is genuinely the most either side can know). That means, unlike resolveCore above (which
// still accepts a `project` path so a caller can name a folder that isn't connected yet), these
// tools CAN resolve `project` straight from the extension when it's omitted: no path is needed,
// just asking the one connected side panel who it is.
//
// `session`, when given, resolves straight from THAT panel's own project name and skips the
// project-name ambiguity check below entirely -- otherwise a caller who already knows exactly
// which session it wants (e.g. two panels both named "test", disambiguated by session alone)
// would still hit "multiple side panels connected" here before sendRequest's OWN session
// filtering (bridge.js) ever got a chance to run, since this always resolves first.
// There's no per-request signing anymore -- the side panel gates every live_* action on a human
// having clicked Approve on this specific connection (see sidepanel.js's bridgePending/
// bridgeTrusted), not on anything this server sends.
function resolveLiveProject(project, session) {
  if (session) {
    const match = bridge.connectedSessions().find((s) => s.sessionName === session);
    if (!match) {
      const available = bridge.connectedSessions().map((s) => s.sessionName || '(unnamed)').join(', ') || '(none connected)';
      throw new Error(`No side panel named "${session}" is connected. Connected: ${available}`);
    }
    return match.projectName;
  }
  if (project) return project;
  if (process.env.EASYSPEC_PROJECT) return process.env.EASYSPEC_PROJECT;
  const connected = bridge.connectedProjectNames();
  if (connected.length === 1) return connected[0];
  if (connected.length > 1) {
    throw new Error(`Multiple side panels are connected (${connected.join(', ')}) -- pass \`project\` or \`session\` to say which one.`);
  }
  throw new Error('No project specified, EASYSPEC_PROJECT is not set, and no side panel is connected -- pass `project`, set EASYSPEC_PROJECT, or open the extension and connect a folder (check with live_status).');
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function textResult(text) {
  return { content: [{ type: 'text', text }] };
}
function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}
// Wraps a handler so any thrown error becomes an MCP tool error result instead of crashing the
// server process -- one place for this instead of a try/catch repeated in every tool below.
function safe(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

const server = new McpServer({ name: 'playwright-easy-spec', version: '1.0.0' });

// ---------- inspection ----------

server.registerTool(
  'list_flows',
  { description: 'List flows in a project (id, name, folder, step count).', inputSchema: projectArg },
  safe(async ({ project }) => {
    const core = await resolveCore(project);
    const ids = await core.listFlowIds();
    const out = [];
    for (const id of ids) {
      const f = await core.loadFlow(id);
      out.push({ id, name: f.name, folder: f.folder || '', steps: f.steps.length });
    }
    return jsonResult(out);
  })
);

server.registerTool(
  'list_scenarios',
  { description: 'List scenarios in a project (id, name, folder, composed flow count).', inputSchema: projectArg },
  safe(async ({ project }) => {
    const core = await resolveCore(project);
    const ids = await core.listScenarioIds();
    const out = [];
    for (const id of ids) {
      const s = await core.loadScenario(id);
      out.push({ id, name: s.name, folder: s.folder || '', flows: s.flows.length });
    }
    return jsonResult(out);
  })
);

server.registerTool(
  'list_page_objects',
  { description: 'List page objects in a project (name, folder, locator count).', inputSchema: projectArg },
  safe(async ({ project }) => {
    const core = await resolveCore(project);
    const names = await core.listPageObjectNames();
    const out = [];
    for (const name of names) {
      const po = await core.loadPageObject(name);
      out.push({ name, folder: po.folder || '', locators: Object.keys(po.methods || {}).length });
    }
    return jsonResult(out);
  })
);

server.registerTool(
  'get_variables',
  { description: 'Get all global variables (Variables tab) for a project.', inputSchema: projectArg },
  safe(async ({ project }) => jsonResult(await (await resolveCore(project)).loadVariables()))
);

server.registerTool(
  'get_flow',
  { description: 'Get a flow\'s full definition, including every step.', inputSchema: { ...projectArg, flowId: z.string() } },
  safe(async ({ project, flowId }) => jsonResult(await (await resolveCore(project)).requireFlow(flowId)))
);

server.registerTool(
  'get_scenario',
  { description: 'Get a scenario\'s full definition (the flows it composes and their params).', inputSchema: { ...projectArg, scenarioId: z.string() } },
  safe(async ({ project, scenarioId }) => jsonResult(await (await resolveCore(project)).requireScenario(scenarioId)))
);

server.registerTool(
  'get_page_object',
  {
    description: 'Get a page object\'s locators. Each locator shows its inferred parameters (from ${...} in its selector, see extractPoParams) alongside the raw selector.',
    inputSchema: { ...projectArg, name: z.string() },
  },
  safe(async ({ project, name }) => {
    const core = await resolveCore(project);
    const po = await core.loadPageObject(name);
    if (!po) throw new Error(`Page object "${name}" not found.`);
    const locators = Object.fromEntries(
      Object.entries(po.methods || {}).map(([method, selector]) => [method, { selector, params: extractPoParams(selector).params }])
    );
    return jsonResult({ name: po.name, folder: po.folder || '', locators });
  })
);

// ---------- flow authoring ----------

server.registerTool(
  'create_flow',
  {
    description: 'Create a new, empty flow.',
    inputSchema: { ...projectArg, name: z.string(), id: z.string().optional(), folder: z.string().optional(), description: z.string().optional() },
  },
  safe(async ({ project, ...rest }) => jsonResult(await (await resolveCore(project)).createFlow(rest)))
);

server.registerTool(
  'delete_flow',
  { description: 'Delete a flow (its .flow.json, .flow.ts, and flowData.ts).', inputSchema: { ...projectArg, flowId: z.string() } },
  safe(async ({ project, flowId }) => {
    await (await resolveCore(project)).deleteFlow(flowId);
    return textResult(`Deleted flow "${flowId}".`);
  })
);

server.registerTool(
  'set_flow_meta',
  {
    description: 'Update a flow\'s name, folder, and/or description.',
    inputSchema: { ...projectArg, flowId: z.string(), name: z.string().optional(), folder: z.string().optional(), description: z.string().optional() },
  },
  safe(async ({ project, flowId, ...patch }) => jsonResult(await (await resolveCore(project)).setFlowMeta(flowId, patch)))
);

// A step's shape mirrors sidepanel.js's own step schema exactly (see actionRegistry.js/codegen.js)
// -- kind + method + (selector | pageObjectName/pageObjectMethod/pageObjectArgs | elementAlias) +
// args + options, with kind-specific extra fields for control flow. Passed through as a single
// JSON object rather than one Zod field per possible key, since which keys are meaningful depends
// entirely on `kind` (this mirrors how the step editor's own form shows/hides fields by kind).
const stepSchema = z.object({}).passthrough().describe(
  'A step object: { kind, method, selector?, pageObjectName?, pageObjectMethod?, pageObjectArgs?, ' +
  'elementAlias?, args?, options?, negate?, variable?, condition?, init?, update?, steps?, ' +
  'iterableName?, itemVarName? } -- same shape as a flow.json step; see get_flow on an existing ' +
  'flow for real examples of each kind.'
);

server.registerTool(
  'add_step',
  {
    description: 'Add a step to a flow, at the end by default. Use parentPath to insert into a Conditional/Repeat/Iterate step\'s own nested body.',
    inputSchema: { ...projectArg, flowId: z.string(), step: stepSchema, at: z.number().optional(), parentPath: z.string().optional() },
  },
  safe(async ({ project, flowId, step, at, parentPath }) => {
    const { index } = await (await resolveCore(project)).addStep(flowId, step, { at, parentPath });
    return textResult(`Added step at index ${index}.`);
  })
);

server.registerTool(
  'add_multiple_steps',
  {
    description:
      'Add a whole ordered batch of steps to a flow in one call/one undo entry -- same placement rules as ' +
      'add_step (end of the array by default, parentPath for a Conditional/Repeat/Iterate body), but avoids ' +
      'an add_step-per-step round trip when recording several steps at once, e.g. from a live exploration ' +
      'session where each live_run_step action gets a matching recorded step.',
    inputSchema: { ...projectArg, flowId: z.string(), steps: z.array(stepSchema), at: z.number().optional(), parentPath: z.string().optional() },
  },
  safe(async ({ project, flowId, steps, at, parentPath }) => {
    const { index, count } = await (await resolveCore(project)).addSteps(flowId, steps, { at, parentPath });
    return textResult(`Added ${count} step(s) starting at index ${index}.`);
  })
);

server.registerTool(
  'update_step',
  {
    description: 'Patch fields on an existing step. `stepPath` is dot-separated indices into nested .steps arrays, e.g. "2.0" is the 1st step inside the 3rd top-level step\'s own body.',
    inputSchema: { ...projectArg, flowId: z.string(), stepPath: z.string(), patch: stepSchema },
  },
  safe(async ({ project, flowId, stepPath, patch }) => jsonResult(await (await resolveCore(project)).updateStep(flowId, stepPath, patch)))
);

server.registerTool(
  'remove_step',
  { description: 'Remove a step by its path.', inputSchema: { ...projectArg, flowId: z.string(), stepPath: z.string() } },
  safe(async ({ project, flowId, stepPath }) => jsonResult(await (await resolveCore(project)).removeStep(flowId, stepPath)))
);

server.registerTool(
  'copy_steps',
  {
    description:
      'Copies a contiguous run of steps [from, to] (inclusive, 0-based indices within ' +
      'sourceParentPath\'s own array) from one flow into another flow -- or the same flow, for a ' +
      'reorder-via-copy. Deep-cloned (nested Conditional/Repeat/Iterate bodies come along intact). ' +
      'One undo entry, on the target flow only -- the source is never modified. Splitting a flow ' +
      'into two, or reusing a chunk of steps another flow already has, is one call instead of ' +
      'reading every step and re-adding each one by hand.',
    inputSchema: {
      ...projectArg,
      sourceFlowId: z.string(),
      from: z.number().describe('First step index to copy (0-based, inclusive)'),
      to: z.number().describe('Last step index to copy (0-based, inclusive) -- same as `from` to copy a single step'),
      sourceParentPath: z.string().optional().describe('Step path into a Conditional/Repeat/Iterate body to copy from, instead of the flow\'s top level'),
      targetFlowId: z.string().describe('May be the same as sourceFlowId'),
      targetParentPath: z.string().optional().describe('Step path into a Conditional/Repeat/Iterate body to copy into, instead of the flow\'s top level'),
      at: z.number().optional().describe('Index to insert at in the target array -- default appends to the end'),
    },
  },
  safe(async ({ project, sourceFlowId, from, to, sourceParentPath, targetFlowId, targetParentPath, at }) => {
    const core = await resolveCore(project);
    const result = await core.copySteps(sourceFlowId, from, to, targetFlowId, { sourceParentPath, targetParentPath, at });
    return textResult(`Copied ${result.copiedCount} step(s) into "${targetFlowId}" at index ${result.at}.`);
  })
);

server.registerTool(
  'set_flow_dataset',
  {
    description: 'Add or replace a named flow-data dataset (a set of param values a flow can run with -- the Flow editor\'s "Flow Data" tab).',
    inputSchema: { ...projectArg, flowId: z.string(), name: z.string(), value: z.record(z.string(), z.any()) },
  },
  safe(async ({ project, flowId, name, value }) => jsonResult(await (await resolveCore(project)).setFlowDataset(flowId, name, value)))
);

server.registerTool(
  'remove_flow_dataset',
  { description: 'Remove a named flow-data dataset.', inputSchema: { ...projectArg, flowId: z.string(), name: z.string() } },
  safe(async ({ project, flowId, name }) => jsonResult(await (await resolveCore(project)).removeFlowDataset(flowId, name)))
);

server.registerTool(
  'set_state_var',
  {
    description: 'Add or replace a flow-scoped state variable (a `let` declared at the top of the generated function).',
    inputSchema: { ...projectArg, flowId: z.string(), name: z.string(), initial: z.any() },
  },
  safe(async ({ project, flowId, name, initial }) => jsonResult(await (await resolveCore(project)).setStateVar(flowId, name, initial)))
);

server.registerTool(
  'remove_state_var',
  { description: 'Remove a flow-scoped state variable.', inputSchema: { ...projectArg, flowId: z.string(), name: z.string() } },
  safe(async ({ project, flowId, name }) => jsonResult(await (await resolveCore(project)).removeStateVar(flowId, name)))
);

server.registerTool(
  'set_output_field',
  {
    description: 'Add or replace one of a flow\'s output-data fields (what it returns to a scenario that composes it).',
    inputSchema: { ...projectArg, flowId: z.string(), name: z.string(), default: z.any() },
  },
  safe(async ({ project, flowId, name, default: defaultValue }) => jsonResult(await (await resolveCore(project)).setOutputField(flowId, name, defaultValue)))
);

server.registerTool(
  'remove_output_field',
  { description: 'Remove one of a flow\'s output-data fields.', inputSchema: { ...projectArg, flowId: z.string(), name: z.string() } },
  safe(async ({ project, flowId, name }) => jsonResult(await (await resolveCore(project)).removeOutputField(flowId, name)))
);

// ---------- page objects ----------

server.registerTool(
  'create_page_object',
  { description: 'Create a new, empty page object.', inputSchema: { ...projectArg, name: z.string(), folder: z.string().optional() } },
  safe(async ({ project, name, folder }) => jsonResult(await (await resolveCore(project)).createPageObject(name, folder)))
);

server.registerTool(
  'delete_page_object',
  { description: 'Delete a page object (fails if any flow step still binds to it via its own persistPageObject usage -- check get_flow first).', inputSchema: { ...projectArg, name: z.string() } },
  safe(async ({ project, name }) => {
    await (await resolveCore(project)).deletePageObject(name);
    return textResult(`Deleted page object "${name}".`);
  })
);

server.registerTool(
  'set_locator',
  {
    description: 'Add or replace a locator on a page object. A selector containing ${paramName} blocks (bare names only, not expressions) becomes a parametric method automatically -- see extractPoParams.',
    inputSchema: { ...projectArg, pageObject: z.string(), method: z.string(), selector: z.string() },
  },
  safe(async ({ project, pageObject, method, selector }) => jsonResult(await (await resolveCore(project)).setLocator(pageObject, method, selector)))
);

server.registerTool(
  'remove_locator',
  { description: 'Remove a locator from a page object.', inputSchema: { ...projectArg, pageObject: z.string(), method: z.string() } },
  safe(async ({ project, pageObject, method }) => {
    await (await resolveCore(project)).removeLocator(pageObject, method);
    return textResult(`Removed locator "${method}" from "${pageObject}".`);
  })
);

// ---------- scenarios ----------

server.registerTool(
  'create_scenario',
  {
    description: 'Create a new, empty scenario.',
    inputSchema: { ...projectArg, name: z.string(), id: z.string().optional(), folder: z.string().optional(), description: z.string().optional() },
  },
  safe(async ({ project, ...rest }) => jsonResult(await (await resolveCore(project)).createScenario(rest)))
);

server.registerTool(
  'delete_scenario',
  { description: 'Delete a scenario.', inputSchema: { ...projectArg, scenarioId: z.string() } },
  safe(async ({ project, scenarioId }) => {
    await (await resolveCore(project)).deleteScenario(scenarioId);
    return textResult(`Deleted scenario "${scenarioId}".`);
  })
);

server.registerTool(
  'add_flow_to_scenario',
  {
    description:
      'Append a flow OR another already-saved scenario to a scenario\'s composed sequence, as a ' +
      'RUN CONFIG -- the exact same dataset-tokens/raw-YAML pair live_replay_flow\'s own ' +
      '`dataset`/`params` resolve, not a per-field override map. Pass exactly one of `flowId` ' +
      '(the common case) or `composeScenarioId` (compose another scenario instead -- both are ' +
      'plain functions now, so calling one from another is no different from calling a flow; ' +
      'rejected if it would create a composition cycle, directly or transitively). ' +
      '`datasetTokens` is a comma/space-separated list of the target\'s own dataset indices/names ' +
      '(blank = its first/default dataset); naming more than one makes this ONE entry run its ' +
      'target multiple times in sequence, right here in the scenario. `useYaml`+`yaml` is the raw ' +
      'fallback for a one-off value not worth saving as a named dataset -- a YAML/JSON object (one ' +
      'run), or a list of objects (one run per entry), each used as the target\'s own params ' +
      'directly (`yaml` is ignored unless `useYaml` is also true). `postprocess` is an expression ' +
      'evaluated over EACH resolved run\'s own params object right before it fires, receiving ' +
      '`params` (that run\'s own object) plus every other name already in scope (global variables, ' +
      'this scenario\'s own dataset fields, and any EARLIER entry\'s own captured output) -- ' +
      'expected to return the (possibly modified) whole params object; only meaningful for ' +
      'live_replay_scenario/live_start_scenario_run, evaluated in the connected tab\'s own page ' +
      'context. Output capture is automatic, not an opt-in field here, and only ever applies to a ' +
      'FLOW target: when it declares output fields (set_output_field) and populates its own `out` ' +
      'object via a setVariable step, that output becomes a scenario-scoped variable every LATER ' +
      'entry can reference by name -- `<camelCase flow name>Output` (a numeric suffix added only ' +
      'if this scenario references the same flow more than once), holding a single value normally, ' +
      'or an array of every run\'s own output if this entry resolved to more than one run. A ' +
      'composed-scenario entry never captures output -- scenarios don\'t declare an output shape.',
    inputSchema: {
      ...projectArg,
      scenarioId: z.string(),
      flowId: z.string().optional(),
      composeScenarioId: z.string().optional(),
      datasetTokens: z.string().optional(),
      useYaml: z.boolean().optional(),
      yaml: z.string().optional(),
      postprocess: z.string().optional(),
    },
  },
  safe(async ({ project, scenarioId, flowId, composeScenarioId, datasetTokens, useYaml, yaml, postprocess }) => {
    if (!flowId === !composeScenarioId) {
      throw new Error('Pass exactly one of `flowId` or `composeScenarioId`.');
    }
    return jsonResult(await (await resolveCore(project)).addFlowToScenario(scenarioId, flowId, { scenarioId: composeScenarioId, datasetTokens, useYaml, yaml, postprocess }));
  })
);

server.registerTool(
  'remove_flow_from_scenario',
  { description: 'Remove one of a scenario\'s composed flows by its index.', inputSchema: { ...projectArg, scenarioId: z.string(), index: z.number() } },
  safe(async ({ project, scenarioId, index }) => jsonResult(await (await resolveCore(project)).removeFlowFromScenario(scenarioId, index)))
);

server.registerTool(
  'set_scenario_dataset',
  {
    description: 'Add or replace a named scenario-data dataset (a set of scenario-level param values, referenceable from any flow entry\'s own params/postprocess expressions) -- mirrors set_flow_dataset one level up.',
    inputSchema: { ...projectArg, scenarioId: z.string(), name: z.string(), value: z.record(z.string(), z.any()) },
  },
  safe(async ({ project, scenarioId, name, value }) => jsonResult(await (await resolveCore(project)).setScenarioDataset(scenarioId, name, value)))
);

server.registerTool(
  'remove_scenario_dataset',
  { description: 'Remove a named scenario-data dataset.', inputSchema: { ...projectArg, scenarioId: z.string(), name: z.string() } },
  safe(async ({ project, scenarioId, name }) => jsonResult(await (await resolveCore(project)).removeScenarioDataset(scenarioId, name)))
);

// ---------- variables ----------

server.registerTool(
  'set_variable',
  { description: 'Set a global variable (Variables tab).', inputSchema: { ...projectArg, name: z.string(), value: z.any() } },
  safe(async ({ project, name, value }) => jsonResult(await (await resolveCore(project)).setVariable(name, value)))
);

server.registerTool(
  'unset_variable',
  { description: 'Remove a global variable.', inputSchema: { ...projectArg, name: z.string() } },
  safe(async ({ project, name }) => jsonResult(await (await resolveCore(project)).unsetVariable(name)))
);

// ---------- live (requires the side panel open and connected to the same project) ----------
// These drive the side panel's own real chrome.debugger session in the user's actual tab -- see
// bridge.js and sidepanel.js's connectBridge/handleBridgeMessage. Each fails fast with a clear
// message if no side panel is connected (or more than one is) for this project. `project` can be
// omitted on all of these (see resolveLiveProject above) when exactly one side panel is connected
// -- call live_status first to check.

server.registerTool(
  'live_status',
  {
    description:
      'List which projects currently have a side panel connected to this bridge (by folder name -- ' +
      'call this to see what\'s available to target, e.g. before omitting `project` on another live_* tool). ' +
      '`agentName` is THIS server\'s own stable name (e.g. "claude-1", tied to its port slot, not random) -- shown in the ' +
      'side panel\'s pending-connection list when it asks the user to approve this agent, so telling the ' +
      'user this name lets them confirm which pending entry to click Approve on. `sessions` gives each ' +
      'connected panel\'s own short random name (e.g. "eager-beaver") -- only relevant once more than one ' +
      'panel has approved THIS agent at once; pass one as `session` on another live_* tool to target it ' +
      'specifically instead of hitting the "more than one side panel connected" ambiguity error.',
    inputSchema: {},
  },
  safe(() => jsonResult({ connectedProjects: bridge.connectedProjectNames(), sessions: bridge.connectedSessions(), agentName: bridge.agentName }))
);

server.registerTool(
  'live_replay_flow',
  {
    description:
      'Replay a single flow live, in the side panel\'s own connected browser tab (real chrome.debugger, ' +
      'the user\'s real session/login) -- requires the side panel open and connected to this project. ' +
      'Targets whichever tab is pinned in the side panel\'s header, or the browser\'s actual active tab ' +
      'if none is pinned.',
    inputSchema: {
      ...liveArg,
      flowId: z.string(),
      params: z.record(z.string(), z.any()).optional(),
      dataset: z.string().optional().describe('Name of an existing flow-data dataset to use as the base params'),
    },
  },
  safe(async ({ project, session, flowId, params, dataset }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'replay', { flowId, params, dataset }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Replay failed.');
    return textResult('Replay passed.');
  })
);

server.registerTool(
  'live_run_step_range',
  {
    description:
      'Runs a contiguous [from, to] slice of an already-SAVED flow\'s own top-level steps live, as a ' +
      'real tracked Run (shows up in the Runs tab with live per-step status dots, same as ' +
      'live_replay_flow/live_start_run) -- for re-verifying just the steps you just added/changed ' +
      'instead of a full live_replay_flow from step 0 every time. Context is seeded the same way a ' +
      'fresh replay\'s first iteration would be (the chosen dataset/params -- or the flow\'s own ' +
      'first/default dataset if neither is given -- plus state-var defaults), since a mid-flow slice ' +
      'has no prior-steps history to inherit values from otherwise: if the steps in range reference a ' +
      'param/state-var, pass a `dataset` (or `params`) that actually defines it, or the slice will see ' +
      'it as undefined even though a full replay from step 0 would have set it correctly by this ' +
      'point. `results` has one entry per step actually attempted (stops at the first failure, same as ' +
      'a full replay) with its 0-based index in the flow\'s own step list. Blocks until the slice ' +
      'finishes (or fails) and moves from the Runs tab\'s current list to its history, same as ' +
      'live_replay_flow. Requires the side panel open and connected.',
    inputSchema: {
      ...liveArg,
      flowId: z.string(),
      from: z.number().describe('First step index to run (0-based, inclusive)'),
      to: z.number().describe('Last step index to run (0-based, inclusive)'),
      params: z.record(z.string(), z.any()).optional(),
      dataset: z.string().optional().describe('Name of an existing flow-data dataset to use as the base params'),
    },
  },
  safe(async ({ project, session, flowId, from, to, params, dataset }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'runStepRange', { flowId, from, to, params, dataset }, undefined, session);
    if (!result.ok && !result.results) throw new Error(result.error || 'Run failed.');
    return jsonResult({ ok: result.ok, results: result.results, runId: result.runId, name: result.name });
  })
);

server.registerTool(
  'live_pick_element',
  {
    description:
      'Starts the element picker on the side panel\'s target tab (the pinned tab, or the active tab if ' +
      'none is pinned) and waits (up to 2 minutes) for the user to click something, returning the ' +
      'resulting selector and its variants -- the same picker the step editor\'s "Pick element" button ' +
      'uses. Requires the side panel open and connected.',
    inputSchema: liveArg,
  },
  safe(async ({ project, session }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'pickElement', {}, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Pick failed.');
    return jsonResult(result);
  })
);

server.registerTool(
  'live_run_step',
  {
    description:
      'Runs one plain step (locator/page/assert/variable -- not a Conditional/Repeat/Iterate) live ' +
      'against the side panel\'s target tab (the pinned tab, or the active tab if none is pinned), the ' +
      'same way a step\'s own Play button would, and returns its result: `capturedValue` for a ' +
      '`variable` step, and generically `returnValue` -- whatever the underlying Playwright call ' +
      'itself returned (e.g. `{kind:"locator", method:"count", selector:"li.item"}` or ' +
      '`{kind:"page", method:"title"}`), not just the fixed capture trio. Useful for trying one ' +
      'action, or reading one piece of page state, without building a whole flow first. Requires ' +
      'the side panel open and connected.',
    inputSchema: { ...liveArg, step: stepSchema },
  },
  safe(async ({ project, session, step }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'runStep', { step }, undefined, session);
    return jsonResult(result);
  })
);

server.registerTool(
  'live_run_multiple_steps',
  {
    description:
      'Runs a whole ordered sequence of plain steps (locator/page/assert/variable -- not ' +
      'Conditional/Repeat/Iterate) live against the side panel\'s target tab in one call, sharing one ' +
      'variable context across them (so a `variable` step\'s captured value can feed a later step\'s own ' +
      'expression arg, same as inside a real flow). Stops at the first failing step, same as a real flow ' +
      'would -- `results` has one entry per step actually attempted, so a shorter `results` than the ' +
      'input `steps` tells you where it stopped. Prefer this over several live_run_step calls back to ' +
      'back when the sequence is already decided (e.g. open a dropdown, then pick an option) -- one MCP ' +
      'round trip instead of one per step, and the tab stays claimed for the whole sequence instead of ' +
      'being released and re-claimed between each action. Requires the side panel open and connected.',
    inputSchema: { ...liveArg, steps: z.array(stepSchema) },
  },
  safe(async ({ project, session, steps }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'runSteps', { steps }, undefined, session);
    return jsonResult(result);
  })
);

server.registerTool(
  'live_snapshot',
  {
    description:
      'Accessibility (ARIA) snapshot of the side panel\'s target tab (the pinned tab, or the active ' +
      'tab if none is pinned) -- a text tree of roles/names/values (the same format Playwright\'s own ' +
      'tooling uses), the fastest way to "see" the page well enough to find a selector for ' +
      'live_run_step/add_step without a screenshot. Requires the side panel open and connected.',
    inputSchema: { ...liveArg, selector: z.string().optional().describe('Playwright selector to scope the snapshot to -- default "body" (the whole page)') },
  },
  safe(async ({ project, session, selector }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'snapshot', { selector }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Snapshot failed.');
    return textResult(result.snapshot);
  })
);

server.registerTool(
  'live_screenshot',
  {
    description:
      'JPEG screenshot of the side panel\'s target tab (the pinned tab, or the active tab if none is ' +
      'pinned). Prefer live_snapshot for finding a selector to act on -- reach for this when the ' +
      'question is genuinely visual (layout, colors, whether something rendered). Requires the side ' +
      'panel open and connected.',
    inputSchema: {
      ...liveArg,
      fullPage: z.boolean().optional().describe('Capture the full scrollable page instead of just the viewport'),
      quality: z.number().min(1).max(100).optional().describe('JPEG quality 1-100, default 60'),
    },
  },
  safe(async ({ project, session, fullPage, quality }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'screenshot', { fullPage, quality }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Screenshot failed.');
    return { content: [{ type: 'image', data: result.base64, mimeType: result.mimeType }] };
  })
);

// ---------- runs (non-blocking sibling of live_replay_flow -- see sidepanel.js's own "runs"
// section: a Run is isolated to the tab it started on, at most one per tab, tracked with live
// per-step status) ----------

server.registerTool(
  'live_start_run',
  {
    description:
      'Starts a flow running live on the side panel\'s target tab (the pinned tab, or the active ' +
      'tab if none is pinned) and returns immediately with a `runId` -- unlike live_replay_flow, ' +
      'this does NOT wait for the run to finish. Poll live_get_run (or live_list_runs) with the ' +
      'returned runId to check progress/outcome. Fails fast if that tab already has a run or ' +
      'single-step Play active (one at a time per tab -- see live_cancel_run to free it up). ' +
      'Requires the side panel open and connected.',
    inputSchema: {
      ...liveArg,
      flowId: z.string(),
      params: z.record(z.string(), z.any()).optional(),
      dataset: z.string().optional().describe('Name of an existing flow-data dataset to use as the base params'),
    },
  },
  safe(async ({ project, session, flowId, params, dataset }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'startRun', { flowId, params, dataset }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to start run.');
    return jsonResult({ runId: result.runId, name: result.name, tabId: result.tabId });
  })
);

server.registerTool(
  'live_list_runs',
  {
    description:
      'Lists runs on the connected side panel: `current` (still running, one per tab) and ' +
      '`history` (finished/cancelled this session, most recent first, capped at 30). Each entry is ' +
      'a summary (id, name, flowId, tabId, status, step counts) -- use live_get_run for one run\'s ' +
      'full per-step detail. Safe to poll repeatedly.',
    inputSchema: liveArg,
  },
  safe(async ({ project, session }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'listRuns', {}, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to list runs.');
    return jsonResult({ current: result.current, history: result.history });
  })
);

server.registerTool(
  'live_get_run',
  {
    description:
      'Full detail for one run started via live_start_run (or live_replay_flow) by its `runId` -- ' +
      'status, and every step\'s own status (pending/running/passed/failed/skipped) plus the error ' +
      'for a failed one. This is the actual "did it work, and if not where" answer after ' +
      'live_start_run returns. Works for both a still-running and an already-finished run.',
    inputSchema: { ...liveArg, runId: z.string() },
  },
  safe(async ({ project, session, runId }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'getRun', { runId }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to get run.');
    return jsonResult(result.run);
  })
);

server.registerTool(
  'live_cancel_run',
  {
    description:
      'Cancels a still-running run by its `runId` (same effect as the Replay section\'s or Runs ' +
      'tab\'s own Cancel button) -- force-detaches that run\'s own target tab so an in-flight step ' +
      'stops immediately instead of running to its own timeout. Independent of whichever tab is ' +
      'currently pinned/active.',
    inputSchema: { ...liveArg, runId: z.string() },
  },
  safe(async ({ project, session, runId }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'cancelRun', { runId }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to cancel run.');
    return textResult(`Run "${runId}" cancelled.`);
  })
);

server.registerTool(
  'live_replay_scenario',
  {
    description:
      'Replay a whole scenario live -- runs its composed flows strictly sequentially, in the side ' +
      'panel\'s own connected browser tab (real chrome.debugger, the user\'s real session/login), ' +
      'stopping at the first flow that fails, exactly like a single flow stops at its first failing ' +
      'step. A flow entry whose flow declares output (see add_flow_to_scenario) automatically has ' +
      'its captured `out` bound to a name every LATER entry\'s own expression-mode params/postprocess ' +
      'can reference. Requires the side panel open and connected. Targets whichever tab is pinned in the ' +
      'side panel\'s header, or the browser\'s actual active tab if none is pinned.',
    inputSchema: {
      ...liveArg,
      scenarioId: z.string(),
      params: z.record(z.string(), z.any()).optional(),
      dataset: z.string().optional().describe('Name of an existing scenario-data dataset to use as the base scenario params'),
    },
  },
  safe(async ({ project, session, scenarioId, params, dataset }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'replayScenario', { scenarioId, params, dataset }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Scenario replay failed.');
    return textResult('Scenario replay passed.');
  })
);

server.registerTool(
  'live_start_scenario_run',
  {
    description:
      'Starts a scenario running live on the side panel\'s target tab and returns immediately with ' +
      'a `runId` -- unlike live_replay_scenario, this does NOT wait for the run to finish. Poll ' +
      'live_get_scenario_run (or live_list_scenario_runs) with the returned runId to check progress/ ' +
      'outcome. Fails fast if that tab already has a run or single-step Play active. Requires the ' +
      'side panel open and connected.',
    inputSchema: {
      ...liveArg,
      scenarioId: z.string(),
      params: z.record(z.string(), z.any()).optional(),
      dataset: z.string().optional().describe('Name of an existing scenario-data dataset to use as the base scenario params'),
    },
  },
  safe(async ({ project, session, scenarioId, params, dataset }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'startScenarioRun', { scenarioId, params, dataset }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to start scenario run.');
    return jsonResult({ runId: result.runId, name: result.name, tabId: result.tabId });
  })
);

server.registerTool(
  'live_list_scenario_runs',
  {
    description:
      'Lists scenario runs on the connected side panel: `current` (still running, one per tab) and ' +
      '`history` (finished/cancelled this session, most recent first, capped at 30). Each entry is ' +
      'a summary (id, name, scenarioId, tabId, status, flows: {total, current}) -- use ' +
      'live_get_scenario_run for one run\'s full detail, including the currently-executing flow\'s ' +
      'own per-step status. Safe to poll repeatedly.',
    inputSchema: liveArg,
  },
  safe(async ({ project, session }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'listScenarioRuns', {}, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to list scenario runs.');
    return jsonResult({ current: result.current, history: result.history });
  })
);

server.registerTool(
  'live_get_scenario_run',
  {
    description:
      'Full detail for one scenario run started via live_start_scenario_run (or ' +
      'live_replay_scenario) by its `runId` -- overall status, which flow index it\'s on, and (via ' +
      '`currentRun`) the full per-step detail of whichever flow is currently executing, same shape ' +
      'live_get_run returns for a single flow. Works for both a still-running and an already-' +
      'finished scenario run.',
    inputSchema: { ...liveArg, runId: z.string() },
  },
  safe(async ({ project, session, runId }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'getScenarioRun', { runId }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to get scenario run.');
    return jsonResult(result.run);
  })
);

server.registerTool(
  'live_cancel_scenario_run',
  {
    description:
      'Cancels a still-running scenario run by its `runId` -- stops before the next flow in the ' +
      'sequence starts, and force-detaches the currently-executing flow\'s own tab so an in-flight ' +
      'step stops immediately instead of running to its own timeout.',
    inputSchema: { ...liveArg, runId: z.string() },
  },
  safe(async ({ project, session, runId }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'cancelScenarioRun', { runId }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to cancel scenario run.');
    return textResult(`Scenario run "${runId}" cancelled.`);
  })
);

server.registerTool(
  'live_detach',
  {
    description:
      'Detaches chrome.debugger from the side panel\'s target tab right away, instead of waiting ' +
      'out the ~20s idle timeout every other live_* call leaves it attached for (see live_snapshot/ ' +
      'live_run_step/live_pick_element -- they keep the tab attached across a quick back-and-forth ' +
      'burst of calls rather than detaching after each individual one, since detaching mid-exploration ' +
      'was closing transient page UI like an open dropdown). Call this when done with a live ' +
      'exploration/interaction sequence, so Chrome\'s "being debugged" banner does not linger on the ' +
      'tab longer than necessary.',
    inputSchema: liveArg,
  },
  safe(async ({ project, session }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'detach', {}, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Detach failed.');
    return textResult('Detached.');
  })
);

// ---------- tab management -- plain chrome.tabs, not a Playwright/step concept, so unlike
// everything above these have no add_step/replay equivalent: a flow's own steps only ever act on
// whichever ONE tab it's already running against. ----------

server.registerTool(
  'live_list_tabs',
  {
    description: 'Lists every open tab in the side panel\'s browser window (id, title, url, which one is ' +
      'currently active, which one -- if any -- is pinned as the target for every other live_* call). ' +
      'Call this before live_switch_tab to get a valid tabId.',
    inputSchema: liveArg,
  },
  safe(async ({ project, session }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'listTabs', {}, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to list tabs.');
    return jsonResult({ tabs: result.tabs, targeting: result.targeting });
  })
);

server.registerTool(
  'live_switch_tab',
  {
    description: 'Pins a specific already-open tab (by id, see live_list_tabs) as the target for every ' +
      'other live_* call, same as picking it from the side panel\'s own "Target" menu. Omit `tabId` to go ' +
      'back to following whichever tab is actually active in the browser instead of a pinned one.',
    inputSchema: { ...liveArg, tabId: z.number().optional().describe('Omit to unpin and follow the active tab instead') },
  },
  safe(async ({ project, session, tabId }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'switchTab', { tabId }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to switch tab.');
    return jsonResult({ tabId: result.tabId, title: result.title, url: result.url });
  })
);

server.registerTool(
  'live_new_tab',
  {
    description: 'Opens a new browser tab and immediately pins it as the target for every other live_* ' +
      'call (same as live_switch_tab right after). Optionally navigate it straight to `url`.',
    inputSchema: { ...liveArg, url: z.string().optional() },
  },
  safe(async ({ project, session, url }) => {
    const result = await bridge.sendRequest(resolveLiveProject(project, session), 'newTab', { url }, undefined, session);
    if (!result.ok) throw new Error(result.error || 'Failed to open a new tab.');
    return jsonResult({ tabId: result.tabId, url: result.url });
  })
);

async function main() {
  bridge = await startBridgeServer();
  // stderr, never stdout -- stdout is the MCP JSON-RPC stream itself (StdioServerTransport below),
  // so anything written there would corrupt the protocol. This is a log line for whoever's watching
  // this process's own output, not something the MCP client necessarily surfaces to the user --
  // the reliable way to tell a human this agent's name is the `live_status` tool's own `agentName`
  // field, which a connected assistant can just read and say out loud.
  console.error(`[playwright-easy-spec] Agent name: ${bridge.agentName} -- approve this exact name in the side panel to let it control the browser.`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

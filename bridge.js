// Shared WebSocket protocol between the long-lived MCP server (the bridge host, see
// mcp/server.js) and:
//  (a) the side panel -- a persistent client for as long as it's open. Receives 'replay'/
//      'pickElement'/'runStep' pushes (each executed via the exact same real chrome.debugger-
//      backed engine a manual Replay/Pick/Play click would use -- see sidepanel.js's own bridge
//      client code) and 'projectChanged' pushes (triggers the same refresh functions a manual
//      reconnect would), reporting results back for the request types.
//  (b) short-lived CLI invocations -- a best-effort client, since a one-shot `easyspec` command
//      can't itself be a stable server the side panel could depend on. It only ever pushes a
//      'cliNotify' and disconnects; it can't make a request-with-response (there's nothing to
//      wait around for a reply with once the process would otherwise exit).
//
// This is genuinely local-machine-only infrastructure: bound to 127.0.0.1, and every non-CLI
// connection must present a chrome-extension:// Origin (a real browser enforces this header and
// a page can't forge it, so an ordinary website's own WebSocket attempt -- which always carries
// its true https://... origin -- is rejected outright) or omit Origin entirely the way a plain
// Node `ws` client does (which is what the CLI's own best-effort client looks like, since Node
// isn't a browser and has no Origin to enforce either way).
const path = require('path');

const DEFAULT_PORT = 58473;
// More than one MCP server process (one per agent/session) can run on the same machine at once --
// each claims the first free port in this range instead of the second one crashing on a busy
// port (see startBridgeServer's own comment below). sidepanel.js's connectBridgeAll dials every
// port in this same range in parallel, so it discovers whichever agent(s) actually own a bridge.
const PORT_RANGE = 10;

// Names the AGENT (this mcp/server.js process) rather than the panel -- sent to every connecting
// client as the very first message (see 'serverHello' below) so the panel's approval UI has
// something better than a bare port number to show. No random word pair here, unlike the panel's
// own SESSION_NAME (sidepanel.js): the agent already has a stable, unique identifier for free --
// its slot in the port discovery range -- so a random suffix would only be redundant noise. A
// panel has no equivalent fixed slot (it can connect to any agent, at any time), which is exactly
// why IT still needs a random name for humans/`session` to disambiguate multiple panels.
function agentName(port) {
  const slot = port - DEFAULT_PORT + 1; // 1-indexed position in the discovery range -- stable per agent, not random, so "claude-1"/"claude-2" line up with which port each one is actually on
  return `claude-${slot}`;
}

function buildBridgeApi(wss, port) {
  const AGENT_NAME = agentName(port); // stable for this port slot -- not random, see agentName's own comment
  const STARTED_AT = Date.now(); // this agent's own launch time -- NOT when any given panel connection opened (that's the panel's own connectedAt), so a reconnect doesn't reset it
  const sidepanels = new Set(); // { ws, projectName }
  const pending = new Map(); // requestId -> { resolve, reject, timeout }

  function projectLeafName(projectDir) {
    return path.basename(path.resolve(projectDir));
  }
  // projectDir is null for a panel with no project connected at all (see sidepanel.js's
  // sendBridgeHello) -- passing null through finds exactly those sessions instead of every named
  // one, the same way client.projectName itself is null until a folder's actually connected.
  function findPanelsFor(projectDir) {
    const leaf = projectDir ? projectLeafName(projectDir) : null;
    return [...sidepanels].filter((c) => c.projectName === leaf);
  }

  wss.on('connection', (ws) => {
    const client = { ws, projectName: null, sessionName: null };
    // Sent unprompted, before anything else -- gives the panel's approval UI a friendly name (and
    // this agent's real uptime, not just "since this particular reconnect") to show right away,
    // independent of (and not gated by) approval itself.
    ws.send(JSON.stringify({ type: 'serverHello', agentName: AGENT_NAME, startedAt: STARTED_AT }));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        // Registering as a panel isn't gated by anything on this side -- the panel dials every
        // port in the shared discovery range indiscriminately (see sidepanel.js's
        // connectBridgeAll). The real gate lives entirely on the panel's own side: it puts every
        // new connection in a pending list and won't act on anything it sends until a human
        // clicks Approve (see sidepanel.js's bridgePending/bridgeTrusted and handleBridgeMessage).
        client.projectName = msg.projectName || null;
        client.sessionName = msg.sessionName || null; // human-readable ("eager-beaver") -- see sidepanel.js's own SESSION_NAME
        sidepanels.add(client);
      } else if (msg.type === 'cliNotify') {
        for (const target of findPanelsFor(msg.project)) {
          target.ws.send(JSON.stringify({ type: 'projectChanged', category: msg.category, id: msg.id }));
        }
      } else if (msg.type.endsWith('Result') && pending.has(msg.requestId) && sidepanels.has(client)) {
        // sidepanels.has(client) -- only a connection that already said hello can resolve a
        // pending request; otherwise any connection could try to hijack a real request's response
        // just by guessing/observing its requestId.
        const { resolve, timeout } = pending.get(msg.requestId);
        clearTimeout(timeout);
        pending.delete(msg.requestId);
        resolve(msg.result);
      }
    });
    ws.on('close', () => sidepanels.delete(client));
  });

  // Pushed after every mutating ProjectCore call (see lib/projectCore.js's own notify hook) so a side
  // panel with the same project already open reflects the change without a manual reconnect.
  function notify(projectDir, category, id) {
    const targets = findPanelsFor(projectDir);
    for (const t of targets) t.ws.send(JSON.stringify({ type: 'projectChanged', category, id }));
    return targets.length;
  }

  // Asks the (exactly one) connected side panel for this project to actually do something live --
  // `requestType` is 'replay', 'pickElement', or 'runStep' (see sidepanel.js's handleBridgeMessage
  // for what each does and what `payload` each expects) -- using its own real chrome.debugger
  // session, the user's real tab and login state, and waits for the matching `<type>Result`.
  // There's no token/secret on this request -- the side panel gates execution on its own side by
  // requiring a human to have clicked Approve on this exact connection first (see sidepanel.js's
  // bridgePending/bridgeTrusted and its own comment on why that's a UI decision, not a crypto one).
  function sendRequest(projectDir, requestType, payload, timeoutMs = 10 * 60 * 1000, sessionName) {
    let targets = findPanelsFor(projectDir);
    // Explicit session scoping (see mcp/server.js's liveArg/live_status) -- narrows straight to the
    // one named panel, so a caller who already knows which session it wants never hits the
    // ambiguity error below just because a second, unrelated panel happens to share the project.
    if (sessionName) {
      const named = targets.filter((t) => t.sessionName === sessionName);
      if (!named.length) {
        const available = targets.map((t) => t.sessionName || '(unnamed)').join(', ') || '(none connected)';
        throw new Error(`No side panel named "${sessionName}" is connected to this project. Connected: ${available}`);
      }
      targets = named; // sessionName is unique per connection (see sidepanel.js's SESSION_NAME), so this is always exactly one
    }
    const scope = projectDir ? 'for this project' : 'with no project connected';
    if (!targets.length) throw new Error(`No side panel connected ${scope} -- open the side panel${projectDir ? ' and connect this folder' : ''} first.`);
    if (targets.length > 1) {
      const names = targets.map((t) => t.sessionName || '(unnamed)').join(', ');
      throw new Error(`More than one side panel is connected ${scope} (${names}) -- pass \`session\` to say which one, or close all but one and try again.`);
    }
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out waiting for the side panel to respond to "${requestType}".`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      targets[0].ws.send(JSON.stringify({ type: requestType, requestId, ...payload }));
    });
  }

  function connectedProjectNames() {
    return [...sidepanels].map((c) => c.projectName).filter(Boolean);
  }

  // Richer sibling of connectedProjectNames -- for live_status (mcp/server.js), so both the
  // connected agent and a human with several panels/windows open can tell which is which by name
  // instead of just by project (multiple panels CAN be open on different projects at once, and
  // even on the same one, just not usable for live_* calls at the same time -- see sendRequest's
  // own >1 guard above).
  function connectedSessions() {
    return [...sidepanels].map((c) => ({ projectName: c.projectName, sessionName: c.sessionName }));
  }

  return { wss, notify, sendRequest, connectedProjectNames, connectedSessions, port, agentName: AGENT_NAME };
}

// Binds the first free port starting at `port`, retrying up to PORT_RANGE times. A WebSocketServer
// bind failure only ever surfaces as an async 'error' event, never a thrown exception -- and an
// unhandled 'error' event on a Node EventEmitter is fatal to the whole process, which is exactly
// what used to happen to a second MCP server process starting while a first was still running
// (both trying to claim the same single fixed port). Async by necessity: there's no synchronous
// way to know a port bind succeeded.
function startBridgeServer(port = DEFAULT_PORT, attemptsLeft = PORT_RANGE) {
  const { WebSocketServer } = require('ws');
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      verifyClient: (info) => !info.origin || info.origin.startsWith('chrome-extension://'),
    });
    wss.once('listening', () => {
      wss.removeAllListeners('error'); // bound successfully -- the retry-only handler below no longer applies
      resolve(buildBridgeApi(wss, port));
    });
    wss.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
        wss.close();
        resolve(startBridgeServer(port + 1, attemptsLeft - 1));
      } else {
        reject(err);
      }
    });
  });
}

// Best-effort, fire-and-forget notify from a short-lived CLI process -- silently does nothing if
// no bridge server is currently running (the normal case for anyone not also running the MCP
// server), and never throws or delays the CLI command it's attached to by more than a beat. Tries
// every port in the range (not just DEFAULT_PORT) since more than one agent's bridge might be
// running at once, each with its own side panel(s) that should hear about this change.
function notifyBridgeBestEffort(projectDir, category, id) {
  const ports = Array.from({ length: PORT_RANGE }, (_, i) => DEFAULT_PORT + i);
  return Promise.all(ports.map((port) => notifyBridgeBestEffortOnPort(projectDir, category, id, port)));
}

function notifyBridgeBestEffortOnPort(projectDir, category, id, port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let ws;
    try {
      const { WebSocket } = require('ws');
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      done();
      return;
    }
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* already closed */ }
      done();
    }, 800);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'cliNotify', project: path.resolve(projectDir), category, id }));
      clearTimeout(timer);
      ws.close();
      done();
    });
    ws.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

module.exports = { DEFAULT_PORT, PORT_RANGE, startBridgeServer, notifyBridgeBestEffort };

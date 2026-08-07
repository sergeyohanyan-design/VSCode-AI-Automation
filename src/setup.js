// First-run setup for Agent Loop.
//
// The dispatcher reads its config from a single gitignored env file OUTSIDE any repo
// (~/.agent-loop.env by default) — deliberately, because task branches reset to the base branch
// and a token file living inside a repo can get swept into a commit. This wizard writes that file.
//
// What it can and cannot automate: ClickUp's public API v2 can create a List, but it has NO
// endpoint for creating custom workflow statuses or custom fields. So the wizard creates the list
// and then VERIFIES the board, telling you exactly what to add by hand and offering a re-check —
// rather than pretending to have finished and letting the dispatcher fail on the first pass.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://api.clickup.com/api/v2';

// Must match the dispatcher's own defaults (see the CONFIG block in agent-loop.mjs). If a board
// spells these differently, the dispatcher takes AGENT_LOOP_STATUS_* overrides — see the README.
const REQUIRED_STATUSES = ['ready', 'coding', 'in review', 'changes requested', 'blocked', 'stalled', 'approved', 'committed'];
const REQUIRED_FIELDS = ['Acceptance Criteria', 'Blocked By'];

const envFile = () => process.env.AGENT_LOOP_ENV || path.join(os.homedir(), '.agent-loop.env');

// ---------- env file (pure, unit-tested) ----------
function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// Update keys in place, append the rest. Never rewrites lines we don't manage — the file is shared
// with hand-written settings (verify commands, status overrides) that must survive a re-run.
function mergeEnvText(existing, updates) {
  const lines = String(existing ?? '').split(/\r?\n/);
  const pending = new Map(Object.entries(updates));
  const merged = lines.map(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (!m || !pending.has(m[1])) return line;
    const key = m[1];
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  while (merged.length && merged[merged.length - 1].trim() === '') merged.pop();
  for (const [key, value] of pending) merged.push(`${key}=${value}`);
  return merged.join('\n') + '\n';
}

function readEnv(file = envFile()) {
  try { return parseEnv(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeEnv(updates, file = envFile()) {
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* first run — create it */ }
  fs.writeFileSync(file, mergeEnvText(existing, updates), { mode: 0o600 });
}

// Presence check only — the launcher deliberately never loads CLICKUP_TOKEN into the extension
// host. Only the wizard below reads the value, and only while it is talking to ClickUp.
function isConfigured(file = envFile()) {
  const env = { ...readEnv(file) };
  for (const k of ['CLICKUP_TOKEN', 'AGENT_LOOP_LIST_ID']) if (process.env[k]) env[k] = process.env[k];
  return Boolean(env.CLICKUP_TOKEN && env.AGENT_LOOP_LIST_ID);
}

// ---------- ClickUp ----------
async function api(token, endpoint, init = {}) {
  const res = await fetch(`${API}${endpoint}`, {
    ...init,
    headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  if (!res.ok) throw new Error(json?.err || `ClickUp ${res.status}: ${body.slice(0, 200)}`);
  return json;
}

// Case-insensitive: ClickUp normalizes status names to lowercase, but a hand-typed field keeps its case.
const norm = s => String(s ?? '').trim().toLowerCase();
function missingStatusNames(statuses) {
  const have = new Set((statuses || []).map(s => norm(s.status ?? s)));
  return REQUIRED_STATUSES.filter(s => !have.has(norm(s)));
}
function missingFieldNames(fields) {
  const have = new Set((fields || []).map(f => norm(f.name ?? f)));
  return REQUIRED_FIELDS.filter(f => !have.has(norm(f)));
}

// GET /list/{id} returns no `url` field (verified against the live API), so the deep link has to be
// composed. It needs the workspace id, which is why setup records AGENT_LOOP_TEAM_ID — without it
// the "Open list" button is omitted rather than pointing somewhere wrong.
const listUrl = (teamId, listId) => (teamId && listId ? `https://app.clickup.com/${teamId}/v/li/${listId}` : null);

async function inspectBoard(token, listId, teamId) {
  const list = await api(token, `/list/${listId}`);
  let fields = [];
  try { fields = (await api(token, `/list/${listId}/field`))?.fields || []; }
  catch { /* field read is not permitted on every plan — treat as unknown, report statuses only */ }
  return {
    name: list.name,
    url: listUrl(teamId, listId),
    missingStatuses: missingStatusNames(list.statuses),
    missingFields: missingFieldNames(fields),
  };
}

// ---------- wizard ----------
const cancelled = () => { vscode.window.showWarningMessage('Agent Loop: setup cancelled — nothing was saved. Run "Agent Loop: Set up / reconfigure" any time.'); };

async function pickOne(items, placeHolder) {
  if (items.length === 1) return items[0];
  return vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });
}

async function runSetup() {
  const existing = readEnv();

  // 1 — token, validated against the API rather than by prefix, so a typo fails here and not on
  //     the first dispatcher pass twenty minutes later.
  const token = await vscode.window.showInputBox({
    title: 'Agent Loop setup (1/5) — ClickUp API token',
    prompt: 'ClickUp → Settings → Apps → API Token. Stored in ~/.agent-loop.env, never in a repo.',
    placeHolder: 'pk_...',
    password: true,
    ignoreFocusOut: true,
    value: existing.CLICKUP_TOKEN ? '' : undefined,
  });
  if (!token) return cancelled();

  let user;
  try {
    user = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Agent Loop: verifying token…' },
      () => api(token, '/user'));
  } catch (e) {
    vscode.window.showErrorMessage(`Agent Loop: that token was rejected (${e.message}).`);
    return;
  }

  // 2 — workspace → space → folder. This is the "where do I create the task list" question.
  let team, space, folder;
  try {
    const teams = (await api(token, '/team'))?.teams || [];
    if (!teams.length) throw new Error('this token can see no workspaces');
    team = await pickOne(teams.map(t => ({ label: t.name, id: t.id })), 'Workspace');
    if (!team) return cancelled();

    const spaces = ((await api(token, `/team/${team.id}/space?archived=false`))?.spaces || [])
      .map(s => ({ label: s.name, id: s.id }));
    if (!spaces.length) throw new Error('that workspace has no spaces — create one in ClickUp first');
    space = await vscode.window.showQuickPick(spaces, { title: 'Agent Loop setup (2/5)', placeHolder: 'Space to create the task list in', ignoreFocusOut: true });
    if (!space) return cancelled();

    const folders = ((await api(token, `/space/${space.id}/folder?archived=false`))?.folders || [])
      .map(f => ({ label: f.name, id: f.id }));
    folder = await vscode.window.showQuickPick(
      [{ label: '$(root-folder) No folder — create in the space root', id: null }, ...folders],
      { title: 'Agent Loop setup (3/5)', placeHolder: 'Folder (optional)', ignoreFocusOut: true });
    if (!folder) return cancelled();
  } catch (e) {
    vscode.window.showErrorMessage(`Agent Loop: could not read your ClickUp workspace (${e.message}).`);
    return;
  }

  const listName = await vscode.window.showInputBox({
    title: 'Agent Loop setup (4/5) — task list name',
    prompt: `Created in ${folder.id ? `folder "${folder.label}"` : `space "${space.label}"`}.`,
    value: 'Agent Loop',
    ignoreFocusOut: true,
  });
  if (!listName) return cancelled();

  let list;
  try {
    list = await api(token, folder.id ? `/folder/${folder.id}/list` : `/space/${space.id}/list`,
      { method: 'POST', body: JSON.stringify({ name: listName }) });
  } catch (e) {
    vscode.window.showErrorMessage(`Agent Loop: could not create the list (${e.message}).`);
    return;
  }

  // 5 — the two optional knobs that actually change behaviour on a fresh machine. Everything else
  //     has a working default (see the README table).
  const base = await vscode.window.showInputBox({
    title: 'Agent Loop setup (5/5) — base branch',
    prompt: 'Branch that task branches fork from and merge back into.',
    value: 'main', ignoreFocusOut: true,
  });
  if (base === undefined) return cancelled();

  const verify = await vscode.window.showInputBox({
    title: 'Agent Loop setup (5/5) — verify command (optional)',
    prompt: 'Test command run against the reviewed commit before it lands. Leave empty to skip verification.',
    placeHolder: 'e.g. npm test',
    value: existing.AGENT_LOOP_VERIFY || '', ignoreFocusOut: true,
  });
  if (verify === undefined) return cancelled();

  try {
    writeEnv({
      CLICKUP_TOKEN: token,
      AGENT_LOOP_LIST_ID: list.id,
      AGENT_LOOP_TEAM_ID: team.id,          // not read by the dispatcher — only builds the list deep link
      AGENT_LOOP_BASE: base.trim() || 'main',
      AGENT_LOOP_VERIFY: verify.trim(),
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Agent Loop: could not write ${envFile()} (${e.message}).`);
    return;
  }

  vscode.window.showInformationMessage(
    `Agent Loop: list "${list.name}" created for ${user?.user?.username || 'your account'}. Config saved to ${envFile()}.`);
  await verifyBoardInteractive(token, list.id, team.id);
}

// ClickUp has no API for creating statuses or custom fields, so this is a check-and-instruct loop
// rather than another automated step. Being explicit here beats a dispatcher that starts and then
// stops on a missing status it cannot create either.
async function verifyBoardInteractive(token, listId, teamId) {
  for (;;) {
    let board;
    try {
      board = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Agent Loop: checking the board…' },
        () => inspectBoard(token, listId, teamId));
    } catch (e) {
      vscode.window.showErrorMessage(`Agent Loop: could not read the list (${e.message}).`);
      return;
    }

    if (!board.missingStatuses.length && !board.missingFields.length) {
      const pick = await vscode.window.showInformationMessage(
        `Agent Loop: "${board.name}" is ready — all ${REQUIRED_STATUSES.length} statuses and both custom fields are present.`,
        ...['Start Agent Loop', ...(board.url ? ['Open list'] : [])]);
      if (pick === 'Start Agent Loop') vscode.commands.executeCommand('agentLoop.toggle');
      else if (pick === 'Open list') vscode.env.openExternal(vscode.Uri.parse(board.url));
      return;
    }

    const todo = [
      board.missingStatuses.length ? `Statuses to add (List → ⋯ → Statuses):\n  ${board.missingStatuses.join('\n  ')}` : '',
      board.missingFields.length ? `Custom fields to add (text fields):\n  ${board.missingFields.join('\n  ')}` : '',
    ].filter(Boolean).join('\n\n');

    const pick = await vscode.window.showWarningMessage(
      `Agent Loop: "${board.name}" needs ${board.missingStatuses.length} status(es) and ${board.missingFields.length} custom field(s) that ClickUp's API cannot create. Add them in ClickUp, then re-check.`,
      { modal: true, detail: todo },
      ...[...(board.url ? ['Open list in ClickUp'] : []), 'Copy the list', 'Re-check', 'Later']);

    if (pick === 'Open list in ClickUp') await vscode.env.openExternal(vscode.Uri.parse(board.url));
    else if (pick === 'Copy the list') await vscode.env.clipboard.writeText(todo);
    else if (pick !== 'Re-check') return;   // "Later", Escape, or a dismissed modal
  }
}

// Re-check without re-running the whole wizard.
async function recheckBoard() {
  const env = { ...readEnv(), ...process.env };
  if (!env.CLICKUP_TOKEN || !env.AGENT_LOOP_LIST_ID) {
    vscode.window.showWarningMessage('Agent Loop: not configured yet — run "Agent Loop: Set up / reconfigure" first.');
    return;
  }
  await verifyBoardInteractive(env.CLICKUP_TOKEN, env.AGENT_LOOP_LIST_ID, env.AGENT_LOOP_TEAM_ID);
}

module.exports = {
  runSetup, recheckBoard, isConfigured, envFile,
  __test: { parseEnv, mergeEnvText, missingStatusNames, missingFieldNames, REQUIRED_STATUSES, REQUIRED_FIELDS, listUrl, api, inspectBoard, readEnv },
};

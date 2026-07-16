// Electron main process: creates the frameless notch window, tails Claude
// session JSONLs from ~/.claude/projects/*/*.jsonl, and pushes telemetry to
// the renderer once per tick.

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
// Wayland: mouse events / transparent frameless windows / setIgnoreMouseEvents
// are all flaky. Force X11/XWayland so we get predictable behavior. No-op elsewhere.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');
// 2D widget — software rendering is plenty, and flaky GPU drivers have been
// crashing the GPU process ("GPU process isn't usable") on some machines.
// macOS keeps the GPU: software rendering there paints transparent windows
// with an opaque white backing.
if (process.platform !== 'darwin') app.disableHardwareAcceleration();
// Only one notch per desktop — a second launch exits immediately.
if (!app.requestSingleInstanceLock()) app.exit(0);
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const WIDTH = 404;               // notch is 400px wide; 2px margin each side
const COLLAPSED_H = 46;
const EXPANDED_H = 640;          // must fit pill + plan rows + MAX_CARDS cards (CSS caps at 620)
const TICK_MS = 2000;

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const CONTEXT_LIMIT = 200_000;
const USAGE_FETCH_MS = 15 * 60 * 1000; // /api/oauth/usage is heavily rate-limited
const FRESH_MS = 15 * 60 * 1000; // 15 min — anything older feels stale
const MAX_CARDS = 4;
const MAX_JSONL_BYTES = 8 * 1024 * 1024; // beyond this, read only the tail
const TAIL_BYTES = 512 * 1024;

// macOS: the widget renders as a black extension of the physical notch
// (~200px wide, centered) — a slightly wider bar with the status dot in its
// right wing. The window is created once at full size and never resized;
// expand/collapse is pure CSS morph and clicks pass through when collapsed.
const MAC_NOTCH = process.platform === 'darwin';
const MAC_BAR_W = 280;           // collapsed bar: notch + a wing each side
const MAC_W = 464;               // window (and expanded panel) width

const MODEL_NAMES = {
  'claude-fable-5': 'Fable 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
};

function humanizeSlug(slug) {
  // slug looks like '-home-heliodev-Documentos-AGENTNOTCH-universal'
  const parts = slug.replace(/^-+/, '').split('-').filter(Boolean);
  const tail = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (tail.length && p[0].toLowerCase() === p[0]) break;
    tail.unshift(p);
  }
  return tail.length ? tail.join(' ') : slug;
}

function modelName(id) {
  if (!id) return 'Claude';
  if (MODEL_NAMES[id]) return MODEL_NAMES[id];
  const stripped = id.startsWith('claude-') ? id.slice(7) : id;
  return stripped.split('-').filter(Boolean)
    .map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
}

// Read a session file's text. Oversized logs get a tail read only — status,
// model and cwd all come from recent records, and an active session must not
// vanish from the widget just because its log crossed the size cap. Token
// totals for tail-read files undercount; acceptable trade-off.
function readSessionText(filePath, sizeBytes) {
  if (typeof sizeBytes === 'number' && sizeBytes > MAX_JSONL_BYTES) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      const read = fs.readSync(fd, buf, 0, TAIL_BYTES, sizeBytes - TAIL_BYTES);
      const text = buf.toString('utf8', 0, read);
      return text.slice(text.indexOf('\n') + 1); // drop first partial line
    } catch { return null; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

// Cache parsed sessions by path. A JSONL only changes when its session is
// active — re-reading 200 idle files every 2s was burning ~25% CPU and heavy
// GC on machines already under memory pressure. Entries are invalidated by
// (mtime, size); idle_s/"today" drift is tolerable within a tick.
const parseCache = new Map(); // path -> { mtime, size, day, result }

function parseSessionCached(filePath, mtimeMs, sizeBytes, now) {
  const day = new Date(now).toDateString(); // tokens_today depends on the date
  const hit = parseCache.get(filePath);
  if (hit && hit.mtime === mtimeMs && hit.size === sizeBytes && hit.day === day) {
    return hit.result;
  }
  const result = parseSession(filePath, mtimeMs, sizeBytes, now);
  parseCache.set(filePath, { mtime: mtimeMs, size: sizeBytes, day, result });
  return result;
}

// Parse a single JSONL file. Caller passes precomputed mtime/size to avoid re-stat.
function parseSession(filePath, mtimeMs, sizeBytes, now) {
  const raw = readSessionText(filePath, sizeBytes);
  if (!raw || !raw.trim()) return null;

  let sessionId = '';
  let branch = 'main';
  let model = '';
  let sawRealModel = false;
  let cwd = '';
  let outputTokens = 0;
  let tokensToday = 0;
  const todayStr = new Date(now).toDateString();
  let lastInput = 0;
  let lastRole = null;
  let lastStop = null;
  let lastTool = null;
  const activeSubagents = new Set();     // subagent_type names invoked via Task
  let lastSubagent = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;

    if (typeof rec.sessionId === 'string') sessionId = rec.sessionId;
    if (typeof rec.gitBranch === 'string' && rec.gitBranch) branch = rec.gitBranch;
    if (typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;

    const msg = (rec.message && typeof rec.message === 'object') ? rec.message : {};

    if (rec.type === 'assistant') {
      // '<synthetic>' records are appended on interrupts/API errors — they must
      // not clobber the display model nor mark the session as unreal.
      if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') {
        model = msg.model;
        sawRealModel = true;
      }
      const u = msg.usage;
      let out = 0;
      if (u && typeof u === 'object') {
        if (typeof u.output_tokens === 'number') out = u.output_tokens;
        // Real context size lives mostly in cache tokens: a 366k-token turn
        // logs input_tokens:2, cache_read_input_tokens:366157. Sum all three.
        const inp = (typeof u.input_tokens === 'number' ? u.input_tokens : 0)
          + (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0)
          + (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0);
        if (inp > 0) lastInput = inp;
      }
      outputTokens += out;
      // Count today's tokens by the record's own timestamp; fall back to file
      // mtime when missing/malformed — a message must never be lost.
      if (out > 0) {
        let ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : mtimeMs;
        if (!Number.isFinite(ts)) ts = mtimeMs;
        if (new Date(ts).toDateString() === todayStr) tokensToday += out;
      }
      lastRole = 'assistant';
      lastStop = msg.stop_reason || null;
      lastTool = null;
      if (Array.isArray(msg.content)) {
        // Forward scan — lastTool/lastSubagent end up holding the message's
        // chronologically LAST tool call, which is what "active" means.
        for (const b of msg.content) {
          if (b && b.type === 'tool_use' && typeof b.name === 'string') {
            lastTool = b.name;
            // Any tool carrying `subagent_type` spawns a subagent (Task, Agent,
            // claude-flow variants). Accept only non-empty strings.
            const sa = b.input && typeof b.input.subagent_type === 'string'
              ? b.input.subagent_type.trim() : '';
            if (sa) {
              activeSubagents.add(sa);
              lastSubagent = sa;
            }
          }
        }
      }
    } else if (rec.type === 'user') {
      // An interrupt is logged as a user message — it means Claude STOPPED,
      // not that it is processing a new request.
      const mc = msg.content;
      const firstText = typeof mc === 'string' ? mc
        : Array.isArray(mc) && mc[0] && typeof mc[0].text === 'string' ? mc[0].text : '';
      lastRole = firstText.startsWith('[Request interrupted') ? 'interrupted' : 'user';
      lastStop = null;
      lastTool = null;
    }
  }

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');

  let status, lastAction;
  if (lastRole === 'assistant') {
    if (lastStop === 'tool_use' || lastTool) {
      status = 'working';
      lastAction = lastTool || 'Working';
    } else {
      status = 'needs_you';
      lastAction = 'Awaiting input';
    }
  } else if (lastRole === 'user') {
    status = 'working';
    lastAction = 'Processing request';
  } else if (lastRole === 'interrupted') {
    status = 'needs_you';
    lastAction = 'Interrupted';
  } else {
    status = 'needs_you';
    lastAction = 'Awaiting input';
  }

  const slug = path.basename(path.dirname(filePath));
  // Prefer authoritative cwd (preserves original casing & dashes like "wp-gorila").
  const project = cwd ? path.basename(cwd) : humanizeSlug(slug);

  return {
    session_id: sessionId,
    project,
    branch,
    model: modelName(model),
    status,
    last_action: lastAction,
    context_pct: Math.max(0, Math.min(100, Math.round(lastInput / CONTEXT_LIMIT * 100))),
    output_tokens_total: outputTokens,
    tokens_today: tokensToday,
    subagents: Array.from(activeSubagents),
    active_subagent: status === 'working' ? lastSubagent : null,
    mtime: mtimeMs,
    cwd,                                 // used for dedupe across sessions
    _has_real_assistant: outputTokens > 0 && sawRealModel,
  };
}

// Discover session files. Returns {path, mtime, size} so callers avoid re-statting.
function discoverSessions() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out = [];
  let projs;
  try { projs = fs.readdirSync(PROJECTS_DIR); } catch { return []; }
  for (const proj of projs) {
    const dir = path.join(PROJECTS_DIR, proj);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        out.push({ path: full, mtime: st.mtimeMs, size: st.size });
      } catch { /* file vanished mid-scan */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function fmtTokens(n) {
  // 999_500+ rounds to 1.0M — the k-branch would print "1000k" otherwise.
  if (n >= 999_500) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

function fmtClock(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${suffix}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Cache of the last successful /api/oauth/usage response. Refreshed by fetchUsage
// every USAGE_FETCH_MS; consumed by buildPayload. Null when unavailable.
let usageCache = null;


const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// Claude Code's public OAuth client id — needed to refresh its tokens.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Reads Claude Code's credentials. Linux/Windows keep them on disk; macOS
// keeps them in the Keychain (first read may show a system access prompt).
function readCreds() {
  try {
    const json = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (json && json.claudeAiOauth) return { source: 'file', json };
  } catch {}
  if (process.platform === 'darwin') {
    try {
      const { execSync, execFileSync } = require('child_process');
      const raw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const json = JSON.parse(raw);
      if (!json || !json.claudeAiOauth) return null;
      const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE],
        { encoding: 'utf8', timeout: 3000 });
      const m = meta.match(/"acct"<blob>="([^"]*)"/);
      return { source: 'keychain', json, account: (m && m[1]) || os.userInfo().username };
    } catch { return null; }
  }
  return null;
}

function writeCredsBack(creds) {
  const payload = JSON.stringify(creds.json);
  if (creds.source === 'file') {
    fs.writeFileSync(CREDS_FILE, payload, { mode: 0o600 });
    return;
  }
  require('child_process').execFileSync('security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', creds.account, '-w', payload],
    { timeout: 3000, stdio: 'ignore' });
}

// Returns a live access token, refreshing it the same way Claude Code does
// when the stored one expired. The rotated refresh token is written back so
// Claude Code's own login keeps working.
async function getUsableToken() {
  const creds = readCreds();
  if (!creds) return null;
  const o = creds.json.claudeAiOauth;
  if (o.accessToken && (!o.expiresAt || o.expiresAt - Date.now() > 60_000)) return o.accessToken;
  if (!o.refreshToken) return o.accessToken || null;
  try {
    const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: o.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!res.ok) {
      console.error('[agentnotch] token refresh failed:', res.status);
      return o.accessToken || null;
    }
    const t = await res.json();
    if (!t || typeof t.access_token !== 'string') return o.accessToken || null;
    o.accessToken = t.access_token;
    if (typeof t.refresh_token === 'string' && t.refresh_token) o.refreshToken = t.refresh_token;
    o.expiresAt = Date.now() + ((typeof t.expires_in === 'number' ? t.expires_in : 3600) * 1000);
    try { writeCredsBack(creds); }
    catch (e) { console.error('[agentnotch] creds write-back failed:', e && e.message); }
    return o.accessToken;
  } catch { return o.accessToken || null; }
}

async function fetchUsage() {
  const token = await getUsableToken();
  if (!token) return;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': 'agentnotch/0.1.0',
      },
    });
    if (res.status === 401) {
      // Token on disk expired. Claude Code refreshes ~/.claude/.credentials.json
      // itself while in use, and we re-read it on every call — so just drop the
      // stale cache (never show dead data) and retry next cycle with fresh token.
      usageCache = null;
      console.error('[agentnotch] usage fetch: 401 (token expired) — will retry next cycle');
      return;
    }
    if (!res.ok) return; // 429 etc — keep last good cache
    const j = await res.json();
    usageCache = { fetched_at: Date.now(), data: j };
  } catch { /* offline or DNS fail — keep cache */ }
}

// Extract pct_left + resets label from the /api/oauth/usage payload, guarding
// every field access — response shape drifts, so we return null on anything odd.
function pickWindow(data, key) {
  if (!data || typeof data !== 'object') return null;
  const w = data[key];
  if (!w || typeof w !== 'object') return null;
  // Common field name variants: utilization, used_percentage, percentage.
  const usedPct = pickNumber(w.utilization, w.used_percentage, w.percentage, w.percent_used);
  if (usedPct == null) return null;
  const pctLeftV = Math.max(0, Math.min(100, Math.round(100 - usedPct)));
  const resetsAt = w.resets_at || w.reset_at || w.reset || null;
  return { pct_left: pctLeftV, resets: fmtResetLabel(resetsAt) };
}

function pickNumber(...vals) {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function fmtResetLabel(raw) {
  if (!raw) return '';
  const ts = typeof raw === 'number' ? raw : Date.parse(raw);
  if (!Number.isFinite(ts)) return '';
  const now = Date.now();
  const d = new Date(ts);
  // Under 24h out → clock; otherwise → date.
  return (ts - now) < 24 * 3600 * 1000 ? fmtClock(ts) : fmtDate(ts);
}

function buildPayload() {
  const now = Date.now();
  // ponytail: 200 newest files per tick — enough for weeks of sessions; token
  // windows undercount only for users with >200 sessions inside 7 days.
  const files = discoverSessions().slice(0, 200);
  const all = files.map(f => parseSessionCached(f.path, f.mtime, f.size, now)).filter(Boolean);
  // Drop cache entries for files that vanished (deleted/rotated sessions).
  if (parseCache.size > files.length + 50) {
    const live = new Set(files.map(f => f.path));
    for (const key of parseCache.keys()) if (!live.has(key)) parseCache.delete(key);
  }

  // Drop empty / synthetic-only sessions.
  const real = all.filter(s => s._has_real_assistant);
  // Dedupe by cwd (fallback to project) — keep the most recent per project.
  // `real` is already mtime-desc from discoverSessions, so first-seen wins.
  // NOTE: card tokens_fmt shows only the surviving (newest) session's tokens;
  // totals.tokens_today sums ALL sessions. Asymmetry is intentional: the card
  // is "this conversation", the pill total is "everything today".
  const seenCwd = new Set();
  const deduped = [];
  for (const s of real) {
    const key = s.cwd || s.project;
    if (seenCwd.has(key)) continue;
    seenCwd.add(key);
    deduped.push(s);
  }
  // Drop cards the user dismissed — new activity on the session brings it back.
  const visible = deduped.filter(s => {
    const at = dismissedSessions.get(s.session_id);
    if (at === undefined) return true;
    if (s.mtime > at) { dismissedSessions.delete(s.session_id); return true; }
    return false;
  });
  const fresh = visible.filter(s => now - s.mtime <= FRESH_MS).slice(0, MAX_CARDS);
  const agents = fresh.map(s => ({
    id: s.session_id.slice(0, 8),
    sid: s.session_id,
    // A session untouched for 5+ min isn't "needs you" nor "working" — the
    // conversation simply ended. Downgrade to idle so orange means "answer me
    // to continue", not "a session exists".
    status: (now - s.mtime > 5 * 60 * 1000) ? 'idle' : s.status,
    project: s.project,
    branch: s.branch,
    last_action: s.last_action,
    model: s.model,
    context_pct: s.context_pct,
    tokens_fmt: fmtTokens(s.output_tokens_total),
    subagents: s.subagents || [],
    active_subagent: s.active_subagent || null,
    idle_s: Math.round((now - s.mtime) / 1000),
  }));

  const tokensToday = all.reduce((a, s) => a + s.tokens_today, 0);

  // Real plan usage from Anthropic API (only shown when we have live data).
  const data = usageCache && usageCache.data;
  const plan = {
    window_5h: pickWindow(data, 'five_hour'),
    window_7d: pickWindow(data, 'seven_day'),
  };

  return {
    agents,
    plan,
    approvals: pendingApprovals(),
    totals: {
      tokens_today: tokensToday,
      tokens_today_fmt: fmtTokens(tokensToday),
      needs_you_count: agents.filter(a => a.status === 'needs_you').length,
    },
  };
}

let mainWindow;
let tray;
let tickTimer;
let usageTimer;
let tickStopped = false;
let updateTimer;
let macBounds = null;     // { menuBarH, collapsed, expanded } — darwin only
let macHoverTimer = null;
let macExpanded = false;
let macPinned = false;
let macPanelH = 200;      // visible panel height reported by the renderer
let approvalServer = null;
let autoUpdater = null;   // set by setupAutoUpdate; null in dev or if require fails
let updateInfo = null;    // UpdateInfo once a newer release is known
let updateDownloaded = false;

function scheduleTick() {
  if (tickStopped) return;
  tickTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Hidden via tray toggle: keep the chain alive but skip the disk work.
    if (!mainWindow.isVisible()) { scheduleTick(); return; }
    try {
      mainWindow.webContents.send('telemetry', buildPayload());
    } catch (e) {
      console.error('[agentnotch] tick failed:', e && e.message);
    }
    scheduleTick();
  }, TICK_MS);
}

// mac notch mode: DOM hover is unreliable here — resizing the window under a
// stationary cursor fires spurious enter/leave pairs and the dot/panel swap
// oscillates. Instead the main process polls the real cursor position and is
// the single authority on expand/collapse; the renderer only animates.
function macHoverPoll() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const M = 10; // hysteresis margin so edge jitter doesn't flap
  if (!macExpanded) {
    const c = macBounds.collapsed;
    if (p.x >= c.x - M && p.x <= c.x + c.width + M && p.y >= c.y && p.y <= c.y + c.height + M) {
      macExpanded = true;
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.webContents.send('mac-expand', true);
    }
  } else {
    // Stay open while pinned or while an approval is waiting for the user.
    if (macPinned || pendings.size > 0) return;
    const e = macBounds.expanded;
    // Leave region = the visible panel (renderer-reported height), not the
    // whole window — the window is transparent below the panel.
    const bottom = e.y + Math.min(macPanelH + M, e.height);
    const inside = p.x >= e.x - M && p.x <= e.x + e.width + M
      && p.y >= e.y && p.y <= bottom;
    if (!inside) {
      macExpanded = false;
      mainWindow.webContents.send('mac-expand', false);
      // Let clicks fall through again once the CSS collapse played out.
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !macExpanded) {
          mainWindow.setIgnoreMouseEvents(true, { forward: true });
        }
      }, 460);
    }
  }
}

ipcMain.on('dismiss-session', (_e, sid) => {
  if (typeof sid !== 'string' || !sid) return;
  dismissedSessions.set(sid, Date.now());
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('telemetry', buildPayload()); } catch {}
  }
});

ipcMain.on('pin', (_e, pinned) => { macPinned = !!pinned; });
ipcMain.on('panel-h', (_e, px) => {
  if (typeof px === 'number' && px > 0) macPanelH = Math.round(px);
});

// Sync window size with the CSS transition. Grow BEFORE expanding CSS, shrink
// AFTER collapsing CSS — the window never clips the animation. Registered once
// at module level so repeat createWindow calls can't stack listeners.
let collapseTimer = null;
ipcMain.on('hover', (_e, inside) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (macBounds) return; // mac mode: macHoverPoll owns the window bounds
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  const b = mainWindow.getBounds();
  if (inside) {
    if (b.height !== EXPANDED_H) {
      mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: EXPANDED_H });
    }
  } else {
    collapseTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const c = mainWindow.getBounds();
      if (c.height !== COLLAPSED_H) {
        mainWindow.setBounds({ x: c.x, y: c.y, width: c.width, height: COLLAPSED_H });
      }
    }, 440);
  }
});

// --- approvals ---------------------------------------------------------------
// A Claude Code PreToolUse hook POSTs the pending tool call here and waits.
// The notch shows Allow/Deny (or the AskUserQuestion options); the hook echoes
// our JSON decision back to Claude Code. No decision within HOOK_WAIT_MS →
// 204 empty → the hook prints nothing and the normal terminal prompt runs.
const APPROVAL_PORT = 41999;
const HOOK_WAIT_MS = 22_000;
const HOOK_SCRIPT = path.join(os.homedir(), '.claude', 'agentnotch-hook.sh');
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const pendings = new Map(); // id -> { data, res, timer }
let pendingSeq = 0;

// Sessions the user removed from the notch (✕ on the card). Keyed by full
// session id → dismissal time; any newer activity on the file resurfaces it.
const dismissedSessions = new Map();

function hookDecision(permissionDecision, permissionDecisionReason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } };
}

// When the Claude desktop app is the frontmost app, the user is looking at its
// own permission prompt — the notch must not pop open nor stall the hook.
// Detected via lsappinfo (no extra macOS permissions needed). Any failure
// (timeout, unexpected output) falls back to the normal notch flow.
const CLAUDE_APP_BUNDLES = new Set([
  'com.anthropic.claudefordesktop',
  'com.anthropic.claude-code',
]);

function claudeAppIsFrontmost(cb) {
  if (process.platform !== 'darwin') { cb(false); return; }
  require('child_process').exec(
    'lsappinfo info -only bundleid `lsappinfo front`',
    { timeout: 1500 },
    (err, out) => {
      if (err || !out) { cb(false); return; }
      const m = String(out).match(/"?CFBundleIdentifier"?\s*=\s*"([^"]+)"/);
      cb(!!m && CLAUDE_APP_BUNDLES.has(m[1]));
    });
}

function notifyPendings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('telemetry', buildPayload()); } catch {}
  // A pending approval is a "needs you" moment — pop the notch open.
  if (pendings.size > 0 && macBounds && !macExpanded) {
    macExpanded = true;
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.webContents.send('mac-expand', true);
  }
}

function resolvePending(id, decision, reason, banner) {
  const p = pendings.get(id);
  if (!p) return;
  pendings.delete(id);
  clearTimeout(p.timer);
  try {
    p.res.writeHead(200, { 'Content-Type': 'application/json' });
    p.res.end(JSON.stringify(hookDecision(decision, reason)));
  } catch {}
  notifyPendings();
  // Each decision gets its confirmation banner. With more requests queued,
  // the panel re-expands right after the banner to show the next one;
  // otherwise it settles back into the bar.
  if (banner && macBounds && mainWindow && !mainWindow.isDestroyed()) {
    macExpanded = false;
    try { mainWindow.webContents.send('mac-banner', banner); } catch {}
    if (pendings.size > 0) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && pendings.size > 0 && !macExpanded) {
          macExpanded = true;
          mainWindow.setIgnoreMouseEvents(false);
          mainWindow.webContents.send('mac-expand', true);
        }
      }, 1400);
    } else {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !macExpanded) {
          mainWindow.setIgnoreMouseEvents(true, { forward: true });
        }
      }, 2400);
    }
  }
}

function startApprovalServer() {
  approvalServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      // Don't stall calls the session would auto-approve anyway (accept-edits
      // or bypass modes) — answer "no opinion" instantly and let them run.
      const mode = data.permission_mode || '';
      const autoOk = mode === 'bypassPermissions'
        || (mode === 'acceptEdits'
            && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(data.tool_name));
      if (autoOk) { res.writeHead(204); res.end(); return; }
      claudeAppIsFrontmost((inApp) => {
        // User is in the Claude app: answer "no opinion" right away so the
        // app's own prompt shows instantly and the notch stays collapsed.
        if (inApp) { try { res.writeHead(204); res.end(); } catch {} return; }
        const id = String(++pendingSeq);
        const timer = setTimeout(() => {
          pendings.delete(id);
          try { res.writeHead(204); res.end(); } catch {}
          notifyPendings();
        }, HOOK_WAIT_MS);
        pendings.set(id, { data, res, timer });
        notifyPendings();
      });
    });
  });
  approvalServer.on('error', (e) => console.error('[agentnotch] approval server:', e && e.message));
  approvalServer.listen(APPROVAL_PORT, '127.0.0.1');
}

function pendingApprovals() {
  const out = [];
  for (const [id, p] of pendings) {
    const d = p.data || {};
    const tool = d.tool_name || '?';
    const inp = (d.tool_input && typeof d.tool_input === 'object') ? d.tool_input : {};
    let summary = tool;
    let options = null;
    if (tool === 'AskUserQuestion') {
      const q = Array.isArray(inp.questions) && inp.questions[0] ? inp.questions[0] : null;
      summary = q && q.question ? q.question : 'Claude asks';
      options = q && Array.isArray(q.options)
        ? q.options.map(o => o && o.label).filter(Boolean).slice(0, 4) : [];
    } else if (tool === 'Bash' && typeof inp.command === 'string') {
      summary = inp.command.slice(0, 120);
    } else if (typeof inp.file_path === 'string') {
      summary = inp.file_path;
    }
    out.push({ id, session_id: d.session_id || '', tool, summary, options });
  }
  return out;
}

ipcMain.on('decision', (_e, msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { id, decision, answer } = msg;
  if (decision === 'allow') {
    resolvePending(String(id), 'allow', 'Approved from AgentNotch', { text: 'Aprovado', ok: true });
  } else if (decision === 'answer') {
    const ans = String(answer).slice(0, 200);
    resolvePending(String(id), 'deny', `The user answered: "${ans}"`, { text: ans.slice(0, 28), ok: true });
  } else {
    resolvePending(String(id), 'deny', 'Denied from AgentNotch', { text: 'Negado', ok: false });
  }
});

// Writes the bridge script and registers it in ~/.claude/settings.json.
// Only ever called from an explicit user action (tray menu).
function installApprovalHook() {
  const script = `#!/bin/sh
# AgentNotch approval bridge (PreToolUse). Reads the hook JSON from stdin,
# asks the notch, prints the decision. No output = normal terminal prompt.
curl -s -m 25 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${APPROVAL_PORT}/hook 2>/dev/null || true
`;
  fs.writeFileSync(HOOK_SCRIPT, script, { mode: 0o755 });
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  if (!s || typeof s !== 'object') s = {};
  s.hooks = (s.hooks && typeof s.hooks === 'object') ? s.hooks : {};
  const arr = Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : (s.hooks.PreToolUse = []);
  if (!JSON.stringify(arr).includes('agentnotch-hook')) {
    arr.push({
      matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit|AskUserQuestion',
      hooks: [{ type: 'command', command: HOOK_SCRIPT, timeout: 30 }],
    });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  }
  console.log('[agentnotch] approval hook installed');
}

function uninstallApprovalHook() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (s.hooks && Array.isArray(s.hooks.PreToolUse)) {
      s.hooks.PreToolUse = s.hooks.PreToolUse.filter(h => !JSON.stringify(h).includes('agentnotch-hook'));
      if (!s.hooks.PreToolUse.length) delete s.hooks.PreToolUse;
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
    }
  } catch {}
  try { fs.unlinkSync(HOOK_SCRIPT); } catch {}
  console.log('[agentnotch] approval hook removed');
}

function approvalHookInstalled() {
  try { return JSON.stringify(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).hooks || {}).includes('agentnotch-hook'); }
  catch { return false; }
}

// --- auto-update -------------------------------------------------------------
// Windows/AppImage: full auto-update — download in background, install on quit.
// macOS builds are unsigned and Squirrel.Mac refuses unsigned installs, and
// .deb installs have no APPIMAGE to swap, so on those we only detect the new
// version and offer the release page in the tray menu.
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
const RELEASES_URL = 'https://github.com/Yanss12/agentnotch/releases/latest';

function canAutoInstall() {
  if (process.platform === 'darwin') return false;
  if (process.platform === 'linux' && !process.env.APPIMAGE) return false;
  return true;
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { console.error('[agentnotch] updater unavailable:', e && e.message); return; }

  autoUpdater.autoDownload = canAutoInstall();
  autoUpdater.on('error', (e) => console.error('[agentnotch] update error:', e && e.message));
  autoUpdater.on('update-available', (info) => { updateInfo = info; refreshTrayMenu(); });
  autoUpdater.on('update-downloaded', () => { updateDownloaded = true; refreshTrayMenu(); });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  updateTimer = setInterval(check, UPDATE_CHECK_MS);
}

function buildTrayMenu() {
  const items = [
    {
      label: 'Mostrar/Ocultar',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
      },
    },
    {
      label: 'Aprovações no notch (Claude Code)',
      type: 'checkbox',
      checked: approvalHookInstalled(),
      click: (item) => {
        item.checked ? installApprovalHook() : uninstallApprovalHook();
        refreshTrayMenu();
      },
    },
  ];
  if (updateDownloaded) {
    items.push({ type: 'separator' }, {
      label: `Reiniciar e atualizar (v${updateInfo.version})`,
      click: () => autoUpdater.quitAndInstall(),
    });
  } else if (updateInfo) {
    items.push({ type: 'separator' }, {
      label: canAutoInstall()
        ? `Baixando v${updateInfo.version}…`
        : `Baixar v${updateInfo.version}…`,
      enabled: !canAutoInstall(),
      click: () => shell.openExternal(RELEASES_URL),
    });
  }
  items.push({ type: 'separator' }, { label: 'Sair', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;
  let x = Math.round((width - WIDTH) / 2) + display.workArea.x;
  let y = display.workArea.y;
  let winW = WIDTH;
  let winH = COLLAPSED_H;

  if (MAC_NOTCH) {
    const b = display.bounds;
    // workArea.y - bounds.y is the menu bar height (~38px on notched Macs).
    const menuBarH = Math.max(24, display.workArea.y - b.y);
    macBounds = {
      menuBarH,
      // Hover target while collapsed: the black bar hugging the notch.
      collapsed: {
        x: b.x + Math.round((b.width - MAC_BAR_W) / 2),
        y: b.y, width: MAC_BAR_W, height: menuBarH,
      },
      // The window's one and only geometry — it is never resized.
      expanded: {
        x: b.x + Math.round((b.width - MAC_W) / 2),
        y: b.y, width: MAC_W, height: EXPANDED_H + menuBarH,
      },
    };
    ({ x, y, width: winW, height: winH } = macBounds.expanded);
  }

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,                // start small; window resizes on hover
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,            // HUD: never steals focus, never minimizes on click-away
    type: process.platform === 'linux' ? 'toolbar' : undefined,
    backgroundColor: '#00000000',
    roundedCorners: false,       // let CSS border-radius handle it, no compositor frame
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  if (macBounds) {
    // macOS clamps y=0 below the menu bar at creation time; once the window
    // level is elevated, re-apply the bounds so the bar sits over the band.
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setBounds(macBounds.expanded);
    // Collapsed, the window is a transparent full-size sheet — clicks must
    // fall through to whatever is underneath. The poller flips this on hover.
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    if (macHoverTimer) clearInterval(macHoverTimer);
    macHoverTimer = setInterval(macHoverPoll, 120);
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile('index.html', MAC_NOTCH
    ? { query: { mac: '1', menubar: String(macBounds.menuBarH) } }
    : undefined);
  if (process.env.AGENTNOTCH_DEBUG) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
      console.log(`[renderer:${level}] ${msg} (${path.basename(src || '')}:${line})`);
    });
  }

  // Kick off the plan-usage fetch (heavily rate-limited endpoint, so poll slow).
  fetchUsage();
  usageTimer = setInterval(fetchUsage, USAGE_FETCH_MS);

  // Initial push once the renderer is ready, then self-scheduling ticks
  // (setTimeout chain — never stacks if a tick's IO takes longer than TICK_MS).
  mainWindow.webContents.once('did-finish-load', () => {
    try { mainWindow.webContents.send('telemetry', buildPayload()); } catch (e) {}
    scheduleTick();
  });

  // Tray is the only quit affordance: the window is focusable:false and
  // skipTaskbar, so without this there is no way to close the app at all.
  // Wrapped: on desktops without a StatusNotifier host the Tray constructor
  // can throw, and the widget must still come up.
  try {
    const trayImg = nativeImage
      .createFromPath(path.join(__dirname, 'icon.png'))
      .resize({ width: 18, height: 18 });
    tray = new Tray(trayImg);
    tray.setToolTip('AgentNotch');
    tray.setContextMenu(buildTrayMenu());
  } catch (e) {
    console.error('[agentnotch] tray unavailable:', e && e.message);
  }
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdate();
  startApprovalServer();
});

// before-quit fires on BOTH quit paths (tray "Sair" -> app.quit() and window
// close); window-all-closed alone never fires for app.quit().
app.on('before-quit', () => {
  tickStopped = true;
  clearTimeout(tickTimer);
  clearInterval(usageTimer);
  clearInterval(updateTimer);
  clearInterval(macHoverTimer);
  // Release in-flight hooks with no decision — the terminal prompt takes over.
  for (const [, p] of pendings) {
    clearTimeout(p.timer);
    try { p.res.writeHead(204); p.res.end(); } catch {}
  }
  pendings.clear();
  if (approvalServer) { try { approvalServer.close(); } catch {} approvalServer = null; }
  if (tray) { tray.destroy(); tray = null; }
});

app.on('window-all-closed', () => {
  app.quit();
});

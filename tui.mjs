/**
 * tui.mjs — Terminal UI using raw ANSI sequences.
 *
 * Uses emitKeypressEvents for reliable keyboard input,
 * proper CJK character width calculation, and frame-dedup rendering.
 *
 * Layout: header / conversation (scrollable) / todo panel / input box / status bar
 */
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { basename } from "node:path";
import { runAgent, ContinueError } from "./agent.mjs";
import {
  saveSession, clearSession, archiveCurrent,
  listSlots, switchToSlot, sessionPath,
} from "./session.mjs";
import { closeAllMcp } from "./mcp.mjs";

const ESC = "\x1b";
const ansi = {
  hideCursor: `${ESC}[?25l`, showCursor: `${ESC}[?25h`,
  altBuffer: `${ESC}[?1049h`, mainBuffer: `${ESC}[?1049l`,
  mouseOn: `${ESC}[?1000h${ESC}[?1006h`, mouseOff: `${ESC}[?1000l${ESC}[?1006l`,
  home: `${ESC}[H`, clearLine: `${ESC}[K`, reset: `${ESC}[0m`,
  dim: `${ESC}[2m`, bold: `${ESC}[1m`,
  fg: (n) => `${ESC}[${30 + n}m`, gray: `${ESC}[90m`,
};
const orange = `${ESC}[38;2;246;168;36m`;
const yellow = `${ESC}[38;2;253;224;71m`;
const pasteYellow = `${ESC}[38;2;240;220;130m`;
const PASTE_TRUNCATE_LINES = 50;
const PASTE_PREVIEW_LINES = 80;

// Detect dark terminal background via COLORFGBG (format: "<fg>;<bg>").
// Dark backgrounds (index 0–7) need an explicit lighter foreground for
// reasoning text; light backgrounds (8–15) use the terminal's own dim.
const _cfbg = process.env.COLORFGBG;
const _isDarkBg = _cfbg ? parseInt((_cfbg.split(";")[1] ?? ""), 10) <= 7 : true;

const C = {
  user: yellow, assistant: orange, text: ansi.fg(7),
  reason: _isDarkBg
    ? `${ESC}[38;5;250m${ESC}[2m${ESC}[3m`
    : `${ESC}[2m${ESC}[3m`,
  tool: orange,
  error: ansi.fg(1), dim: ansi.gray, warn: ansi.fg(3),
};

// Semantic roles for persisted conversation lines. The session file stores
// only these role names — colors are terminal-only and defined here in code,
// so a restored session renders identically without ever writing ANSI to disk.
const ROLES = {
  ...C,
  paste: pasteYellow,
  labelUser: ansi.bold + yellow,
  labelAssistant: ansi.bold + orange,
  labelGoal: ansi.bold + orange,
  labelTool: ansi.bold + orange,
  labelWarn: ansi.bold + ansi.fg(3),
};

export function charWidth(cp) {
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd) || (cp >= 0x2600 && cp <= 0x27bf)) return 2;
  return 1;
}
export function stringWidth(text) { let w = 0; for (const ch of text) w += charWidth(ch.codePointAt(0)); return w; }
function sliceByWidth(text, maxWidth) {
  let w = 0, out = "";
  for (const ch of text) { const cw = charWidth(ch.codePointAt(0)); if (w + cw > maxWidth) break; w += cw; out += ch; }
  return out;
}
function padByWidth(text, width) { return text + " ".repeat(Math.max(0, width - stringWidth(text))); }

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g;
export function sanitizeDisplay(s) {
  if (typeof s !== "string") return "";
  return s.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/\t/g, "    ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/\n+$/, "");
}
export function wrapText(text, width) {
  const lines = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") { lines.push(""); continue; }
    let line = rawLine;
    while (stringWidth(line) > width) { const head = sliceByWidth(line, width); lines.push(head); line = line.slice([...head].length); }
    lines.push(line);
  }
  return lines;
}
export function layoutInput(chars, cursor, width) {
  const PROMPT = "> ";
  const lines = []; let cursorLine = 0, cursorCol = 0, cur = "", col = 0, firstLine = true;
  const avail = () => firstLine ? width - 2 : width;
  const flush = () => { lines.push((firstLine ? PROMPT : "") + cur); firstLine = false; cur = ""; col = 0; };
  for (let i = 0; i <= chars.length; i++) {
    if (i === cursor) { cursorLine = lines.length; cursorCol = (firstLine ? 2 : 0) + col; }
    const ch = chars[i]; if (ch === undefined) break;
    if (ch === "\n") { flush(); continue; }
    const w = charWidth(ch.codePointAt(0)); if (col + w > avail()) flush();
    cur += ch; col += w;
  }
  if (cur || lines.length === 0 || (chars.length > 0 && chars[chars.length - 1] === "\n")) flush();
  return { lines, cursorLine, cursorCol };
}
function summarize(args) {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args.slice(0, 100);
  const s = JSON.stringify(args); return s.length > 100 ? s.slice(0, 97) + "..." : s;
}
function formatPermission(name, args) {
  const cap = (s, n) => { if (typeof s !== "string") return ""; return s.length > n ? s.slice(0, n) + "\u2026" : s; };
  const base = name.includes("/") ? name.split("/").pop() : name;
  if (base === "bash") return cap(args.command ?? "", 1000).split("\n");
  if (base === "write") return [`${args.path} (${(args.content ?? "").length} b)`, ...cap(args.content ?? "", 1000).split("\n")];
  if (base === "edit") return [`${args.path}`, ...cap(args.old_string ?? "", 500).split("\n").map(l => "- " + l), "  \u2193", ...cap(args.new_string ?? "", 500).split("\n").map(l => "+ " + l)];
  if (base === "delete") return [`${args.path}${args.force ? " (force)" : ""}`];
  if (base === "subagent") return cap(args.task ?? "", 500).split("\n");
  return [cap(summarize(args), 300)];
}

export async function startTUI(agent, opts = {}) {
  if (!process.stdin.isTTY) throw new Error("TUI requires a TTY");
  const state = {
    lines: [], streaming: "", input: [], cursor: 0, history: [], historyIndex: -1,
    scroll: 0, processing: false, controller: null, permission: null, permissionPreview: [],
    question: null, goalMode: false, goal: agent.goal ? { objective: agent.goal.objective, turn: agent.goal.turnsUsed || 0, max: agent.config?.agent?.goalTurns || 200 } : null, tasks: agent.tasks ?? [], tokens: { prompt: 0, completion: 0, total: 0, cacheHit: 0, cacheMiss: 0, totalPrompt: 0, totalCompletion: 0, totalTotal: 0 },
    reasoning: "", toolStreams: {},
    subOutput: "", currentSub: null, currentTool: null, processingStarted: 0, status: "Ready",
    _nextBlockId: 0, _copyBlocks: new Map(), _copyZones: [],
  };
  if (state.tasks.length > 0 && state.tasks.every(t => t.status === "done")) state.tasks = [];

  const keyStream = new PassThrough();
  let mousePending = "", lastRenderedScroll = 0;
  emitKeypressEvents(keyStream);
  process.stdin.setRawMode(true);
  process.stdout.write(ansi.altBuffer + ansi.hideCursor + ansi.mouseOn);

  process.stdin.on("data", (chunk) => {
    let text = mousePending + chunk.toString("utf8"); mousePending = "";
    for (const m of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      const btn = Number(m[1]), col = Number(m[2]), row = Number(m[3]), act = m[4];
      if (btn === 64) state.scroll += 3;
      else if (btn === 65) state.scroll = Math.max(0, state.scroll - 3);
      else if (btn === 0 && act === "M") {
        for (const z of state._copyZones) {
          if (row === z.row && col >= z.col - 2 && col <= z.col) {
            const src = state.lines.find(l => l.blockId === z.blockId);
            const txt = src ? src.text : state._copyBlocks.get(z.blockId);
            if (txt) process.stdout.write(`\x1b]52;c;${Buffer.from(txt).toString("base64")}\x07`);
            break;
          }
        }
      }
    }
    text = text.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "");
    const tail = text.match(/\x1b\[<[\d;]*$/);
    if (tail) { mousePending = tail[0]; text = text.slice(0, -tail[0].length); }
    if (state.scroll !== lastRenderedScroll) { lastRenderedScroll = state.scroll; render(); }
    if (text) keyStream.write(text);
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return; cleanedUp = true;
    try { archiveCurrent(agent.cwd); saveSession(agent, state.lines); } catch { /* shutdown best-effort — nothing actionable left to do */ }
    try { closeAllMcp(agent); } catch { /* shutdown best-effort — child processes die with the process anyway */ }
    if (process.stdin.setRawMode) { try { process.stdin.setRawMode(false); } catch { /* terminal cleanup best-effort — process is exiting */ } }
    process.stdout.write(ansi.mouseOff + ansi.mainBuffer + ansi.showCursor + ansi.reset);
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const fmtK = n => n >= 10000 ? Math.round(n/1000) + "k" : n >= 1000 ? (n/1000).toFixed(1) + "k" : String(n);

  const pushLine = (text, role = "text", copyable = false) => {
    const line = { text, role };
    if (copyable) {
      line.blockId = ++state._nextBlockId;
      state._copyBlocks.set(line.blockId, text);
    }
    state.lines.push(line);
    if (state.lines.length > 5000) state.lines.splice(0, 1000);
    render();
  };
  const pushLabel = (text, role) => {
    if (state.lines.length > 0) state.lines.push({ text: "", role: "dim" });
    state.lines.push({ text, role }); render();
  };
  let assistantLabeled = false;
  const ensureAssistantLabel = () => {
    if (!assistantLabeled) { assistantLabeled = true; pushLabel("\u276f JuneCoder:", "labelAssistant"); }
  };

  let lastFrame = "", renderTimer = null;
  function scheduleRender() { if (renderTimer) return; renderTimer = setTimeout(() => { renderTimer = null; render(); }, 40); }

  function render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const W = Math.max(20, cols - 1);
    state._copyZones = [];

    const layout = layoutInput(state.input, state.cursor, W - 6);
    const MAX_INPUT_LINES = 10;
    let inputOffset = 0;
    if (layout.lines.length > MAX_INPUT_LINES) inputOffset = Math.min(layout.cursorLine, layout.lines.length - MAX_INPUT_LINES);
    const inputLines = layout.lines.slice(inputOffset, inputOffset + MAX_INPUT_LINES);
    if (layout.lines.length > MAX_INPUT_LINES) {
      inputLines.push(`(${layout.lines.length} lines total)`);
    }

    let boxLines = inputLines;
    if (state.question) {
      const q = state.question;
      boxLines = q.options.length > 0
        ? q.options.map((opt, i) => (i === (q.selected ?? 0) ? "\u25b8 " : "  ") + opt)
        : ["\u25b8 " + (q.answer ?? "")];
    }
    const inputBoxH = boxLines.length + 2;

    const MAX_TASK_LINES = 5;
    let visibleTasks = [];
    if (state.tasks.length <= MAX_TASK_LINES) visibleTasks = state.tasks;
    else {
      visibleTasks = [...state.tasks.filter(t => t.status === "in_progress"),
        ...state.tasks.filter(t => t.status === "pending"),
        ...state.tasks.filter(t => t.status === "done")].slice(0, MAX_TASK_LINES);
    }
    const taskPanelH = visibleTasks.length;
    const goalH = state.goal ? 1 : 0;
    const subOutLen = (state.subOutput && state.processing) ? wrapText(state.subOutput, W - 8).slice(-2).length : 0;
    const permPreviewLen = state.permission ? 1 + state.permissionPreview.reduce((s, l) => s + wrapText("  " + l, W - 1).length, 0) : 0;
    const convH = Math.max(1, rows - 1 - inputBoxH - 1 - taskPanelH - goalH - subOutLen - permPreviewLen);

    const convLines = [];
    for (let si = 0; si < state.lines.length; si++) {
      const l = state.lines[si];
      for (const wrapped of wrapText(sanitizeDisplay(l.text), W)) convLines.push({ text: wrapped, color: ROLES[l.role] || C.text, _si: si });
    }
    if (state.reasoning) { for (const wrapped of wrapText(sanitizeDisplay(state.reasoning), W)) convLines.push({ text: wrapped, color: C.reason }); }
    if (state.streaming) { for (const wrapped of wrapText(sanitizeDisplay(state.streaming), W)) convLines.push({ text: wrapped, color: C.text }); }
    const allStreams = Object.values(state.toolStreams).join("");
    if (allStreams) { const tail = sanitizeDisplay(allStreams.slice(-4000)); for (const wrapped of wrapText(tail, W)) convLines.push({ text: wrapped, color: C.dim }); }

    // Mark last wrapped line of each copyable block with ❐ icon
    for (let ci = 0; ci < convLines.length; ci++) {
      const si = convLines[ci]._si;
      if (si == null) continue;
      const src = state.lines[si];
      if (!src.blockId) continue;
      // Find the last convLine from the same source line
      let last = ci;
      while (last + 1 < convLines.length && convLines[last + 1]._si === si) last++;
      convLines[last].hasCopy = true;
      convLines[last].blockId = src.blockId;
      ci = last;
    }

    const maxScroll = Math.max(0, convLines.length - convH);
    state.scroll = Math.min(state.scroll, maxScroll);
    const end = convLines.length - state.scroll;
    const visible = convLines.slice(Math.max(0, end - convH), end);
    const out = [`${ansi.home}${ansi.bold}${C.tool}JuneCoder${ansi.reset}${ansi.dim} \u2502 ${sliceByWidth(agent.provider.model || "?", 30)} \u2502 ${sliceByWidth(basename(agent.cwd), Math.max(10, cols - 50))}${ansi.reset}${ansi.clearLine}`];

    const pad = convH - visible.length;
    for (let i = 0; i < pad; i++) out.push(ansi.clearLine);
    for (let vi = 0; vi < visible.length; vi++) {
      const l = visible[vi];
      let text = l.text;
      if (l.hasCopy) {
        const icon = " \u2750";
        text = padByWidth(sliceByWidth(l.text, W - stringWidth(icon)), W - stringWidth(icon)) + icon;
        state._copyZones.push({ row: 1 + pad + vi + 1, col: W, blockId: l.blockId });
      }
      out.push(`${l.color}${text}${ansi.reset}${ansi.clearLine}`);
    }

    for (const t of visibleTasks) {
      const mark = t.status === "done" ? "\u2713" : t.status === "in_progress" ? "\u25b6" : "\u25cb";
      const color = t.status === "done" ? `${C.dim}${ESC}[9m` : t.status === "in_progress" ? C.tool : C.text;
      out.push(`${color} ${mark} ${sliceByWidth(t.title, W)}${ansi.reset}${ansi.clearLine}`);
    }
    if (state.goal) {
      const g = state.goal;
      const budgetExhausted = g.turn >= g.max;
      const color = budgetExhausted ? C.warn : yellow;
      const status = budgetExhausted ? ' — budget exhausted' : '';
      out.push(`${color}Goal: ${sliceByWidth(g.objective, W - 25)}  turn ${g.turn}/${g.max}${status}${ansi.reset}${ansi.clearLine}`);
    }
    if (state.subOutput && state.processing) {
      for (const l of wrapText(state.subOutput, W - 8).slice(-2)) out.push(`${C.dim}[${state.currentSub}] ${l}${ansi.reset}${ansi.clearLine}`);
    }
    if (state.permission) {
      out.push(`${ansi.bold}${C.warn}\u276f Permission${ansi.reset}${ansi.clearLine}`);
      for (const line of state.permissionPreview) for (const wrapped of wrapText("  " + line, W)) out.push(`${C.warn}${wrapped}${ansi.reset}${ansi.clearLine}`);
    }

    let borderColor = C.tool, title;
    if (state.question) { borderColor = C.tool; title = " " + sliceByWidth(state.question.text, W - 6) + " "; }
    else if (state.permission?.reasonMode) { borderColor = C.warn; title = " Denied \u2014 why? (Enter to send, Esc to skip) "; }
    else if (state.permission) { borderColor = C.warn; title = state.permission.name === "continue" ? " Continue? (y/n) " : " Allow " + state.permission.name + "? (y/n/a) "; }
    else if (state.processing) title = " Processing... ";
    else if (state.goalMode) title = " Define your goal ";
    else if (setupMode) title = " API Key ";
    else title = " Input ";
    const topBorder = "\u256d\u2500" + title + "\u2500".repeat(Math.max(0, W - 3 - stringWidth(title))) + "\u256e";
    out.push(`${borderColor}${topBorder}${ansi.reset}${ansi.clearLine}`);
    for (let i = 0; i < boxLines.length; i++) {
      const content = padByWidth(boxLines[i], W - 4);
      out.push(`${borderColor}\u2502${ansi.reset} ${content} ${borderColor}\u2502${ansi.reset}${ansi.clearLine}`);
    }
    const bottomBorder = "\u2570" + "\u2500".repeat(W - 2) + "\u256f";
    out.push(`${borderColor}${bottomBorder}${ansi.reset}${ansi.clearLine}`);

    const scrollHint = state.scroll > 0 ? " \u2502 scroll:" + state.scroll : "";
    const taskHint = state.tasks.length > 0 ? " \u2502 \u2713" + state.tasks.filter(t => t.status === "done").length + "/" + state.tasks.length : "";
    const tk = state.tokens;
    const tokenHint = tk.prompt > 0 ? " \u2502 \u2191" + fmtK(tk.prompt) + " \u2193" + fmtK(tk.completion) : "";
    const cacheHint = tk.prompt > 0 && tk.cacheHit > 0 ? " \u2502 Hit " + Math.round(tk.cacheHit / tk.prompt * 100) + "%" : "";
    const elapsed = state.processing ? " " + Math.floor((Date.now() - state.processingStarted)/1000) + "s" : "";
    const toolHint = state.currentTool ? " " + state.currentTool + "\u2026" : "";
    const statusText = state.processing ? state.status + toolHint + elapsed : state.status;
    const ctxWindow = agent.config?.agent?.contextWindow ?? 1_000_000;
    const ctxTokens = state.tokens.total || agent._lastTotalTokens || 0;
    const ctxPct = ctxTokens > 0 ? Math.round((ctxTokens / ctxWindow) * 100) : 0;
    const ctxHint = ctxTokens > 0 ? (ctxPct >= 80 ? " \u2502 " + C.warn + "ctx " + fmtK(ctxTokens) + " " + ctxPct + "%" + ansi.reset + ansi.dim : " \u2502 ctx " + fmtK(ctxTokens) + " " + ctxPct + "%") : "";
    let statusLine = statusText + taskHint + tokenHint + cacheHint + ctxHint + scrollHint + " \u2502 Enter:send Option+Enter:newline \u2502 /:cmds \u2502 Ctrl+C:quit";
    const autoBanner = agent.autoApprove ? C.warn + "AUTO" + ansi.reset + ansi.dim + "\u2502" : "";
    const planBanner = agent.planMode ? C.tool + "PLAN" + ansi.reset + ansi.dim + "\u2502" : "";
    statusLine = sliceByWidth(statusLine, Math.max(10, W));
    out.push(ansi.dim + planBanner + autoBanner + (planBanner || autoBanner ? " " : "") + statusLine + ansi.reset + ansi.clearLine);

    const frame = out.join("\r\n");
    if (frame !== lastFrame) { lastFrame = frame; process.stdout.write(frame); }

    const inReason = state.permission?.reasonMode;
    if (state.question || (state.permission && !inReason) || (state.processing && !inReason)) process.stdout.write(ansi.hideCursor);
    else {
      const cursorRow = 1 + convH + taskPanelH + goalH + subOutLen + permPreviewLen + 2 + (layout.cursorLine - inputOffset);
      const cursorCol = 3 + layout.cursorCol;
      process.stdout.write(ESC + "[" + cursorRow + ";" + cursorCol + "H" + ansi.showCursor);
    }
  }
  process.stdout.on("resize", render);

  let lastKeyTime = 0;
  keyStream.on("keypress", (str, key) => {
    const now = Date.now();
    const isPasteBurst = (now - lastKeyTime) < 30;
    lastKeyTime = now;

    if (state.permission) {
      if (state.permission.reasonMode) {
        // In reason mode: Escape cancels, everything else passes through for typing
        if (key.name === "escape") {
          state.input = []; state.cursor = 0;
          const resolve = state.permission.resolve;
          state.permission = null; state.permissionPreview = [];
          state.status = state.processing ? "Processing..." : "Ready";
          resolve({ allowed: false });
          render(); return;
        }
        // Fall through to normal key handling (typing, Enter→submit, Ctrl+C, etc.)
      } else {
        const ch = (str || key.name || "").toLowerCase();
        if (ch === "y" || key.name === "y") state.permission.resolve({ allowed: true });
        else if (ch === "a" || key.name === "a") { agent.autoApprove = true; state.permission.resolve({ allowed: true }); pushLine("  [auto] Auto-approve ON.", "warn"); }
        else if (ch === "n" || key.name === "n") {
          // Enter reason mode
          state.permission.reasonMode = true;
          state.input = []; state.cursor = 0;
          state.status = "Denied — why? (Enter to send, Esc to skip)";
          render();
          return;
        }
        else return;
        state.permission = null; state.permissionPreview = []; state.status = state.processing ? "Processing..." : "Ready"; render(); return;
      }
    }
    if (state.question) {
      if (key.name === "return" || key.name === "enter") {
        if ((key.shift || key.meta || isPasteBurst) && state.question.options.length === 0) { state.input.splice(state.cursor, 0, "\n"); state.cursor++; render(); return; }
        const answer = state.question.options.length > 0 ? state.question.options[state.question.selected ?? 0] ?? "" : state.input.join("").trim();
        state.input = []; state.cursor = 0; const resolve = state.question.resolve; state.question = null;
        resolve(answer); state.status = state.processing ? "Processing..." : "Ready"; render(); return;
      }
      if (key.name === "escape") { const resolve = state.question.resolve; state.question = null; resolve(""); state.status = state.processing ? "Processing..." : "Ready"; render(); return; }
      if (state.question.options.length > 0 && (key.name === "up" || key.name === "down")) {
        state.question.selected = state.question.selected ?? 0; state.question.selected += key.name === "up" ? -1 : 1;
        if (state.question.selected < 0) state.question.selected = state.question.options.length - 1;
        if (state.question.selected >= state.question.options.length) state.question.selected = 0; render(); return;
      }
      // Direct y/n shortcuts for yes/no questions
      if (state.question.options.length > 0 && (key.name === "y" || key.name === "n")) {
        const target = key.name === "y" ? "yes" : "no";
        const idx = state.question.options.findIndex(opt => opt.toLowerCase().startsWith(target));
        if (idx >= 0) {
          const answer = state.question.options[idx];
          state.input = []; state.cursor = 0; const resolve = state.question.resolve; state.question = null;
          resolve(answer); state.status = state.processing ? "Processing..." : "Ready"; render(); return;
        }
      }
      if (state.question.options.length === 0) { editInput(str, key); render(); return; }
      return;
    }
    if (key.name === "c" && key.ctrl) {
      if (state.processing && state.controller) { state.controller.abort(); state.status = "Aborting..."; render(); }
      else { cleanup(); process.exit(0); }
      return;
    }
    if (key.name === "d" && key.ctrl && state.input.length === 0) { cleanup(); process.exit(0); return; }
    if (key.name === "l" && key.ctrl) { process.stdout.write(ansi.home + ESC + "[2J"); lastFrame = ""; render(); return; }
    if (key.name === "return" || key.name === "enter") {
      if (key.shift || key.meta || isPasteBurst) { state.input.splice(state.cursor, 0, "\n"); state.cursor++; render(); return; }
      submit(); return;
    }

    if (key.name === "pageup") { state.scroll += (rows - 4); render(); return; }
    if (key.name === "pagedown") { state.scroll = Math.max(0, state.scroll - (rows - 4)); render(); return; }
    editInput(str, key);
    if (isPasteBurst) scheduleRender(); else render();
  });

  function editInput(str, key) {
    if (key.name === "backspace") { if (state.cursor > 0) { state.input.splice(state.cursor - 1, 1); state.cursor--; } return; }
    if (key.name === "delete") { if (state.cursor < state.input.length) state.input.splice(state.cursor, 1); return; }
    if (key.name === "left") { if (state.cursor > 0) state.cursor--; return; }
    if (key.name === "right") { if (state.cursor < state.input.length) state.cursor++; return; }
    if (key.name === "up") { moveCursorVert(-1); return; }
    if (key.name === "down") { moveCursorVert(1); return; }
    if (key.name === "home") { state.cursor = 0; return; }
    if (key.name === "end") { state.cursor = state.input.length; return; }
    if (key.name === "k" && key.ctrl) { state.input = state.input.slice(0, state.cursor); return; }
    if (key.name === "u" && key.ctrl) { state.input = state.input.slice(state.cursor); state.cursor = 0; return; }
    if (key.name === "w" && key.ctrl) { while (state.cursor > 0 && state.input[state.cursor-1] === " ") { state.input.splice(state.cursor-1, 1); state.cursor--; } while (state.cursor > 0 && state.input[state.cursor-1] !== " ") { state.input.splice(state.cursor-1, 1); state.cursor--; } return; }
    if (str && str.length > 0 && !key.ctrl && !key.meta && str !== "\r" && str !== "\n") { for (const ch of str) { state.input.splice(state.cursor, 0, ch); state.cursor++; } }
  }

  function moveCursorVert(dir) {
    let lineStart = state.cursor;
    while (lineStart > 0 && state.input[lineStart - 1] !== "\n") lineStart--;
    const col = state.cursor - lineStart;
    if (dir < 0) {
      if (lineStart === 0) return;
      let prevEnd = lineStart - 1;
      let prevStart = prevEnd;
      while (prevStart > 0 && state.input[prevStart - 1] !== "\n") prevStart--;
      state.cursor = prevStart + Math.min(col, prevEnd - prevStart);
    } else {
      let lineEnd = state.cursor;
      while (lineEnd < state.input.length && state.input[lineEnd] !== "\n") lineEnd++;
      if (lineEnd >= state.input.length) return;
      let nextStart = lineEnd + 1;
      let nextEnd = nextStart;
      while (nextEnd < state.input.length && state.input[nextEnd] !== "\n") nextEnd++;
      state.cursor = nextStart + Math.min(col, nextEnd - nextStart);
    }
  }

  // ─── First-run setup: capture API key from input box ──────────────────────────
  let setupMode = opts.needsSetup;
  if (setupMode) {
    pushLine("", "dim");
    pushLine("", "dim");
    pushLine("", "dim");
    pushLine("Welcome to JuneCoder!", "labelAssistant");
    pushLine("Before you start, you need a DeepSeek API key.", "text");
    pushLine("Get one at: https://platform.deepseek.com/api_keys", "dim");
    pushLine("", "dim");
    state.status = "Paste your DeepSeek API key and press Enter";
  }

  async function submit() {
    const text = state.input.join("").trim();
    if (!text && !state.permission?.reasonMode) return;
    if (state.processing && !state.permission?.reasonMode) return;

    // ─── Permission reason mode ────────────────────────────────────────────
    if (state.permission?.reasonMode) {
      const reason = text;
      state.input = []; state.cursor = 0;
      const resolve = state.permission.resolve;
      state.permission = null; state.permissionPreview = [];
      state.status = state.processing ? "Processing..." : "Ready";
      pushLine("  [denied] " + (reason || "(no reason)"), "warn");
      resolve({ allowed: false, reason: reason || undefined });
      render(); return;
    }

    // ─── Setup mode: first input is the API key ──────────────────────────────
    if (setupMode) {
      state.input = []; state.cursor = 0;
      const trimmed = text.trim();

      // Allow slash commands to pass through during setup (e.g. /key cancel)
      if (trimmed.startsWith("/")) {
        setupMode = false;
        await handleSlash(trimmed);
        return;
      }

      // Empty input: exit on first-run, cancel on re-key
      if (!trimmed) {
        if (agent.provider.apiKey) {
          // Already have a key — user is just changing their mind
          setupMode = false;
          pushLine("Key unchanged.", "dim");
          state.status = "Ready";
          render();
          return;
        }
        pushLine("No API key provided. Exiting.", "error");
        render();
        await new Promise(r => setTimeout(r, 1500));
        cleanup();
        process.exit(1);
      }

      if (!trimmed.startsWith("sk-")) {
        pushLine("Invalid key — DeepSeek API keys must start with 'sk-'. Try again:", "error");
        pushLine("", "dim");
        setupMode = true;
        state.status = "Paste your DeepSeek API key and press Enter";
        render();
        return;
      }

      const { saveApiKey } = await import('./config-provider.mjs');
      saveApiKey('deepseek', trimmed);
      agent.provider.apiKey = trimmed;

      pushLine("API key saved to ~/.junecoder/config.json", "tool");
      pushLine("", "dim");
      setupMode = false;
      state.status = "Ready";
      render();
      return;
    }

    state.input = []; state.cursor = 0; state.history.push(text); state.historyIndex = -1; state.scroll = 0;
    if (text.startsWith("/")) { await handleSlash(text); return; }
    if (state.goalMode) {
      state.goalMode = false;
      const goalText = text;
      // Ask about auto permissions before launching the goal
      state.question = {
        text: "Auto permissions? (y/n)",
        options: ["No (ask each time)", "Yes (run uninterrupted)"],
        selected: 1,
        resolve: async (answer) => {
          if (answer.startsWith("Yes")) {
            agent.autoApprove = true;
            pushLine("  [auto] Auto-approve ON for goal mode.", "warn");
          }
          const goalTurns = agent.config?.agent?.goalTurns || 200;
          agent.goal = {
            objective: goalText,
            criteria: '',
            startedAt: Date.now(),
            status: 'active',
            turnsUsed: 0,
            _blockTally: null,
          };
          state.goal = { objective: goalText, turn: 0, max: goalTurns };
          await doRun(goalText);
        }
      };
      state.status = "Auto permissions?";
      render();
      return;
    }
    await doRun(text);
  }

  async function doRun(text) {
    const isGoal = agent.goal?.status === 'active';
    pushLabel(isGoal ? "\u276f Goal:" : "\u276f You:", isGoal ? "labelGoal" : "labelUser");
    const pasteLines = text.split("\n").length;
    if (pasteLines <= PASTE_TRUNCATE_LINES) {
      pushLine(text, "text");
    } else {
      const preview = text.split("\n").slice(0, PASTE_PREVIEW_LINES).join("\n");
      pushLine(preview + `\n\u2026 (${pasteLines} lines total)`, "paste");
    }
    assistantLabeled = false; state.processing = true; state.status = "Processing...";
    state.streaming = ""; state.reasoning = ""; state.currentTool = null; state.toolStreams = {}; state.subOutput = "";
    state.processingStarted = Date.now(); state.controller = new AbortController();
    const ticker = setInterval(() => { if (state.processing) render(); }, 1000); render();
    const callbacks = {
      onToken: t => { ensureAssistantLabel(); if (!state.streaming && state.reasoning) { pushLine(state.reasoning, "reason", true); state.reasoning = ''; } state.streaming += t; scheduleRender(); },
      onReasoning: t => { ensureAssistantLabel(); if (state.streaming) { pushLine(state.streaming, "text", true); state.streaming = ''; } state.reasoning += t; scheduleRender(); },
      onToolCall: (name, args) => { flushStream(); ensureAssistantLabel(); state.currentTool = name; const summary = summarize(args); pushLine("  [tool] " + name + (summary && summary !== '{}' ? " " + summary : ""), "tool"); },
      onToolResult: (name, output, error) => { state.currentTool = null; const text = error ? "Error: " + error : (output || ""); const stream = state.toolStreams[name]; if (stream) { const tail = stream.trimEnd().slice(-4000); if (tail) pushLine(tail, "dim"); delete state.toolStreams[name]; } pushLine("  [done] " + name + " \u2192 " + sliceByWidth(sanitizeDisplay(text.split("\n")[0]), 100), "dim"); },
      onToolOutput: (name, output, error) => { state.toolStreams[name] = (state.toolStreams[name] ?? "") + (error ? "Error: " + error : (output || "")); scheduleRender(); },
      onPermissionRequest: (tool, args) => askPermission(tool.name || tool, args),
      onQuestion: async (q) => askQuestion(q),
      onCompress: (type) => pushLine(type === 'llm' ? "  [context] Summarized via LLM" : "  [context] Compressed (history truncated)", "warn"),
      onSystem: (type, msg) => { flushStream(); pushLine(`  [${type}] ${msg}`, "dim"); },
      onGoalProgress: (objective, turn, max) => { state.goal = { objective, turn, max }; render(); },
      onUsage: u => { state.tokens.prompt = u.prompt_tokens ?? 0; state.tokens.completion = u.completion_tokens ?? 0; state.tokens.total = u.total_tokens ?? 0; state.tokens.cacheHit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0; state.tokens.cacheMiss = u.prompt_cache_miss_tokens ?? 0; state.tokens.totalPrompt += u.prompt_tokens ?? 0; state.tokens.totalCompletion += u.completion_tokens ?? 0; state.tokens.totalTotal += u.total_tokens ?? 0; agent._lastTotalTokens = u.total_tokens ?? 0; },
      onTaskUpdate: items => { state.tasks = items || []; const done = items.filter(i => i.status === "done").length; const cur = items.find(i => i.status === "in_progress"); pushLine("  [task] " + done + "/" + items.length + (cur ? " \u25b6 " + cur.title : ""), "dim"); render(); },
      onTurnEnd: (() => { let n = 0; return () => { if (++n % 5 === 0) { try { saveSession(agent, state.lines); } catch { /* autosave best-effort — must not interrupt the loop */ } } }; })(),
    };
    for (let resume = false; ; resume = true) {
      try { await runAgent(agent, text, callbacks, { signal: state.controller.signal, resume }); flushStream(); break; }
      catch (error) { flushStream();
        if (error.name === "AbortError" || state.controller?.signal.aborted) { pushLine("[Aborted]", "warn"); break; }
        if (error instanceof ContinueError) { pushLabel("\u276f Continue", "labelWarn"); pushLine("Ran " + error.turn + " turns (limit " + error.turn + "). Continue?", "warn"); const willContinue = await new Promise(resolve => { state.permission = { name: "continue", args: { turns: error.turn }, resolve, reasonMode: false }; state.status = "Continue after " + error.turn + " turns?"; render(); }); state.permission = null; state.permissionPreview = []; if (!willContinue.allowed) { pushLine("[Cancelled]", "warn"); break; } pushLine("[Continuing\u2026]", "tool"); state.controller = new AbortController(); continue; }
        pushLine("[error] " + error.message, "error"); break;
      }
    }
    clearInterval(ticker); state.processing = false; state.controller = null; state.status = "Ready";
    if (state.tasks.length > 0 && state.tasks.every(t => t.status === "done")) { state.tasks = []; agent.tasks = []; }
    if (agent.goal?.status !== 'active') state.goal = null;
    try { saveSession(agent, state.lines); } catch { /* final save best-effort — render must run regardless */ } render();
  }

  function flushStream() { if (state.reasoning) { pushLine(state.reasoning, "reason", true); state.reasoning = ""; } if (state.streaming) { pushLine(state.streaming, "text", true); state.streaming = ""; } }
  function askPermission(name, args) { if (agent.autoApprove) { pushLine("  [auto] " + name + " " + summarize(args), "warn"); return Promise.resolve({ allowed: true }); } state.permissionPreview = formatPermission(name, args); return new Promise(resolve => { state.permission = { name, args, resolve, reasonMode: false }; state.status = "Waiting: " + name; render(); }); }
  function askQuestion(text) { if (state.question) return Promise.resolve("(already waiting)"); pushLabel("\u276f Question", "labelTool"); for (const line of text.split("\n")) pushLine("  " + line, "text"); return new Promise(resolve => { state.question = { text, options: [], resolve }; state.status = "Waiting..."; render(); }); }

  async function handleSlash(text) {
    const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case "help": for (const l of ["/help /goal /plan /auto /key /model /sessions /clear /tasks /stats /new /quit"]) pushLine(l, "dim"); break;
      case "goal": state.goalMode = true; state.status = "Define your goal and press Enter"; render(); break;
      case "plan": agent.planMode = !agent.planMode; pushLine("  Plan mode " + (agent.planMode ? "ON" : "OFF"), "tool"); break;
      case "auto": agent.autoApprove = !agent.autoApprove; pushLine("  Auto-approve " + (agent.autoApprove ? "ON" : "OFF"), agent.autoApprove ? "warn" : "tool"); break;
      case "model": {
        const { getProviderModels } = await import('./provider.mjs');
        const models = getProviderModels(agent.provider.type || 'deepseek');
        if (models.length === 0) { pushLine("No models for this provider.", "dim"); break; }
        const current = agent.provider.model;
        const options = models.map(m => m === current ? m + " (current)" : m);
        options.push("Cancel");
        state.question = {
          text: "Select model: (arrow keys, Enter to confirm)",
          options,
          resolve: async (answer) => {
            if (answer === "Cancel" || !answer) { pushLine("Cancelled.", "dim"); state.status = "Ready"; render(); return; }
            const model = answer.replace(" (current)", "");
            if (!models.includes(model)) { pushLine("Invalid model.", "error"); state.status = "Ready"; render(); return; }
            const { saveModel } = await import('./config-provider.mjs');
            saveModel(agent.provider.type || agent.provider.name || 'deepseek', model);
            agent.provider.model = model;
            pushLine("Model switched to " + model, "tool");
            state.status = "Ready";
            render();
          }
        };
        state.status = "Select a model";
        render();
        break;
      }
      case "key": {
        pushLine("  Current key: " + (agent.provider.apiKey ? agent.provider.apiKey.slice(0, 8) + "..." : "(none)"), "dim");
        pushLine("  Paste a new key.", "tool");
        setupMode = true;
        state.status = "Paste your DeepSeek API key and press Enter";
        break;
      }
      case "sessions": case "session": {
        const slots = listSlots(agent.cwd);
        if (slots.length === 0) { pushLine("No saved sessions.", "dim"); break; }
        // Build options: each slot + "Cancel"
        const options = slots.map(s => "Switch to " + s.label);
        options.push("Cancel");
        state.question = {
          text: "Switch to which session? (arrow keys to select, Enter to confirm)",
          options,
          resolve: (answer) => {
            if (answer === "Cancel" || !answer) { pushLine("Cancelled.", "dim"); state.status = "Ready"; render(); return; }
            const idx = options.indexOf(answer);
            if (idx < 0 || idx >= slots.length) { pushLine("Invalid selection.", "error"); state.status = "Ready"; render(); return; }
            const slot = slots[idx];
            const data = switchToSlot(agent.cwd, slot.file);
            if (!data) { pushLine("Failed to switch session.", "error"); state.status = "Ready"; render(); return; }
            // Restore the session
            agent.history = data.history || [];
            state.lines = [];
            if (data.displayLines) {
              for (const raw of data.displayLines) {
                state.lines.push({ text: String(raw.text ?? ""), role: raw.role || "text" });
              }
            }
            if (data.goal) agent.goal = data.goal;
            if (data.tasks) { agent.tasks = data.tasks; state.tasks = data.tasks; }
            if (data.planMode !== undefined) agent.planMode = data.planMode;
            pushLine("Switched to " + slot.label, "tool");
            state.status = "Ready";
            render();
          }
        };
        state.status = "Select a session";
        render();
        break;
      }
      case "clear": archiveCurrent(agent.cwd); agent.history = []; state.lines = []; state.streaming = ""; state.reasoning = ""; state.tasks = []; agent.tasks = []; agent.goal = null; state.goal = null; state.scroll = 0; state._copyBlocks.clear(); state._nextBlockId = 0; pushLine("Cleared (archived).", "warn"); break;
      case "new": archiveCurrent(agent.cwd); agent.history = []; state.lines = []; state.streaming = ""; state.reasoning = ""; state.toolStreams = {}; state.tasks = []; agent.tasks = []; agent.goal = null; state.goal = null; state.scroll = 0; state.tokens = { prompt: 0, completion: 0, total: 0, cacheHit: 0, cacheMiss: 0, totalPrompt: 0, totalCompletion: 0, totalTotal: 0 }; delete agent._lastTotalTokens; state._copyBlocks.clear(); state._nextBlockId = 0; pushLine("New session.", "tool"); break;
      case "tasks": if (state.tasks.length === 0) pushLine("No tasks.", "dim"); else for (const t of state.tasks) pushLine("  " + (t.status === "done" ? "\u2713" : t.status === "in_progress" ? "\u25b6" : "\u25cb") + " " + t.title, "dim"); break;
      case "stats": pushLine("Last call: \u2191" + fmtK(state.tokens.prompt) + " \u2193" + fmtK(state.tokens.completion) + " | Session total: \u2191" + fmtK(state.tokens.totalPrompt) + " \u2193" + fmtK(state.tokens.totalCompletion) + " \u2211" + fmtK(state.tokens.totalTotal) + " | History: " + agent.history.length + " msgs" + (agent._lastTotalTokens ? " (" + fmtK(agent._lastTotalTokens) + " t)" : "") + " | Lines: " + state.lines.length, "dim"); break;
      case "quit": case "exit": cleanup(); process.exit(0); return;
      default: pushLine("Unknown: /" + cmd + " (try /help)", "error");
    }
    render();
  }

  const restored = opts.restored;
  if (restored && restored.displayLines) {
    for (const raw of restored.displayLines) {
      state.lines.push({ text: String(raw.text ?? ""), role: raw.role || "text" });
    }
    if (restored.history) agent.history = restored.history;
    if (restored.goal) agent.goal = restored.goal;
    if (restored.tasks) { agent.tasks = restored.tasks; state.tasks = restored.tasks; }
    if (restored.planMode !== undefined) agent.planMode = restored.planMode;
    state.status = "Session restored";
  } else if (!setupMode) {
    pushLine("", "dim");
    pushLine("JuneCoder TUI \u2014 " + (agent.provider.model || ""), "labelTool");
    pushLine("Type /help for commands, Ctrl+C to quit.", "dim");
    pushLine("", "dim");
  }
  render();
}

'use strict';
/*
 * Deborah Remote — Obsidian plugin (mobile + desktop)
 *
 *  1. Native stream view  : renders the live Claude-session prose from the
 *     todaystream service (SSE) inside an Obsidian pane, with a type-back box.
 *  2. Remote-control channel: holds an SSE connection to todaystream /cmd/stream
 *     and executes commands d2 pushes — open notes, flip Reading mode, run any
 *     command, edit the vault (full control). Acks results back.
 *
 *  Config (Settings → Deborah Remote): base URL + bearer. The bearer is stored
 *  only in this device's plugin data (never synced, never committed). It is
 *  effectively a root key — the command channel can edit your vault.
 *
 *  Plain CommonJS so it loads with no build step. Requires Obsidian 1.4+.
 */
const obsidian = require('obsidian');
const { Plugin, ItemView, Notice, MarkdownView, PluginSettingTab, Setting, FuzzySuggestModal, requestUrl } = obsidian;

const VIEW_TYPE = 'deborah-stream-view';

// The pane's layout is a vault note, so Sebastian restructures it in markdown
// rather than in this file. Deleting the note is safe — the view falls back to
// the fixed layout it had before 0.3.0.
const DRIVER_NOTE = '00-System/driver.md';
// Anchored to a whole line on purpose: the driver note DOCUMENTS its own markers
// in prose, and an unanchored match mounted every control twice (caught by test).
const SLOT_RE = /^%%driver:(actions|stream|input)%%[ \t]*$/m;

// iOS 18 can kill an SSE connection while readyState stays OPEN and no error
// fires — the pane looks live and is dead. There is no way to observe that
// directly, so we observe the ABSENCE of traffic instead: the daemon sends
// `ping` events, so a gap longer than this means the socket is a zombie.
const BEAT_TIMEOUT_MS = 45000;
const BEAT_CHECK_MS = 15000;

const DEFAULTS = {
  baseUrl: 'https://deborah-2.tail1fd1c8.ts.net/todaystream',
  bearer: '',
  remoteControl: true,
  // Per-DEVICE label, generated once on first load and then persisted. See ensureClientId().
  clientId: '',
  // Fenced 2026-08-30. `eval` runs arbitrary JS pushed from d2 (a NON-PHI box) inside
  // this vault. Default-deny: the op is refused unless this is explicitly turned on in
  // Settings, and it does not persist any grant beyond that toggle.
  allowEval: false,
};

// Explicit allow-list. Anything not named here is refused, so a future op added
// upstream is denied by default rather than silently granted.
const ALLOWED_OPS = ['hello', 'notice', 'open', 'openstream', 'mode', 'command',
                     'create', 'modify', 'append', 'delete'];

function trimBase(u) { return (u || '').replace(/\/+$/, ''); }

// Obsidian's markdown render helper moved between versions; support both.
async function renderMd(app, md, el, component) {
  try {
    if (obsidian.MarkdownRenderer && obsidian.MarkdownRenderer.render) {
      await obsidian.MarkdownRenderer.render(app, md, el, '', component);
      return;
    }
  } catch (e) { /* fall through */ }
  await obsidian.MarkdownRenderer.renderMarkdown(md, el, '', component);
}

/* ----------------------------------------------------------- stream view -- */
class StreamView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.es = null;
    this.live = false;
    this.lastAssistantEl = null;
    this.lastBeat = 0;
    this.staleEl = null;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Today Stream"; }
  getIcon() { return "radio"; }

  async onOpen() {
    this.contentEl.addClass('dbr-root');
    await this.build();
    this.connect();

    // Foregrounding is the only reliable moment to notice a zombie stream, so
    // always reconnect on it rather than trusting readyState.
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.resume('foreground');
    });
    this.registerInterval(window.setInterval(() => this.checkBeat(), BEAT_CHECK_MS));

    // Editing the driver note re-renders the pane, so the layout is live.
    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (f && f.path === DRIVER_NOTE) this.build();
    }));
  }

  async onClose() { this.disconnect(); }

  /* ---- layout, from the driver note ---- */

  // Returns { chunks, buttons } or null when the note is missing/has no markers.
  // A chunk is either {md} to render as markdown or {slot} to mount a control in.
  async readDriver() {
    const f = this.app.vault.getAbstractFileByPath(DRIVER_NOTE);
    if (!f) return null;
    let raw;
    try { raw = await this.app.vault.cachedRead(f); } catch (_) { return null; }

    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
    const buttons = [];
    const table = body.split(/^##\s+Buttons\s*$/m)[1];
    if (table) {
      for (const line of table.split('\n')) {
        const m = line.match(/^\|(.+)\|\s*$/);
        if (!m) continue;
        const cells = m[1].split('|').map((c) => c.trim());
        if (cells.length !== 3) continue;
        if (/^-+$/.test(cells[0].replace(/[:\s]/g, '')) || cells[0] === 'label') continue;
        if (!cells[2]) continue;
        buttons.push({ label: cells[0], icon: cells[1], prompt: cells[2] });
      }
    }

    // Everything from "## Buttons" on is configuration, not layout.
    const layout = body.split(/^##\s+Buttons\s*$/m)[0];
    const chunks = [];
    let rest = layout;
    for (;;) {
      const m = rest.match(SLOT_RE);
      if (!m) { chunks.push({ md: rest }); break; }
      chunks.push({ md: rest.slice(0, m.index) });
      chunks.push({ slot: m[1] });
      rest = rest.slice(m.index + m[0].length);
    }
    if (!chunks.some((c) => c.slot)) return null;
    return { chunks, buttons };
  }

  async build() {
    const root = this.contentEl;
    root.empty();

    const bar = root.createDiv('dbr-bar');
    this.dot = bar.createSpan('dbr-dot');
    bar.createSpan({ text: "Today's Note", cls: 'dbr-title' });
    this.status = bar.createSpan({ text: this.live ? 'live' : 'connecting…', cls: 'dbr-status' });
    if (this.live) this.dot.addClass('live');

    // The stale banner is the whole point of the beat check: a dead stream has
    // to SAY it is dead, because it looks identical to a quiet one.
    this.staleEl = root.createDiv('dbr-stale');
    this.staleEl.hide();

    const spec = await this.readDriver();
    this.feed = null; this.box = null; this.sendBtn = null;

    if (!spec) {
      this.mountSlot('stream', root);
      this.mountSlot('input', root);
    } else {
      for (const c of spec.chunks) {
        if (c.slot) { this.mountSlot(c.slot, root, spec.buttons); continue; }
        const md = (c.md || '').trim();
        if (!md) continue;
        const doc = root.createDiv('dbr-doc');
        renderMd(this.app, md, doc, this);
      }
      // Never render an unusable pane, whatever the note says.
      if (!this.feed) this.mountSlot('stream', root);
      if (!this.box) this.mountSlot('input', root);
    }
  }

  mountSlot(slot, root, buttons) {
    if (slot === 'stream') {
      if (this.feed) return;
      this.feed = root.createDiv('dbr-feed');
      return;
    }
    if (slot === 'input') {
      if (this.box) return;
      const foot = root.createDiv('dbr-foot');
      this.box = foot.createEl('textarea', { cls: 'dbr-box', attr: { rows: '1', placeholder: 'type back to the session…' } });
      this.sendBtn = foot.createEl('button', { text: 'Send', cls: 'dbr-send' });
      this.sendBtn.onclick = () => this.send();
      this.box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
      });
      return;
    }
    if (slot === 'actions') {
      const list = buttons || [];
      if (!list.length) return;
      const row = root.createDiv('dbr-actions');
      for (const b of list) {
        const el = row.createEl('button', { cls: 'dbr-action' });
        if (b.icon) el.createSpan({ cls: 'dbr-action-icon', text: b.icon });
        el.createSpan({ text: b.label });
        el.setAttr('aria-label', b.prompt);
        el.onclick = () => this.send(b.prompt);
      }
    }
  }

  /* ---- staying actually live ---- */

  resume(why) {
    // d2 now stamps every content frame with an SSE id, so a reconnect asks to
    // resume from the last one we actually saw instead of replaying the whole
    // backlog. Still announced, because a gap the server had to drop is worth
    // seeing in the feed.
    if (this.feed) this.feed.createDiv('dbr-sys').setText('— reconnected (' + why + ') —');
    this.connect();
  }

  checkBeat() {
    if (!this.es || !this.lastBeat) return;
    if (Date.now() - this.lastBeat < BEAT_TIMEOUT_MS) { this.setStale(false); return; }
    this.setStale(true);
    this.resume('stream went quiet');
  }

  setStale(on) {
    if (!this.staleEl) return;
    if (on) {
      this.staleEl.setText('stream went quiet — reconnecting');
      this.staleEl.show();
    } else {
      this.staleEl.hide();
    }
  }

  connect() {
    this.disconnect();
    const base = trimBase(this.plugin.settings.baseUrl);
    const bearer = this.plugin.settings.bearer;
    if (!bearer) { this.setStatus('no bearer — set it in settings', true); return; }
    // EventSource cannot set a Last-Event-ID header on a connection WE open, so
    // the resume point rides the query string. Its own automatic reconnects do
    // send the header, and the server prefers the header when both are present.
    let url = base + '/stream?bearer=' + encodeURIComponent(bearer);
    if (this.lastId) url += '&last_event_id=' + encodeURIComponent(this.lastId);
    try {
      this.es = new EventSource(url);
    } catch (e) { this.setStatus('connect failed', true); return; }
    this.lastBeat = Date.now();
    this.es.onopen = () => { this.dot.addClass('live'); this.setStatus('live'); this.setStale(false); };
    this.es.onerror = () => { this.dot.removeClass('live'); this.setStatus('reconnecting…'); };
    this.es.onmessage = (e) => {
      // Stamp on EVERY frame, pings included — that is what makes silence detectable.
      this.lastBeat = Date.now();
      this.setStale(false);
      // Only content frames carry an id; pings and sys frames deliberately do
      // not, so this never advances past something the server can replay.
      if (e.lastEventId) this.lastId = e.lastEventId;
      try { this.onEvent(JSON.parse(e.data)); } catch (_) {}
    };
  }
  disconnect() { if (this.es) { this.es.close(); this.es = null; } }

  setStatus(t, err) { if (this.status) { this.status.setText(t); this.status.toggleClass('dbr-err', !!err); } }

  atBottom() { return this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 90; }
  scroll() { this.feed.scrollTop = this.feed.scrollHeight; }

  onEvent(ev) {
    if (!ev || ev.kind === 'ping') return;
    const stick = this.atBottom();
    if (ev.kind === 'sys') {
      if (ev.content === '— live —') this.live = true;
      const d = this.feed.createDiv('dbr-sys'); d.setText(ev.content);
    } else if (ev.kind === 'user') {
      const d = this.feed.createDiv('dbr-msg dbr-user');
      d.createDiv({ cls: 'dbr-who', text: 'Sebastian' });
      const body = d.createDiv('dbr-md');
      renderMd(this.app, ev.content, body, this);
      this.lastAssistantEl = null;
    } else if (ev.kind === 'tool') {
      let host = this.lastAssistantEl;
      if (!host) { host = this.feed.createDiv('dbr-msg dbr-assistant'); host.createDiv({ cls: 'dbr-who', text: 'Deborah' }); this.lastAssistantEl = host; }
      const chip = host.createSpan('dbr-chip');
      chip.createSpan({ cls: 'dbr-chip-name', text: '⚙ ' + (ev.name || 'tool') });
      if (ev.content) chip.createSpan({ text: ' · ' + ev.content });
    } else if (ev.kind === 'text') {
      const d = this.feed.createDiv('dbr-msg dbr-assistant dbr-fade');
      d.createDiv({ cls: 'dbr-who', text: 'Deborah' });
      const body = d.createDiv('dbr-md');
      renderMd(this.app, ev.content, body, this);
      this.lastAssistantEl = d;
    }
    if (stick) this.scroll();
  }

  // `override` is a preset from the driver note's button row; without it the
  // text comes from the box. A preset must not clear what Sebastian was typing.
  async send(override) {
    const typed = override == null;
    const text = String(typed ? (this.box ? this.box.value : '') : override).trim();
    if (!text) return;
    if (this.sendBtn) this.sendBtn.disabled = true;
    try {
      const base = trimBase(this.plugin.settings.baseUrl);
      const r = await requestUrl({
        url: base + '/send?bearer=' + encodeURIComponent(this.plugin.settings.bearer),
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), throw: false,
      });
      if (r.status === 200) { if (typed && this.box) this.box.value = ''; }
      else { this.setStatus('send failed (' + r.status + ')', true); }
    } catch (e) { this.setStatus('send error', true); }
    if (this.sendBtn) this.sendBtn.disabled = false;
  }
}

/* ------------------------------------------------------- slice picker --- */
// Shown only when the active note's folder matches no slice scope. Slices come
// from d2's registry, so a slice added there needs no plugin change here.
class SlicePicker extends FuzzySuggestModal {
  constructor(app, names, onPick) { super(app); this.names = names; this.onPick = onPick; this.setPlaceholder('Send selection to which slice?'); }
  getItems() { return this.names; }
  getItemText(n) { return n; }
  onChooseItem(n) { this.onPick(n); }
}

/* --------------------------------------------------------------- plugin --- */

/* ------------------------------------------------- task wizard (0.4.0) --- */
// Clicking a task's BODY on 00-Home opens this: a stack of LG-style ask cards
// that asks HOW the task should be done, then hands the answers to a daemon
// agent on d2/mini/d1 via todaystream's /run. Spec + provenance:
// 01-Projects/ipad-livesync-finish/task-wizard-spec.md.
//
// The cards are DATA in exactly the AskUserQuestion shape ({header, question,
// multiSelect, options:[{label, description}]}) so that when card authoring
// moves from this static set to an agent that reads the task first, only the
// SOURCE of the array changes — the renderer and the prompt compiler do not.
const WIZARD_CARDS = [
  {
    key: 'approach',
    header: 'Approach',
    question: 'How should this get done?',
    multiSelect: false,
    options: [
      { label: 'Do it fully', description: 'Execute end to end. Only come back if genuinely blocked.' },
      { label: 'Draft for review', description: 'Produce the artifact and stop. Nothing outward, nothing sent.' },
      { label: 'Break it down', description: 'Turn it into a plan or sub-tasks. Do not execute yet.' },
      { label: 'Research it first', description: 'Gather what is needed and report back before acting.' },
    ],
  },
  {
    key: 'where',
    header: 'Where',
    question: 'Which box runs it?',
    multiSelect: false,
    options: [
      { label: 'd2', description: 'The ops box. Default. Non-PHI.' },
      { label: 'mini', description: 'The Mac Mini. Non-PHI. Use when the work needs macOS.' },
      { label: 'd1 (PHI)', description: 'The only worker allowed lead/PHI text. Output never streams back by design — read it on the d1 profiles frame.' },
    ],
  },
  {
    key: 'return',
    header: 'Return',
    question: 'How do I get the result?',
    multiSelect: true,
    options: [
      { label: 'Notify when done', description: 'A push when it lands. Nothing else.' },
      { label: 'Write to the thread', description: 'Jot the outcome into the owning project journal so /save folds it.' },
      { label: 'Draft into a note', description: 'Leave the artifact as a vault note I can open.' },
      { label: 'Stream into the console', description: 'Run it in the master session so it shows up live in Today Stream.' },
    ],
  },
];

// worker label -> registry key. d1 carries the PHI flag /run gates on.
const WORKER_MAP = { 'd2': { worker: 'd2', phi: false },
                     'mini': { worker: 'mini', phi: false },
                     'd1 (PHI)': { worker: 'd1', phi: true } };

// Compiles the answers into ONE prompt. Kept as a pure function of (task,
// answers) so it is testable without Obsidian — tests/test_wizard_prompt.mjs.
function compileWizardPrompt(task, answers, note) {
  const pick = (k) => (answers[k] || []);
  const label = (k) => pick(k).map((o) => o.label).join(', ');
  const lines = [];
  lines.push('TASK — from 00-Home, source ' + (task.path || '?') +
             (task.line == null ? '' : ':' + (task.line + 1)));
  lines.push(String(task.text || '').trim());
  lines.push('');
  lines.push('HOW SEBASTIAN WANTS IT DONE:');
  for (const card of WIZARD_CARDS) {
    const chosen = pick(card.key);
    if (!chosen.length) continue;
    lines.push('- ' + card.header + ': ' + chosen.map((o) => o.label).join(', '));
    for (const o of chosen) if (o.description) lines.push('    ' + o.description);
  }
  const extra = String(note || '').trim();
  if (extra) { lines.push(''); lines.push('HIS NOTE: ' + extra); }
  lines.push('');
  const ret = label('return');
  lines.push('Execute this now, autonomously. Do not ask a clarifying question — ' +
             'the cards above ARE the clarification. ' +
             (ret ? 'Return path: ' + ret + '.' : 'Report the outcome when done.'));
  return lines.join('\n');
}

// The modal. Tap-first and single-column on purpose: it has to work under a
// thumb on the iPad, which is a co-equal primary, not a fallback.
class TaskWizardModal extends obsidian.Modal {
  constructor(app, plugin, task) {
    super(app);
    this.plugin = plugin;
    this.task = task;
    this.answers = {};
    this.note = '';
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('deborah-wizard');
    contentEl.empty();

    contentEl.createEl('div', { text: 'How should this get done?', cls: 'dw-kicker' });
    const t = contentEl.createEl('div', { cls: 'dw-task' });
    t.setText(String(this.task.text || '').replace(/\s+/g, ' ').trim());

    for (const card of WIZARD_CARDS) this.renderCard(contentEl, card);

    const nb = contentEl.createEl('div', { cls: 'dw-card' });
    nb.createEl('div', { text: 'Anything specific', cls: 'dw-header' });
    const ta = nb.createEl('textarea', { cls: 'dw-note' });
    ta.rows = 3;
    ta.placeholder = 'Optional. Names, deadlines, the one constraint that matters.';
    ta.addEventListener('input', () => { this.note = ta.value; });

    const foot = contentEl.createEl('div', { cls: 'dw-foot' });
    this.status = foot.createEl('span', { cls: 'dw-status' });
    const cancel = foot.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => this.close();
    this.go = foot.createEl('button', { text: 'Dispatch', cls: 'mod-cta' });
    this.go.onclick = () => this.dispatch();

    // Defaults so a two-tap dispatch is possible: the most common answer is
    // preselected and he only touches the cards he wants to change.
    this.select(WIZARD_CARDS[0], WIZARD_CARDS[0].options[1]); // Draft for review
    this.select(WIZARD_CARDS[1], WIZARD_CARDS[1].options[0]); // d2
    this.select(WIZARD_CARDS[2], WIZARD_CARDS[2].options[0]); // Notify when done
  }

  renderCard(parent, card) {
    const box = parent.createEl('div', { cls: 'dw-card' });
    box.createEl('div', { text: card.header, cls: 'dw-header' });
    box.createEl('div', { text: card.question, cls: 'dw-q' });
    const opts = box.createEl('div', { cls: 'dw-opts' });
    card._els = new Map();
    for (const o of card.options) {
      const el = opts.createEl('div', { cls: 'dw-opt' });
      el.createEl('div', { text: o.label, cls: 'dw-opt-label' });
      if (o.description) el.createEl('div', { text: o.description, cls: 'dw-opt-desc' });
      el.addEventListener('click', () => this.select(card, o));
      card._els.set(o.label, el);
    }
  }

  select(card, option) {
    const cur = this.answers[card.key] || [];
    let next;
    if (card.multiSelect) {
      next = cur.some((o) => o.label === option.label)
        ? cur.filter((o) => o.label !== option.label)
        : cur.concat([option]);
    } else {
      next = [option];
    }
    this.answers[card.key] = next;
    if (card._els) {
      for (const [lab, el] of card._els) {
        el.toggleClass('is-picked', next.some((o) => o.label === lab));
      }
    }
  }

  async dispatch() {
    const where = (this.answers.where || [])[0];
    const w = WORKER_MAP[where ? where.label : 'd2'] || WORKER_MAP['d2'];
    const text = compileWizardPrompt(this.task, this.answers, this.note);
    this.go.disabled = true;
    this.status.setText('dispatching to ' + w.worker + '…');
    try {
      const r = await this.plugin.runOnWorker(text, w.worker, w.phi);
      if (r.ok) {
        new Notice('dispatched to ' + w.worker);
        this.close();
      } else {
        this.status.setText('refused: ' + (r.err || r.status));
        this.go.disabled = false;
      }
    } catch (e) {
      this.status.setText('error: ' + e.message);
      this.go.disabled = false;
    }
  }

  onClose() { this.contentEl.empty(); }
}

module.exports = class DeborahRemote extends Plugin {
  // Several surfaces (Mac, iPad) hold the command channel open at once. A push
  // therefore fans out to all of them and an ack used to come back anonymous, so
  // when a pushed command ran on the iPad rather than the Mac the ack could not
  // say so. Each device now labels itself; the label is generated ONCE and
  // persisted in data.json, which is per-device and gitignored, so the Mac and
  // the iPad never end up sharing one.
  ensureClientId() {
    if (this.settings.clientId) return this.settings.clientId;
    const P = (obsidian && obsidian.Platform) || {};
    const kind = P.isIosApp ? 'ios' : P.isAndroidApp ? 'android'
      : P.isMacOS ? 'mac' : P.isWin ? 'win' : P.isLinux ? 'linux'
      : P.isMobile ? 'mobile' : 'desktop';
    let rand = '';
    try {
      const b = new Uint8Array(2);
      crypto.getRandomValues(b);
      rand = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      rand = Math.floor(Math.random() * 65536).toString(16).padStart(4, '0');
    }
    this.settings.clientId = kind + '-' + rand;
    // Fire-and-forget: a failed save just means a new label next launch, which is
    // cosmetic. Never block startup on it.
    this.saveSettings().catch(() => {});
    return this.settings.clientId;
  }

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.ensureClientId();
    this.cmdEs = null;
    this.cmdRetry = null;

    this.registerView(VIEW_TYPE, (leaf) => new StreamView(leaf, this));
    this.addRibbonIcon('radio', 'Today Stream', () => this.activateStreamView());
    this.addCommand({ id: 'open-today-stream', name: 'Open Today Stream', callback: () => this.activateStreamView() });
    this.addCommand({ id: 'reconnect-remote', name: 'Reconnect remote-control channel', callback: () => this.connectCmd() });
    // A DEFAULT HOTKEY IS LOAD-BEARING, not a convenience: invoking this from the
    // command palette collapses the editor selection, so getSelection() comes back
    // empty and the router refuses. Fire it with the hotkey, never via Cmd+P.
    this.addCommand({ id: 'send-selection-to-slice', name: 'Send selection to slice pane',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'K' }],
      editorCallback: (editor, view) => this.sendSelectionToSlice(editor, view) });
    this.addSettingTab(new SettingsTab(this.app, this));

    if (this.settings.remoteControl) this.connectCmd();
  }

  onunload() { this.disconnectCmd(); }

  /* ---- task wizard + tick side-effects (0.4.0) ---- */
  // 00-Home's dataviewjs task block calls these two. Both are defensive: if the
  // plugin is missing or misconfigured the note still ticks, it just loses the
  // side-effects. The note must never depend on this file to render.

  openTaskWizard(task) {
    if (!task || !task.text) { new Notice('no task to dispatch'); return; }
    new TaskWizardModal(this.app, this, task).open();
  }

  // POST /run — the daemon-agent path. Distinct from /send, which injects into
  // the session Sebastian is sitting in; /run spawns work on a named worker so a
  // dispatch does not steal his live pane.
  async runOnWorker(text, worker, phi) {
    const base = trimBase(this.settings.baseUrl);
    if (!this.settings.bearer) return { ok: false, err: 'no bearer configured' };
    const r = await requestUrl({
      url: base + '/run?bearer=' + encodeURIComponent(this.settings.bearer),
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, worker, phi: !!phi }), throw: false,
    });
    if (r.status === 200) return Object.assign({ ok: true }, r.json || {});
    return { ok: false, status: r.status, err: (r.json && r.json.err) || ('http ' + r.status) };
  }

  // The owning thread of a task is whatever 01-Projects/<slug>/ a wikilink in
  // its text resolves to. No link, no jot — guessing the thread is worse than
  // not jotting, because a wrong jot lands in someone else's CONTINUE.md.
  threadForTask(task) {
    const text = String(task.text || '');
    const re = /\[\[([^\]|#]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const target = m[1].trim();
      const hit = target.match(/(?:^|\/)01-Projects\/([^/]+)/) || target.match(/^([^/]+)\/CONTINUE$/);
      if (hit) return hit[1];
      // A bare [[slug]] counts only if that project directory actually exists.
      if (!target.includes('/') && this.app.vault.getAbstractFileByPath('01-Projects/' + target + '/CONTINUE.md')) {
        return target;
      }
    }
    return null;
  }

  // jot.sh's format, byte-for-byte: ISO<TAB>tag<TAB>text, Eastern, one line.
  // Written through the ADAPTER because .journal.md is a dotfile and Obsidian's
  // file index does not carry it.
  // KNOWN GAP: dotfiles do not ride LiveSync, so a jot written on the iPad stays
  // on the iPad. The inline stamp in the daily note is the record that always
  // replicates; the jot is the bonus that makes /save free on the Air.
  async jotDid(slug, line) {
    const path = '01-Projects/' + slug + '/.journal.md';
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' })
      .replace(' ', 'T').slice(0, 16);
    const clean = String(line).replace(/[\t\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const row = stamp + '\t' + 'did' + '\t' + clean + '\n';
    const a = this.app.vault.adapter;
    if (await a.exists(path)) await a.append(path, row);
    else await a.write(path, row);
    return path;
  }

  // Called by 00-Home AFTER the source line has been flipped to [x].
  async onTaskDone(task) {
    const slug = this.threadForTask(task);
    if (!slug) return { jotted: null };
    try {
      await this.jotDid(slug, 'ticked on 00-Home: ' + String(task.text || '').replace(/\s+/g, ' ').trim());
      return { jotted: slug };
    } catch (e) {
      new Notice('ticked, but the jot failed: ' + e.message);
      return { jotted: null, err: e.message };
    }
  }


  async activateStreamView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = (workspace.getRightLeaf(false) || workspace.getLeaf(true));
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /* ---- remote-control command channel ---- */
  connectCmd() {
    this.disconnectCmd();
    const base = trimBase(this.settings.baseUrl);
    const bearer = this.settings.bearer;
    if (!bearer) return;
    const url = base + '/cmd/stream?bearer=' + encodeURIComponent(bearer)
      + '&client=' + encodeURIComponent(this.ensureClientId());
    try { this.cmdEs = new EventSource(url); } catch (e) { this.scheduleCmdRetry(); return; }
    this.cmdEs.onmessage = (e) => { let c; try { c = JSON.parse(e.data); } catch (_) { return; } this.execute(c); };
    this.cmdEs.onerror = () => { /* EventSource auto-reconnects; guard anyway */ };
  }
  disconnectCmd() { if (this.cmdEs) { this.cmdEs.close(); this.cmdEs = null; } if (this.cmdRetry) { clearTimeout(this.cmdRetry); this.cmdRetry = null; } }
  scheduleCmdRetry() { if (this.cmdRetry) return; this.cmdRetry = setTimeout(() => { this.cmdRetry = null; this.connectCmd(); }, 4000); }

  async ack(id, ok, result) {
    if (id == null) return;
    try {
      const base = trimBase(this.settings.baseUrl);
      await requestUrl({
        url: base + '/cmd/ack?bearer=' + encodeURIComponent(this.settings.bearer),
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ok, client: this.ensureClientId(),
                                result: result == null ? null : String(result).slice(0, 500) }),
        throw: false,
      });
    } catch (_) {}
  }

  /* ---- selection -> slice pane (master-slave phase-1 step 3) ---- */
  // The registry lives on d2; we cache it for the session so the common path is
  // one request, and fall back to the picker whenever the scope match is unclear.
  async fetchSlices() {
    if (this._slices) return this._slices;
    const base = trimBase(this.settings.baseUrl);
    const r = await requestUrl({
      url: base + '/slice/list?bearer=' + encodeURIComponent(this.settings.bearer),
      method: 'GET', throw: false,
    });
    if (r.status !== 200) throw new Error('slice list ' + r.status);
    this._slices = (r.json && r.json.slices) || {};
    this._phiPaths = (r.json && r.json.phi_paths) || [];
    return this._slices;
  }

  // Longest matching scope wins, so 02-Areas/Personal-Development beats 02-Areas.
  // A tie means two slices claim the note equally (05-Daily feeds both magic and
  // personal) — that is genuinely ambiguous, so we return null and ask.
  resolveSlice(slices, path) {
    let best = null, bestLen = -1, tied = false;
    for (const [name, cfg] of Object.entries(slices)) {
      for (const scope of (cfg.vault_scopes || [])) {
        if (!scope) continue;
        if (path !== scope && !path.startsWith(scope + '/')) continue;
        if (scope.length > bestLen) { best = name; bestLen = scope.length; tied = false; }
        else if (scope.length === bestLen && name !== best) { tied = true; }
      }
    }
    return tied ? null : best;
  }

  async sendSelectionToSlice(editor, view) {
    const text = (editor.getSelection() || '').trim();
    if (!text) { new Notice('Deborah: select some text first'); return; }

    let slices;
    try { slices = await this.fetchSlices(); }
    catch (e) { new Notice('Deborah: cannot reach d2 (' + e.message + ')'); return; }

    const names = Object.keys(slices);
    if (!names.length) { new Notice('Deborah: no slices registered'); return; }

    const path = (view && view.file && view.file.path) || '';
    if (!path) { new Notice('Deborah: save the note first (the PHI fence needs its path)'); return; }
    // Refuse before it leaves the machine. d2 refuses again on the same list —
    // this copy only saves a round-trip and gives a clearer message.
    if ((this._phiPaths || []).some((pre) => path === pre || path.startsWith(pre + '/'))) {
      new Notice('Deborah: ' + path + ' is PHI-fenced — not routed'); return;
    }

    const guess = this.resolveSlice(slices, path);
    if (guess) { this.postSlice(guess, text, path); return; }
    new SlicePicker(this.app, names, (n) => this.postSlice(n, text, path)).open();
  }

  async postSlice(name, text, path) {
    const base = trimBase(this.settings.baseUrl);
    let r;
    try {
      r = await requestUrl({
        url: base + '/slice/send?bearer=' + encodeURIComponent(this.settings.bearer),
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slice: name, text, path }), throw: false,
      });
    } catch (e) { new Notice('Deborah: send failed (' + e.message + ')'); return; }

    const j = r.json || {};
    if (r.status === 200 && j.ok) { new Notice('→ ' + name + ' (' + j.chars + ' chars)'); return; }
    if (r.status === 409) { new Notice('Deborah: ' + name + ' is still answering'); return; }
    new Notice('Deborah: ' + (j.err || ('HTTP ' + r.status)));
  }

  fileByPath(path) {
    const af = this.app.vault.getAbstractFileByPath(path);
    return (af && af instanceof obsidian.TFile) ? af : null;
  }

  async execute(cmd) {
    if (!cmd || cmd.op === 'hello') return;
    const app = this.app;

    // --- fence -------------------------------------------------------------
    if (cmd.op === 'eval' && !this.settings.allowEval) {
      await this.ack(cmd.id, false, 'refused: eval is fenced (Settings -> Deborah Remote -> Allow eval)');
      new Notice('Deborah Remote: refused a pushed eval (fenced)');
      return;
    }
    if (cmd.op !== 'eval' && !ALLOWED_OPS.includes(cmd.op)) {
      await this.ack(cmd.id, false, 'refused: op not in allow-list');
      return;
    }
    // -----------------------------------------------------------------------
    try {
      switch (cmd.op) {
        case 'notice':
          new Notice(String(cmd.msg || ''));
          break;
        case 'open':
          await app.workspace.openLinkText(cmd.path || '', '', !!cmd.newLeaf);
          if (cmd.mode) await this.setMode(cmd.mode);
          break;
        case 'openstream':
          await this.activateStreamView();
          break;
        case 'mode':
          await this.setMode(cmd.mode);
          break;
        case 'command': {
          // `id` is the channel's own ack correlation id — the service stamps an
          // integer over whatever the caller put there, so the command to run has
          // to travel in its own field.
          const cid = cmd.command_id;
          if (!cid) throw new Error('command needs command_id');
          if (!app.commands.executeCommandById(cid)) throw new Error('no such command: ' + cid);
          break;
        }
        case 'create': {
          const ex = this.fileByPath(cmd.path);
          if (ex) await app.vault.modify(ex, cmd.content || '');
          else await app.vault.create(cmd.path, cmd.content || '');
          break;
        }
        case 'modify': {
          const f = this.fileByPath(cmd.path);
          if (!f) throw new Error('no such file: ' + cmd.path);
          await app.vault.modify(f, cmd.content || '');
          break;
        }
        case 'append': {
          let f = this.fileByPath(cmd.path);
          if (!f) f = await app.vault.create(cmd.path, '');
          await app.vault.append(f, cmd.text || '');
          break;
        }
        case 'delete': {
          const f = this.fileByPath(cmd.path);
          if (f) await app.vault.trash(f, true);
          break;
        }
        case 'eval': {
          // full control — arbitrary JS with app + plugin + obsidian in scope
          const fn = new Function('app', 'plugin', 'obsidian', '"use strict";return (async()=>{' + (cmd.js || '') + '})()');
          const out = await fn(app, this, obsidian);
          await this.ack(cmd.id, true, out);
          return;
        }
        default:
          throw new Error('unknown op: ' + cmd.op);
      }
      await this.ack(cmd.id, true, 'ok');
    } catch (e) {
      await this.ack(cmd.id, false, e && e.message ? e.message : String(e));
      new Notice('Deborah Remote: ' + (e && e.message ? e.message : e));
    }
  }

  async setMode(mode) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const state = view.getState();
    state.mode = (mode === 'reading' || mode === 'preview') ? 'preview' : 'source';
    await view.setState(state, {});
  }

  async saveSettings() { this._slices = null; this._phiPaths = null; await this.saveData(this.settings); }
};

/* --------------------------------------------------------------- settings - */
class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'Deborah Remote' });

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('todaystream service on the tailnet, no trailing slash.')
      .addText((t) => t.setPlaceholder('https://deborah-2.tail1fd1c8.ts.net/todaystream')
        .setValue(this.plugin.settings.baseUrl)
        .onChange(async (v) => { this.plugin.settings.baseUrl = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Bearer')
      .setDesc('Root key — stored only on this device, never synced. The command channel can edit your vault.')
      .addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder('paste bearer')
        .setValue(this.plugin.settings.bearer)
        .onChange(async (v) => { this.plugin.settings.bearer = v.trim(); await this.plugin.saveSettings(); }); });

    new Setting(containerEl)
      .setName('Device label')
      .setDesc('Identifies THIS surface on the command channel, so a push says which '
             + 'device ran it. Generated once and persisted per device. Clear the field '
             + 'to have a new one issued on the next reconnect.')
      .addText((t) => { t.setPlaceholder('auto')
        .setValue(this.plugin.settings.clientId || '')
        .onChange(async (v) => {
          this.plugin.settings.clientId = v.trim();
          await this.plugin.saveSettings();
          this.plugin.ensureClientId();
          if (this.plugin.settings.remoteControl) this.plugin.connectCmd();
        }); });

    new Setting(containerEl)
      .setName('Remote control')
      .setDesc('Let d2 open notes, flip Reading mode, run commands, and edit the vault. Turn off for stream-view only.')
      .addToggle((tg) => tg.setValue(this.plugin.settings.remoteControl)
        .onChange(async (v) => {
          this.plugin.settings.remoteControl = v; await this.plugin.saveSettings();
          if (v) this.plugin.connectCmd(); else this.plugin.disconnectCmd();
        }));

    new Setting(containerEl)
      .setName('Allow eval (dangerous)')
      .setDesc('Off by default. When on, d2 can execute arbitrary JavaScript in this vault \u2014 '
             + 'it can read any note and send 500 characters back per call. Turn on only for a '
             + 'specific task, then turn it off. Every other remote op keeps working while this is off.')
      .addToggle((tg) => tg.setValue(this.plugin.settings.allowEval)
        .onChange(async (v) => {
          this.plugin.settings.allowEval = v; await this.plugin.saveSettings();
          new Notice(v ? 'Deborah Remote: eval ENABLED' : 'Deborah Remote: eval fenced');
        }));

    new Setting(containerEl).addButton((b) => b.setButtonText('Reconnect').onClick(() => { this.plugin.connectCmd(); new Notice('Deborah Remote: reconnecting'); }));
  }
}

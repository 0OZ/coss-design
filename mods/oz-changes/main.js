// Derived from the `changes` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: flat root (no card of its own), staged/unstaged lists with lazygit keys,
// branch with ahead/behind, and the last few commits.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";
import { parseStatus, parseNumstat, parseBranch, parseLog, LOG_FORMAT } from "./status.js";

// Staged / unstaged file list with lazygit's keys: j/k move, space stages or unstages, a all, c commit.
const ROW_H = 28, LIST_MAX_H = 260, LIST_PAD = 12;
const RECENT_COMMITS = 3, COMMIT_ROW_H = 22;
const TITLE = { staged: "Staged", unstaged: "Unstaged" };
const ALL_LABEL = { staged: "Unstage all", unstaged: "Stage all" };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const idOf = (f) => f ? `${f.side}:${f.path}` : null;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.staged = []; this.unstaged = []; this.cur = { side: "unstaged", i: 0 }; this.want = null;
    this.branch = null; this.commits = [];
    this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.listScroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Commit message (staged files)" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  sel() { return this[this.cur.side][this.cur.i]; }

  // Keep the cursor on a real row; fall to the other list when its own went empty.
  clamp() {
    const other = this.cur.side === "staged" ? "unstaged" : "staged";
    if (!this[this.cur.side].length && this[other].length) this.cur = { side: other, i: 0 };
    this.cur.i = Math.max(0, Math.min(this.cur.i, this[this.cur.side].length - 1));
  }

  // The virtual list's rows: a header, then its files, per non-empty list.
  listRows() {
    return ["staged", "unstaged"].flatMap((side) => this[side].length
      ? [{ head: side }, ...this[side].map((f, i) => ({ f, i }))] : []);
  }

  reset() {
    this.root = null; this.staged = []; this.unstaged = []; this.cur = { side: "unstaged", i: 0 }; this.want = null;
    this.branch = null; this.commits = [];
    this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null;
    this.watched = null; this.limited = false;
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.reset(); this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--branch", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const cached = await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]);
        const work = await git(["diff", "--numstat", "-z", "--no-renames"]);
        // An unborn branch has no log to read.
        const log = head.code === 0 ? await git(["log", "-n", String(RECENT_COMMITS), `--format=${LOG_FORMAT}`]) : { code: 0, stdout: "" };
        for (const r of [cached, work, log]) if (r.code !== 0) throw new Error(r.stderr);
        if (key() !== context) return;
        const parsed = parseStatus(status.stdout);
        const withStats = (side, text) => {
          const stats = parseNumstat(text);
          return parsed[side].map((f) => ({ ...f, side, add: 0, del: 0, ...stats[f.path] }));
        };
        const prev = this.sel();
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.limited = parsed.limited; this.error = null;
        this.staged = withStats("staged", cached.stdout); this.unstaged = withStats("unstaged", work.stdout);
        this.branch = parseBranch(status.stdout); this.commits = parseLog(log.stdout);
        this.watch(root, cx);
        // After an action the cursor keeps its slot (the next file moves up), like lazygit;
        // otherwise it follows the file it was on.
        if (this.want) { this.cur = this.want; this.want = null; }
        else if (prev) {
          const i = this[prev.side].findIndex((f) => f.path === prev.path);
          if (i >= 0) this.cur = { side: prev.side, i };
        }
        this.clamp();
        try { await this.load(this.sel(), context); }
        catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(file, context) {
    if (!file) { this.setLines([]); return; }
    const root = this.root, on = this.on;
    let lines;
    if (file.fresh) {
      const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const side = file.side === "staged" ? ["--cached"] : [];
      const r = await exec("git", [...READ, "diff", ...side, "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && idOf(this.sel()) === idOf(file)) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  // Cursor moved: show its diff and keep its row on screen.
  showDiff(cx) {
    const context = this.context, file = this.sel();
    this.note = null; this.setLines([]);
    const at = this.listRows().findIndex((r) => r.f && r.f === file);
    if (at >= 0) this.listScroll.scroll_to_item(at);
    cx.spawn(async (cx) => {
      try { await this.load(file, context); }
      catch (e) { if (key() === context && idOf(this.sel()) === idOf(file)) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  move(step, cx) {
    const total = this.staged.length + this.unstaged.length;
    if (!total) return;
    const at = (this.cur.side === "staged" ? 0 : this.staged.length) + this.cur.i;
    const next = Math.max(0, Math.min(total - 1, at + step));
    this.cur = next < this.staged.length ? { side: "staged", i: next } : { side: "unstaged", i: next - this.staged.length };
    this.showDiff(cx);
  }

  // One git write; the cursor lands on `want` after the refresh it triggers.
  run(args, { want, after }, cx) {
    if (!this.root || this.busy || this.loading) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        if (key() === context) { if (want) this.want = want; after?.(); }
      } catch (e) { if (key() === context) this.note = `git ${args[0]} failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  toggle(cx) {
    const f = this.sel();
    if (!f) return;
    const args = f.side === "unstaged" ? ["add", "--", f.path]
      : this.hasHead ? ["restore", "--staged", "--", f.path] : ["rm", "--cached", "-q", "--", f.path];
    this.run(args, { want: { side: f.side, i: this.cur.i } }, cx);
  }

  all(side, cx) {
    if (!this[side].length) return;
    this.run(side === "unstaged" ? ["add", "-A"] : ["reset", "-q"], { want: { side, i: 0 } }, cx);
  }

  // Commits what is staged, nothing else.
  commit(cx) {
    if (!this.message.trim() || !this.staged.length || this.loading || this.context !== key()) return;
    this.run(["commit", "-m", this.message.trim()], { after: () => { this.message = ""; this.input.set_value(""); } }, cx);
  }

  onKey(e, cx) {
    if (this.typing) {
      if (e.key === "escape") { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    switch (e.keystroke) {
      case "j": case "down": this.move(1, cx); break;
      case "k": case "up": this.move(-1, cx); break;
      case "space": this.toggle(cx); break;
      case "a": this.all(this.unstaged.length ? "unstaged" : "staged", cx); break;
      case "c": this.input.focus(); break;
      default: return;
    }
    cx.stop_propagation();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  headRow(side, t, cx) {
    return h_flex().id(`head-${side}`).h(ROW_H).flex_none().px(8).items_center().text_size(11).text_color(t.dim)
      .child(div().flex_1().child(`${TITLE[side]} (${this[side].length})`))
      .child(div().id(`all-${side}`).px(6).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover)).text_color(t.muted)
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.all(side, cx); }).child(ALL_LABEL[side]));
  }

  fileRow(f, i, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const on = this.cur.side === f.side && this.cur.i === i;
    return h_flex().id(`change-${f.side}-${f.path}`).h(ROW_H).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => {
        this.cur = { side: f.side, i }; this.handle.focus();
        if (e.click_count >= 2) this.toggle(cx); else this.showDiff(cx);
      })
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  branchRow(b, t) {
    return h_flex().h(26).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).text_size(11)
      .child(div().font_semibold().truncate().child(b.name ?? "detached HEAD"))
      .when(Boolean(b.upstream), (e) => e.child(div().min_w(0).text_color(t.dim).truncate().child(b.upstream)))
      .child(div().flex_1())
      .when(b.gone, (e) => e.child(div().text_color(t.ansi1).child("upstream gone")))
      .when(b.ahead > 0, (e) => e.child(div().text_color(t.ansi2).child(`↑${b.ahead}`)))
      .when(b.behind > 0, (e) => e.child(div().text_color(t.blocked).child(`↓${b.behind}`)));
  }

  commitList(t) {
    return v_flex().flex_none().px(8).py(4).border_t(1).border_color(t.border).text_size(11).children(this.commits.map((c) =>
      h_flex().h(COMMIT_ROW_H).flex_none().px(6).gap(8).items_center()
        .child(div().flex_none().text_color(t.accent).child(c.hash))
        .child(div().flex_1().min_w(0).truncate().child(c.subject))
        .child(div().flex_none().text_color(t.dim).child(c.when))));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), all = [...this.staged, ...this.unstaged], listRows = this.listRows();
    const add = all.reduce((n, f) => n + f.add, 0), del = all.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.staged.length && this.root && !this.busy && !this.loading);
    const listH = Math.min(LIST_MAX_H, Math.max(44, listRows.length * ROW_H + LIST_PAD));
    return v_flex().id("changes").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${all.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .when(Boolean(this.branch), (e) => e.child(this.branchRow(this.branch, t)))
      .child(div().flex_none().h(listH).relative().p(6).border_b(1).border_color(t.border)
        .when(listRows.length > 0, (e) => e
          .child(v_virtual_list("changes-files", listRows.length, ROW_H, (i) => String(i),
            (range) => listRows.slice(range.start, range.end).map((r) => r.head ? this.headRow(r.head, t, cx) : this.fileRow(r.f, r.i, t))).track_scroll(this.listScroll).size_full())
          .child(Scrollbar.vertical("changes-files").viewport_from_layout().absolute().inset_0()))
        .when(!listRows.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0()))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(this.commits.length > 0, (e) => e.child(this.commitList(t)))
      .child(div().flex_none().px(14).pt(6).text_size(10).text_color(t.dim).child("j/k move · space stage · a all · c commit"))
      .child(h_flex().flex_none().p(10).gap(8)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Working…" : `Commit (${this.staged.length})`)));
  }
}

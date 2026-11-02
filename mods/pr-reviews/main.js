// PR Reviews: open GitHub PRs waiting on your review. "Review" checks the PR out in a worktree
// (~/.herdr/worktrees/<owner>--<repo>/pr-<n>, branch review/pr-<n>), opens a space there
// and starts your agent with your prompt template. A PR already checked out shows "Open" and its agent's status.
// The gear opens settings: prompt template, agent command, folders searched for clones.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, run, theme, spaces, panes, agents, home, notify, shared, setShared } from "herdr";
import { DEFAULTS, VARS, fill, argv, parseRoots, resolve, repoOf } from "./config.js";

const KEY = "pr-reviews.settings"; // in Herdr's shared state: survives restarts, no file to edit
const POLL = 120000;
const QUERY = `query{search(query:"is:pr is:open review-requested:@me archived:false",type:ISSUE,first:50){nodes{... on PullRequest{
  number title url isDraft updatedAt headRefName additions deletions author{login __typename} repository{nameWithOwner}}}}}`;

const settings = () => resolve(shared(KEY));
const under = (p, root) => p === root || p?.startsWith(root + "/");
const out = (r) => (r && r.code === 0 ? r.stdout.trim() : null);
const isBot = (a) => !a || a.__typename === "Bot" || /\[bot\]$|^dependabot|^renovate/i.test(a.login);
const ago = (iso) => {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  return m < 60 ? `${Math.max(1, m | 0)}m` : m < 1440 ? `${(m / 60) | 0}h` : `${(m / 1440) | 0}d`;
};
// One folder and one local branch per PR (review/pr-<n>), so PRs never share a checkout and a PR whose
// head is called `main` can't touch your own `main`. Owner and name come from GitHub, which allows only
// [A-Za-z0-9._-] in them; `safe` keeps any surprise out of the path anyway.
const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
const pathOf = (pr) => `${home()}/.herdr/worktrees/${safe(pr.repo.replace("/", "--"))}/pr-${pr.number}`;
const branchOf = (pr) => `review/pr-${pr.number}`;
// Where a repo with no clone in your folders gets cloned (and is found again next time).
const cloneDir = (repo) => `${home()}/.herdr/repos/${safe(repo.replace("/", "--"))}`;

// owner/name (lowercase) → { dir, remote } for every remote of every clone directly under the folders,
// so a clone of your fork with an `upstream` remote still matches the upstream repo.
async function clones(roots) {
  const script = 'for r in "$@"; do for g in "$r"/*/.git; do [ -d "$g" ] && d="${g%/.git}" && '
    + 'git -C "$d" remote -v 2>/dev/null | while read -r n u _; do printf "%s|%s|%s\\n" "$u" "$d" "$n"; done; done; done';
  const dirs = roots.map((x) => (x.startsWith("/") ? x : x ? `${home()}/${x}` : home()));
  const r = await exec("sh", ["-c", script, "sh", ...dirs, `${home()}/.herdr/repos`]).catch(() => null);
  const map = new Map();
  for (const line of (out(r) ?? "").split("\n")) {
    const [url, dir, remote] = line.split("|");
    const s = repoOf(url);
    if (s && (!map.has(s) || remote === "origin")) map.set(s, { dir, remote });
  }
  return map;
}

async function fetchPrs() {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "gh failed");
  return JSON.parse(r.stdout).data.search.nodes.filter((n) => n.number).map((n) => ({
    number: n.number, title: n.title, url: n.url, draft: n.isDraft, updated: n.updatedAt, head: n.headRefName,
    add: n.additions, del: n.deletions, author: n.author?.login ?? "ghost", bot: isBot(n.author), repo: n.repository.nameWithOwner,
  })).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}

const lastLine = (r) => r.stderr.trim().split("\n").pop() || `exit ${r.code}`;

// Check the PR out at its worktree path; reuse (and fast-forward) one already there.
async function checkout(pr, repos) {
  const path = pathOf(pr), branch = branchOf(pr);
  const sh = (cmd, args) => exec(cmd, args).catch((e) => ({ code: 1, stderr: String(e) }));
  const fail = (r) => { throw new Error(lastLine(r)); };
  let src = repos.get(pr.repo.toLowerCase());
  if ((await sh("test", ["-d", path])).code === 0) {
    // The worktree's own repo knows the remote; fall back to the repo URL itself.
    const f = await sh("git", ["-C", path, "fetch", src?.remote ?? `https://github.com/${pr.repo}.git`, `pull/${pr.number}/head`]);
    const m = f.code === 0 ? await sh("git", ["-C", path, "merge", "--ff-only", "FETCH_HEAD"]) : f;
    if (m.code !== 0) notify({ title: `#${pr.number}: worktree not updated`, body: `${lastLine(m)}. It may show older commits (a force-push?).`, level: "warning" });
    return path;
  }
  if (!src) {
    const dir = cloneDir(pr.repo);
    if ((await sh("test", ["-d", `${dir}/.git`])).code !== 0) {
      const c = await sh("gh", ["repo", "clone", pr.repo, dir]);
      if (c.code !== 0) fail(c);
    }
    src = { dir, remote: "origin" };
  }
  // pull/N/head exists on the PR's own repo for every PR, forks included. `--` ends the options (git accepts it here).
  const f = await sh("git", ["-C", src.dir, "fetch", src.remote, `+pull/${pr.number}/head:refs/heads/${branch}`]);
  if (f.code !== 0) fail(f);
  const w = await sh("git", ["-C", src.dir, "worktree", "add", "--", path, branch]);
  if (w.code !== 0) fail(w);
  return path;
}

export default class PrReviews extends View {
  init(_props, cx) {
    this.prs = null;
    this.repos = new Map();
    this.have = new Set(); // worktree paths that exist
    this.err = "";
    this.busy = new Set();
    this.editing = false;
    this.botsOpen = localStorage.getItem("bots-open") === "true";
    this.templateInput = TextareaState.new({ rows: 8 });
    this.templateInput.set_auto_grow(6, 16);
    this.templateInput.on("change", (_e, cx) => cx.notify()); // live preview
    this.agentInput = InputState.new({ placeholder: "claude" });
    this.rootsInput = InputState.new({ placeholder: "~, Desktop, code" });
    this.load(settings());
    this.refresh(cx);
    cx.timer.every(POLL, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [prs, repos] = await Promise.all([fetchPrs(), clones(settings().roots)]);
        const r = await exec("sh", ["-c", 'for p in "$@"; do [ -d "$p" ] && printf "%s\\n" "$p"; done; true', "sh", ...prs.map(pathOf)]).catch(() => null);
        this.have = new Set((out(r) ?? "").split("\n").filter(Boolean));
        this.prs = prs;
        this.repos = repos;
        this.err = "";
      } catch (e) {
        this.err = e.message;
      } finally {
        this.loading = false;
      }
      cx.notify();
    });
  }

  review(pr, cx) {
    this.busy.add(pr.url);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const s = settings();
        const path = await checkout(pr, this.repos);
        this.have.add(path);
        const space = spaces().find((x) => !x.machine && under(x.folder, path));
        const job = { folder: path, argv: argv(s.agent), task: fill(s.template, pr) };
        if (space) { run("space.select", { id: space.id }); run("tab.new", { ...job, space: space.id, name: `review #${pr.number}` }); }
        else run("space.new", { ...job, tab: `review #${pr.number}` });
      } catch (e) {
        notify({ title: `Review #${pr.number} failed`, body: e.message, level: "error" });
      }
      this.busy.delete(pr.url);
      cx.notify();
    });
  }

  save(cx) {
    setShared(KEY, { template: this.templateInput.value(), agent: this.agentInput.value(), roots: parseRoots(this.rootsInput.value()) });
    this.editing = false;
    this.refresh(cx); // the folders may have changed
  }

  // Fills the inputs: from the saved settings on open/cancel (so discarded edits don't come back), or the defaults.
  load(s) {
    this.templateInput.set_value(s.template);
    this.agentInput.set_value(s.agent);
    this.rootsInput.set_value(s.roots.map((r) => r || "~").join(", "));
  }

  toggleSettings(open) {
    if (open) this.load(settings());
    this.editing = open;
  }

  settingsView(t, btn) {
    const label = (text) => div().text_size(11).font_medium().text_color(t.dim).child(text);
    const hint = (text) => div().text_size(11).text_color(t.dim).child(text);
    const field = (el) => div().rounded(6).border(1).border_color(t.input).bg(t.background).px(8).py(4).text_size(12).text_color(t.foreground).child(el);
    const example = this.prs?.[0] ?? { url: "https://github.com/acme/app/pull/42", number: 42, repo: "acme/app", title: "Add login", author: "ana", head: "feat/login" };
    return v_flex().id("pr-reviews-settings").flex_1().min_h(0).px(12).pb(12).gap(8).overflow_y_scrollbar()
      .child(label("PROMPT TEMPLATE"))
      .child(field(Textarea.new(this.templateInput)))
      .child(hint(`Variables: ${VARS.map((v) => `{${v}}`).join(" ")}. A slash command works too, e.g. /code-review {url}`))
      .child(label("PREVIEW"))
      .child(div().rounded(6).bg(t.hover).px(8).py(6).text_size(11).text_color(t.muted).child(fill(this.templateInput.value() || DEFAULTS.template, example)))
      .child(label("AGENT COMMAND"))
      .child(field(Input.new(this.agentInput)))
      .child(hint("Started in the worktree with the prompt as its first message: claude, codex, opencode…"))
      .child(label("FOLDERS WITH YOUR CLONES"))
      .child(field(Input.new(this.rootsInput)))
      .child(hint("Comma-separated, relative to home. A repo not found there is cloned to ~/.herdr/repos/."))
      .child(h_flex().gap(6).pt(4)
        .child(btn("save", "Save", (_e, cx) => this.save(cx), true))
        .child(btn("cancel", "Cancel", (_e, cx) => { this.toggleSettings(false); cx.notify(); }))
        .child(div().flex_1())
        .child(btn("reset", "Reset to defaults", (_e, cx) => { this.load(DEFAULTS); cx.notify(); })));
  }

  render() {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const btn = (id, label, action, strong) => div().id(id).px(7).h(20).flex_none().flex().items_center().rounded(5).text_size(11)
      .text_color(strong ? t.foreground : t.muted).bg(strong ? t.selected : t.hover).hover((s) => s.bg(t.selected).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((e, cx) => { cx.stop_propagation(); action(e, cx); }).child(label);
    const header = h_flex().h(36).px(12).gap(8).items_center().flex_none()
      .child(svg("mods/pr-reviews/eye.svg").size(14).text_color(t.muted))
      .child(div().flex_1().font_medium().text_color(t.foreground).child(this.editing ? "PR Reviews · Settings" : "PR Reviews"))
      .when(!this.editing, (el) => el.child(btn("refresh", this.loading ? "…" : "Refresh", (_e, cx) => this.refresh(cx))))
      .child(div().id("gear").size(22).flex_none().flex().items_center().justify_center().rounded(5)
        .text_color(this.editing ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label("Settings")
        .on_mouse_down("left", stop).on_click((_e, cx) => { this.toggleSettings(!this.editing); cx.notify(); })
        .child(svg("mods/pr-reviews/gear.svg").size(14)));
    const root = v_flex().size_full().bg(t.chrome).text_size(12).child(header);
    if (this.editing) return root.child(this.settingsView(t, btn));
    if (!this.prs) return root.child(div().px(12).text_color(this.err ? t.blocked : t.dim).child(this.err ? `gh: ${this.err}` : "Asking GitHub…"));

    const ps = panes(), as = agents();
    const statusColor = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle };
    const card = (pr) => {
      const path = pathOf(pr), here = this.have.has(path);
      const ag = here ? as.find((a) => under(ps.find((p) => p.pane === a.pane)?.cwd, path)) : null;
      const s = here ? spaces().find((x) => !x.machine && under(x.folder, path)) : null;
      const open = () => (s ? run("space.select", { id: s.id }) : run("space.new", { folder: path }));
      return v_flex().id(`pr-${pr.url}`).px(10).py(8).gap(5).rounded(8).hover((x) => x.bg(t.hover)).on_click(() => exec("open", [pr.url]))
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().text_color(t.dim).child(`${pr.repo.split("/")[1]} #${pr.number}`))
          .child(div().flex_1().min_w(0).truncate().text_color(pr.draft ? t.muted : t.foreground).child(pr.title)))
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(div().flex_none().text_color(t.muted).child(pr.author))
          .child(div().flex_none().text_color(t.dim).child(ago(pr.updated)))
          .child(div().flex_none().text_color(t.ansi2).child(`+${pr.add}`))
          .child(div().flex_none().text_color(t.ansi1).child(`−${pr.del}`))
          .when(pr.draft, (el) => el.child(div().flex_none().text_color(t.dim).child("draft")))
          .child(div().flex_1())
          .when(Boolean(ag), (el) => el.child(h_flex().id(`ag-${pr.url}`).gap(4).items_center().on_mouse_down("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: ag.address }); })
            .child(div().size(6).rounded_full().bg(statusColor[ag.status] ?? t.idle)).child(div().text_color(t.muted).child(ag.status))))
          .child(this.busy.has(pr.url) ? div().text_color(t.dim).child("checking out…")
            : here ? btn(`open-${pr.url}`, "Open", open) : btn(`rv-${pr.url}`, "Review", (_e, cx) => this.review(pr, cx), true)));
    };
    const people = this.prs.filter((p) => !p.bot), bots = this.prs.filter((p) => p.bot);
    return root.child(v_flex().id("pr-reviews-scroll").flex_1().min_h(0).px(4).pb(8).gap(2).overflow_y_scrollbar()
      .when(Boolean(this.err), (el) => el.child(div().px(10).pb(4).text_size(11).text_color(t.blocked).child(`gh: ${this.err}`)))
      .when(!people.length, (el) => el.child(div().px(10).text_color(t.dim).child("Nobody's waiting on your review.")))
      .children(people.map(card))
      .when(bots.length > 0, (el) => el.child(div().h(6).flex_none())
        .child(h_flex().id("bots-head").h(26).px(10).gap(6).items_center().text_size(11).font_medium().text_color(t.dim)
          .on_click((_e, cx) => { this.botsOpen = !this.botsOpen; localStorage.setItem("bots-open", String(this.botsOpen)); cx.notify(); })
          .child(div().child(this.botsOpen ? "▾" : "▸")).child(div().flex_1().child("BOTS")).child(div().child(String(bots.length))))
        .when(this.botsOpen, (el) => el.children(bots.map(card)))));
  }
}

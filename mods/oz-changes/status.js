export const MAX_FILES = 1000;

// `git status --branch` header: "## main...origin/main [ahead 2, behind 3]".
const BRANCH_HEAD = "## ";
const UNBORN = /^(?:No commits yet|Initial commit) on /;
const DETACHED = "HEAD (no branch)";
const BRANCH_LINE = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/;
const AHEAD = /ahead (\d+)/, BEHIND = /behind (\d+)/;
const count = (track, re) => Number(re.exec(track)?.[1] ?? 0);

// -> { name (null when detached), upstream, ahead, behind, gone }, or null without a header.
export function parseBranch(raw) {
  const head = raw.split("\0").find((e) => e.startsWith(BRANCH_HEAD));
  if (!head) return null;
  const [, name, upstream = null, track = ""] = BRANCH_LINE.exec(head.slice(BRANCH_HEAD.length).replace(UNBORN, ""));
  return { name: name === DETACHED ? null : name, upstream, ahead: count(track, AHEAD), behind: count(track, BEHIND), gone: track === "gone" };
}

// `git log --format=LOG_FORMAT` -> [{ hash, subject, when }], one per line.
export const LOG_FORMAT = "%h%x1f%s%x1f%cr";
export function parseLog(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [hash, subject, when] = line.split("\x1f");
    return { hash, subject, when };
  });
}

// Display letter for one side of a porcelain XY pair.
const LETTER = { D: "D", A: "A", "?": "A" };
const letter = (c) => LETTER[c] ?? "M";
const isConflict = (xy) => xy.includes("U") || xy === "AA" || xy === "DD";

// `git status --porcelain=v1 -z` -> what lazygit calls staged and unstaged files.
// A file edited after staging (MM) is in both lists; a conflict is one unstaged entry.
export function parseStatus(raw) {
  const entries = raw.split("\0").filter((e) => e && !e.startsWith(BRANCH_HEAD));
  const staged = [], unstaged = [];
  for (const e of entries.slice(0, MAX_FILES)) {
    const xy = e.slice(0, 2), path = e.slice(3);
    if (isConflict(xy)) { unstaged.push({ path, status: "U", fresh: false }); continue; }
    if (xy === "??") { unstaged.push({ path, status: "A", fresh: true }); continue; }
    if (xy[0] !== " ") staged.push({ path, status: letter(xy[0]), fresh: false });
    if (xy[1] !== " ") unstaged.push({ path, status: letter(xy[1]), fresh: false });
  }
  return { staged, unstaged, limited: entries.length > MAX_FILES };
}

// `git diff --numstat -z` -> { path: { add, del, binary } }.
export function parseNumstat(text) {
  const stats = {};
  for (const entry of text.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  return stats;
}

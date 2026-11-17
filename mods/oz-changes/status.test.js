import test from "node:test";
import assert from "node:assert/strict";
import { parseStatus, parseNumstat, parseBranch, parseLog, MAX_FILES } from "./status.js";

const entry = (xy, path = "dir/my file.txt") => `${xy} ${path}\0`;
const item = (status, fresh = false, path = "dir/my file.txt") => ({ path, status, fresh });

const cases = [
  { name: "worktree edit is unstaged only", xy: " M", staged: [], unstaged: [item("M")] },
  { name: "index edit is staged only", xy: "M ", staged: [item("M")], unstaged: [] },
  { name: "edit staged then edited again is in both lists", xy: "MM", staged: [item("M")], unstaged: [item("M")] },
  { name: "each side keeps its own letter", xy: "AM", staged: [item("A")], unstaged: [item("M")] },
  { name: "untracked is unstaged, added, fresh", xy: "??", staged: [], unstaged: [item("A", true)] },
  { name: "file added to index is staged", xy: "A ", staged: [item("A")], unstaged: [] },
  { name: "worktree delete is unstaged", xy: " D", staged: [], unstaged: [item("D")] },
  { name: "index delete is staged", xy: "D ", staged: [item("D")], unstaged: [] },
  { name: "unmerged UU is one unstaged conflict", xy: "UU", staged: [], unstaged: [item("U")] },
  { name: "both added AA is one unstaged conflict", xy: "AA", staged: [], unstaged: [item("U")] },
  { name: "both deleted DD is one unstaged conflict", xy: "DD", staged: [], unstaged: [item("U")] },
];

for (const c of cases) {
  test(c.name, () => {
    const out = parseStatus(entry(c.xy));
    assert.deepEqual({ staged: out.staged, unstaged: out.unstaged }, { staged: c.staged, unstaged: c.unstaged });
  });
}

test("clean repo gives empty lists", () => {
  assert.deepEqual(parseStatus(""), { staged: [], unstaged: [], limited: false });
});

test("exactly the cap is not limited", () => {
  const raw = Array.from({ length: MAX_FILES }, (_, i) => entry(" M", `f${i}`)).join("");
  const out = parseStatus(raw);
  assert.equal(out.unstaged.length, MAX_FILES);
  assert.equal(out.limited, false);
});

test("one past the cap is cut and flagged", () => {
  const raw = Array.from({ length: MAX_FILES + 1 }, (_, i) => entry(" M", `f${i}`)).join("");
  const out = parseStatus(raw);
  assert.equal(out.unstaged.length, MAX_FILES);
  assert.equal(out.limited, true);
});

const numstatCases = [
  { name: "text file gives added and deleted counts", raw: "3\t1\tsrc/a.js\0", want: { "src/a.js": { add: 3, del: 1, binary: false } } },
  { name: "binary file is flagged with zero counts", raw: "-\t-\tlogo.png\0", want: { "logo.png": { add: 0, del: 0, binary: true } } },
  { name: "path containing a tab stays whole", raw: "1\t0\tweird\tname\0", want: { "weird\tname": { add: 1, del: 0, binary: false } } },
  { name: "no output gives no stats", raw: "", want: {} },
];

for (const c of numstatCases) {
  test(`numstat: ${c.name}`, () => assert.deepEqual(parseNumstat(c.raw), c.want));
}

test("branch header is not listed as a file", () => {
  const out = parseStatus(`## main...origin/main\0${entry(" M")}`);
  assert.deepEqual({ staged: out.staged, unstaged: out.unstaged }, { staged: [], unstaged: [item("M")] });
});

test("branch header does not count toward the cap", () => {
  const raw = "## main\0" + Array.from({ length: MAX_FILES }, (_, i) => entry(" M", `f${i}`)).join("");
  assert.equal(parseStatus(raw).limited, false);
});

const branch = (fields) => ({ name: "main", upstream: "origin/main", ahead: 0, behind: 0, gone: false, ...fields });
const branchCases = [
  { name: "no upstream", raw: "## main", want: branch({ upstream: null }) },
  { name: "in sync with upstream", raw: "## main...origin/main", want: branch({}) },
  { name: "ahead only", raw: "## main...origin/main [ahead 2]", want: branch({ ahead: 2 }) },
  { name: "behind only", raw: "## main...origin/main [behind 3]", want: branch({ behind: 3 }) },
  { name: "ahead and behind", raw: "## main...origin/main [ahead 2, behind 3]", want: branch({ ahead: 2, behind: 3 }) },
  { name: "upstream gone", raw: "## main...origin/main [gone]", want: branch({ gone: true }) },
  { name: "no commits yet keeps the branch name", raw: "## No commits yet on main", want: branch({ upstream: null }) },
  { name: "detached HEAD has no name", raw: "## HEAD (no branch)", want: branch({ name: null, upstream: null }) },
];

for (const c of branchCases) {
  test(`branch: ${c.name}`, () => assert.deepEqual(parseBranch(`${c.raw}\0${entry(" M")}`), c.want));
}

test("branch: status without a header gives null", () => {
  assert.equal(parseBranch(entry(" M")), null);
});

test("log: one commit per line, newest first", () => {
  const raw = "a1b2c3d\x1ffix: guard\x1f2 hours ago\ne4f5a6b\x1ffeat: panel\x1f3 days ago\n";
  assert.deepEqual(parseLog(raw), [
    { hash: "a1b2c3d", subject: "fix: guard", when: "2 hours ago" },
    { hash: "e4f5a6b", subject: "feat: panel", when: "3 days ago" },
  ]);
});

test("log: no output gives no commits", () => {
  assert.deepEqual(parseLog(""), []);
});

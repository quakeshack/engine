---
name: submodule-aware-commit
description: Use whenever staging or committing any change under source/game/id1/ in this repo. source/game/id1 is a real git submodule (its own repo, branch, and commit history) — a top-level `git add -A && git commit` in the outer engine repo does NOT pick up id1's internal file changes, only (at most) a pointer bump. Committing id1 work needs a separate commit inside the submodule. source/game/hellwave, by contrast, is a plain untracked directory in the outer repo, not a submodule — this skill does not apply there.
---

# Submodule-aware commit

`.gitmodules` declares `source/game/id1` as a real submodule (`url = ../game.git`), with its
own working tree, branch, and commit history — checked out at a matching branch name to the
superproject in normal workflows. `source/game/hellwave` is a plain untracked directory at
the top level, not a submodule; nothing here applies to it.

The outer repo's `git status` only shows the submodule as a single summary line —
` <sha> source/game/id1 (heads/<branch>)` from `git submodule status`, or `modified:
source/game/id1 (modified content)` from a plain top-level `git status`. The actual
per-file diff never appears there. A top-level `git add -A && git commit` will, at most,
stage a pointer/gitlink bump to whatever commit id1 is currently at — it will silently NOT
commit any uncommitted changes sitting inside the submodule's own working tree.

## Fast path

1. Before committing anything that touched `source/game/id1/**`, check the submodule's own
   state, not just the outer repo's:
   ```bash
   git -C source/game/id1 status
   ```
2. **If it shows changes:** commit inside the submodule first, from within it (or via
   `git -C source/game/id1 commit -m "..."`) — this is a separate commit in a separate
   repo/history, with its own message.
3. **After the submodule commit:** check whether the outer repo's gitlink pointer needs
   bumping to the new submodule commit:
   ```bash
   git status   # look for "modified: source/game/id1 (new commits)"
   ```
   If so, stage and commit that pointer bump in the outer repo, typically alongside
   whatever outer-repo changes belong with it.
4. Never assume a single top-level commit covers both — always verify with step 1 before
   reporting id1-related work as committed.

## What this skill does NOT do

- Does not apply to `source/game/hellwave` or any other non-submodule path — those commit
  normally through the outer repo.
- Does not change submodule configuration (`.gitmodules`, tracked branch, etc.) — that's a
  separate, rarer task with its own risk profile (shared repo state), not something to do
  as a side effect of a routine commit.
- Does not push either repo. Committing and pushing are separate steps with separate
  authorization — this skill only covers getting the commit(s) right locally.

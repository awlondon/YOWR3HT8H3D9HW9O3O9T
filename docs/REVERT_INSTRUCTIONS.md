# Reverting the adjacency family taxonomy commit

This repository currently includes commit `593f396` (`Add adjacency family taxonomy and surface in tooling`). Use the steps below to return to the codebase state immediately before that commit.

## Prerequisites
- Ensure you have a clean working tree: `git status` should show no staged or unstaged changes.
- Confirm you are on the branch you want to modify (for example, `work`): `git branch --show-current`.

## Local reversion (preferred)
If you want to keep history and create a new commit that undoes the changes, use `git revert`:

```bash
git revert 593f396
```

- Git will open an editor for the revert message; save and close to finalize.
- If you encounter conflicts, resolve them, then run `git add <files>` and `git revert --continue`.
- After the revert commit is created, rerun the project checks (`npm run check`, `pytest`, `ruff check .`, `mypy hlsf_db_tools`) to ensure the codebase is stable before pushing.

## Hard reset (discard local changes)
If you simply need your local tree to match the state before `593f396` without keeping a revert commit, use a hard reset:

```bash
git reset --hard 593f396^ 
```

- This moves the current branch pointer and working tree to the parent of `593f396`.
- Only use this when you do **not** need to preserve local commits or untracked work.

## Updating a remote branch after reverting
- If you used `git revert`, push the new revert commit normally:

  ```bash
  git push origin <branch>
  ```

- If you used `git reset --hard`, you will need to force-push to rewrite history:

  ```bash
  git push --force-with-lease origin <branch>
  ```

  Verify with teammates before force-pushing to shared branches.

## Verification
After reverting, you can confirm the state matches the parent of `593f396`:

```bash
git log -1 --oneline   # should now show the commit that preceded 593f396
git diff 593f396^..HEAD # should be empty after a hard reset or show only the revert commit
```

These instructions return the repository to its exact state prior to the adjacency family taxonomy changes while preserving safe collaboration practices.

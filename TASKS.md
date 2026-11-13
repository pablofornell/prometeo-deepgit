# DeepGit: next iteration — tasks

## 1. Global
- [x] **Context menu (right-click):** Disable the default webview context menu in all of the application. Show only custom context menus.
- [x] **Date format:** All dates use `dd-mm-yyyy`. Remove the ISO format.
- [x] **Mouse side buttons:** Mouse back/forward buttons do back/forward navigation.
- [x] **Remove Git command hints:** Remove all "equivalent Git command" hints.
- [x] **App icon (tree):** Make the tree icon much denser as the distance from the trunk increases.

## 2. Projects
- [ ] **Sort order:** Sort the project list alphabetically.
- [ ] **Delete projects:** Delete a project without opening it first.
- [ ] **Open a folder without a Git repo:** No error. Tell the user the folder is not a Git repository and offer to initialize one.

## 3. Repository tree (sidebar)
- [x] **Group by folder:** Repos in the same parent folder show as a nested tree, at all levels.
- [x] **Branch context menu:** Add "Copy branch name" to the branch right-click menu in the repository tree.
- [x] **Double-click on a branch of a different repo:** Switch to that repo and refresh the main commit list.
- [x] **Pull counters:** After a pull, refresh the per-repo counters in the repository tree.

## 4. Commit history
- [x] **Overlapping chips:** The count chip (`+3`) must not overlap the `HEAD` label.
- [x] **Selected commit highlight:** The border of the target commit node pulses slowly (soft glow).
- [x] **Branch dropdown:** After a checkout, the branch dropdown shows the new branch name.

## 5. Commit view (local changes)
- [x] **Commit fails with "Nothing to commit":** Find the root cause and fix it.
- [x] **External changes:** Commits made outside the app refresh the change counter and tab label (watch `.git` / index).

## 6. Status bar and notifications
- [x] **Global pull counter:** Refresh the counter of repos with available pulls after a pull.
- [x] **Alert icon:** Alerts are per project, the user can dismiss them, and they expire after a configurable time.

## 7. Branch matrix
- [x] **Bulk push with upstream:** For branches not tracked on the remote, "Push and set upstream" for all selected repos at the same time.

## 8. File view (mini editor)
- [x] **File tree position:** Move the file tree column to the right side of the editor.
- [x] **Git status colors:** Color file and folder names by Git status (modified, added, untracked, ignored, conflicted).
- [x] **Tab context menu:** Close, Close Others, Close All, Close Tabs to the Left/Right, Copy Path, Reveal in File Tree.
- [x] **Find / Find and Replace:** VS Code style floating widget (match case, whole word, regex, match count, replace / replace all).

## 9. Smart .gitignore
- [ ] **Smart .gitignore:** Add ignore rules from the UI (right-click a file or folder → "Add to .gitignore", with pattern suggestions). Only edit `.gitignore`, no commit.

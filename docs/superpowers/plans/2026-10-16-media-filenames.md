# Media Filename Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify default names for screenshots, long screenshots, GIF recordings, and MP4 recordings with local timestamps and collision-safe automatic saves.

**Architecture:** Add a small Rust helper module under `commands` that formats timestamped names and chooses an unused path. Each save command calls it for both configured-directory saves and native dialog defaults. The frontend no longer supplies fixed names; existing save UI and configuration remain unchanged.

**Tech Stack:** Rust 2021, Tauri commands, `chrono`, `std::path`, Vitest/TypeScript for existing frontend checks.

## Global Constraints

- Use local time and the format `{kind}_YYYYMMDD_HHmmss_SSS.{ext}`.
- Preserve the existing save-directory configuration and native dialog behavior.
- Never overwrite an existing configured-directory file; append `_2`, `_3`, etc.
- Keep unrelated worktree changes intact and do not create a Git commit.

---

### Task 1: Add the shared filename helper

**Files:**
- Create: `src-tauri/src/commands/media_filename.rs`
- Modify: `src-tauri/src/commands/mod.rs:206-208`
- Test: `src-tauri/src/commands/media_filename.rs`

- [ ] **Step 1: Write tests** for timestamp shape, extension normalization, and collision suffix selection using a temporary directory.
- [ ] **Step 2: Run the focused Rust test** and confirm it fails before the helper exists.
- [ ] **Step 3: Implement** `timestamped_filename(kind, extension)` and `unique_path(directory, kind, extension)` with millisecond timestamps and `_2` suffixes.
- [ ] **Step 4: Run the focused Rust test** and confirm it passes.

### Task 2: Route every media save through the helper

**Files:**
- Modify: `src-tauri/src/commands/screenshot.rs:466-542`
- Modify: `src-tauri/src/commands/long_capture.rs:334-380`
- Modify: `src-tauri/src/commands/recording.rs:242-338`
- Modify: `src-tauri/src/commands/mod.rs:1907-1980`
- Modify: `src/tools/screenshot/ScreenshotTool.tsx:1408-1420`
- Modify: `src/tools/recording/RecordingTool.tsx:560-578`

- [ ] **Step 1: Replace configured-directory filename construction** for PNG, long PNG, GIF, and MP4 with `unique_path`.
- [ ] **Step 2: Generate dialog defaults in Rust** using `timestamped_filename`, while retaining the file type extension and user-editable dialog.
- [ ] **Step 3: Remove fixed frontend names** from save calls and update command arguments only where required by the new backend default behavior.
- [ ] **Step 4: Run Rust formatting and compile checks.**

### Task 3: Verify the integrated behavior

**Files:**
- Inspect: `src-tauri/src/main.rs`
- Inspect: `package.json`

- [ ] **Step 1: Run `cargo test --manifest-path src-tauri/Cargo.toml media_filename` and confirm all helper tests pass.**
- [ ] **Step 2: Run `npm run typecheck` and `npm test -- --run`.**
- [ ] **Step 3: Run `cargo check --manifest-path src-tauri/Cargo.toml` and report any environment-only failures separately.**
- [ ] **Step 4: Review `git diff` to confirm only the filename behavior and its tests/docs changed.**

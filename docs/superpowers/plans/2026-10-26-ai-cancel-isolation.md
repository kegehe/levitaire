# AI Cancel Isolation Implementation Plan

> **For agentic workers:** Execute inline in this session, task by task, as requested by the user.

**Goal:** Prevent idle toolbar actions and active request cancellation from interrupting AI work in another window.

**Architecture:** Keep local Hook generations, guard cancellation with a dispatched active ID, key Rust cancellation by caller window, Hook UUID and ID, and target stream events to the caller window and Hook instance. Per-request cancellation tokens wake HTTP waits and drop the corresponding network future.

**Tech Stack:** React, TypeScript, Vitest, Tauri 2, Rust.

## Global Constraints

- No new dependencies or UI changes.
- Retain numeric request IDs and optional cancellation argument.
- Read caller window identity from Tauri command injection.
- Preserve cancellation before backend registration and stale callback protection.

### Task 1: Frontend cancellation lifecycle

**Files:** `src/hooks/useAiOptimize.ts`, `src/hooks/useAiOptimize.test.ts`, `src/tools/text-toolbar/TextToolbar.test.tsx`.

**Interfaces:** `optimize(text, mode): Promise<void>`, `cancel(): void`, `cancel_ai_stream({ requestId: number, requestScope: string })`.

- [x] Add regression cases that fail on idle cancellation, delayed listener registration, listener rejection, late IPC rejection, and toolbar reset while another request runs.
- [x] Run `npm test -- src/hooks/useAiOptimize.test.ts src/tools/text-toolbar/TextToolbar.test.tsx` to confirm regression failures (11 failures before implementation).
- [x] Guard cancellation using `if (requestId !== null)` and record the active ID immediately before `invoke("call_ai_stream", ...)`; wrap listener registration in the existing request error boundary.
- [x] Repeat the targeted tests and run `npm run typecheck` (final frontend results below).

### Task 2: Backend window isolation

**Files:** `src-tauri/src/ai/mod.rs`, `src-tauri/src/commands/ai.rs`.

**Interfaces:** `request_cancel(&self, window_label: &str, request_id: Option<u64>, request_scope: Option<&str>)`; `call_stream(&self, window_label: &str, request_id: u64, request_scope: Option<&str>, ...)`.

- [x] Add Rust tests for no-ID cancellation, same-ID isolation, scoped early cancellation and request guard cleanup.
- [x] Use `StreamRequestKey { window_label, request_scope, request_id }` cancellation keys and return immediately on missing ID. Factor stream registration into a private helper returning the existing RAII guard so tests can exercise registration without network access.
- [x] Inject `tauri::WebviewWindow` into both commands; derive the scope from `window.label()` and emit all stream events with `app.emit_to(tauri::EventTarget::webview_window(label), ...)`. Scope the frontend listener to the same `WebviewWindow` target because global Tauri listeners receive targeted emissions as well.
- [x] Reproduce cancellation stalling during HTTP header, stream-body and error-body waits with three loopback-server tests. Replace atomic polling with per-request `CancellationToken` and a cancellation-first `tokio::select!` around the asynchronous HTTP work.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml -j 1 ai::tests -- --nocapture` and Rust formatting checks (32 passed; 1 existing live API test ignored; project compiled successfully).

### Task 3: Final verification

- [x] Review the diff for unrelated changes, stale global-cancellation comments, and uncovered races.
- [x] Run frontend tests covering affected code, TypeScript and targeted lint/format checks (final results below).
- [x] Record actual verification results and any environment limitation; deliver the completed changes.

## Verification results

- Frontend regression suite: 258 passed, including 20 added cases; 11 initial failures reproduced before implementation. A subsequent review also reproduced the remount collision and pending timer on IPC failure before fixing them.
- Window instance checks: 5 passed.
- Backend AI module: 32 passed, including 9 added cases; 1 existing live API test ignored because it requires explicit API credentials. Three loopback network tests first failed by timing out on cancellation, then passed with wakeable request cancellation.
- TypeScript, targeted ESLint, Prettier, rustfmt and `git diff --check`: passed.
- Initial parallel Rust dependency compilation exhausted available memory. A single-job retry completed successfully after a transient dependency metadata error; the final full test build exited with code 0.
- No live external AI request was sent during verification.
- Review rerun: `npm test -- src/hooks/useAiOptimize.test.ts src/tools/text-toolbar/TextToolbar.test.tsx src/test/windowInstanceGuard.test.ts --maxWorkers=1`: 263 passed. A preceding parallel run during Rust compilation timed out in an existing QR-code test and failed the following QR-code test; both passed in the serial rerun without changing QR-code code.

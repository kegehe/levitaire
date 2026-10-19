# Disk Cleanup Hardening Design

## Goal

Reduce accidental cleanup risk without expanding the cleanup scope. The changes cover runtime target validation, quarantine path integrity, duplicate request handling, conservative developer-cache defaults, and regression tests.

## Design

- Revalidate purge targets immediately before the delete engine starts. The root must remain an existing directory, fixed-volume path, and non-reparse point.
- Validate quarantine storage paths derived from manifests against the quarantine root before any restore or purge operation. Invalid or redirected entries fail closed.
- Reject duplicate rule IDs in a single cleanup request.
- Keep ordinary temporary and thumbnail cleanup defaults unchanged; make developer package/build caches opt-in by changing only the bundled rule defaults.
- Add focused tests for the new request and path guards. Existing deletion behavior remains unchanged for valid targets.

## Verification

Run the disk-cleanup Rust test suite and the affected frontend configuration tests. Inspect the final diff to ensure no cleanup target paths are introduced into frontend code.

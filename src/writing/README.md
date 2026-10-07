# Portable writing core

Import from `src/writing/index.ts`. These modules have no React, store, Tauri, network, or filesystem dependencies.

`createWritingPipeline({request, persistence})` exposes `plan(request, signal)` and `run(request, signal, onProgress?)`. Planning returns a plan without replacing any stored checkpoint. Running returns a **review candidate** (`fullBody` includes the original `baselineText`), never writes the accepted manuscript.

The injected `request(system, user, role, signal, purpose, format)` must reject transport/incomplete-stream errors, honour cancellation, and report provider truncation as `{text, finishReason:'length'}`. JSON phases require a provider JSON-object response format. Roles are `planning`, `writing`, `review`; purposes are `scene_plan`, `scene_review`, `scene_draft`, `scene_continue`, `quick_draft`. A returned string asserts a complete response; do not return an unconfirmed streaming fragment as a string.

The injected persistence must atomically compare the **entire** durable expected checkpoint and save the next checkpoint. `isValidCheckpointTransition(expected,next)` verifies state transitions, leases, original input, and immutable completed prefixes. A synchronous UI get followed by an asynchronous save is not atomic. Hosts must serialize the compare/persist/publish operation, reject storage failures, prevent imports or plan edits over live runs, and retain recoverable previous records.

Explicit `resumeRunId` transfers the lease to a new UUID. Cumulative HTTP quota survives resume. Cancellation retains only fully completed scenes. Transport failures are not retried; only invalid JSON gets a bounded correction attempt and output limits get bounded continuation. `exitState` copied into `CompletedScene` is labelled **planned constraint**, not verified story fact.

`makeSourceFingerprint(material)` namespaces canonical UTF-8 SHA-256 as `pc-writing.v1:<digest>`. Include effective original draft/final text, task, all chapter metadata/order and context sources, and `workspaceFingerprintMaterial(workspace)`. Exclude operational model IDs, quota, and mode. The live source callback must construct the same material. Android checkpoint digests remain readable/importable, but must never be rebound to the PC hash just to enable resume; replan from current sources instead.

Wire field names and uppercase enums match Android 1.6.0. `validateWritingArchive` validates the whole plan/checkpoint graph without side effects. Importing `RUNNING` should mark it `INTERRUPTED`; imported work is not a live task. `validateReview` requires exact UTF-16 evidence offsets and prevents literary preference findings from acting as hard blockers.

`readTextRange`, `searchText`, `chapterReviewTextChunks`, `chapterReviewDiff` and `applyReviewDiff` preserve UTF-16 and whitespace; diff memory is bounded, not quadratic. `previewManuscript` supports plain TXT/Markdown (5 million characters, 2,000 chapters). `exportEpub` / `exportDocx` return dependency-free stored ZIP packages; callers choose paths and write/download the bytes. Generated XML is escaped, controls are replaced, and no imported markup is executed.

Independent tests: `node --test tests/writingCore.test.mjs`. They bundle the TypeScript in memory using the installed esbuild dependency and do not call real models or write application data.

# Changelog

## 0.1.0 (unreleased)

First version. Implements version 1.1 of the DecisionNode SDK surface: decisions with `truth`, `choice`, `score` and `number` questions, `/v1/systemone`, the models list, image uploads, sessions and the Batch API.

- `DecisionNode` client: `decide`, `decideMany`, `systemone`, `check`, `classify`, `score`, `number`, `gate`, `models`, `upload`, `openSession`, `supervise`, `batches`, `runBatch` and `decideRaw`. The helpers take `images` and `model` like `decide`.
- `number(instructions, min, max, step)` and `NumberAnswer` (`number`, `expected`, `confidence`, `probabilities` keyed by each value as the API wrote it). A grid field left out is left out of the request.
- An answer the API sends under the older wire name of `truth` is read as a `TruthAnswer` whose `type` is `truth`.
- `systemone` sends `POST /v1/systemone` with the model always set and each `truth` question written with the type name that path takes.
- Images by URL pass through after a local check (`https`, at most 2,048 characters), the recommended input. Images from a path, bytes or base64 are checked locally (JPEG, PNG or WebP by their first bytes, a declared type that must match, 10 MiB, 40 megapixels read from the image header), then sent inline when the request's local images total under `DEFAULT_INLINE_THRESHOLD` (524,288 bytes, the `inlineThreshold` option) and uploaded at or above it: one presign for the request, the PUTs in parallel with exactly the storage's headers, then the upload id. `Image.fromBase64` and `Image.fromUploadId` are new.
- An in-memory cache keyed by the SHA-256 of an image's bytes reuses an upload, whatever its size, until 5 minutes before it expires (at most 256 entries). Concurrent requests with the same bytes share one upload. A request whose placed upload went stale uploads again and is resent once.
- The API's fixed request rules are checked before anything is sent: images, a choice of 1 to 255 options, a score of 1 to 10 levels, a truth with instructions or criteria, a number with instructions and a grid of at most 4,096 values. A fault throws the API's own class (`BadRequestError`, or `ValidationError` where the API answers 422) with no status and no request id; in `decideMany` and batches, for the whole call.
- Sessions: `openSession`, `Session.connect`, `send`, `replies`, `next`, `end`, and `supervise`, with `Reply`, `FrameError` and `SessionClosed` values. `SessionLimitError`, a `RateLimitError`, for a `429` `session_limit_exceeded`, never retried. Node 22+, Deno and Bun use their own WebSocket; Node 20 uses the optional `ws` dependency.
- The Batch API: `batches.create`, `add` (split into calls of at most 10 MiB), `finalize`, `get`, `list`, `results` (streamed line by line) and `cancel`, and `runBatch`. Create, add and finalize retry only on 429 and 529.
- `gate` asks three fixed questions, worded the same in every DecisionNode SDK.
- Result types `Decision`, `DecisionResult` (one entry of `decideMany`), `ModelInfo` (one entry of `models()`) and `UnknownAnswer` (an answer of a type this version does not know).
- Empty strings for `apiKey`, `baseUrl` and `model` count as not given. `decideMany` checks every request before sending any: a `concurrency` below 1 throws a `RangeError`, an invalid request a `TypeError`, and nothing is sent.
- A missing token count or latency is `null`, never 0.
- Question builders `truth`, `choice`, `score` and `number`; plain wire-form question objects work anywhere a builder does.
- Answer types inferred from the questions: `choice` answers are typed with the union of their option names.
- A file image is read when the `Image` is made; an unreadable file throws a `TypeError` there. Its media type, and that of bytes given without one, is taken from the first bytes.
- Timeouts, retries on 408, 429, 5xx, timeouts and connection errors, honouring `retry-after-ms` and `Retry-After` (seconds or an HTTP date), capped at 60 seconds. A `sleep` option replaces the wait in tests.
- Only 200 to 299 is a success. Redirects are never followed; a 3xx is an error.
- A caller's `fetch` cannot be inspected, so it is refused with a `TypeError` when the client is made unless `fetchHonoursManualRedirect: true` confirms it honours `redirect: 'manual'` and keeps TLS checks on. It is still called with `redirect: 'manual'`, and a response it reports as redirected, as an opaque redirect, or from another URL is refused, its body never read.
- With `NODE_TLS_REJECT_UNAUTHORIZED=0`, an `https` base URL (the scheme in any case, `HTTPS://` included) is refused with a `TypeError`, when the client is made and before each request. A process-wide dispatcher that turns off certificate checks cannot be detected and is the caller's responsibility.
- The base URL must be `https`; `http` only for `localhost`, `127.0.0.1` and `::1`. Anything else throws a `TypeError` when the client is made.
- `timeout` must be above 0 and `maxRetries` a whole number 0 or more, else a `RangeError`. The timeout covers the whole attempt, from sending to the last byte of the body.
- Local argument problems (an empty question map, an unserialisable value, an unreadable image file, a bad base URL, timeout, `maxRetries`, `inlineThreshold`, `concurrency` or `pollInterval`) throw JavaScript's own `TypeError` or `RangeError`, never a `DecisionNodeError` subclass.
- An answer of a known type with a field missing or of the wrong type is an `UnknownAnswer` with its raw fields; the decision does not fail.
- `check`, `classify` and `score` throw `ServerError` (with the status, `requestId` and `reason`) when their own answer is missing or malformed; `decide` returns an `UnknownAnswer` for it.
- An error with no server message has `message` `""`.
- Typed errors under the exported base class `DecisionNodeError`, including `RefusalError`, `PermissionDeniedError`, `ContextLimitError`, `ValidationError`, `RateLimitError` and `OverloadedError`. A status without its own class is `DecisionNodeError` itself. An error's `message` is the API's own message; `reason` is the API's explanation from the `x-decisionnode-error` header.
- `SPEC_VERSION` (`"1.1"`) and `User-Agent: decisionnode-node/<version>`.
- `decision.safety`, parsed from the `x-decisionnode-safety` response header. The README documents the `x-decisionnode-safety-body` request header.
- ESM, CommonJS and TypeScript declarations. Runs on Node 20.16+, Deno, Bun and edge runtimes with `fetch`; sessions need a runtime whose WebSocket can send an `Authorization` header.

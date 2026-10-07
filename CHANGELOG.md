# Changelog

## 0.1.0 (unreleased)

First version. Implements version 1.0 of the DecisionNode SDK surface.

- `DecisionNode` client: `decide`, `decideMany`, `check`, `classify`, `score`, `gate`, `models` and `decideRaw`. `check`, `classify`, `score` and `gate` take `images` and `model` like `decide`.
- `gate` asks three fixed questions, worded the same in every DecisionNode SDK.
- Result types `Decision`, `DecisionResult` (one entry of `decideMany`), `ModelInfo` (one entry of `models()`) and `UnknownAnswer` (an answer of a type this version does not know).
- Empty strings for `apiKey`, `baseUrl` and `model` count as not given. `decideMany` checks every request before sending any: a `concurrency` below 1 throws a `RangeError`, an invalid request a `TypeError`, and nothing is sent.
- A missing token count or latency is `null`, never 0.
- Question builders `truth`, `choice` and `score`; plain wire-form question objects work anywhere a builder does.
- Answer types inferred from the questions: `choice` answers are typed with the union of their option names.
- Images from a file path, bytes, a `Blob` or an `https` URL. A file is read when the `Image` is made; its media type, and that of bytes given without one, is taken from the first bytes (JPEG, PNG or WebP). An unreadable file or an unrecognised format throws a `TypeError` there.
- Timeouts, retries on 408, 429, 5xx, timeouts and connection errors, honouring `retry-after-ms` and `Retry-After` (seconds or an HTTP date), capped at 60 seconds. A `sleep` option replaces the wait in tests.
- Only 200 to 299 is a success. Redirects are never followed; a 3xx is an error.
- A caller's `fetch` cannot be inspected, so it is refused with a `TypeError` when the client is made unless `fetchHonoursManualRedirect: true` confirms it honours `redirect: 'manual'` and keeps TLS checks on. It is still called with `redirect: 'manual'`, and a response it reports as redirected, as an opaque redirect, or from another URL is refused, its body never read.
- With `NODE_TLS_REJECT_UNAUTHORIZED=0`, an `https` base URL (the scheme in any case, `HTTPS://` included) is refused with a `TypeError`, when the client is made and before each request. A process-wide dispatcher that turns off certificate checks cannot be detected and is the caller's responsibility.
- The base URL must be `https`; `http` only for `localhost`, `127.0.0.1` and `::1`. Anything else throws a `TypeError` when the client is made.
- `timeout` must be above 0 and `maxRetries` a whole number 0 or more, else a `RangeError`. The timeout covers the whole attempt, from sending to the last byte of the body.
- Local argument problems (an empty question map, an unserialisable value, a bad image, base URL, timeout, `maxRetries` or `concurrency`) throw JavaScript's own `TypeError` or `RangeError`, never a `DecisionNodeError` subclass.
- An answer of a known type with a field missing or of the wrong type is an `UnknownAnswer` with its raw fields; the decision does not fail.
- `check`, `classify` and `score` throw `ServerError` (with the status, `requestId` and `reason`) when their own answer is missing or malformed; `decide` returns an `UnknownAnswer` for it.
- An error with no server message has `message` `""`.
- Typed errors under the exported base class `DecisionNodeError`, including `RefusalError`, `PermissionDeniedError`, `ContextLimitError`, `ValidationError`, `RateLimitError` and `OverloadedError`. A status without its own class is `DecisionNodeError` itself. An error's `message` is the API's own message; `reason` is the API's explanation from the `x-decisionnode-error` header.
- `SPEC_VERSION` (`"1.0"`) and `User-Agent: decisionnode-node/<version>`.
- `decision.safety`, parsed from the `x-decisionnode-safety` response header. The README documents the `x-decisionnode-safety-body` request header.
- The conformance tests fail, never skip, when `DECISIONNODE_CONFORMANCE_DIR` is unset. Passes conformance suite 1.3; the conformance harness catches the base error by its exported name.
- CI pins every action to a commit SHA, checks out with `persist-credentials: false`, and checks the conformance suite out at one pinned commit.
- ESM, CommonJS and TypeScript declarations. Runs on Node 20.16+, Deno, Bun and edge runtimes with `fetch`.

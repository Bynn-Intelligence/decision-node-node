# DecisionNode for TypeScript and JavaScript

The official TypeScript and JavaScript client for the [DecisionNode](https://decisionnode.com) API: ask yes-or-no, pick-one and scale questions about any text, JSON or image, and get calibrated probabilities back as typed answers.

Runs on Node.js 20.16+, Deno, Bun and edge runtimes. Ships ESM, CommonJS and TypeScript declarations, with no dependencies.

## Install

```sh
npm install @bynn/decisionnode
```

## Set your key

```sh
export DECISIONNODE_API_KEY="your-api-key"
```

## Quickstart

```ts
import { DecisionNode, choice, score, truth } from '@bynn/decisionnode';

const dn = new DecisionNode(); // reads DECISIONNODE_API_KEY

const d = await dn.decide({
  state: { ticket: 'I was charged twice and nobody has replied for 3 days.' },
  questions: {
    route: choice('Where should this go?', { billing: 'money', bug: 'broken', account: 'login' }),
    urgency: score('How urgent is this?', ['routine', 'today', 'urgent', 'critical']),
    escalate: truth('Escalate to a human now?'),
  },
});

d.answers.route.choice;        // "billing", typed as "billing" | "bug" | "account"
d.answers.route.probabilities; // { billing: 0.87, bug: 0.08, account: 0.05 }
d.answers.urgency.score;       // 2.31
d.answers.escalate.truth;      // 0.94
```

Answer types follow from the questions: `d.answers.escalate` is a `TruthAnswer`, `d.answers.urgency` a `ScoreAnswer`, and `d.answers.route.choice` is the union of the option names. There are no thresholds in the API: what 0.94 means is your code's decision.

## Questions

| Builder | Answer | Fields |
|---|---|---|
| `truth(instructions, ifTrue?, ifFalse?)` | `TruthAnswer` | `truth`: the probability that the statement is true, 0 to 1 |
| `choice(instructions, options)` | `ChoiceAnswer` | `choice`, `confidence`, `probabilities` by option name |
| `score(instructions, levels)` | `ScoreAnswer` | `score` (expected level index), `confidence`, `probabilities` and `legend` by level index |

`options` is a map of name to description, or a list of names. `levels` run low to high, 1 to 10 of them. `state`, `instructions`, descriptions and levels take a string or any JSON value.

A plain object in the API's wire form works anywhere a builder does, so a request copied from the API reference runs unchanged:

```ts
await dn.decide({
  state: 'Paid 740 SEK at Nordic Rail.',
  questions: {
    currency: { type: 'choice', instructions: 'Which currency?', criteria: { SEK: null, NOK: null, EUR: null } },
  },
});
```

Answers are read by question id. Question ids and option names are sent and returned byte for byte. Numbers are passed through exactly as the API sent them.

## The client

```ts
const dn = new DecisionNode({
  apiKey: 'your-api-key',       // default: DECISIONNODE_API_KEY
  baseUrl: 'https://...',       // default: DECISIONNODE_BASE_URL, else https://api.decisionnode.com
  model: 'decisionnode-latest', // default: DECISIONNODE_MODEL, else decisionnode-latest
  timeout: 10_000,              // milliseconds per attempt, above 0
  maxRetries: 2,                // retries after the first attempt, 0 or more
  headers: { 'x-team': 'support' },
  fetch: customFetch,           // default: the global fetch
  fetchHonoursManualRedirect: true, // required with fetch, see below
});
```

Every option is optional. An argument wins over the environment, which wins over the default; an empty string counts as not given, so `apiKey: ''` still reads `DECISIONNODE_API_KEY`. A client is safe to share and reuses connections.

The base URL must use `https`; `http` is accepted only for `localhost`, `127.0.0.1` and `::1`, so a key never travels unencrypted. Any other base URL, a `timeout` of 0 or less, or a `maxRetries` that is not a whole number 0 or more throws a `TypeError` or `RangeError` when the client is made, before any request.

### Your own `fetch`

A `fetch` you pass must honour `redirect: 'manual'`: it must never follow a redirect, and it must keep TLS certificate and hostname checks on. A function cannot be inspected, so the client cannot show that yours does; it refuses a `fetch` with a `TypeError` when the client is made unless you confirm it with `fetchHonoursManualRedirect: true`. The global `fetch` of Node, Deno, Bun and browsers honours it. Even with the confirmation, your `fetch` is called with `redirect: 'manual'`, and a response it reports as redirected, as an opaque redirect, or from a URL other than the one requested is refused with a `DecisionNodeError`, its body never read.

A `fetch` that wraps the global one, as most do, is safe as long as it passes `init.redirect` through and does not set its own:

```ts
const dn = new DecisionNode({
  fetch: (url, init) => fetch(url, { ...init, keepalive: true }),
  fetchHonoursManualRedirect: true,
});
```

The process's own transport settings count too: with `NODE_TLS_REJECT_UNAUTHORIZED=0` (which turns off certificate checks in Node and Bun), an `https` base URL is refused with a `TypeError`, both when the client is made and before each request, so your key never goes over a connection whose certificate is unchecked. The scheme is read case-insensitively, so `HTTPS://` counts as `https`. Only that variable can be seen: a process-wide dispatcher you install that turns off certificate checks cannot be detected, and keeping checks on there is your responsibility.

| Method | Returns |
|---|---|
| `decide({ state, questions, images, model })` | `Decision` |
| `decideMany(requests, { concurrency })` | `DecisionResult[]`: one `Decision` or error per request, in input order |
| `check({ state, instructions, ifTrue, ifFalse, images, model })` | `TruthAnswer` |
| `classify({ state, instructions, options, images, model })` | `ChoiceAnswer` |
| `score({ state, instructions, levels, images, model })` | `ScoreAnswer` |
| `gate({ action, context, images, model })` | `Decision` with `risk`, `touches_production` and `verdict` |
| `models()` | `ModelInfo[]` with each model's published limits |
| `decideRaw(body)` | The response body as parsed JSON |

An answer of a type this version does not know yet is an `UnknownAnswer` with every field in `raw`, and so is an answer of a known type with a field missing or of the wrong type: the decision does not fail. `check`, `classify` and `score` promise a typed answer instead, so when their own answer is missing or malformed they throw a `ServerError` with the status, `requestId` and the server's `reason` from `x-decisionnode-error`. Every method takes a second argument `{ signal }` to cancel the call with an `AbortSignal`.

A `Decision` has `answers`, `model` (the version that answered), `usage.inputTokens`, `usage.outputTokens`, `requestId`, `latencyMs` (the server's time), `safety` and `raw` (the parsed body). A token count or latency the response did not carry is `null`, never 0. `decision.get('route')` reads one answer by id.

### Many decisions

```ts
const results = await dn.decideMany(
  tickets.map((ticket) => ({ state: ticket, questions: { spam: truth('Is this spam?') } })),
  { concurrency: 8 },
);

for (const r of results) {
  if (r instanceof Error) console.error(r.message);
  else console.log(r.answers.spam.truth);
}
```

At most `concurrency` requests are in flight (default 8). Every request is checked before any is sent: a `concurrency` below 1 throws a `RangeError`, and an invalid request anywhere in the list (an empty question map, a value that cannot be serialised as JSON) throws a `TypeError`, with nothing sent. Once sending starts, one failure does not stop the others.

### Gate an action

```ts
const g = await dn.gate({ action: 'DROP TABLE invoices;', context: { environment: 'production' } });
g.answers.verdict.choice; // "allow" | "confirm" | "block"
g.answers.risk.score;     // 0 (none) to 4 (severe)
```

The gate's wording is fixed and the same in every DecisionNode SDK:

| Id | Type | Question |
|---|---|---|
| `risk` | score | How much harm could this action cause if it is wrong? Levels `none`, `low`, `moderate`, `high`, `severe`. |
| `touches_production` | truth | Does this action change a production system, production data or anything customers use? |
| `verdict` | choice | Should this action run as it is, wait for a person to confirm it, or be blocked? Options `allow` (safe to run without asking), `confirm` (a person should confirm it first), `block` (should not run). |

The state sent is `{ action, context }`.

### Fields this version does not know yet

```ts
const body = await dn.decideRaw({
  model: 'decisionnode-latest',
  state: 'Customer: refund me.',
  questions: { refund: { type: 'truth', instructions: 'Is this a refund request?' } },
});
```

`decideRaw` sends the body exactly as given and returns the parsed response.

## Images

```ts
import { Image } from '@bynn/decisionnode';

const d = await dn.decide({
  state: { claim: { total: '740.00', currency: 'SEK' } },
  images: [
    Image.fromPath('receipt', './receipt.jpg'),            // read and encoded for you
    Image.fromBytes('photo', bytes),                        // Uint8Array, ArrayBuffer or Blob
    Image.fromUrl('scan', 'https://example.com/scan.webp'), // fetched by the API
  ],
  questions: { total_matches: truth('Does the total on the receipt equal the total in the claim?') },
});
```

Up to 4 images a request, 10 MB each, JPEG, PNG or WebP; URLs must be `https`. A file is read when the `Image` is made, and its media type is taken from its first bytes; so is the media type of bytes given without one (`Image.fromBytes('photo', bytes, 'image/png')` names it instead). An unreadable file or a format that is not JPEG, PNG or WebP throws a `TypeError` right there. Reading a path needs a runtime with a file system (Node, Deno, Bun); on edge runtimes pass bytes or a URL.

## Errors

Every error is a `DecisionNodeError`, exported under that name, with `status`, `errorType`, `requestId` and `reason` (the API's explanation in words, from the `x-decisionnode-error` header). `message` is the API's own message exactly as sent, and empty when the response carried none; when no response arrived, it describes what went wrong.

| Status | Error | Extra fields |
|---|---|---|
| 400 | `BadRequestError`; `ContextLimitError` when the request is over the model's token limit | |
| 401 | `AuthenticationError` (also thrown before sending when no key is set) | |
| 402 | `InsufficientCreditError` | |
| 403 | `RefusalError` when the request was refused under the usage policy, else `PermissionDeniedError` | `category`, `safety` |
| 404 | `NotFoundError` | |
| 422 | `ValidationError` | `entries` |
| 429 | `RateLimitError` | `retryAfter` (seconds, at most 60) |
| 529 | `OverloadedError` | `retryAfter` (seconds, at most 60) |
| other 5xx, a 2xx whose body is not JSON, or a helper's own answer missing or malformed | `ServerError` | |
| no response | `ConnectionError`, `TimeoutError` | |
| any other status: 3xx, 405, 409, 408 after its retries | `DecisionNodeError` itself | |

Only 200 to 299 is a success. Redirects are never followed, so your key is never sent to another URL or over plain HTTP: a 3xx is an error with its status. This holds for your own `fetch` too: it must be confirmed with `fetchHonoursManualRedirect: true`, it is called with `redirect: 'manual'`, and a response it reports as redirected is refused with a `DecisionNodeError`, its body never read (see "Your own `fetch`").

Problems with your own arguments are not `DecisionNodeError`s: they throw JavaScript's own `TypeError` or `RangeError` (an empty question map, a bad base URL, timeout or `maxRetries`, a `concurrency` below 1, an invalid request in `decideMany`, a `fetch` without `fetchHonoursManualRedirect: true`, TLS checks turned off for an `https` base URL, an image that cannot be read or recognised, a value that cannot be serialised as JSON).

```ts
import { ContextLimitError, DecisionNodeError, RefusalError } from '@bynn/decisionnode';

try {
  await dn.decide({ state, questions });
} catch (err) {
  if (err instanceof ContextLimitError) console.error('Too long:', err.reason);
  else if (err instanceof RefusalError) console.error('Refused:', err.category);
  else if (err instanceof DecisionNodeError) console.error(err.status, err.message, err.requestId);
  else throw err;
}
```

### Retries and timeouts

Each attempt times out after 10 seconds, counted from sending the request to the last byte of the response body. Requests are retried twice after the first attempt on 408, 429, every 5xx (529 included), timeouts and connection errors. The wait is the API's `retry-after-ms` when sent, else `Retry-After` in seconds or as an HTTP date, capped at 60 seconds; without either it is exponential backoff from 0.5 s with jitter, up to 8 s. 400, 401, 402, 403, 404 and 422 are never retried. A decision changes nothing on the server, so a retry is always safe.

## Safety

The hosted API runs a safety check on every decision. `decision.safety` holds what it found:

```ts
d.safety; // { checked: true, harm: 0.031, selfHarm: 0.004, flagged: [] }
```

`flagged` lists the categories above your key's thresholds. When the check did not run, `safety` is `{ checked: false, reason }`. A self-hosted server sends no safety information and `safety` is `null`. A refused request throws `RefusalError` and is never retried.

### The `x-decisionnode-safety-body` request header

The check's result always arrives in the `x-decisionnode-safety` response header. To also receive it in the response body, send the request header `x-decisionnode-safety-body: true`. Set it once for every request through the client's `headers` option, then read it from the parsed body:

```ts
const dn = new DecisionNode({ headers: { 'x-decisionnode-safety-body': 'true' } });

const d = await dn.decide({ state, questions });
d.raw.safety; // the check's result, as the API sent it in the body
d.safety;     // the same check, parsed from the response header
```

Without the header the body carries no `safety` field.

## Models

```ts
const models = await dn.models();
models.map((m) => [m.name, m.limits]);
```

| Model | |
|---|---|
| `decisionnode-latest` | The main model, moving with each release (default) |
| `decisionnode-flash-latest` | The fast, lower-cost model, moving with each release |
| `decisionnode-1.0`, `decisionnode-1.0-flash` | Pinned versions |

Limits differ by model version; `models()` returns each model's published limits.

## Configuration

| Setting | Option | Environment variable | Default |
|---|---|---|---|
| API key | `apiKey` | `DECISIONNODE_API_KEY` | none: a call without a key fails before sending |
| Base URL | `baseUrl` | `DECISIONNODE_BASE_URL` | `https://api.decisionnode.com` |
| Model | `model` | `DECISIONNODE_MODEL` | `decisionnode-latest` |

The client sends no telemetry and contacts nothing but the base URL. Besides your key, your own headers and the JSON content headers, the only header it sends is `User-Agent: decisionnode-node/<version>`. To see each attempt, pass `logger: (line) => console.debug(line)`: it prints the method, path, status, request id and time, never the state, the questions or the key.

## Development

```sh
npm ci
npm run typecheck
npm test                  # unit tests
npm run build
DECISIONNODE_CONFORMANCE_DIR=/path/to/decision-node-conformance npm run test:conformance
```

The conformance suite runs every case of every kind against the suite's mock server; nothing else is contacted. This version passes suite 1.3. CI checks the suite out at the pinned commit in `CONFORMANCE_REF` in `.github/workflows/ci.yml`, pins every action to a commit SHA and checks out without persisting credentials. `DECISIONNODE_CONFORMANCE_DIR` is required: without it the conformance run fails rather than skipping. Tests can replace the wait between attempts with the `sleep` option, which is how a 60 second wait is checked without waiting.

`SPEC_VERSION` holds the version of the DecisionNode SDK specification this package implements, `"1.0"`.

## License

MIT. Copyright (c) 2026 Bynn Intelligence, Inc.

# DecisionNode for TypeScript and JavaScript

The official TypeScript and JavaScript client for the [DecisionNode](https://decisionnode.com) API: ask yes-or-no, pick-one, scale and number questions about any text, JSON or image, and get calibrated probabilities back as typed answers. Decide one request at a time, stream readings through a session, or run thousands at half price as a batch.

Runs on Node.js 20.16+, Deno, Bun and edge runtimes. Ships ESM, CommonJS and TypeScript declarations. Its one dependency is optional: `ws`, used only for sessions on Node 20, whose runtime has no WebSocket of its own.

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
import { DecisionNode, choice, number, score, truth } from '@bynn/decisionnode';

const dn = new DecisionNode(); // reads DECISIONNODE_API_KEY

const d = await dn.decide({
  state: { ticket: 'I was charged twice and nobody has replied for 3 days.' },
  questions: {
    route: choice('Where should this go?', { billing: 'money', bug: 'broken', account: 'login' }),
    urgency: score('How urgent is this?', ['routine', 'today', 'urgent', 'critical']),
    escalate: truth('Escalate to a human now?'),
    days: number('How many days has the customer waited?', 0, 30),
  },
});

d.answers.route.choice;        // "billing", typed as "billing" | "bug" | "account"
d.answers.route.probabilities; // { billing: 0.87, bug: 0.08, account: 0.05 }
d.answers.urgency.score;       // 2.31
d.answers.escalate.truth;      // 0.94
d.answers.days.number;         // 3
```

Answer types follow from the questions: `d.answers.escalate` is a `TruthAnswer`, `d.answers.urgency` a `ScoreAnswer`, `d.answers.days` a `NumberAnswer`, and `d.answers.route.choice` is the union of the option names. There are no thresholds in the API: what 0.94 means is your code's decision.

## Questions

| Builder | Answer | Fields |
|---|---|---|
| `truth(instructions, ifTrue?, ifFalse?)` | `TruthAnswer` | `truth`: the probability that the statement is true, 0 to 1 |
| `choice(instructions, options)` | `ChoiceAnswer` | `choice`, `confidence`, `probabilities` by option name |
| `score(instructions, levels)` | `ScoreAnswer` | `score` (expected level index), `confidence`, `probabilities` and `legend` by level index |
| `number(instructions, min?, max?, step?)` | `NumberAnswer` | `number` (the most probable value), `expected` (the mean), `confidence`, `probabilities` by value |

`options` is a map of name to description, or a list of names: 1 to 255 of them. `levels` run low to high, 1 to 10 of them. `state`, `instructions`, descriptions and levels take a string or any JSON value.

A `number` question reads a value from a grid: `min` to `max` in steps of `step`, by default 0 to 255 in whole numbers, at most 4,096 values. A bound you leave out is left out of the request, so the API's default applies. Its `instructions` are required. `probabilities` is keyed by each value exactly as the API wrote it (`"7"`, `"3.5"`); sort numerically when you need order.

```ts
const rating = await dn.number({ state: review, instructions: 'Rating out of 5, in halves?', min: 0, max: 5, step: 0.5 });
rating.number;        // 3.5
rating.probabilities; // { "3": 0.21, "3.5": 0.612, "4": 0.13 }
```

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

## Images

Send an image by URL when you can. It is the fastest input: nothing is uploaded, the request stays small, and the API fetches the image while it reads the rest of the request.

```ts
import { Image } from '@bynn/decisionnode';

const d = await dn.decide({
  state: { claim: { total: '740.00', currency: 'SEK' } },
  images: [Image.fromUrl('receipt', 'https://files.example.com/claims/4411/receipt.jpg')],
  questions: { total_matches: truth('Does the total on the receipt equal the total in the claim?') },
});
```

Local images work too, from a file, bytes or base64:

```ts
Image.fromPath('receipt', './receipt.jpg');      // read when the Image is made
Image.fromBytes('photo', bytes);                 // Uint8Array, ArrayBuffer or Blob
Image.fromBase64('photo', base64Text);           // no data: prefix
Image.fromUploadId('photo', 'upl_...');          // an image uploaded before
```

How a local image travels is chosen for you, for the fastest answer:

- **Small images go inline.** When the local images of one request total under 512 KiB (`DEFAULT_INLINE_THRESHOLD`, 524,288 bytes), they are sent as base64 in the request itself.
- **Larger ones are uploaded once.** At or above that total, the client asks the API for upload URLs in one call, puts each image straight into storage in parallel, and names it in the request by its upload id. Only the storage's own headers go with an upload: never your key, never your custom headers.
- **An uploaded image is reused.** The client remembers each upload by a SHA-256 of its bytes, in memory, until 5 minutes before the upload expires (an upload lives an hour). The same bytes are then sent by their upload id whatever their size, across `decide`, `decideMany`, session frames and batches, so they are never sent twice. Concurrent requests with the same bytes share one upload.
- **A stale upload is replaced.** If the API reports an upload the client placed as expired, already used or missing, the client uploads the image again and resends the request once.

Set `inlineThreshold` on the client to move the cut-off: `0` uploads every local image, a large value sends everything inline. `dn.upload(images)` uploads images whatever their size and returns their upload ids, for use later with `Image.fromUploadId`. No image is ever resized or re-encoded.

Every image is checked before anything is sent: at most 4 per request, ids present and unique, URLs by the rules above that need no network, an upload id's media type one of the three, local bytes JPEG, PNG or WebP by their first bytes (a media type you give must match them), at most 10 MiB each, and at most 40 megapixels, read from the image header without decoding the image. A fault throws `BadRequestError` with the API's message, and no request is made. An unreadable file throws a `TypeError` when the `Image` is made. Reading a path needs a runtime with a file system (Node, Deno, Bun); on edge runtimes pass bytes or a URL.

## The client

```ts
const dn = new DecisionNode({
  apiKey: 'your-api-key',       // default: DECISIONNODE_API_KEY
  baseUrl: 'https://...',       // default: DECISIONNODE_BASE_URL, else https://api.decisionnode.com
  model: 'decisionnode-latest', // default: DECISIONNODE_MODEL, else decisionnode-latest
  timeout: 10_000,              // milliseconds per attempt, above 0
  maxRetries: 2,                // retries after the first attempt, 0 or more
  inlineThreshold: 524_288,     // bytes; local images under it go inline, see Images
  headers: { 'x-team': 'support' },
  fetch: customFetch,           // default: the global fetch
  fetchHonoursManualRedirect: true, // required with fetch, see below
});
```

Every option is optional. An argument wins over the environment, which wins over the default; an empty string counts as not given, so `apiKey: ''` still reads `DECISIONNODE_API_KEY`. A client is safe to share and reuses its connections; create one and keep it.

The base URL must use `https`; `http` is accepted only for `localhost`, `127.0.0.1` and `::1`, so a key never travels unencrypted. Any other base URL, a `timeout` of 0 or less, or a `maxRetries` or `inlineThreshold` that is not a whole number 0 or more throws a `TypeError` or `RangeError` when the client is made, before any request.

| Method | Returns |
|---|---|
| `decide({ state, questions, images, model })` | `Decision` |
| `decideMany(requests, { concurrency })` | `DecisionResult[]`: one `Decision` or error per request, in input order |
| `systemone({ state, questions, images, model })` | `Decision`, from `POST /v1/systemone` |
| `check({ state, instructions, ifTrue, ifFalse, images, model })` | `TruthAnswer` |
| `classify({ state, instructions, options, images, model })` | `ChoiceAnswer` |
| `score({ state, instructions, levels, images, model })` | `ScoreAnswer` |
| `number({ state, instructions, min, max, step, images, model })` | `NumberAnswer` |
| `gate({ action, context, images, model })` | `Decision` with `risk`, `touches_production` and `verdict` |
| `models()` | `ModelInfo[]` with each model's published limits |
| `upload(images)` | The upload id of each image |
| `openSession({ questions, state, instructions, model, window, ttlSeconds })` | `Session` |
| `supervise(body, feed, onReply)` | The last `SessionClosed`, or `null` |
| `batches.create`, `add`, `finalize`, `get`, `list`, `results`, `cancel` | `Batch`, `BatchPage`, `BatchResults` |
| `runBatch(requests, { pollInterval, timeout })` | `{ batch, results }` |
| `decideRaw(body)` | The response body as parsed JSON |

An answer of a type this version does not know yet is an `UnknownAnswer` with every field in `raw`, and so is an answer of a known type with a field missing or of the wrong type: the decision does not fail. `check`, `classify`, `score` and `number` promise a typed answer instead, so when their own answer is missing or malformed they throw a `ServerError` with the status, `requestId` and the server's `reason` from `x-decisionnode-error`. Every method takes a last argument `{ signal }` to cancel the call with an `AbortSignal`.

A `Decision` has `answers`, `model` (the version that answered), `usage.inputTokens`, `usage.outputTokens`, `requestId`, `latencyMs` (the server's time), `safety` and `raw` (the parsed body). A token count or latency the response did not carry is `null`, never 0. `decision.get('route')` reads one answer by id.

### Checked before sending

The client checks every request against every fixed rule the API documents before it sends anything, so a request the API would refuse costs no round trip and the server never sees it. A fault throws exactly what the API would answer: the same class, the same `errorType` and message, and for a 422 a `ValidationError` whose `entries` are the API's own list. These errors have no `status` and no `requestId`, since no request was made.

| Rule | Thrown as |
|---|---|
| A question that is not an object, has no `type`, or has a field of the wrong type (`instructions`, a state, an option description, a score level or a truth side that is not a string, an object or an array; a choice without options as an object; a score without levels as a list) | `ValidationError`, the API's entries |
| An unknown question type, or a `number` question on `systemone` | `BadRequestError`, `api_usage_error`, "Invalid request." |
| A choice of no options or more than 255, a score of more than 10 levels, a truth with neither instructions nor criteria, a number without instructions | `BadRequestError` with the API's plain message and no `errorType` |
| A number grid: `min`, `max` or `step` not a finite number, beyond 2^53, `step` not above 0, more than 6 decimals in `min` or `step`, beyond the bound that keeps every value exact, `min` above `max`, more than 4,096 values | `ValidationError`, the API's entries |
| More than 128 objects and arrays inside each other | `BadRequestError`, `api_usage_error` |
| Images (see Images); an image URL that is not `https` | `BadRequestError`, `api_usage_error` |
| An `https` image URL over 2,048 characters, with user information, on a port other than 443, or naming a private, loopback, link-local or other reserved address literally | `BadRequestError`, `image_url_refused` |
| A session's `window` outside 1 to 64 or `ttl_seconds` outside 1 to 3,600 | `ValidationError`, the API's entries |
| A session frame (see Sessions) | `BadRequestError`, `api_usage_error` |
| A batch request without a `customId`, an empty or repeated one, an `add` with no requests, a `batches.list` `offset` below 0 or `limit` outside 1 to 100 | `BadRequestError`, `api_usage_error` |

Some limits are stated only by `/v1/models`: whether a model answers `number` questions or serves sessions, its largest session window, how many requests a batch holds and how long a `customId` may be. Once you have called `models()` on a client, it checks those against what it read, and a value `/v1/models` restates (such as the largest window) replaces the documented one; before that, those checks are left to the API. Token counts and anything that depends on the server's state, such as whether an upload is still live, stay the API's to judge. `decideRaw` sends its body exactly as given, unchecked.

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

At most `concurrency` requests are in flight (default 8). Every request is checked before any is sent: a `concurrency` below 1 throws a `RangeError`, a malformed request (an empty question map, a value that cannot be serialised as JSON) throws a `TypeError`, and a request the API would refuse (see "Checked before sending") throws its error, with nothing sent. Once sending starts, one failure does not stop the others. Requests that carry the same image share one upload.

### `/v1/systemone`

`systemone` sends the same request to `POST /v1/systemone`, the API's strict path: it always sends the model (the call's, else the client's), and writes each `truth` question with the type name that path takes. Its answers read exactly as `decide`'s. That path does not take `number` questions; the API refuses them with a `BadRequestError`.

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

## Sessions

A session answers a stream of readings against a fixed context: open it once with the questions, then send frames over one WebSocket and read a reply per frame. When frames arrive faster than they are answered, the newest one wins: the frames it replaced are listed in its reply's `dropped`.

```ts
const session = await dn.openSession({
  instructions: 'You are the mission supervisor of a survey drone.',
  state: { mission: 'Survey the north field' },
  questions: {
    mode: choice('Which flight mode now?', { continue: 'keep flying', hold: 'hover', return: 'fly home', land: 'land now' }),
    abort: truth('Should the mission be aborted now?'),
  },
});
await session.connect();

await session.send({ frame: { battery: 0.31, wind_mps: 11.4 } });
await session.send({ frame: 'Obstacle ahead.', image: Image.fromPath('camera', './frame.jpg') });

for await (const event of session.replies()) {
  if (event instanceof Reply) console.log(event.seq, event.answers.mode);
  else if (event instanceof FrameError) console.warn(event.seq, event.errorType, event.message);
  else break; // SessionClosed: event.code, event.reopen
}
await session.end();
```

- `openSession` always sends a model. It is retried like a decision, except when the key already holds as many open sessions as it may: that `429` throws `SessionLimitError` (a `RateLimitError`) at once.
- `connect()` sends your key in the handshake's `Authorization` header, never in the URL, together with the client's custom headers. A refused handshake rejects with `SessionClosed`. After a close with code `1013` (the server was busy), call `connect()` again: the session is kept.
- `send()` numbers frames from 1 unless you pass `seq`, and resolves once the frame is on the socket, without waiting for its reply. A frame that breaks a fixed rule (no `frame` and no `image`, an empty `frame`, an empty or unknown `questions` list, a `seq` out of range, an image URL, an image that breaks the image rules) is refused by `send()` itself with a `BadRequestError`: nothing is written and it takes no `seq`. Frames go out in the order you send them. A frame's image follows the rules under Images: small ones inline, large or already uploaded ones by upload id. Frames take no image URLs.
- `replies()` yields `Reply` and `FrameError` values and ends with the `SessionClosed`. A frame error is a value, never thrown: the session goes on. `next({ timeout })` reads one event.
- `end()` ends the session and closes the socket; a session that has already ended counts as ended. Pings are answered automatically.

`SessionClosed.reopen` is true for the codes after which a new session can be opened with the same body (`1001`, `1006`, `1011`, `4404`, `4408`, `4409`, `4410`). `supervise` does that for you over one long-lived feed:

```ts
async function* readings() {
  for await (const telemetry of drone) yield { frame: telemetry };
}

const closed = await dn.supervise(body, readings(), (event) => console.log(event));
```

It opens and connects a session, sends each reading, hands every reply and frame error to your callback, and reopens when a session ends with a reopen code: at once after `4408` (idle) and `4410` (expired), after a backoff of 1 to 30 seconds with jitter after the others, and on `1013` it connects to the same session again. It stops on any other code and returns that `SessionClosed`. When the feed ends it waits for the replies still owed, ends the session, and returns the last `SessionClosed`, or `null`.

Sessions need a WebSocket that can send an `Authorization` header: Node 22 and later, Deno and Bun have one, and on Node 20 the client uses the `ws` package, installed with it as an optional dependency. Browsers cannot send that header, so `connect()` throws a `TypeError` there; open sessions from your server.

## Batches

A batch runs many decide requests within 24 hours at half price. Each request carries your own `customId`, unique in the batch.

```ts
const { batch, results } = await dn.runBatch(
  tickets.map((t) => ({ customId: t.id, state: t.text, questions: { route: choice('Where?', ['billing', 'bug']) } })),
  { pollInterval: 60_000 },
);

for await (const r of results) {
  if (r.decision) console.log(r.customId, r.decision.answers.route.choice);
  else console.warn(r.customId, r.status, r.error?.message);
}
```

`runBatch` creates an empty draft, adds the requests, finalizes the batch, checks on it every `pollInterval` milliseconds (at least 10,000, default 60,000; a longer `Retry-After` from the API wins) until it ends, and returns it with its results. Past `timeout` (default 26 hours) it throws `TimeoutError`. If adding the requests fails, the draft is cancelled and the error thrown.

The steps are also available one by one on `dn.batches`:

| Method | Does |
|---|---|
| `create(requests?)` | Creates a batch; with no requests, an empty draft |
| `add(batchId, requests)` | Adds requests to a draft, in calls of at most 10 MiB |
| `finalize(batchId)` | Queues the draft to run |
| `get(batchId)` | The batch, with its `state` and `counters` |
| `list({ offset, limit })` | A page of your batches, newest first, with `nextOffset` |
| `results(batchId)` | The results of an ended batch, read line by line as they download |
| `cancel(batchId)` | Cancels the batch; lines already running finish |

Requests are sent as JSON Lines; each line always carries a model (the request's, else the client's), and a missing state is sent as empty. Every request is checked before anything is sent, as for `decide`, and its local images go inline or by upload id by the same threshold, counted per line. A `Batch` has every field of the API's batch object: `id`, `state`, `counters`, `createdAt`, `finalizedAt`, `expiresAt`, `endedAt`, `resultsUrl`, `resultsExpireAt`, `priceFactor`, `usage`, `error`, and `raw`.

`results()` returns `BatchResults`: iterate it once with `for await`, or call `toArray()`. Each `BatchResult` has `customId`, `status` (the line's HTTP status, or `expired` or `cancelled` for a line that never ran), `headers`, and either `decision` (a `Decision` for a `200` line, numbers exactly as sent) or `error` (the error that status and body give, as a value, never thrown).

Creating, adding and finalizing are retried only when the API answers `429` or `529`, since it applied nothing then; never after a timeout or a lost answer, which could create a second draft or add lines twice. A finalize answered `409` because an earlier, lost attempt went through returns the batch.

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
| 429 | `RateLimitError`; `SessionLimitError` when the key holds as many sessions as it may | `retryAfter` (seconds, at most 60) |
| 529 | `OverloadedError` | `retryAfter` (seconds, at most 60) |
| other 5xx, a 2xx whose body is not JSON, or a helper's own answer missing or malformed | `ServerError` | |
| no response | `ConnectionError`, `TimeoutError` | |
| any other status: 3xx, 405, 409, 410, 408 after its retries | `DecisionNodeError` itself | |

A failed upload to storage is a `DecisionNodeError` with the storage's status, `errorType` `upload_failed`, and the storage's error code in `reason`. Batch errors with their own `errorType` (`batch_limit_exceeded`, `invalid_batch_state`, `results_not_ready`, `results_expired`) use the classes above by status.

Only 200 to 299 is a success. Redirects are never followed, so your key is never sent to another URL or over plain HTTP: a 3xx is an error with its status. This holds for your own `fetch` too: it must be confirmed with `fetchHonoursManualRedirect: true`, it is called with `redirect: 'manual'`, and a response it reports as redirected is refused with a `DecisionNodeError`, its body never read (see "Your own `fetch`").

Problems with your own arguments are not `DecisionNodeError`s: they throw JavaScript's own `TypeError` or `RangeError` (an empty question map, a bad base URL, timeout, `maxRetries` or `inlineThreshold`, a `concurrency` below 1, a malformed request in `decideMany` or a batch, a `pollInterval` below 10 seconds, a `fetch` without `fetchHonoursManualRedirect: true`, TLS checks turned off for an `https` base URL, an image file that cannot be read, a value that cannot be serialised as JSON). A request the API would refuse is not an argument problem: it throws the API's own error class (see "Checked before sending").

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

An upload to storage is retried the same way on 5xx, timeouts and connection errors; a `412` on a retry means an earlier attempt stored the image, and counts as success. A `403` after the upload URL's 5 minutes have passed, by the client's clock, gets a fresh URL once; a second such `403` is thrown. Batch results stream in, and each read of the stream must bring data within the timeout.

## Safety

The hosted API runs a safety check on every decision. `decision.safety` holds what it found:

```ts
d.safety; // { checked: true, harm: 0.031, selfHarm: 0.004, flagged: [] }
```

`flagged` lists the categories above your key's thresholds. When the check did not run, `safety` is `{ checked: false, reason }`. A self-hosted server sends no safety information and `safety` is `null`. A refused request throws `RefusalError` and is never retried. In a session, each reply carries the check's result in its body form as `safety`, and a refused frame is a `FrameError` with `errorType` `refusal_error`.

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

Limits differ by model version; `models()` returns each model's published limits in `limits`, wire names as sent. The number, upload, session and batch limits are also typed fields: `numberOneQuestionValues`, `numberMaxGridValues`, `numberDefaultRange`, `numberDefaultStep`, `uploadMaxBytes`, `uploadTtlSeconds`, `uploadMediaTypes`, `sessions` and `batch`, each `null` when a model does not publish it.

## Configuration

| Setting | Option | Environment variable | Default |
|---|---|---|---|
| API key | `apiKey` | `DECISIONNODE_API_KEY` | none: a call without a key fails before sending |
| Base URL | `baseUrl` | `DECISIONNODE_BASE_URL` | `https://api.decisionnode.com` |
| Model | `model` | `DECISIONNODE_MODEL` | `decisionnode-latest` |
| Inline threshold | `inlineThreshold` | | `DEFAULT_INLINE_THRESHOLD`, 524,288 bytes |
| Clock | `clock` | | `Date.now`; the time, in epoch milliseconds, that upload URLs and cached uploads are judged by |

The client sends no telemetry and contacts nothing but the base URL, and the storage URLs the API returns for an upload. Besides your key, your own headers and the content headers, the only header it sends to the API is `User-Agent: decisionnode-node/<version>`. To see each attempt, pass `logger: (line) => console.debug(line)`: it prints the method, path, status, request id and time, never the state, the questions or the key.

`SPEC_VERSION` holds the version of the DecisionNode SDK specification this package implements, `"1.1"`.

## License

MIT. Copyright (c) 2026 Bynn Intelligence, Inc.

# DecisionNode for TypeScript and JavaScript

The official TypeScript and JavaScript client for the [DecisionNode](https://decisionnode.com) API: ask yes-or-no, pick-one, scale and number questions about any text, JSON or image, and get calibrated probabilities back as typed answers. Decide one request at a time, stream readings through a session, or run thousands at half price as a batch.

Runs on Node.js 20.16+, Deno, Bun and edge runtimes. Ships ESM, CommonJS and TypeScript declarations. Its one dependency is optional: `ws`, used only for sessions on Node 20, whose runtime has no WebSocket of its own.

## Install

From npm, once the package is published there:

```sh
npm install @decisionnode/sdk
```

From GitHub, which works today:

```sh
npm install github:Bynn-Intelligence/decision-node-node
```

The GitHub install builds the package on your machine as it installs, and you import it by the same name, `@decisionnode/sdk`.

## Set your key

```sh
export DECISIONNODE_API_KEY="your-api-key"
```

## Quickstart

```ts
import { DecisionNode, choice, number, score, truth } from '@decisionnode/sdk';

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
| `point(instructions, image?, units?)` | `PointAnswer` | `x`, `y`, `present`, `confidence`, `image`, `width`, `height` (see Points and boxes) |
| `box(instructions, image?, units?)` | `BoxAnswer` | `x1`, `y1`, `x2`, `y2`, `present`, `confidence`, `image`, `width`, `height` |

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
import { Image } from '@decisionnode/sdk';

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

A request body may be at most 25 MiB (26,214,400 bytes). Inline images count toward it; uploaded images and URLs do not, so with the default threshold a request with images stays far below it. The client measures each body as it would be sent before sending it (an image it would upload counted by its upload id, so nothing is uploaded to measure) and throws `RequestTooLargeError` for one over the limit.

Set `inlineThreshold` on the client to move the cut-off: `0` uploads every local image, a large value sends everything inline. `dn.upload(images)` uploads 1 to 16 images whatever their size and returns their upload ids, for use later with `Image.fromUploadId`. No image is ever resized or re-encoded.

Every image is checked before anything is sent: ids present, at most 64 characters (counted as Unicode code points) and unique, URLs by the rules above that need no network, an upload id's media type one of the three, local bytes JPEG, PNG or WebP by their first bytes (a media type you give must match them), at most 10 MiB each, and at most 40 megapixels, read from the image header without decoding the image. A fault throws `BadRequestError` with the API's message, and no request is made. A request holds at most 16 images; a 17th throws `ValidationError` as the API answers it (a `too_long` entry on the images). An unreadable file throws a `TypeError` when the `Image` is made. Reading a path needs a runtime with a file system (Node, Deno, Bun); on edge runtimes pass bytes or a URL.

### Referring to images and videos

There are two ways to say which image a question is about:

1. **By id (recommended).** Give each image a short, meaningful id and use it in the instructions, in backticks: "Does the total on `receipt` match the amount in the claim?"
2. **By number.** Images are numbered from 1 in the order of `images`: "image 2", "the second image", "Picture 2" and "the last image" all work.

The model sees each image as `Picture 1 (receipt):`, `Picture 2 (claim_photo):`, so both ways point to the same image. Prefer ids: they stay right when images are added or reordered. Use names, not digits, as ids (`front`, not `2`). Videos work the same way, by id or by number ("video 1"), numbered separately in the order of `videos`. The `image` of a point or box question takes the id.

```ts
const d = await dn.decide({
  state: 'Expense claim 4411: 740.00 EUR.',
  images: [
    Image.fromUrl('receipt', 'https://files.example.com/claims/4411/receipt.jpg'),
    Image.fromUrl('claim_photo', 'https://files.example.com/claims/4411/photo.jpg'),
  ],
  questions: { matches: truth('Does the total on `receipt` match the amount in the claim?') },
});
```

## Points and boxes

A `point` question finds one spot in an image; a `box` question draws a rectangle around something. They mix freely with the other types in one request, and several of them on the same image share one read of it.

```ts
import { Image, box, point, truth } from '@decisionnode/sdk';

const d = await dn.decide({
  images: [Image.fromUrl('belt', 'https://files.example.com/line-3/cam-2/0917.jpg')],
  questions: {
    pick: point('Point to the yellow package closest to the robot arm.'),
    damage: box('Draw a box around the damaged package.', 'belt'),
    any_damage: truth('Is any package on the belt damaged?'),
  },
});

const pick = d.answers.pick; // a PointAnswer
if (pick.present > 0.8 && pick.confidence > 0.7) {
  robot.pick(pick.x, pick.y);
} else {
  sendToOperator();
}
```

| Field | |
|---|---|
| `x`, `y` | The point, from the top-left corner of the image: `x` to the right, `y` down. Whole pixels by default; with units `normalized`, fractions of the width and height with 4 decimals |
| `x1`, `y1`, `x2`, `y2` | The box: its top-left corner (`x1`, `y1`) and bottom-right corner (`x2`, `y2`), in the same units |
| `present` | The probability that what you asked for is in the image at all. Under a low value the place is only the best guess |
| `confidence` | The probability that the place is right, if the thing is there: for a point, that it lies on the thing; for a box, that it overlaps the true box by at least half (intersection over union of 0.5 or more) |
| `image`, `width`, `height` | The image the answer refers to and its size in pixels, so you can draw or convert the answer without another lookup |

Every field is always there. When several things match, the answer is the best match; say which one you mean in the instructions ("the leftmost yellow package").

A point or box question needs an image in the request. With two or more images, name the one to look in by its id (`point(instructions, 'belt')`); a reference by number ("Picture 2") goes in the instructions. These rules and the units (`'pixels'` or `'normalized'`) are checked before anything is sent, and a fault throws `ValidationError` as the API would. `decide`, `decideMany` and batch requests take point and box questions.

## Videos

A video is sent as the frames you sampled, each with its time in seconds, and the questions see them as one video, in order and with their times. Only frames are sent: no video file, no video URL and no sound go to the API.

```ts
import { Video, VideoFrame, number, truth } from '@decisionnode/sdk';

// cameraFrames: [seconds, JPEG bytes] pairs you already hold
const frames = cameraFrames.map(([t, jpeg]) => new VideoFrame(t, jpeg));

const d = await dn.decide({
  state: 'Warehouse camera 4, loading dock, shift B.',
  videos: [new Video('dock', frames, { fps: 2 })],
  questions: {
    fall: truth('Does a person fall in the video?'),
    forklifts: number('How many forklifts pass the door?', 0, 50),
  },
});

d.answers.fall.truth;
d.usage.videoFrames;
d.warnings;
```

| | |
|---|---|
| `new Video(id, frames, { fps, start, end })` | `id` is unique across the request's images and videos. `fps` caps the frames read a second (above 0, at most 4; the API reads 2 by default). `start` and `end` set the window read, on the frames' own times; `end` is after `start`. Left out, the API's defaults apply |
| `new VideoFrame(t, data, mediaType?)` | `t` in seconds, at least 0, larger than the frame before it. `data` is JPEG, PNG or WebP bytes (`Uint8Array` or `ArrayBuffer`, the type read from them) or base64 text with its media type |

The ids, times, media types, `fps` and the window are checked before anything is sent, and a fault throws `BadRequestError` as the API would. A request holds at most 4 videos; a fifth throws `ValidationError` (a `too_long` entry on the videos). The frame limits are the API's and are published with it. Frames always go inline: they are never uploaded or resized. `decide`, the helpers, `decideMany` and batch requests take `videos`; sessions do not.

To turn a video file into frames, use the `dn` command-line tool (`dn truth "Does a person fall?" --video dock.mp4 --fps 2`); it runs FFmpeg on your machine and sends only the frames. This package has no such dependency.

## Boosters

A booster is a specialist model that reads the request's images before the decision. Its reading is added to what the model sees as evidence, and comes back in the response. The model still answers every question: a booster never answers one or adds one, and a request without boosters is answered exactly as before.

| Booster | Reads | Tells the model |
|---|---|---|
| `age` | A picture of a person | How old the person is, with a range and a confidence (the largest face is read) |
| `ai_generated` | Any picture | How likely the picture was made by an image generator, which generator most likely, and whether the file carries Content Credentials (C2PA) and who signed them |

```ts
import { AgeReading, Image, truth } from '@decisionnode/sdk';

const d = await dn.decide({
  images: [
    Image.fromUrl('a1b2', 'https://files.example.com/a1b2.jpg'),
    Image.fromUrl('c3d4', 'https://files.example.com/c3d4.jpg'),
  ],
  boosters: ['age', 'ai_generated'],
  questions: {
    adult: truth('Is the person in the first picture an adult?'),
    synthetic: truth('Is the second picture AI-generated?'),
  },
});

d.answers.adult.truth;                // 0.97
d.answers.synthetic.truth;            // 0.91

const age = d.evidence?.age;          // an Evidence: version 'age-v3', status 'ok', latencyMs, results
for (const reading of age?.results ?? []) {
  if (reading instanceof AgeReading && reading.faces > 0) {
    reading.ageYears;                 // 27, between reading.low and reading.high
  }
}
d.evidence?.ai_generated?.results[1]; // an AiGeneratedReading: generated 0.93, method 'inference'
d.usage.boosterTokens;                // the readings' share of usage.inputTokens
d.usage.boosters;                     // the booster calls billed
```

`boosters` takes up to 4 booster names, each named once, in the order you give. A booster that needs a setting is a `Booster`. Here `ai_generated` reads only the second picture, and the request fails if it cannot:

```ts
import { Booster } from '@decisionnode/sdk';

await dn.decide({
  images,
  boosters: ['age', new Booster('ai_generated', { images: ['c3d4'], require: true })],
  questions,
});
```

`new Booster(name, { images, require, options })` is sent as `{ name: 'ai_generated', images: ['c3d4'], require: true }`, each setting only when given; a plain object in that form works too. A `Booster` with no setting is sent as its name, so the request stays the plain list:

| Setting | |
|---|---|
| `images` | The ids of the request's images the booster reads. Left out: every image |
| `require` | `true`: a booster that fails or does not answer in time fails the request (see the errors below). Left out or `false`: the decision runs without that reading, and `evidence` says why |
| `options` | The booster's own settings, for boosters that have any. The API checks them, not this package |

Boosters read images in every form (URL, inline or uploaded), and every question sees every reading. Which boosters exist and which your workspace may use is the API's to say, so nothing about `boosters` is checked before sending, and a name the API adds later works with this version. `decide`, the helpers, `decideMany` and batch requests take `boosters`; sessions do not. Without boosters (left out or an empty list) the request carries no `boosters` field.

`decision.evidence` holds one `Evidence` per booster the request named, by name in the request's order, and is `null` for a request that named none:

| Field | |
|---|---|
| `version` | The version of the booster that read, such as `age-v3` |
| `status` | `ok`; `timeout` (no answer in time); `error`; `skipped` (none of the request's images is one it reads) |
| `latencyMs` | How long the booster took |
| `billedCalls` | The calls of this booster billed on this request |
| `results` | One reading per image the booster was to read, each naming its `image`. A picture it did not read (it timed out or failed) or could not decode (`readable` false) is an `UnknownReading` holding those fields, and `status` says why |
| `raw` | The entry as the API sent it |

| Reading | Fields |
|---|---|
| `AgeReading` | `image`, `faces` (how many faces were found; the largest is read), and `ageYears`, `low`, `high` (the range) and `confidence`, each `null` when `faces` is 0 |
| `AiGeneratedReading` | `image`, `generated` (the probability that a generator made the picture), `confidence`, `method` (`inference`: read from the pixels; `c2pa`: the file's trusted Content Credentials declare it generated or edited by AI), `topGenerator` (`name` and `probability` of the likeliest generator when the reading says likely generated; `null` otherwise, and always on a `c2pa` reading), `c2paSigner` (who signed the file's Content Credentials when they are trusted, else `null`), `c2pa` (`untrusted` when the file carries Content Credentials that validate but are not trusted, which change nothing in the reading; else `null`) |
| `UnknownReading` | `image` and `raw`: a reading of a booster this version does not know, or one with a field missing or of the wrong type. The decision does not fail |

A request whose boosters name `ocr` waits 30 s per attempt by default instead of 10 s. A `timeout` you set on the client is used as given, even below 30 s. Such a decision is never retried after a timeout, because the server finishes the timed-out attempt and may bill it: set a timeout of at least 30 s for requests that name `ocr`. Its other retries (408, 429, 5xx, a lost connection) stay.

Each reading also has `raw`. Numbers are passed through as received. `usage.boosterTokens` (the readings' share of `inputTokens`) and `usage.boosters` (the booster calls billed) are `null` for a request without boosters.

Booster calls are drawn from your prepaid balance with the request's tokens: one call per booster and image read with status `ok`. A booster that timed out or failed is free, and a refused request pays for none of its boosters. The readings' tokens are input tokens at the model's price. The price per call is on the [pricing page](https://decisionnode.com/docs/pricing#boosters).

| Status, `errorType` | Error | When |
|---|---|---|
| 400 `api_usage_error` | `BadRequestError`, the reason in `reason` | `boosters` is malformed: not a list, more than 4, a booster named twice, an unknown key in `options` |
| 400 `booster_unknown` | `BadRequestError` | A name that is not a booster |
| 400 `booster_input_mismatch` | `BadRequestError` | A booster that reads images on a request without any, or an `images` id that is not one of the request's images |
| 403 `booster_not_enabled` | `PermissionDeniedError` | The booster is turned off for your workspace (in the console) |
| 529 `booster_unavailable` | `OverloadedError` | A booster with `require: true` failed or did not answer in time. Retried like every 529 |

Every error of a request that named boosters carries `boosters`, each booster's status and time by name, read from the `x-decisionnode-boosters` response header, so you can see which required booster failed:

```ts
try {
  await dn.decide({ images, questions, boosters: [new Booster('age', { require: true })] });
} catch (err) {
  if (err instanceof OverloadedError && err.errorType === 'booster_unavailable') {
    err.boosters.age?.status; // 'timeout' or 'error'
  }
}
```

## The client

```ts
const dn = new DecisionNode({
  apiKey: 'your-api-key',       // default: DECISIONNODE_API_KEY
  baseUrl: 'https://...',       // default: DECISIONNODE_BASE_URL, else https://api.decisionnode.com
  model: 'decisionnode-moe',    // default: DECISIONNODE_MODEL, else decisionnode-moe
  timeout: 10_000,              // milliseconds per attempt, above 0
  maxRetries: 2,                // retries after the first attempt, 0 or more
  inlineThreshold: 524_288,     // bytes; local images under it go inline, see Images
  uploadTimeout: 60_000,        // milliseconds per storage PUT of an upload, apart from timeout
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
| `check({ state, instructions, ifTrue, ifFalse, images, model })` | `TruthAnswer` |
| `classify({ state, instructions, options, images, model })` | `ChoiceAnswer` |
| `score({ state, instructions, levels, images, model })` | `ScoreAnswer` |
| `number({ state, instructions, min, max, step, images, model })` | `NumberAnswer` |
| `gate({ action, context, images, model })` | `Decision` with `risk`, `touches_production` and `verdict` |
| `models()` | `ModelInfo[]` with each model's published limits |
| `upload(images)` | The upload id of each image |
| `checkRequest(method, request)` | Nothing: runs a call's local checks without sending |
| `openSession({ questions, state, instructions, model, window, ttlSeconds })` | `Session` |
| `supervise(body, feed, onReply)` | The last `SessionClosed`, or `null` |
| `batches.create`, `add`, `finalize`, `get`, `list`, `results`, `cancel` | `Batch`, `BatchPage`, `BatchResults` |
| `runBatch(requests, { pollInterval, timeout })` | `{ batch, results }` |
| `decideRaw(body)` | The response body as parsed JSON |

An answer of a type this version does not know yet is an `UnknownAnswer` with every field in `raw`, and so is an answer of a known type with a field missing or of the wrong type: the decision does not fail. `check`, `classify`, `score` and `number` promise a typed answer instead, so when their own answer is missing or malformed they throw a `ServerError` with the status, `requestId` and the server's `reason` from `x-decisionnode-error`. Every method takes a last argument `{ signal }` to cancel the call with an `AbortSignal`.

A `Decision` has `answers`, `model` (the version that answered; for a fine-tuned model its pinned name), `usage.inputTokens`, `usage.outputTokens`, for a request with videos `usage.videoFrames` and `usage.videoSeconds` (`null` otherwise), for a request with boosters `evidence`, `usage.boosterTokens` and `usage.boosters` (`null` otherwise), `usage.cost` (what the answer cost in USD: `usd`, `modelUsd`, `boostersUsd` and `freeTier`, read as sent and never summed by the SDK; `null` when the server sent none), `fallback` (on a fallback answer the model that answered and the one asked for, `null` otherwise; see Fallback below), `warnings` (what the API changed when it read the videos, an empty array when nothing), `requestId`, `latencyMs` (the server's time), `safety` and `raw` (the parsed body). A token count or latency the response did not carry is `null`, never 0. `decision.get('route')` reads one answer by id.

### Checked before sending

The client checks every request against every fixed rule the API documents before it sends anything, so a request the API would refuse costs no round trip and the server never sees it. A fault throws exactly what the API would answer: the same class, the same `errorType` and message, and for a 422 a `ValidationError` whose `entries` are the API's own list. These errors have no `status` and no `requestId`, since no request was made.

| Rule | Thrown as |
|---|---|
| A question that is not an object, has no `type`, or has a field of the wrong type (`instructions`, a state, an option description, a score level or a truth side that is not a string, an object or an array; a choice without options as an object; a score without levels as a list) | `ValidationError`, the API's entries |
| An unknown question type | `BadRequestError`, `api_usage_error`, "Invalid request." |
| A choice of no options or more than 255, a score of more than 10 levels, a truth with neither instructions nor criteria, a number without instructions | `BadRequestError` with the API's plain message and no `errorType` |
| A number grid: `min`, `max` or `step` not a finite number, beyond 2^53, `step` not above 0, more than 6 decimals in `min` or `step`, beyond the bound that keeps every value exact, `min` above `max`, more than 4,096 values | `ValidationError`, the API's entries |
| More than 128 objects and arrays inside each other | `BadRequestError`, `api_usage_error` |
| Images (see Images); an image URL that is not `https` | `BadRequestError`, `api_usage_error` |
| An image id over 64 characters, counted as Unicode code points (`Image 1: its id is longer than 64 characters.`, images counted from 0) | `BadRequestError`, `api_usage_error` |
| An `https` image URL over 2,048 characters, with user information, on a port other than 443, or naming a private, loopback, link-local or other reserved address literally | `BadRequestError`, `image_url_refused` |
| A session's `window` outside 1 to 64 or `ttl_seconds` outside 1 to 3,600 | `ValidationError`, the API's entries |
| A session frame (see Sessions) | `BadRequestError`, `api_usage_error` |
| A batch request without a `customId`, an empty or repeated one, an `add` with no requests, a `batches.list` `offset` below 0 or `limit` outside 1 to 100 | `BadRequestError`, `api_usage_error` |
| A body over 25 MiB (26,214,400 bytes) as it would be sent: a request, each `decideMany` request (none is sent when one is over), each batch line with its `customId` | `RequestTooLargeError`, `request_too_large_error` |

Some limits are stated only by `/v1/models`: whether a model answers `number` questions or serves sessions, its largest session window, how many requests a batch holds and how long a `customId` may be. Once you have called `models()` on a client, it checks those against what it read, and a value `/v1/models` restates (such as the largest window) replaces the documented one; before that, those checks are left to the API. A request's model is matched to an entry by its name, else by the entry that states that name as its `alias` or its pinned `version`, so `decisionnode-moe` finds the limits of the version it stands for; a name the list does not state is left to the API. Token counts and anything that depends on the server's state, such as whether an upload is still live, stay the API's to judge. `decideRaw` sends its body exactly as given, unchecked.

To check a request without sending it, for example to validate input from a form before you queue it, pass the same arguments to `checkRequest`. It runs every check the call would run, with the limits held from `models()`, and throws the same error; it sends nothing and uploads nothing, and resolves when the request would be sent:

```ts
await dn.checkRequest('decide', { state, questions, images });
await dn.checkRequest('openSession', { questions, window: 8 });
await dn.checkRequest('batches.create', requests); // or 'batches.add'
await session.checkFrame({ frame: reading, questions: ['abort'] });
```

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
  model: 'decisionnode-moe',
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
- `checkFrame()` runs the same checks as `send()` without writing anything.
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

#### Proxies and certificates

The session's socket goes through the same proxy and trusts the same certificates as the client's requests wherever the runtime allows it. Options for the socket alone go in the client's `webSocketOptions`; it may not turn certificate checks off.

| Runtime | Proxy | Custom certificate authority |
|---|---|---|
| Node 22 and later | The process's global dispatcher, which `fetch` uses too: set an undici `ProxyAgent` with `setGlobalDispatcher` and both follow it. `webSocketOptions: { dispatcher }` sets one for the socket alone | `NODE_EXTRA_CA_CERTS`, or the `connect.ca` of the dispatcher |
| Node 20 (`ws`) | `webSocketOptions: { agent }`, an HTTP agent that tunnels through your proxy; the global dispatcher does not reach `ws` | `NODE_EXTRA_CA_CERTS`, or `webSocketOptions: { ca }` |
| Bun | `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, which Bun's `fetch` reads, are handed to the socket too; `webSocketOptions: { proxy }` sets one for the socket alone. Needs a Bun version whose WebSocket takes `proxy` | `webSocketOptions: { tls: { ca } }` |
| Deno | `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` apply to the socket as to `fetch` | `--cert` or `DENO_CERT`, as for `fetch` |

When you pass your own `fetch`, the client cannot see what proxy it uses: configure the socket's with the global settings above or `webSocketOptions`.

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

`results()` returns `BatchResults`: iterate it once with `for await`, or call `toArray()`. It reads the whole results file as it downloads, line by line, however many lines it has; nothing is paged and the file is never held whole in memory unless you collect it. Each `BatchResult` has `customId`, `status` (the line's HTTP status, or `expired` or `cancelled` for a line that never ran), `headers`, and either `decision` (a `Decision` for a `200` line, numbers exactly as sent) or `error` (the error that status and body give, as a value, never thrown).

Creating, adding and finalizing are retried only when the API answers `429` or `529`, since it applied nothing then; never after a timeout or a lost answer, which could create a second draft or add lines twice. A finalize answered `409` because an earlier, lost attempt went through returns the batch.

## Errors

Every error is a `DecisionNodeError`, exported under that name, with `status`, `errorType`, `requestId` and `reason` (the API's explanation in words, from the `x-decisionnode-error` header). `message` is the API's own message exactly as sent, and empty when the response carried none; when no response arrived, it describes what went wrong.

| Status | Error | Extra fields |
|---|---|---|
| 400 | `BadRequestError`; `ContextLimitError` when the request is over the model's token limit | |
| 401 | `AuthenticationError` (also thrown before sending when no key is set) | |
| 402 | `InsufficientCreditError` | |
| 403 | `RefusalError` when the request was refused under the usage policy (`category`, `safety`); every other 403 is a `PermissionDeniedError`: a booster turned off for your workspace (`booster_not_enabled`) or a suspended workspace, told apart by `errorType` | `category`, `safety` on a `RefusalError` |
| 404 | `NotFoundError` | |
| 413 | `RequestTooLargeError`: the body is over 25 MiB; never retried. Send large images as uploads | |
| 422 | `ValidationError` | `entries` |
| 429 | `RateLimitError`; `SessionLimitError` when the key holds as many sessions as it may | `retryAfter` (seconds, at most 60) |
| 529 | `OverloadedError`, also when a required booster failed (`booster_unavailable`) | `retryAfter` (seconds, at most 60) |
| other 5xx, a 2xx whose body is not JSON, or a helper's own answer missing or malformed | `ServerError` | |
| no response | `ConnectionError`, `TimeoutError` | |
| any other status: 3xx, 405, 409, 410, 408 after its retries | `DecisionNodeError` itself | |

The service's edge or a proxy may answer with a page of its own instead of the API's JSON error (a 408 for an upload that stalls, a 413 for a body far over the limit, a 502). Such an error is classed by its status alone, as in the table (a 400 is a `BadRequestError`, never a `ContextLimitError`; a 403 a `PermissionDeniedError`, never a `RefusalError`; a 422 a `ValidationError` with no `entries`), with `errorType` `null`, `requestId` and `reason` from the headers when sent, and the client's own `message`: `HTTP <status> <text>`, then the request id when there is one, for example `HTTP 413 Content Too Large` or `HTTP 408 Request Timeout (request id req_...)`. The page itself is never read into the error. Retries are the same as for any body: a 408 is retried, a 413 never.

Every error also has `boosters`: for a request that named boosters, each booster's status and time from the `x-decisionnode-boosters` header (see "Boosters"); an empty object otherwise.

A failed upload to storage is a `DecisionNodeError` with the storage's status, `errorType` `upload_failed`, and the storage's error code in `reason`. Batch errors with their own `errorType` (`batch_limit_exceeded`, `invalid_batch_state`, `results_not_ready`, `results_expired`) use the classes above by status.

Only 200 to 299 is a success. Redirects are never followed, so your key is never sent to another URL or over plain HTTP: a 3xx is an error with its status. This holds for your own `fetch` too: it must be confirmed with `fetchHonoursManualRedirect: true`, it is called with `redirect: 'manual'`, and a response it reports as redirected is refused with a `DecisionNodeError`, its body never read (see "Your own `fetch`").

Problems with your own arguments are not `DecisionNodeError`s: they throw JavaScript's own `TypeError` or `RangeError` (an empty question map, a bad base URL, timeout, `maxRetries` or `inlineThreshold`, a `concurrency` below 1, a malformed request in `decideMany` or a batch, a `pollInterval` below 10 seconds, a `fetch` without `fetchHonoursManualRedirect: true`, TLS checks turned off for an `https` base URL, an image file that cannot be read, a value that cannot be serialised as JSON). A request the API would refuse is not an argument problem: it throws the API's own error class (see "Checked before sending").

```ts
import { ContextLimitError, DecisionNodeError, RefusalError } from '@decisionnode/sdk';

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

Each attempt times out after 10 seconds (30 seconds for a request whose boosters name `ocr`, unless you set `timeout`), counted from sending the request to the last byte of the response body. Requests are retried twice after the first attempt on 408, 429, every 5xx (529 included), timeouts and connection errors, except that a decision naming `ocr` is never retried after a timeout (see Boosters). The wait is the API's `retry-after-ms` when sent, else `Retry-After` in seconds or as an HTTP date, capped at 60 seconds; without either it is exponential backoff from 0.5 s with jitter, up to 8 s. 400, 401, 402, 403, 404, 413 and 422 are never retried. A decision changes nothing on the server, so a retry is otherwise safe.

Each storage PUT of an upload has its own timeout, `uploadTimeout` (60 seconds by default), apart from `timeout`, since a large image on a slow uplink needs longer than a decision. It is retried the same way on 5xx, timeouts and connection errors; a `412` on a retry means an earlier attempt stored the image, and counts as success. A `403` after the upload URL's 5 minutes have passed, by the client's clock, gets a fresh URL once; a second such `403` is thrown. Batch results stream in, and each read of the stream must bring data within the timeout.

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
| `decisionnode-moe` | The main model, always its current release (default) |
| `decisionnode-flash` | The fast, lower-cost model, always its current release |

A pinned release is `decisionnode-<family>-<version>`, for example `decisionnode-moe-<version>`, with the versions `models()` lists. Every answer names the pinned id that answered in `decision.model`, so you can log which release decided. `model` is free text: a pinned id, a fine-tuned model's name, and the older ids the API still accepts (`decisionnode-1.0`, `decisionnode-1.0-flash`, `decisionnode-latest`, `decisionnode-flash-latest`) are sent as given.

Limits differ by model version; `models()` returns each model's published limits in `limits`, wire names as sent. The number, upload, session and batch limits are also typed fields: `numberOneQuestionValues`, `numberMaxGridValues`, `numberDefaultRange`, `numberDefaultStep`, `uploadMaxBytes`, `uploadTtlSeconds`, `uploadMediaTypes`, `sessions` and `batch`, each `null` when a model does not publish it.

### Fallback

A request for `decisionnode-moe` that no ready worker can take at once is answered by Flash, billed at Flash's price. `decision.model` is the model that answered, and `decision.fallback` names both: the model that answered by its pinned id, and the model asked for as it was asked (a family id or an older id as the family id, a pinned id as itself); it is `null` on an ordinary answer:

```ts
const d = await dn.decide({ model: 'decisionnode-moe', state, questions });
if (d.fallback !== null) {
  d.fallback.servedModel;    // 'decisionnode-flash-<version>', the model that answered
  d.fallback.requestedModel; // 'decisionnode-moe', the model asked for
}
```

With `fallback: false` such a request gets the 529 `OverloadedError` instead, retried like every 529. `decide`, the helpers, `decideMany` requests and batch requests take `fallback`; it is sent only when given, and left out the API's default (`true`) applies. Sessions, batch lines and fine-tuned models never fall back.

### Fine-tuned models

A model your workspace fine-tuned in the console is called by its name, `<base>@<workspace>/<name>`, which means the version deployed most recently, or `<base>@<workspace>/<name>:<n>` for one version:

```ts
const d = await dn.decide({ model: 'decisionnode-moe@acme/fraud', state, questions });
d.model; // 'decisionnode-moe@acme/fraud:3', the version that answered
```

The name is sent as given, in `model` on any call or as the client's `model`. Only your workspace's keys can use it, and it answers like its base: the same question types, answers, limits and errors. A name that does not exist, a version that is not deployed and another workspace's model all throw `BadRequestError` with the message `Unknown model: <name>`.

`models()` lists your workspace's fine-tuned models beside the catalogue. Their entries add `fineTuned` (`true`), `base` (the base model's pinned id), `adapterVersion` (the version number; on a plain name, the version it resolves to) and `status` (`deployed`, which answers decisions, or `ready`: trained and checked, not deployed). Each is `null` on a catalogue entry.

## Configuration

| Setting | Option | Environment variable | Default |
|---|---|---|---|
| API key | `apiKey` | `DECISIONNODE_API_KEY` | none: a call without a key fails before sending |
| Base URL | `baseUrl` | `DECISIONNODE_BASE_URL` | `https://api.decisionnode.com` |
| Model | `model` | `DECISIONNODE_MODEL` | `decisionnode-moe` |
| Inline threshold | `inlineThreshold` | | `DEFAULT_INLINE_THRESHOLD`, 524,288 bytes |
| Upload timeout | `uploadTimeout` | | `DEFAULT_UPLOAD_TIMEOUT`, 60,000 milliseconds per storage PUT |
| Clock | `clock` | | `Date.now`; the time, in epoch milliseconds, that upload URLs and cached uploads are judged by |

The client sends no telemetry and contacts nothing but the base URL, and the storage URLs the API returns for an upload. Besides your key, your own headers and the content headers, the only header it sends to the API is `User-Agent: decisionnode-node/<version>`. To see each attempt, pass `logger: (line) => console.debug(line)`: it prints the method, path, status, request id and time, never the state, the questions or the key.

`SPEC_VERSION` holds the version of the DecisionNode SDK specification this package implements, `"1.3"`.

## License

MIT. Copyright (c) 2026 Bynn Intelligence, Inc.

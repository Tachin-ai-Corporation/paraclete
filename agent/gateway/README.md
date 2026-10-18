# agent/gateway/

The model gateway. It runs one organ turn: builds the request, calls Vertex AI (Gemini, or Claude when
turned on), runs the tool loop, and returns the result with a tool log the model cannot fabricate.

**Belongs here:** the turn loop, provider routing and fallbacks, prompt caching and sessions, the tool
registry and each organ's toolset.
**Doesn't:** deciding what work to do. That is the brain service and `work/`. Nor reading
configuration or listening on a port: the gateway service in `services/` reads `config/contracts.json`
and the token file, builds the pieces below, and calls `listen()` on loopback.

The gateway runs as its own service on a local port. Other code calls it over HTTP, never by import.

## Files

| File | Does |
|---|---|
| `server.mjs` | `createGatewayServer()`: the HTTP endpoints below, bearer-token auth, sessions, organ routing. Returns a server that is not listening |
| `turn-loop.mjs` | `runTurn()` and `runTurnWithFallback()`: model call, tools, next call, until done; the loop guard, terminal tools, the tool log; a fallback that continues the transcript instead of rerunning tools |
| `google-step.mjs` | One Gemini step: transcript to `contents`, thought signatures and call ids, explicit context caching |
| `anthropic-step.mjs` | One Claude step: transcript to messages, prompt-caching breakpoints, streaming, temperature only |
| `loop-guard.mjs` | Detects a stuck tool loop and decides when to warn and when to stop |
| `model-clients.mjs` | Builds the Vertex AI SDK clients; parses `<provider>/<model id>` strings |
| `organs.mjs` | Each organ's job, toolset, sampling, step budget, prompt, and the model tier it runs on |
| `tools.mjs` | The tools (shell, files, images, memory, verdicts), their result bounds, and each organ's toolset |
| `images.mjs` | Recognizes an image by its bytes, reads its size from its header, and keeps only a turn's most recent images attached |
| `sessions.mjs` | The in-memory store of the cortex's conversation sessions |
| `skill-catalog.mjs` | The skill index a tool-using organ sees, built from skill directories |
| `health.mjs` | `/healthz` and `/ready` |

Only this package imports npm packages, and only `model-clients.mjs` imports them; see
[agent/README.md](../README.md).

## HTTP contract

The server listens on loopback only. Requests that run a model or touch a session carry
`Authorization: Bearer <gateway token>`; a missing or wrong token gets `401`
`{"error":{"message":"Unauthorized","type":"auth_error"}}`. The probes need no token.

| Method and path | Auth | Answers |
|---|---|---|
| `POST /v1/chat/completions` | token | Runs one organ turn (below) |
| `DELETE /v1/sessions/{id}` | token | Drops a session: `{"ok":true,"existed":true\|false}`. Idempotent |
| `GET /status` | token | Uptime, request count, sessions (ids and counters, never content), providers, models |
| `GET /v1/models` | none | Liveness before relying on the gateway: `{"object":"list","data":[{"id":"vertex-google","available":true,"location":"global",…}]}` |
| `GET /healthz` | none | `200 ok` while the process serves |
| `GET /ready` | none | `200` when every provider an organ or fallback is routed to has a client, else `503`; body `{"ready","providers","required"}` |

### `POST /v1/chat/completions`

An OpenAI-style chat request. `model` names the organ: `brain/<organ>` or just `<organ>`
(`cortex`, `prefrontal`, `motor`, `cerebellum`, `temporal-memory`, `temporal-research`); none means
`cortex`. The organ decides the model, the tools and the step budget; the caller cannot pick them.

```json
{
  "model": "brain/motor",
  "messages": [
    { "role": "system", "content": "stable block" },
    { "role": "system", "content": "working memory" },
    { "role": "user", "content": "[BRAIN-ORCHESTRATED]\n…" }
  ],
  "max_tokens": 65536,
  "temperature": 0.3,
  "top_p": 0.9,
  "exec": false,
  "session": { "id": "m-123", "op": "open | continue | reset", "seq": 0 }
}
```

- `messages`: `system`, `user` and `assistant` roles. Content is a string or an array of text parts
  `{ "type": "text", "text", "tier": "boot" | "mission" | "volatile" }`; tiers place Claude's cache
  breakpoints and never reach the provider. The organ's own prompt (`prompts/<organ>.md` plus the
  role's addition) always leads the system prompt; each system message the caller sends follows as a
  separate block, most stable first. Only the gateway reads organ prompts. Any other role is a `400`.
- Text passes to the model untouched, `[BRAIN-ORCHESTRATED]` included: the marker tells the mouth a
  turn is the brain's own (`agent/providers/notifications.mjs` sends it with acknowledgments). The
  gateway neither strips nor reads it.
- `max_tokens`, `temperature`, `top_p` override the organ's defaults. Claude gets `temperature` only.
- `exec: true` gives `temporal-memory` its memory toolset for a consolidation run; without it that
  organ has no tools.
- `session` (the cortex, when sessions are on): `open` stores the messages as the session; `continue`
  replays the stored messages plus these; `reset` replaces them. Organs excluded from sessions (the
  cerebellum) ignore it.

Response, `200`:

```json
{
  "id": "chatcmpl-gateway-7",
  "object": "chat.completion",
  "created": 1792252800,
  "model": "vertex-google/gemini-4-argon",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…\n\n---\n[TOOL EXECUTION LOG]\n…\n[END TOOL LOG]" }, "finish_reason": "STOP" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "promptTokenCount": 0, "candidatesTokenCount": 0, "cachedContentTokenCount": 0, "cacheCreationTokenCount": 0, "last_step_input_tokens": 0, "steps": 1, "provider": "vertex-google" },
  "session": { "id": "m-123", "present": true, "seq": 1 },
  "tool_records": [{ "seq": 0, "tool": "readFile", "args": "…", "result": "…", "chars": 52000 }]
}
```

- `model` is the model that answered: the fallback's when the organ's model failed.
- `content` ends with the tool log when any tool ran (see `agent/context/tool-record.mjs`).
- `session` appears when a session was opened, reset or continued; `tool_records` when a result was
  too large for the log.
- A `continue` that misses answers `200` with only
  `{"session":{"id","present":false,"reason":"absent" | "organ" | "system_hash" | "seq"}}` and makes
  no model call; the brain then reopens.
- Errors: `400` for a malformed request or an unknown organ, `413` for a body over the limit, `500`
  when both the organ's model and its fallback failed. Body
  `{"error":{"message","type":"gateway_error","code"}}`.

## Settings

`createGatewayServer({ settings })` and `runTurn({ settings })` take one settings object; anything
missing or invalid falls back to the default. The gateway service maps `config/contracts.json` onto
it.

| Key | Default | What it controls |
|---|---|---|
| `anthropic.promptCaching` | `false` | Claude prompt caching on the stable system block |
| `anthropic.messageBreakpoints` | `false` | Cache breakpoints inside the first user message, by tier |
| `anthropic.sessionAffinity` | `false` | Keeps one organ's calls on one Vertex backend so cache reads hit |
| `anthropic.cacheTtlStable` / `cacheTtlMission` | `'1h'` / `'1h'` | Cache lifetimes for boot and mission tiers |
| `gemini.explicitCache` / `explicitCacheTtlSeconds` | `false` / `3600` | Gemini explicit context caching of the system prompt and tools |
| `images.kept` | `3` | How many of the images viewed in one turn stay attached to the transcript |
| `images.geminiPlacement` | `'function-response'` | Where a tool's image goes in a Gemini request: inside the function response, or `'user-part'` after it (see Images) |
| `toolRecord` | see `agent/context/tool-record.mjs` | When a tool result is stored by reference instead of inlined |
| `loopGuard.*` | identical 2/3, duplicate 3/4, semantic 8/16, error 5/8, `synthesize: true` | When a stuck tool loop gets a warning, and when it is stopped |
| `retry.maxRetries` / `retry.baseDelayMs` | `3` / `2000` | Retries of a transient model error before failing over |
| `session.enabled` / `session.excludedOrgans` | `false` / `['cerebellum']` | Cortex conversation sessions |
| `maxBodyBytes` | 16 MB | The largest request the server accepts |

Passed to the constructors instead: the organ models (`createOrganRegistry({ models: { cortex,
strong, fast, fallback } })`), the step budget, tool limits (`createToolRegistry({ limits })`,
`imageMaxBytes` and `imageMaxSide` among them) and session limits (`createSessionStore()`).

## Images

The motor, temporal-research and the cerebellum can look at an image with the `viewImage` tool; the
verifier needs it because a chart or a rendered slide is checked by looking at it.

- **The tool.** `viewImage({ path })` takes a PNG, JPEG or WebP file, checked by its first bytes, up
  to `imageMaxBytes` (3,750,000: Claude on Vertex AI takes 5 MB of base64 per image) and
  `imageMaxSide` (8000 px, Claude's limit). Anything else is refused with a route through the files
  skill: a PDF page or slide is rendered with `file-convert <path> png`, a GIF converted the same way,
  a larger image copied smaller with `file-convert <path> jpg` or a resize. GIF is refused because
  Gemini's function responses don't take it, and the transcript must suit every model a turn can
  fall back to. `readFile` routes an image to `viewImage`.
- **The transcript.** The tool returns `{ result, images }`. The text goes to the tool log and the
  loop guard; the image goes on the tool message as `images: [{ mimeType, data, name }]` and nowhere
  else. Nothing the gateway answers with (the content, the tool log, `tool_records`) carries pixels.
- **Retention.** Every step resends the transcript, so only the `images.kept` most recent images stay
  attached. An older one is taken off, and its tool message says so and how to view it again. A
  fallback continues the same transcript, so it sees the images the failed model saw, never more.
- **Gemini.** By default the image goes inside the function response, as
  `functionResponse.parts: [{ inlineData: { mimeType, data } }]`: Vertex AI's multimodal function
  responses, documented for Gemini 3 and later. `images.geminiPlacement: 'user-part'` sends it
  instead as an `inlineData` part after the function responses in the same user turn.
- **Claude.** The image goes inside the `tool_result`: `content: [{ type: 'text', text },
  { type: 'image', source: { type: 'base64', media_type, data } }]`.
- **Sessions.** Images never reach a cortex session: a request's messages may hold only text, and a
  session stores only what the brain sent.

# claude-bridge

A small local server that answers Anthropic Messages API-shaped requests (`POST /v1/messages` with a JSON schema) by running the Claude Code CLI (`claude -p`) on a dedicated sign-in folder. It exists so an n8n workflow can be tested against a real Claude model on your own subscription. The workflow calls `{ANTHROPIC_BASE_URL}/v1/messages`. For local tests that base URL points here. In production it points at `https://api.anthropic.com` with an API key, and nothing else in the workflow changes.

> **Personal local testing only.** A subscription sign-in is for ordinary, individual use. Never use this bridge for client work, business production, or anything that runs on its own. Those use API keys.
>
> **Calls count against your plan's usage limits.** If extra usage is switched on for the account, calls past the limits can be billed. Every bridge run spends one call on the startup canary. `maxCalls` (default 60) caps a run.

Zero dependencies: Node 24 built-ins only.

## Setup

1. Create a sign-in folder just for the bridge and sign in to it once. Each folder gets its own Keychain entry, so your default `~/.claude` sign-in is never touched. Never copy credential files between folders.

   ```bash
   CLAUDE_CONFIG_DIR=$HOME/.claude-n8n-bridge claude auth login
   CLAUDE_CONFIG_DIR=$HOME/.claude-n8n-bridge claude auth status   # check the account and plan
   ```

2. Start the bridge with a fresh token for each run:

   ```bash
   export CLAUDE_BRIDGE_TOKEN=$(openssl rand -hex 24)
   CLAUDE_BRIDGE_CONFIG_DIR=$HOME/.claude-n8n-bridge \
   CLAUDE_BRIDGE_PORT=8787 \
   CLAUDE_BRIDGE_MAX_CALLS=60 \
   node _shared/claude-bridge/claude-bridge.mjs
   # stdout: ready http://127.0.0.1:8787 account=<email-domain>/<plan>
   ```

   Environment variables: `CLAUDE_BRIDGE_PORT` (default 0, which picks a free port), `CLAUDE_BRIDGE_TOKEN` (required, at least 24 characters), `CLAUDE_BRIDGE_CONFIG_DIR` (required), `CLAUDE_BRIDGE_MAX_CALLS` (default 60), and `CLAUDE_BRIDGE_CLI` (default `claude`). Logs go to stderr, one line per request, and each line shows `budget_left`. Ctrl-C or SIGTERM shuts the bridge down cleanly.

3. Point the workflow at it: base URL `http://127.0.0.1:8787` and header `x-api-key: $CLAUDE_BRIDGE_TOKEN`. For production, change the base URL to `https://api.anthropic.com` and use a real API key with `anthropic-version`.

## Programmatic use

```js
import { startBridge } from './claude-bridge.mjs';

const bridge = await startBridge({
  token,                                   // required, >= 24 chars
  configDir: '~/.claude-n8n-bridge',       // required; ~ is expanded; must exist
  port: 0, host: '127.0.0.1', cli: 'claude',
  maxCalls: 60, timeoutMs: 90000, maxQueue: 4,
  allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  // optional extras: logger(line), killGraceMs (default 5000)
});
// resolves only after the preflight passes:
// { url, port, account: { emailDomain, plan }, stats(): { calls, errors, queued }, close() }
```

`stats().calls` counts CLI calls started, including the canary. `errors` counts calls that failed after reaching the CLI queue. `queued` counts requests waiting behind the running call.

## HTTP interface

All routes require the token, sent as `x-api-key: <token>` or `Authorization: Bearer <token>`.

- `GET /health` returns `{ ok, cli_version, account, stats, budget_left }`.
- `POST /v1/messages` takes a JSON body:

  ```json
  {
    "model": "claude-haiku-5-5",
    "max_tokens": 512,
    "system": "You triage inbound leads.",
    "messages": [{ "role": "user", "content": "Lead text..." }],
    "output_config": { "format": { "type": "json_schema", "schema": { "type": "object", "properties": {}, "required": [] } } },
    "metadata": { "user_id": "optional" }
  }
  ```

  - `system` can be a string or an array of text blocks.
  - `messages` must hold exactly one `user` message. Its content can be a string or text blocks, and text blocks are joined together.
  - The older top-level `output_format` is also accepted.
  - `max_tokens` and `temperature` are accepted but ignored.
  - `stream`, `tools`, images and other non-text blocks are rejected.

  The response looks like this:

  ```json
  {
    "id": "msg_bridge_<uuid>", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
    "content": [{ "type": "text", "text": "<JSON.stringify(structured_output)>" }],
    "stop_reason": "end_turn", "stop_sequence": null,
    "usage": { "input_tokens": 1304, "output_tokens": 162 },
    "bridge": { "via": "claude-code-cli", "cli_version": "2.1.296", "duration_ms": 1502, "notional_cost_usd": 0.0003, "request_id": "req_bridge_<uuid>" }
  }
  ```

  `input_tokens` includes cache reads and writes, plus the CLI's own prompt overhead, so it is not comparable with API token counts. `notional_cost_usd` is what the CLI estimates the call would cost on the API. The subscription is not billed per call.

### Schemas

The bridge checks every result against the request's schema with a built-in validator. The schema's root `type` must be `"object"`. These keywords are supported: `type` (object, string, number, integer, boolean, array, null, or an array of those), `properties`, `required`, `additionalProperties`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `items`, `minItems` and `maxItems`. Annotations such as `description` and `title` are allowed. Any other keyword (`$ref`, `anyOf`, `pattern`, `format` and so on) gets a 400, so a schema is never only partly checked.

The real API's structured outputs support a different subset. Numeric and string-length limits are a common gap. Before going live, check the schema against the current Anthropic structured-outputs docs.

### Errors

Errors use Anthropic's shape: `{ "type": "error", "error": { "type", "message" } }`. Every response carries a `request-id` header.

| Status | `error.type` | When |
| --- | --- | --- |
| 400 | `invalid_request_error` | bad JSON or content-type, model not allowed, no schema or a non-object root, unsupported schema keyword, system text over 16 KB, user text over 32 KB, non-text blocks, tools, streaming |
| 401 | `authentication_error` | token missing or wrong |
| 403 | `permission_error` | an `Origin` header is present (browser), or the Host header is not `127.0.0.1:<port>` or `localhost:<port>` |
| 404 | `not_found_error` | any other route |
| 413 | `request_too_large` | body over 256 KB |
| 429 | `rate_limit_error` | queue full, call budget spent, or the CLI reports a plan usage or rate limit (always sends `retry-after`) |
| 502 | `api_error` | CLI failed or could not start, output not JSON, `structured_output` missing or not matching the schema, model mismatch |
| 503 | `authentication_error` | CLI is not signed in (run the `auth login` command in the message) |
| 503 | `overloaded_error` | model overloaded, bridge starting or shutting down |
| 504 | `timeout_error` | CLI took longer than `timeoutMs`; its whole process group was killed |

## Hardening

- **Network.** The bridge binds only to `127.0.0.1`; any other `host` throws.
  - The Host header must be `127.0.0.1:<port>` or `localhost:<port>`, which guards against DNS rebinding.
  - Any request with an `Origin` header gets a 403, and no CORS headers are ever sent.
  - Only two routes exist, and both require the token. Tokens are compared with `timingSafeEqual` over SHA-256 digests, which are always the same length. A token shorter than 24 characters is refused.
- **Request limits.** Body ≤ 256 KB, JSON content-type only, model from the allowlist, schema required with an object root, system text ≤ 16 KB, user text ≤ 32 KB, text blocks only.
- **Child process.**
  - The CLI is started with `spawn(cli, args, { shell: false, detached: true })` in a fresh `mkdtemp` folder, and that folder is always removed afterwards.
  - The prompt is written to stdin, and stdin is then closed.
  - System text, model and schema go in as `--flag=value`, so a value that starts with `-` can't be read as a flag.
  - Flags passed every time: `-p --output-format json --tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands --no-session-persistence`. `--bare` is never used.
  - Output buffers are capped at 2 MB.
  - On a timeout, the bridge sends SIGTERM to the whole process group and SIGKILL 5 s later.
- **Environment allowlist.** The child gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `CLAUDE_CONFIG_DIR`. `ANTHROPIC_*`, `CLAUDE_CODE_*`, `AWS_*`, `OPENAI_*`, proxies and `NODE_OPTIONS` never reach it. `USER` is required: the CLI looks up its Keychain credential under account `$USER`. Tested with `claude auth status`: with `USER` the CLI is signed in; without it, or with a wrong value, the CLI reports `loggedIn: false`. `HOME` and `LOGNAME` alone are not enough. If `USER` is missing (for example under launchd), the bridge fills it in from `os.userInfo()`.
- **Config dir.** A leading `~` is expanded with `os.homedir()` and the path is resolved. It must be an existing directory and must not be the default `~/.claude`. There is never a fallback.
- **Preflight.** On startup the bridge runs these checks before it serves anything. Any failure stops startup with a message that says what to fix.
  1. `claude --version`.
  2. `claude auth status`: the CLI must be signed in via `claude.ai` with provider `firstParty`. Only the email domain and plan are kept.
  3. One canary call through the exact production code path (Haiku, a tiny schema). It counts toward `maxCalls`.
- **Output checks.** These checks run on every CLI result:
  - `is_error: true` counts as a failure whatever `subtype` says.
  - `structured_output` is required and is checked against the request schema.
  - The requested model id must appear in `modelUsage`, optionally with a date suffix.
- **Concurrency and budget.**
  - One CLI process runs at a time, and other requests wait in a first-in, first-out queue of up to `maxQueue`. A request that disconnects while waiting leaves the queue without using a call.
  - A per-process `maxCalls` budget applies.
- **Logging.** One line per request: request id, model, status, duration, error type, budget left. Prompts, outputs, tokens, environment variables and full email addresses are never logged.
- **Shutdown.** `close()`, SIGINT and SIGTERM stop new connections, reject requests still waiting, kill the running child's process group, and resolve once that's done. A process `exit` hook SIGKILLs any group still running.

## Three CLI gotchas (Claude Code 2.1.296)

1. **Prompt on stdin, not argv.** If stdin has no data and is not a TTY, `claude -p` waits 3 s and prints a warning. A prompt in argv that starts with `--` would also be read as a flag. The bridge always writes the prompt to stdin and closes it.
2. **`~` is not expanded for you.** `CLAUDE_CONFIG_DIR='~/...'` points at an empty folder. The CLI even creates a `~` folder in the working directory, then returns `{"subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}`. The bridge expands `~` itself, requires an existing absolute folder, and treats `is_error: true` as a failure regardless of `subtype`.
3. **Never `--bare`.** It forces API-key auth and skips the Keychain, so a subscription sign-in stops working.

## Tests

```bash
node --test _shared/claude-bridge/tests/bridge.test.mjs
```

The tests use `tests/fake-claude.mjs` as the CLI, so they make no real Claude calls. The bridge passes only an allowlisted environment to the child, so the fake can't be steered with environment variables. Instead it reads a `MODE:<name>` marker from the prompt, or `<configDir>/fake-mode` and `<configDir>/fake-auth.json`, and it records argv, environment, stdin and pid under `<configDir>/calls/`.

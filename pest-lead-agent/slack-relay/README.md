# Slack Socket Mode relay

`relay.mjs` carries the **Approve** and **Hold** clicks from Slack to the n8n workflow "Pest Lead Agent · Handle approval". It has no dependencies (Node 24's global `WebSocket` and `fetch`).

Socket Mode means Slack never calls us: the relay opens one outbound WebSocket to Slack and Slack sends the clicks down it. Nothing listens on a public port, so there is no request URL and no signing-secret check on Slack's side. The xapp app token authenticates the socket.

## What it does

1. Calls `apps.connections.open` with the app token and connects to the WebSocket URL it returns. It never logs the URL, because the URL carries a connection ticket.
2. Answers `hello` (logs that it is connected). On `disconnect` it closes the socket and reconnects at once. On any other close it reconnects with backoff (1, 2, 5, 10, 30 s). Every reconnect asks Slack for a fresh URL.
3. **Acks every envelope first** (`{"envelope_id": ...}`, because Slack wants the ack within 3 seconds), then decides what to do with it.
4. Forwards an envelope only when it is `interactive` → `block_actions` from the configured team (`SLACK_TEAM_ID`) with action `approve_lead` or `hold_lead`. Everything else is dropped, and the log records its type only, never its content.
5. Forwards **ids only**: `team_id`, `action_id`, `value` (the lead's event id), `user_id`, `channel_id`, `message_ts`, `action_ts`, `retry_attempt`. The message text, the blocks, `response_url` and `trigger_id` are never sent. The workflow refuses any other field with a 400.
6. Signs the POST the same way leads are signed (`workflow/signature.js`): HMAC-SHA256 over `<timestamp>.<raw body>` in `x-ridgeway-signature`, Unix seconds in `x-ridgeway-timestamp`, with a 300 s window and a timing-safe compare in n8n. The secret is `SLACK_RELAY_SECRET` (in Doppler: `RIDGEWAY_SLACK_RELAY_SECRET`).
7. Posts only to `http://127.0.0.1` or `localhost` (it refuses any other target). If n8n is unreachable it retries 3 times, 2 s apart. It does not repeat an HTTP answer such as a 500, because the workflow has its own retries and the buttons stay on the message until a decision has been applied.

## Run it

The usual way is the whole live stack (n8n, the mock and this relay in one process, until Ctrl-C):

```sh
pest-lead-agent/scripts/live-slack.sh --check            # app token + Socket Mode: wait for hello, exit
pest-lead-agent/scripts/live-slack.sh --post <event ids> # post leads to #leads, then serve the buttons
pest-lead-agent/scripts/live-slack.sh                    # serve again from the saved state (results/live-slack/)
```

To run it by itself, for example against the demo editor on port 5688 (from the repository root, so Doppler finds its config):

```sh
SLACK_TEAM_ID=T0C88V52NGN RELAY_TARGET_URL=http://127.0.0.1:5688/webhook/ridgeway/slack-action \
  doppler run -- node pest-lead-agent/slack-relay/relay.mjs
```

The editor then needs the same secret and an approver list in its environment. `env.sh` sets `SLACK_RELAY_SECRET` to a placeholder and leaves `SLACK_APPROVER_IDS` empty, so nobody can approve. Set both before `./start.sh`.

Tests: `tests/relay.test.mjs` (an injected WebSocket class and fetch, no network). It covers ack before forward, ids only, the signature, filtering by team, action and type, retry_attempt, reconnect on `disconnect` and on a dropped socket, backoff after a failed `apps.connections.open`, and that the token and the URL are never logged.

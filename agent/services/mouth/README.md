# agent/services/mouth/

The mouth: the agent's only way out. Every few seconds it delivers the work envelopes whose
delivery is pending, each to exactly the Address it carries, in the agent's voice, and sends a short
status note to a person whose request is taking a while. It serves the dashboard on every instance
and Google Chat on a Workspace role. Deciding that something should be said is the brain's (it sets
`delivery_status: 'pending'`); taking messages in is the [ears](../ears/README.md)'.

**Installed:** yes, as `paraclete-mouth.service`.

| File | Job |
|---|---|
| `main.mjs` | The service: wires the parts, runs the poll loop, writes the heartbeat |
| `delivery.mjs` | Which pending envelopes go out, to which Address, with which mentions and files; retries and failures |
| `voice.mjs`, `voice-prompt.md` | Rewrites the brain's text as the agent speaking, or suppresses internal noise |
| `voicing-context.mjs` | The recent conversation the voice hears first |
| `status-updates.mjs`, `status-prompts.md` | The notes a person gets while a mission runs |
| `outbound.mjs` | The one send call: the right token per channel, and what each channel last answered |

Delivery itself (the Address model, the dashboard write and the Chat post) is
`agent/providers/channel.mjs`.

## Rules

- **Exactly the Address.** A reply goes where the message came from: a dashboard thread, a Chat
  space's thread, or a Chat direct message. The mouth never picks another destination.
- **Never lost, never twice.** A failed send backs off (`contracts.delivery`) and is tried again,
  then fails for good after `max_attempts`; a Chat address with no space, or Chat on an instance
  without a Workspace account, fails at once. A delivery already said with the same content is only
  marked again, not repeated.
- **Checkpoints and tasks stay inside,** except acknowledgments and notifications.

## Google Chat

- The mouth posts as the agent's own Workspace user, with `chat.messages` and `chat.spaces.readonly`
  through domain-wide delegation (`agent/auth/workspace-scopes.mjs`). It is the only service that
  holds the send scope.
- Every post carries a client-assigned message id starting `client-paraclete-`. The ears recognize the
  agent's own messages by it. For a delivery or a status note the id comes from what the message is
  (the envelope and a digest of its content, or the mission and the step), and goes out as the
  request id too: a post retried after a crash returns the message Chat already has instead of a
  second copy.
- A reply in a space goes into the thread of the message it answers and mentions the person who
  asked (`<users/<id>>`), or everyone (`<users/all>`) when the agent is stuck and nobody in particular
  asked. A reply to a direct message goes to the conversation and mentions no one.
- Markdown becomes what Chat renders (headings and bold-italic as bold, links as their text), and a
  message over Chat's 4,096 characters is cut in its body, never in its mentions.
- The heartbeat's `gchat` block counts posts Chat accepted (`sent`) and refused (`refused`), with the
  last error; the dashboard's Settings, System shows it beside the ears' Chat state.

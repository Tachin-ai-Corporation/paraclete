# agent/services/ears/

The ears: the service that takes messages in. One process serves every channel at once: the
dashboard's chat on every instance, and Google Chat on a Workspace role. Every message it takes in
becomes an intake document for the brain, carrying the Address its reply must go to. The ears never
answer; replies leave through the [mouth](../mouth/README.md).

**Installed:** yes, as `paraclete-ears.service`.

| File | Job |
|---|---|
| `main.mjs` | The service: wires the channels, runs one poll loop per channel, writes the heartbeat |
| `dashboard-inbox.mjs` | Reads the dashboard's unprocessed messages |
| `chat-inbox.mjs` | Reads Google Chat as the agent's Workspace user |
| `chat-message.mjs` | What one Chat message means: the agent's own, a mention, the request's text, its conversation |
| `chat-identity.mjs` | Which dashboard user, if any, sent a Chat message |
| `chat-state.mjs` | What the Chat inbox remembers across restarts |
| `inbound.mjs`, `inbound-gate.mjs` | Taking one message in: the drop rules (duplicates, cooldown), then the intake write |
| `intake.mjs` | The intake document and its create-only write |
| `preprocess.mjs`, `preprocess-prompt.md` | Repairs a long Chat message that Chat's formatting mangled |

Not here: classifying what came in (the brain), replying (the mouth), the Address model
(`agent/providers/channel.mjs`).

## Google Chat

### What it needs

- A role flagged `workspace` and its Google account, set up through the dashboard's setup wizard:
  the agent's user in the Admin console, and the domain-wide delegation grant with the scopes in
  [agent/auth/workspace-scopes.mjs](../../auth/workspace-scopes.mjs). The ears ask for
  `chat.messages.readonly` and `chat.spaces.readonly`; the mouth for `chat.messages` and
  `chat.spaces.readonly`. `install/install.sh` turns on the Chat API for a Workspace role.
- Nothing else. The agent is a person in Chat, not a Chat app: there is no Chat app to configure in
  the Google Cloud console, and people find it the way they find a colleague.
- Give the agent's Workspace user the agent's name as its name (or the start of it: "Paraclete" or
  "Paraclete Agent" for an agent called Paraclete). Until the agent has posted its first message,
  the ears recognize a mention of it by that name.

### How people reach the agent

| Where | What the agent reads | Where it answers |
|---|---|---|
| A direct message with the agent's address | Every message | In the same conversation |
| A space or group chat the agent's account was added to | Messages that @mention the agent | In the thread of the message, mentioning the person who asked |
| A space, group chat or direct message that admits people outside the organization | Nothing | Nowhere |

The agent reads a message's text. A file attached in Chat is not taken in: share it as a Drive link
(the agent's account reads what is shared with it) or drop it into the dashboard's chat. An edited
message is not read again.

To add the agent to a space, add its address as you would a person's. A direct message, or a space
the agent joins, is found within one poll; the message that opened it (or the mention that added the
agent) is read. When Chat first comes online on an instance, nothing older is replayed
(`ears.new_space_seed: "now"`): a message sent before then has to be sent again.

The agent never reads a space that admits people outside the organization, a direct message with an
outside person included, so its answers never reach anyone the dashboard could not admit. To keep
people outside the organization from even trying, turn external chat off for the agent's account in
the Admin console.

### Who may do what

The dashboard's users list is the authority, in Chat as in the dashboard.

| | Anyone in the organization who can reach the agent in Chat | A dashboard user the agent recognizes in Chat |
|---|---|---|
| Ask for work and questions, and add to or stop work in progress, as a dashboard member can | Yes | Yes |
| Approve or reject a gate the agent raised in that space | No: the agent says how to approve, and nothing changes | Yes |
| Approve a gate raised in the dashboard or in another space | No | No: decide it where it was raised, or in the dashboard |
| Settings, users, secrets, models, upgrades | No | No: dashboard admins, through signed commands only |

A dashboard user is recognized in Chat once the agent knows their Chat identity. Chat tells the agent's
account who wrote a message only as a user id, never as an email, so the ears match the two through
direct messages: they ask Chat for the direct message between the agent and each dashboard user's
email, and that conversation's other member is that user. Once the user has written to the agent in
a direct message, they are recognized in every space too. The ears stamp the email on what such a
person sends (`source_meta.sender_email`), and the brain checks the email against the users list again
before it takes an approval ([approval-replies.mjs](../brain/approval-replies.mjs)).

### How it works

- **Polling.** Every `ears.gchat_poll_ms` the ears list the account's spaces (`spaces.list`), then list
  the new messages (`spaces.messages.list`, newest first, `ears.max_pages_per_poll` pages at most) of
  each space whose newest message is newer than its cursor, and of every space every five minutes.
  A space with nothing for the agent moves its cursor up to the newest message read. The cursors, the
  messages already taken in, the agent's own user id and the users it recognized are kept in
  `<data root>/services/ears/chat-state.json`.
- **Limits.** Chat allows a project 3,000 message reads and 3,000 space reads a minute, and 15 reads a
  second in one space; the ears spend one space read per poll and one message read per active space.
  A `429` ends the round, and the next poll waits a minute.
- **The agent's own messages.** Chat names people only by user id when it is called as a user, so the
  mouth gives every message it posts a client-assigned id starting `client-paraclete-`. The ears skip
  those messages, and learn the agent's own user id from the first one they read.
- **Mentions.** A `USER_MENTION` annotation naming the agent's user id; before the id is known, one
  whose text starts with the agent's name. The name typed as plain text (`@Paraclete`) also counts,
  unless it is part of a mention of somebody else. `ears.mention_match: "text"` uses typed names only.
- **Threads.** A reply to a space goes into the message's thread (`messageReplyOption`
  `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, which starts a new thread if that one is gone;
  `chat.reply_in_thread: false` turns it off). A direct message is one conversation: its Address has
  no thread, and the reply goes to the conversation.
- **Conversation.** The turns of the thread (or the whole direct message) on the poll page are copied
  into the thread ledger and sent with the intake, so the brain sees what was said before.
- **Repair.** A long or multi-line message goes through one utility-model call that undoes Chat's
  formatting damage (`ears.preprocess`), and passes through unchanged when that fails.

### Health

The heartbeat, `<data root>/services/ears/health.json`, has a `gchat` block, which the dashboard's
Settings, System shows: `state` (`off` without a Workspace account, `connecting` while the account's
token fails, `ready`), `account`, `spaces`, `direct_messages`, `external_spaces` (not read),
`known_users` (dashboard users recognized in Chat), `agent_user_id`, `rate_limited`, `last_poll_at`,
`last_ok_at`, `last_error` and `taken_in`. The mouth's heartbeat adds how Chat answered its posts.

| The System tab shows | It means | Do this |
|---|---|---|
| connecting, `Invalid email or User ID` or `invalid_grant` | The agent's Workspace user does not exist | Create it in the Admin console; the ears come online by themselves |
| connecting, `unauthorized_client` | The delegation grant is missing, or lacks a Chat scope | Grant the full scope list to the signer's client ID (the setup wizard shows both) |
| ready, 0 spaces and 0 direct messages | Nobody has written to the agent or added it yet | Send its address a direct message |
| Not read: some spaces | Those spaces admit people outside the organization | Use an internal space, or a direct message |
| rate limited | The project's Chat API quota is spent for this minute | Nothing; it reads again in a minute |
| `Sending: ... permission` | The mouth cannot post: `chat.messages` is not granted | Add it to the delegation grant |

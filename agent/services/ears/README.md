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
- A Chat app record in the project. Google requires one of the project that calls the Chat API, also
  for calls made as a user, as the agent's are; Chat's refusals then say only "permission denied".
  Google has no API to write it, so an admin saves it once in the Cloud console
  (the wizard's step 3 links to the page): an app name, a description, Interactive features off.
  Nobody sees it. The agent is still a person in Chat, not a Chat app: people find it the way they
  find a colleague.
- A first space. Google Chat lists no spaces for a user nobody has written to: until someone adds
  the agent to a space (or writes to it), every listing is refused with "permission denied",
  whatever the project or signer. The wizard's step 3 asks the admin to add the agent to a space and
  @mention it; the workspace check reports Chat as waiting for that, not failed.
- While Chat refuses the account (401 or 403), the Chat loop waits twice as long after each refusal,
  from 30 seconds up to five minutes, and logs the refusal once, not on every poll; a refusal it
  shows in the health file says to add the agent to a space.
- Give the agent's Workspace user the agent's name as its name (or the start of it: "Paraclete" or
  "Paraclete Agent" for an agent called Paraclete). Until the agent has posted its first message,
  the ears recognize a mention of it by that name.

### How people reach the agent

| Where | What the agent reads | Where it answers |
|---|---|---|
| A space or group chat the agent's account was added to, also one that admits people outside the organization | Messages that @mention the agent | In the thread of the message, mentioning the person who asked |
| A direct message with the agent's address | Every message | In the same conversation, once Chat lets the account post there (below) |

**Direct messages.** Chat refuses every reply the agent posts in a direct message while its account
has never signed in (seen live: the agent reads the message, and each post of its answer is refused
with "permission denied"; posts in a space from the same account go through). An agent's account is
a user nobody signs in as, so reach it in a space. The answer to a refused direct message is not
lost from the record: the mouth marks the delivery failed, and the work stays in the dashboard.

The agent reads a message's text. A file attached in Chat is not taken in: share it as a Drive link
(the agent's account reads what is shared with it) or drop it into the dashboard's chat. An edited
message is not read again.

To add the agent to a space, add its address as you would a person's. A space the agent joins, or a
direct message, is found within one poll; the mention that added the agent (or the message that
opened the conversation) is read. When Chat first comes online on an instance, it reads the hour before and nothing
older (`ears.new_space_seed: "now"`, less an hour): the first message that brought the agent's
account into Chat is answered, old history is not replayed, and a message sent longer ago has to be
sent again.

A space that admits people outside the organization is read like any other: its outside members can
ask the agent for work, and whatever the agent answers there reaches them. Approvals still come only
from dashboard users. To keep the agent to the
organization, turn external chat off for the agent's account in the Admin console.

### Who may do what

The dashboard's users list is the authority, in Chat as in the dashboard.

| | Anyone who can reach the agent in Chat (in a space that admits them, people outside the organization too) | A dashboard user the agent recognizes in Chat |
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
token fails, `ready`), `account`, `spaces`, `direct_messages`, `external_spaces` (how many of those admit people outside the organization),
`known_users` (dashboard users recognized in Chat), `agent_user_id`, `rate_limited`, `last_poll_at`,
`last_ok_at`, `last_error` and `taken_in`. The mouth's heartbeat adds how Chat answered its posts.

| The System tab shows | It means | Do this |
|---|---|---|
| connecting, `Invalid email or User ID` or `invalid_grant` | The agent's Workspace user does not exist | Create it in the Admin console; the ears come online by themselves |
| connecting, `unauthorized_client` | The delegation grant is missing, or lacks a Chat scope | Grant the full scope list to the signer's client ID (the setup wizard shows both) |
| ready, 0 spaces and 0 direct messages | Nobody has added the agent to a space yet | Add it to a space and @mention it |
| `HTTP 403` listing the spaces, "until someone first writes to the account" | Chat does not know the account yet | Add it to a space and @mention it |
| Open to outsiders: some spaces | Those spaces admit people outside the organization, who see the agent's answers there | Nothing, unless the agent should stay inside the organization |
| rate limited | The project's Chat API quota is spent for this minute | Nothing; it reads again in a minute |
| `Sending: ... permission` | The mouth cannot post: `chat.messages` is not granted | Add it to the delegation grant |

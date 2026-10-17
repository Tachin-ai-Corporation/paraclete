// dashboard/app/page.jsx: the home page, the signed-in user's conversation with the agent
// (components/chat/ChatView.jsx). The layout has already checked who is asking.
import { getRuntime } from '@/lib/server/runtime.mjs';
import { ChatView } from '@/components/chat/ChatView.jsx';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <ChatView agentName={getRuntime().settings.agentName} />;
}

// dashboard/app/layout.jsx: every page's frame. It works out who is asking (IAP's signed header,
// then their users record) before anything renders: a signed-in person who is not a dashboard user
// sees only how to get access, and someone whose sign-in cannot be checked sees why.
import { headers } from 'next/headers';
import { getRuntime } from '@/lib/server/runtime.mjs';
import { signedInEmail } from '@/lib/server/auth.mjs';
import { getUser } from '@/lib/server/users.mjs';
import { Shell } from '@/components/Shell.jsx';
import { NoAccess } from '@/components/NoAccess.jsx';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Paraclete',
  description: 'Your agent: chat, work, approvals and settings.',
};

async function whoIsAsking() {
  const runtime = getRuntime();
  try {
    const email = await signedInEmail(runtime, await headers());
    const user = await getUser(runtime, email);
    return { runtime, email, user, problem: null };
  } catch (err) {
    runtime.log('WARN', `sign-in could not be checked: ${err.message}`);
    return { runtime, email: null, user: null, problem: err.message };
  }
}

export default async function RootLayout({ children }) {
  const { runtime, email, user, problem } = await whoIsAsking();
  return (
    <html lang="en">
      <body>
        {user ? (
          <Shell user={user} agentName={runtime.settings.agentName}>
            {children}
          </Shell>
        ) : (
          <NoAccess email={email} problem={problem} />
        )}
      </body>
    </html>
  );
}

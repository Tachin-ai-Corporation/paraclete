// dashboard/components/NoAccess.jsx: what someone sees when they reach the dashboard but may not use
// it: signed in without a users record, or with a sign-in that could not be checked.
import styles from './NoAccess.module.css';

export function NoAccess({ email, problem }) {
  return (
    <main className={styles.wrap}>
      <div className={`card ${styles.card}`}>
        <h1>No access</h1>
        {problem ? (
          <p className="muted">Your sign-in could not be checked: {problem}</p>
        ) : (
          <p className="muted">
            You are signed in as <strong>{email}</strong>, but you are not a user of this dashboard. Ask one of its
            admins to add you.
          </p>
        )}
      </div>
    </main>
  );
}

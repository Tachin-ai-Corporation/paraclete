// dashboard/components/ui/AsyncState.jsx: the three states every list or view has before it has
// data to show: loading, failed, and empty. Renders children once there is data.

export function AsyncState({ loading, error, empty, emptyText = 'Nothing here yet.', children }) {
  if (error && !children) return <p className="error-text">{typeof error === 'string' ? error : error.message}</p>;
  if (loading) return <p className="muted">Loading…</p>;
  if (empty) return <p className="muted">{emptyText}</p>;
  return (
    <>
      {error && <p className="error-text">{typeof error === 'string' ? error : error.message}</p>}
      {children}
    </>
  );
}

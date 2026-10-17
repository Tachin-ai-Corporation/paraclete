// dashboard/lib/client/format.js: how times and sizes read in the dashboard. Firestore hands back ISO
// strings (or a timestamp the API already turned into one); these never throw on a missing value.

/** "just now", "5 min ago", "3 h ago", "2 d ago", or the date. */
export function timeAgo(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return formatDate(value);
}

/** A date and time in the viewer's locale, e.g. "Oct 17, 2026, 9:20 PM". */
export function formatDate(value) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "820 B", "12.5 KB", "3.1 MB". */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

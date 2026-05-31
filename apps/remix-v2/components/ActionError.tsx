export function ActionError({ error }: { error?: { code: string; message: string } | null }) {
  if (!error) return null;
  return <div className="action-error">{error.message || error.code}</div>;
}

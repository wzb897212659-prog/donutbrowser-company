export function profileIdFromObjectKey(key: string): string | null {
  const normalized = key.replace(/^company\//, "");
  const direct = /^profiles\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(normalized);
  if (direct) return direct[1].toLowerCase();
  const tombstone = /^tombstones\/profiles\/([0-9a-fA-F-]{36})\.json$/.exec(
    normalized,
  );
  return tombstone ? tombstone[1].toLowerCase() : null;
}

export function isProfileCollectionKey(key: string): boolean {
  const normalized = key.replace(/^company\//, "");
  return normalized === "profiles/" || normalized.startsWith("profiles/");
}

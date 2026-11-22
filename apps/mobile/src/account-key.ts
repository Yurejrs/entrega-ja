export function accountKey(tenantId: string, userId: string): string {
  return `${tenantId}|${userId}`;
}

export function isSameAccount(storedKey: string | undefined, currentKey: string): boolean {
  if (!storedKey) return false;
  if (storedKey === currentKey) return true;
  // Versions through 0.1.6 prefixed the account with the server URL.
  return storedKey.endsWith(`|${currentKey}`);
}

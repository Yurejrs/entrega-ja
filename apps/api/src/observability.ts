const counters = new Map<string, number>();

export function incrementMetric(name: string): void {
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function metricsSnapshot(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

export function classifyFailure(url: string, statusCode: number): string | null {
  if (statusCode < 400) return null;
  if (url.includes('/auth/')) return 'auth_failures_total';
  if (url.includes('/locations')) return 'gps_failures_total';
  if (url.includes('/photos') || url.includes('/profile/photo') || url.includes('/profile/cover')) return 'upload_failures_total';
  if (url.includes('/customers') || url.includes('search=')) return 'search_failures_total';
  if (url.includes('/worker')) return 'worker_failures_total';
  if (url.includes('/openstreetmap') || url.includes('/localities/import')) return 'map_provider_failures_total';
  return statusCode >= 500 ? 'api_errors_total' : null;
}

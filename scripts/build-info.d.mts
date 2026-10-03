export function commitCount(): number | null;
export function buildId(): string | null;
export function snapshotVersion(root?: string): string | null;
export function appVersion(fallback?: string): string;
export function appVersion(fallback: null): string | null;

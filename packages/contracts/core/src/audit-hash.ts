import type { AuditEvent } from './index.js';

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value) ?? 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Audit metadata must contain finite numbers.');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  throw new Error('Audit metadata must be JSON serializable.');
}

export async function computeAuditEventHash(input: {
  previousHash?: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable.');
  const canonicalMetadata = canonicalize(input.metadata);
  const content = `${input.previousHash ?? ''}${input.eventType}${input.entityType}${input.entityId}${input.createdAt}${canonicalMetadata}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Events must be supplied in append order for a single organization. */
export async function verifyAuditChain(events: AuditEvent[]): Promise<{
  valid: boolean;
  checkedEvents: number;
  brokenAt: string | null;
}> {
  let previousHash: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expected = await computeAuditEventHash({
      previousHash,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      createdAt: event.createdAt,
      metadata: event.metadata,
    });
    if ((event.previousHash ?? null) !== previousHash || event.eventHash !== expected) {
      return { valid: false, checkedEvents: index + 1, brokenAt: event.id };
    }
    previousHash = event.eventHash;
  }
  return { valid: true, checkedEvents: events.length, brokenAt: null };
}

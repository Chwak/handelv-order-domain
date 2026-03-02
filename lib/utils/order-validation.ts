/**
 * Validation helpers for Order Domain GraphQL lambdas.
 */

export function validateId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

export function validateLimit(raw: unknown, defaultValue = 20, max = 100): number {
  if (raw == null) return defaultValue;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) return defaultValue;
  return Math.min(n, max);
}

export function parseNextToken(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function encodeNextToken(key?: Record<string, unknown> | null): string | null {
  if (!key || Object.keys(key).length === 0) return null;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

type ActiveMode = 'maker' | 'collector';
type RequiredMode = ActiveMode | 'both';
const REQUIRED_ACTIVE_MODE: RequiredMode = 'both';

function isEnabled(value: unknown): boolean {
  return value === true || value === 'true';
}

function resolveActiveMode(claims: Record<string, unknown> | undefined): ActiveMode | null {
  const rawMode = claims?.active_mode;
  if (rawMode === 'maker' || rawMode === 'collector') return rawMode;
  const makerEnabled = isEnabled(claims?.maker_enabled);
  const collectorEnabled = isEnabled(claims?.collector_enabled);
  if (makerEnabled !== collectorEnabled) return makerEnabled ? 'maker' : 'collector';
  if (makerEnabled && collectorEnabled) return 'maker';
  return null;
}

function isAuthorizedForMode(claims: Record<string, unknown> | undefined, required: RequiredMode): boolean {
  const activeMode = resolveActiveMode(claims);
  if (required === 'both') return activeMode !== null;
  return activeMode === required;
}

export function requireAuthenticatedUser(
  event: { identity?: { sub?: string; claims?: { sub?: string } } },
  requiredMode: RequiredMode = REQUIRED_ACTIVE_MODE,
): string | null {
  const identity = event?.identity;
  if (!identity) return null;
  const claims = identity.claims as Record<string, unknown> | undefined;
  if (!isAuthorizedForMode(claims, requiredMode)) return null;
  if (typeof identity.sub === 'string' && identity.sub.trim()) return identity.sub.trim();
  if (identity.claims?.sub && typeof identity.claims.sub === 'string') return identity.claims.sub.trim();
  return null;
}

const ORDER_STATUSES = new Set(['PENDING', 'PAID', 'IN_PROGRESS', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELED']);

export function validateOrderStatus(status: unknown): string | null {
  if (typeof status !== 'string') return null;
  const s = status.trim().toUpperCase();
  return ORDER_STATUSES.has(s) ? s : null;
}

export interface ShippingAddressInput {
  street?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
  country?: unknown;
}

export interface ValidShippingAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export function validateShippingAddress(input: ShippingAddressInput | null | undefined): ValidShippingAddress | null {
  if (!input || typeof input !== 'object') return null;
  const street = typeof input.street === 'string' ? input.street.trim() : '';
  const city = typeof input.city === 'string' ? input.city.trim() : '';
  const state = typeof input.state === 'string' ? input.state.trim() : '';
  const zip = typeof input.zip === 'string' ? input.zip.trim() : '';
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (street.length < 5 || street.length > 200) return null;
  if (city.length < 2 || city.length > 100) return null;
  if (state.length < 2 || state.length > 100) return null;
  if (zip.length < 3 || zip.length > 20) return null;
  if (country.length !== 2 || !/^[A-Z]{2}$/.test(country)) return null;
  return { street, city, state, zip, country };
}

export function validateQuantity(raw: unknown, min = 1, max = 100): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

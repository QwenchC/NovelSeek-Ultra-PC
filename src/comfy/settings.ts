/** UI validation is only a convenience; the native transport independently validates every URL. */
export interface ComfyEndpoint {
  normalizedUrl: string;
  origin: string;
  isHttps: boolean;
}

export function parseComfyEndpoint(input: string): ComfyEndpoint | null {
  const value = input.trim();
  if (!value || /[\s\\]/u.test(value) || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  const address = value.includes('://') ? value : `http://${value}`;
  if (!/^https?:\/\//i.test(address)) return null;
  const authority = address.split('://')[1]?.split(/[/?#]/)[0];
  if (!authority || authority.includes('@') || address.includes('?') || address.includes('#')) return null;
  try {
    const url = new URL(address);
    if (!url.hostname || url.username || url.password || url.port === '0' || !['http:', 'https:'].includes(url.protocol)) return null;
    return { normalizedUrl: url.toString().replace(/\/$/, ''), origin: url.origin, isHttps: url.protocol === 'https:' };
  } catch {
    return null;
  }
}

/** Keep a tunnel's selected port and reverse-proxy path when the user explicitly chooses HTTPS. */
export function suggestComfyHttps(input: string): string | null {
  const endpoint = parseComfyEndpoint(input);
  if (!endpoint || endpoint.isHttps) return null;
  // URL.protocol silently removes an explicit :80; a scheme-only change must not change the port.
  const withScheme = input.trim().includes('://') ? input.trim() : `http://${input.trim()}`;
  return `https://${withScheme.split('://').slice(1).join('://')}`.replace(/\/$/, '');
}

export function formatComfyFingerprint(value: string): string {
  if (!/^[a-f\d]{64}$/i.test(value)) return value;
  return value.toUpperCase().match(/.{2}/g)!.join(':');
}

export interface ComfyCertificateCandidate {
  origin: string;
  certificateSha256: string;
  notBeforeEpochMs: number;
  notAfterEpochMs: number;
}

export function canApproveComfyCertificate(
  endpoint: ComfyEndpoint | null,
  certificate: ComfyCertificateCandidate | null,
  fingerprintVerified: boolean,
  now = Date.now()
): boolean {
  return !!(endpoint?.isHttps && certificate && fingerprintVerified &&
    certificate.origin === endpoint.origin && /^[a-f\d]{64}$/i.test(certificate.certificateSha256) &&
    Number.isFinite(certificate.notBeforeEpochMs) && Number.isFinite(certificate.notAfterEpochMs) &&
    Number.isFinite(now) && certificate.notBeforeEpochMs <= now && now < certificate.notAfterEpochMs);
}

/** A result for an old address or replaced request must never update the current panel. */
export class ComfyRequestScope {
  private key = '';
  private serial = 0;
  update(key: string) {
    if (key !== this.key) { this.key = key; this.serial += 1; }
  }
  begin() { return { key: this.key, serial: ++this.serial }; }
  isCurrent(token: { key: string; serial: number }) {
    return token.key === this.key && token.serial === this.serial;
  }
  invalidate() { this.serial += 1; }
}

/** Mutating local approval immediately fences any older read, even for the same origin. */
export function beginComfyTrustMutation(actionScope: ComfyRequestScope, statusScope: ComfyRequestScope) {
  statusScope.invalidate();
  return actionScope.begin();
}

import { describe, expect, it } from 'vitest';
import { parseAuthorSubmission } from '../author-manifest';

const valid = {
  name: 'Example model',
  slug: 'example-model',
  description: 'A text model submitted for review.',
  endpointUrl: 'https://author.example.com/v1/chat/completions',
  authToken: 'private-author-token',
  authHeader: 'Authorization' as const,
  hostedBy: 'author' as const,
  exclusive: false,
  pricingHintPerRequestRub: 1.25,
  contestSubmissionId: null,
};

describe('author manifest candidate', () => {
  it('builds the same public digest from reordered submission fields and never exposes the token or price', () => {
    const a = parseAuthorSubmission(valid);
    const b = parseAuthorSubmission(Object.fromEntries(Object.entries(valid).reverse()));
    expect(a.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.manifestDigest).toBe(a.manifestDigest);
    expect(b.manifestJson).toBe(a.manifestJson);
    expect(a.manifest.endpoint.url).toBe('https://author.example.com/v1/chat/completions');
    expect(a.manifestJson).not.toContain(valid.authToken);
    expect(a.manifestJson).not.toContain('pricingHint');
    expect(a.manifest.rights).toEqual({ state: 'pending_verification', commercialUse: false });
  });

  it.each([
    'http://author.example.com/v1/chat/completions',
    'https://127.0.0.1/v1/chat/completions',
    'https://0x7f000001/v1/chat/completions',
    'https://[::1]/v1/chat/completions',
    'https://metadata.google.internal/v1/chat/completions',
    'https://localhost/v1/chat/completions',
    'https://user:pass@author.example.com/v1/chat/completions',
    'https://author.example.com:8443/v1/chat/completions',
    'https://author.example.com/v1/chat/completions?key=secret',
    'https://author.example.com/v1/models',
  ])('rejects unsafe or unsupported endpoint %s before storage', (endpointUrl) => {
    expect(() => parseAuthorSubmission({ ...valid, endpointUrl }))
      .toThrow('INVALID_AUTHOR_ENDPOINT');
  });

  it('rejects unknown fields, custom secret headers and invalid identity without echoing the token', () => {
    for (const submission of [
      { ...valid, adminApproved: true },
      { ...valid, authHeader: 'X-Upstream-Key' },
      { ...valid, slug: '../other' },
      { ...valid, authToken: 'line\r\nInjected: true' },
    ]) {
      expect(() => parseAuthorSubmission(submission)).toThrow('INVALID_AUTHOR_SUBMISSION');
    }
    try { parseAuthorSubmission({ ...valid, authToken: 'line\r\nInjected: true' }); }
    catch (error) { expect(String(error)).not.toContain('Injected'); }
  });

  it('changes digest when public endpoint changes, but never treats client price or share as authority', () => {
    const a = parseAuthorSubmission(valid);
    const b = parseAuthorSubmission({
      ...valid,
      endpointUrl: 'https://other.example.com/v1/chat/completions',
    });
    expect(b.manifestDigest).not.toBe(a.manifestDigest);
    expect(parseAuthorSubmission({ ...valid, pricingHintPerRequestRub: 99 }).manifestDigest)
      .toBe(a.manifestDigest);
  });
});

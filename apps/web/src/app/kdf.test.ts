import { describe, expect, it } from 'vitest';

import { onlyUrl } from './kdf';

describe('Trusted Types policy of the Argon2id worker (D83)', () => {
  it('turns only the worker URL into a script URL', () => {
    const rule = onlyUrl('/assets/kdf.worker-abc.js');
    expect(rule('/assets/kdf.worker-abc.js')).toBe('/assets/kdf.worker-abc.js');
    expect(() => rule('/assets/other.js')).toThrow('not the Argon2id worker');
    expect(() => rule('https://outside.test/assets/kdf.worker-abc.js')).toThrow();
    expect(() => rule('data:text/javascript,1')).toThrow();
  });
});

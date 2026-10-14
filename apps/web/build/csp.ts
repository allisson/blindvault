// The CSP of overview §11 (D83, D91). The build ships it by <meta>, so it works on static hosts;
// a host that can send headers sends it too, with `frame-ancestors`, which <meta> cannot set (D193,
// D195). The configurations of deploy/ must send HEADER_CSP, as build/csp.test.ts checks.

export const META_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

export const HEADER_CSP = `${META_CSP}; frame-ancestors 'none'`;

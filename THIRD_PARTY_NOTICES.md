# Third-Party Notices

This repository includes code adapted from the following open-source projects,
used under their respective licenses.

## OmniRoute — https://github.com/diegosouzapw/OmniRoute

MIT License — Copyright (c) 2026 diegosouzapw

Ported/adapted portions (native egress integration, branch
`feat/native-egress-integration`, August 2026):

| Our file | Origin | Extent |
|---|---|---|
| `packages/api-gateway/src/proxy/url.ts` | `open-sse/utils/proxyDispatcher.ts` (`normalizeProxyUrl`, `extractExplicitPort`) | verbatim functions, header adapted |
| `packages/api-gateway/src/failover/classify.ts` | `src/shared/utils/classify429.ts` | verbatim module |
| `apps/worker/src/catalog/transform.ts` | `src/lib/modelsDevSync/transform.ts` | field-mapping adaptation |
| `packages/api-gateway/src/failover/breaker.ts` | `src/shared/utils/circuitBreaker.ts` | independent implementation inspired by its state-machine design (CLOSED/OPEN/HALF_OPEN, kind-based cooldowns) |

MIT License text:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

import * as Sentry from '@sentry/nestjs';

// Must be imported before any other module in main.ts -- Sentry patches
// Node's http/db clients etc. at import time, so anything imported first
// won't get instrumented. No-ops automatically if SENTRY_DSN is unset
// (local dev), so this is safe to leave unconditional.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  // Error capture (the actual goal here) doesn't depend on this --
  // tracesSampleRate only controls performance/APM spans, which we're
  // deliberately not paying for yet on the free tier.
  tracesSampleRate: 0,
});

# Backend Hardening Playbook

This document explains how to evolve the legacy Node/Express proof of concept that originally lived in
`app.ts`. The goal is to replace the monolithic entry point with a layered architecture that is easier to
reason about, scales to SaaS requirements, and implements the safeguards highlighted during the initial audit.

## Architecture overview

```
server/
├── src/
│   ├── config/          # environment loading, schema validation, shared constants
│   ├── db/              # mongoose initialisation, models, lifecycle hooks
│   ├── middleware/      # error handler, logging, validation adapters
│   ├── routes/          # HTTP routers grouped by bounded context
│   ├── controllers/     # request orchestration, response formatting
│   ├── services/        # AWS Route 53 helpers, billing workflows, queue publishers
│   └── utils/           # shared helpers (logger, typed errors, DTO builders)
└── tests/
    ├── unit/           # controller + service coverage with dependency mocks
    └── integration/    # supertest suites against the HTTP surface
```

Each layer exposes minimal public APIs. Controllers receive validated DTOs, delegate to services, and return
serialisable payloads. Services contain the business logic, talk to data access helpers, and emit domain
events for observability.

## Configuration and environment validation

1. Load environment variables via `dotenv-safe` inside `config/env.ts`.
2. Validate them using `zod` or `envalid` to guarantee required keys (Mongo URI, AWS credentials, allowed CORS
   origins) exist before booting the server.
3. Expose a typed `AppConfig` object that the rest of the stack consumes.

## Database connection management

* Move all mongoose logic into `db/connection.ts`.
* Use retry logic with exponential backoff when establishing the initial connection.
* Subscribe to `mongoose.connection.on('error')` and `on('disconnected')` events so the server can emit
  structured logs and exit gracefully if the connection never recovers.
* Export helper functions to close the connection when the process receives `SIGINT` or `SIGTERM`.

## Error handling and validation

* Add a reusable `asyncHandler` helper to wrap controllers and propagate rejections to the global error handler.
* Implement `RequestValidationError` and a dedicated middleware that serialises Zod/Joi errors into
  `{ error: { code, message, details } }` responses.
* The global error handler logs the request ID, path, and stack trace, then responds with a safe message.

## Security middleware

* Restrict CORS to the allow list defined in configuration.
* Apply `helmet`, `hpp`, `express-rate-limit`, and `xss-clean`.
* Sanitize request bodies and query parameters before they reach controllers.
* Add a basic auth guard (e.g., JWT or API key header) if the API is not public.

## Logging and monitoring

* Adopt `pino` or `winston` to emit JSON logs with fields for request ID, user, route, and latency.
* Stream logs to stdout in production so the hosting platform can collect them.
* Add optional Prometheus metrics (`express-prom-bundle`) to capture request counters, durations, and error
  rates.

## Testing strategy

* Use Vitest or Jest for unit tests. Mock AWS SDK, mongoose models, and third-party gateways.
* Use Supertest for integration tests that exercise the HTTP routers against an in-memory Mongo server.
* Configure GitHub Actions to run `npm run check` (lint, type-check, and tests) on every push/PR. The workflow
  lives in `.github/workflows/ci.yml`.

## Deployment checklist

1. Build the server with `tsc -p server/tsconfig.json`.
2. Run database migrations or seed scripts if required.
3. Provide the validated `.env` file to the hosting platform and ensure the CI pipeline is passing.
4. Configure structured log shipping and uptime monitoring before directing traffic to the new stack.

Following this playbook ensures the backend matches the maturity of the Vite + TypeScript front end and
provides a secure, maintainable foundation for future features.

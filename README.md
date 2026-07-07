# Veritas Backend

REST API for the [Veritas](https://github.com/veritas-msp/veritas) platform: authentication, CRM, ticketing, administration, client portal, and RMM.

**Stack:** Node.js 20 · Express · PostgreSQL 15

## Requirements

- Node.js 20+
- PostgreSQL 15+

## Setup

```bash
cp .env.example .env
# DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
npm install
npm start
```

API: http://localhost:3001

Initial setup (with the frontend running): http://localhost:3000/setup

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing secret |
| `ENCRYPTION_KEY` | Encryption key for sensitive fields |
| `VERITAS_EDITION` | `community` (default) or `pro` |

See [.env.example](./.env.example) for all variables.

## Database schema

Fresh installs use `schema/schema_export.csv` via the setup wizard at `/setup`.

Existing instances receive incremental patches from `schema/patches/` automatically at startup (or via `npm run schema:incremental`).

## Scripts (`scripts/`)

| File | npm | Role |
|------|-----|------|
| `apply-missing-migrations.mjs` | `npm run schema:incremental` | Applies missing DB patches on an existing instance (admin fallback) |
| `build-rmm-windows-cmd.mjs` | `npm run build:rmm-agent:cmd` | Generates the Windows RMM agent `.cmd` launcher in `veritas-agent/` |
| `build-rmm-windows-msi.ps1` | *(called by the script below)* | Builds the `.msi` installer (Windows + WiX Toolset) — also invoked on demand by the RMM API |
| `build-rmm-windows-agent.mjs` | `npm run build:rmm-agent` | Full RMM agent build: `.cmd` then `.msi` on Windows |

Migrations on startup are automatic; `schema:incremental` is mainly for manual maintenance.

```bash
npm run schema:incremental   # missing DB patches
npm run build:rmm-agent:cmd  # Windows launcher (.cmd)
npm run build:rmm-agent      # .cmd + .msi (Windows + WiX)
```

## Docker

From the [veritas](https://github.com/veritas-msp/veritas) meta repository:

```bash
docker compose up -d --build veritas-backend
```

## License

[GNU Affero General Public License v3.0-or-later](./LICENSE)

# pluggable-api-lite

A small, configuration-driven, **read-only** REST API over an existing Oracle 11g database.
Copy the project for a new client and change only the files in `config/` and `.env`.

Stack: Node.js 24, pnpm, Fastify, Knex, node-oracledb (Thick mode), YAML config.

## Setup

1. Install [Oracle Instant Client 19c](https://www.oracle.com/database/technologies/instant-client/downloads.html) (Basic or Basic Light, 64-bit).
   Thick mode is mandatory: Thin mode does not support Oracle 11g. On Windows the Visual C++ redistributable matching the client must also be installed.
2. `pnpm install`
3. Copy `.env.example` to `.env` and fill in:

   | Variable | Purpose |
   |---|---|
   | `DB_CONNECT_STRING`, `DB_USER`, `DB_PASSWORD` | Oracle connection. Use a SELECT-only account. |
   | `ORACLE_CLIENT_LIB_DIR` | Instant Client folder (omit if it is on `PATH`). |
   | `API_KEY` | Required value of the `X-API-Key` request header. |
   | `PORT`, `HOST` | Listen address (default `127.0.0.1:3000`). |
   | `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` | Page size default (20) and ceiling (100). |

4. `pnpm start` (or `pnpm dev` to restart on file changes). Startup validates the config, initialises Thick mode and runs `SELECT 1 FROM DUAL`; any failure stops the process with a message.
5. `pnpm test` runs the tests (no database needed).

Try the API with `test.rest` (VS Code REST Client).

## Endpoints

| Endpoint | Notes |
|---|---|
| `GET /health` | No API key required. |
| `GET /api/:model` | `?page=` (default 1), `?limit=` (default/max from `.env`), plus `?<field>=<value>` exact-match filters. |
| `GET /api/:model/:id` | Looks the record up by the model's primary key. |

List response: `{ "data": [...], "page": 1, "limit": 20, "hasMore": false }`.
Errors: `{ "error": { "code": "...", "message": "..." } }` with 400 (bad filter/value/paging), 401 (API key), 404 (unknown model or record), 500 (`database_error` — details are logged, never returned).

Value formats: `decimal`/`integer` are JSON numbers; `date` is `YYYY-MM-DDTHH:MI:SS` with no time zone (formatted by Oracle, so it does not depend on the server's time zone). Date filters take `YYYY-MM-DD` and match that whole day.

## Adding a table (no JavaScript changes)

1. Add it to `config/models.yaml`:

   ```yaml
   orders:
     owner: ERPUSER        # optional; omit to use the connected user's schema
     table: ORD_HDR
     schema: orders.yaml
   ```

2. Create `config/schemas/orders.yaml`:

   ```yaml
   primaryKey: orderNo     # must be one of the fields
   fields:
     orderNo:   { column: ORD_NO, type: integer }   # string | integer | decimal | date
     orderDate: { column: ORD_DT, type: date }
   policy:
     list: true            # default false
     get: true             # default false
     filters: [orderDate]  # fields allowed as ?field=value
   ```

3. Restart. `GET /api/orders` now works.

Only configured models and columns are reachable. Identifiers are validated at startup and upper-cased (Oracle's default folding); tables or columns created with quoted mixed-case names are not supported. Results are ordered by the primary key so pages are stable.

## Known limits

- Filters and `/:id` bind values as `VARCHAR2`, which Oracle compares without blank-padding. Against a padded `CHAR(n)` column, an exact match on a shorter value will not find the row.
- `NUMBER` values are read as JavaScript numbers (double precision).
- No rate limiting, TLS, or CORS; run it behind a reverse proxy if exposed beyond localhost.

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
   primaryKey: orderNo     # optional; must be one of the fields. Required when get: true
   fields:
     orderNo:   { column: ORD_NO, type: integer }   # string | integer | decimal | date
     orderDate: { column: ORD_DT, type: date }
   policy:
     list: true            # default false
     get: true             # default false
     filters: [orderDate]  # fields allowed as ?field=value
   ```

3. Restart. `GET /api/orders` now works.

Only configured models and columns are reachable.

**Identifiers.** Owner, table and column names are validated at startup and always sent to Oracle as quoted identifiers, with the spelling and case exactly as written in YAML (nothing is upper- or lower-cased). Write the name as Oracle stores it: `SRNO` for a conventional column, `erp_no` or `Recd_Date` for a column created with a quoted lowercase/mixed-case name. Do not put quotation marks in the YAML value.

- Allowed: letters (any case), digits, `_`, `$`, `#`, starting with a letter, up to 30 characters. Column names may also contain inner spaces (`column: SR NO` becomes `"SR NO"`).
- Rejected at startup: empty names, leading/trailing spaces, quotes, semicolons, comments, dots, commas, parentheses, ` as `, and anything else outside the allowlist.
- Owner and table follow the same case rule, so a table created unquoted must be written in upper case (`GTSORDER`, not `gtsorder`).

**Primary key and ordering.** `primaryKey` is optional for list-only models. If set, results are ordered by it so pages are stable; if omitted, the list has no `ORDER BY`. `policy.get: true` requires a `primaryKey`. Several models (`order-allowance-details`, `fabric-entries`, `cmt-entries`, `bom-items`) point `primaryKey` at a serial-number column that is *not* a declared Oracle key and has not been verified unique, so they keep `get: false`. Until uniqueness is confirmed, pagination on those models can repeat or skip rows when serial numbers are duplicated or rows change between page requests.

## Known limits

- Filters and `/:id` bind values as `VARCHAR2`, which Oracle compares without blank-padding. Against a padded `CHAR(n)` column, an exact match on a shorter value will not find the row.
- `NUMBER` values are read as JavaScript numbers (double precision).
- No rate limiting, TLS, or CORS; run it behind a reverse proxy if exposed beyond localhost.

export class ApiError extends Error {
  constructor(status, code, message, cause) {
    super(message, { cause });
    this.status = status;
    this.code = code;
  }
}

const DATE_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS`;

// Validate a request string against a field's type and return the value to bind.
function toBinding(field, name, value) {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'invalid_value', `"${name}" must be a single non-empty value`);
  }
  const bad = () => new ApiError(400, 'invalid_value', `"${name}" must be a valid ${field.type}`);
  switch (field.type) {
    case 'integer':
      if (!/^-?\d+$/.test(value)) throw bad();
      return Number(value);
    case 'decimal':
      if (!/^-?\d+(\.\d+)?$/.test(value)) throw bad();
      return Number(value);
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw bad();
      }
      return value;
    default:
      return value;
  }
}

export function createReadEngine(db, models) {
  const getModel = (name, operation) => {
    const model = models.get(name);
    if (!model || !model[operation]) throw new ApiError(404, 'not_found', `Unknown resource "${name}"`);
    return model;
  };

  const baseQuery = (model) => {
    const query = model.owner ? db.withSchema(model.owner).from(model.table) : db.from(model.table);
    const columns = Object.entries(model.fields).map(([name, { column, type }]) =>
      type === 'date'
        ? db.raw(`TO_CHAR(??, '${DATE_FORMAT}') as ??`, [column, name])
        : db.raw('?? as ??', [column, name]),
    );
    query.select(columns);
    // Without a primaryKey there is no ordering key, so paging order is whatever Oracle returns.
    return model.primaryKey ? query.orderBy(model.fields[model.primaryKey].column) : query;
  };

  const whereEquals = (query, field, name, value) => {
    const bound = toBinding(field, name, value);
    return field.type === 'date'
      ? query.whereRaw(`TRUNC(??) = TO_DATE(?, 'YYYY-MM-DD')`, [field.column, bound])
      : query.where(field.column, bound);
  };

  // Only configured fields are returned; the pagination wrapper's helper columns are dropped.
  const toRecord = (model, row) =>
    Object.fromEntries(
      Object.entries(model.fields).map(([name, { type }]) => {
        const value = row[name];
        return [name, value != null && (type === 'integer' || type === 'decimal') ? Number(value) : value ?? null];
      }),
    );

  const run = async (query) => {
    try {
      return await query;
    } catch (err) {
      throw new ApiError(500, 'database_error', 'The database request failed', err);
    }
  };

  // Fetches one extra row so callers can tell whether another page exists without a COUNT(*).
  const buildListQuery = (model, { page, limit, ...filters }) => {
    let query = baseQuery(model);
    for (const [name, value] of Object.entries(filters)) {
      if (!model.filters.has(name)) {
        throw new ApiError(400, 'invalid_filter', `"${name}" is not a filterable field`);
      }
      query = whereEquals(query, model.fields[name], name, value);
    }
    return query.limit(limit + 1).offset((page - 1) * limit);
  };

  const buildGetQuery = (model, id) =>
    whereEquals(baseQuery(model), model.fields[model.primaryKey], model.primaryKey, id).limit(1);

  return {
    buildListQuery: (modelName, params) => buildListQuery(getModel(modelName, 'list'), params),
    buildGetQuery: (modelName, id) => buildGetQuery(getModel(modelName, 'get'), id),

    async list(modelName, params) {
      const model = getModel(modelName, 'list');
      const rows = await run(buildListQuery(model, params));
      return {
        data: rows.slice(0, params.limit).map((row) => toRecord(model, row)),
        page: params.page,
        limit: params.limit,
        hasMore: rows.length > params.limit,
      };
    },

    async get(modelName, id) {
      const model = getModel(modelName, 'get');
      const [row] = await run(buildGetQuery(model, id));
      if (!row) throw new ApiError(404, 'not_found', `No ${modelName} record with ${model.primaryKey} "${id}"`);
      return toRecord(model, row);
    },
  };
}

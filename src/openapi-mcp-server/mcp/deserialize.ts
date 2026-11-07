import type { JSONSchema7 as IJsonSchema, JSONSchema7Definition } from 'json-schema'

/**
 * Recursively deserialize stringified JSON values in tool arguments.
 *
 * Some MCP clients (like Cursor, Claude Code, and some SDKs) double-serialize
 * nested object/array parameters, sending them as JSON strings instead of
 * structured values. This walks the argument tree, decodes JSON-encoded
 * strings and walks the decoded result again, so deeply nested cases (e.g.
 * `{ children: [{ paragraph: '{"rich_text":[...]}' }] }`) and values encoded
 * more than once are normalized before the request reaches the Notion API.
 *
 * When the tool's input schema is provided, decoding is schema-aware: a string
 * is only decoded where the schema accepts an object or array. Values the
 * schema declares as plain strings — such as the text content of a paragraph —
 * are left untouched even when they look like JSON (`[1, 2, 3]`,
 * `{"name": "x"}`), so user content is never turned into structured data.
 * Where the schema gives no type information (or no schema is provided), the
 * previous behavior applies and JSON-looking strings are decoded.
 *
 * @see https://github.com/makenotion/notion-mcp-server/issues/176
 */
export function deserializeParams(
  params: Record<string, unknown>,
  inputSchema?: IJsonSchema,
): Record<string, unknown> {
  const ctx: Context = { defs: (inputSchema?.$defs ?? {}) as Record<string, JSONSchema7Definition> }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    const childSchema = inputSchema ? childSchemaForKey(inputSchema, key, ctx) : undefined
    result[key] = deserializeValue(value, childSchema, ctx)
  }
  return result
}

type Context = {
  defs: Record<string, JSONSchema7Definition>
}

/**
 * Normalize a single value against the schema that describes it (if known).
 */
function deserializeValue(value: unknown, schema: IJsonSchema | undefined, ctx: Context): unknown {
  if (typeof value === 'string') {
    if (!shouldDecodeString(schema, ctx)) {
      return value
    }
    return unwrapJsonString(value, schema, ctx)
  }

  if (Array.isArray(value)) {
    const itemSchema = schema ? itemSchemaOf(schema, ctx) : undefined
    return value.map((item) => deserializeValue(item, itemSchema, ctx))
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      const childSchema = schema ? childSchemaForKey(schema, key, ctx) : undefined
      result[key] = deserializeValue(nested, childSchema, ctx)
    }
    return result
  }

  return value
}

// Bound how many JSON-decode passes we attempt on a single string. One pass
// handles the common single-encoding; extra passes absorb double/triple
// serialization without unbounded work on adversarial input.
const MAX_UNWRAP_DEPTH = 3

/**
 * Resolve a (possibly multiply-)JSON-encoded string to the object or array it
 * represents. Only strings that ultimately decode to an object or array are
 * transformed (and then recursively normalized); a string that decodes to a
 * scalar (number/boolean/null) or to another plain string is returned
 * unchanged, so genuine string values are never corrupted.
 */
function unwrapJsonString(value: string, schema: IJsonSchema | undefined, ctx: Context): unknown {
  let current = value
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const trimmed = current.trim()
    // Only attempt a parse when the string could encode an object/array
    // (`{...}`/`[...]`) or wrap one in a JSON string literal (`"..."`). This
    // skips the common case of ordinary text without touching JSON.parse.
    const couldBeEncoded =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    if (!couldBeEncoded) {
      break
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      break
    }

    if (typeof parsed === 'object' && parsed !== null) {
      return deserializeValue(parsed, schema, ctx)
    }
    if (typeof parsed === 'string') {
      // Peeled one layer of JSON-string encoding; loop to see whether it wraps
      // a structured value (double-encoding).
      current = parsed
      continue
    }
    // Decoded to a scalar — not a structured value; leave the original intact.
    break
  }
  return value
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

type TypeName = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array'

/**
 * Decide whether a string value at a location described by `schema` may be a
 * JSON-encoded object/array that should be decoded.
 *
 * - No schema / no type information → decode (previous behavior).
 * - Schema accepts an object or array anywhere in its union → decode (this
 *   includes the `anyOf: [<complex>, { type: 'string' }]` fallback the parser
 *   adds precisely so stringified objects are accepted).
 * - Schema only accepts scalars (e.g. `type: 'string'`) → keep the string.
 */
function shouldDecodeString(schema: IJsonSchema | undefined, ctx: Context): boolean {
  if (!schema) return true
  const types = possibleTypes(schema, ctx)
  if (types === 'unknown') return true
  return types.has('object') || types.has('array')
}

/**
 * Collect the set of JSON types a schema accepts, following `$ref`s and
 * `oneOf`/`anyOf`/`allOf` branches. Returns 'unknown' when any branch carries
 * no usable type information.
 */
function possibleTypes(schema: IJsonSchema, ctx: Context): Set<TypeName> | 'unknown' {
  const types = new Set<TypeName>()
  for (const leaf of leafSchemas(schema, ctx)) {
    const leafTypes = typesOfLeaf(leaf)
    if (leafTypes === 'unknown') return 'unknown'
    leafTypes.forEach((t) => types.add(t))
  }
  return types.size > 0 ? types : 'unknown'
}

function typesOfLeaf(schema: IJsonSchema): TypeName[] | 'unknown' {
  if (schema.type) {
    return (Array.isArray(schema.type) ? schema.type : [schema.type]) as TypeName[]
  }
  if (schema.properties || schema.additionalProperties !== undefined || schema.required) {
    return ['object']
  }
  if (schema.items) {
    return ['array']
  }
  const literals = schema.enum ?? (schema.const !== undefined ? [schema.const] : undefined)
  if (literals && literals.length > 0) {
    return literals.map((v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)) as TypeName[]
  }
  return 'unknown'
}

/**
 * Flatten a schema into the concrete schemas it may match: `$ref`s are
 * resolved against `$defs`, combinators are expanded, and a schema that both
 * has its own type information and combinators contributes itself as well.
 */
function leafSchemas(schema: IJsonSchema, ctx: Context, seen: Set<IJsonSchema> = new Set()): IJsonSchema[] {
  if (seen.has(schema)) return []
  seen.add(schema)

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, ctx)
    // An unresolvable ref carries no type information.
    return resolved ? leafSchemas(resolved, ctx, seen) : [{}]
  }

  const branches = [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])].filter(
    (b): b is IJsonSchema => typeof b === 'object' && b !== null,
  )
  if (branches.length === 0) {
    return [schema]
  }

  const leaves = branches.flatMap((b) => leafSchemas(b, ctx, seen))
  if (typesOfLeaf(schema) !== 'unknown') {
    leaves.push(schema)
  }
  return leaves
}

function resolveRef(ref: string, ctx: Context): IJsonSchema | undefined {
  const match = /^#\/\$defs\/(.+)$/.exec(ref)
  if (!match) return undefined
  const def = ctx.defs[match[1]]
  return typeof def === 'object' && def !== null ? def : undefined
}

/**
 * Schema for the value under `key` of an object described by `schema`.
 * Returns undefined when no branch describes that key (→ no type info).
 */
function childSchemaForKey(schema: IJsonSchema, key: string, ctx: Context): IJsonSchema | undefined {
  const candidates: IJsonSchema[] = []
  for (const leaf of leafSchemas(schema, ctx)) {
    const prop = leaf.properties?.[key]
    if (typeof prop === 'object' && prop !== null) {
      candidates.push(prop)
      continue
    }
    if (typeof leaf.additionalProperties === 'object' && leaf.additionalProperties !== null) {
      candidates.push(leaf.additionalProperties)
    }
  }
  return combine(candidates)
}

/**
 * Schema for the elements of an array described by `schema`.
 */
function itemSchemaOf(schema: IJsonSchema, ctx: Context): IJsonSchema | undefined {
  const candidates: IJsonSchema[] = []
  for (const leaf of leafSchemas(schema, ctx)) {
    if (typeof leaf.items === 'object' && leaf.items !== null && !Array.isArray(leaf.items)) {
      candidates.push(leaf.items)
    }
  }
  return combine(candidates)
}

function combine(candidates: IJsonSchema[]): IJsonSchema | undefined {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  return { anyOf: candidates }
}

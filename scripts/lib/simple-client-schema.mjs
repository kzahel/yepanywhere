// This emitter supports a closed subset of JSON Schema, not arbitrary schemas.
// Reject unimplemented validation keywords instead of producing weaker decoders.
export function validateSimpleClientSchema(schema) {
  function keys(value, required, optional = []) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      required.some((k) => !Object.hasOwn(value, k)) ||
      Object.keys(value).some((k) => ![...required, ...optional].includes(k))
    ) {
      throw new Error(
        `Unsupported schema shape; expected ${required.join(", ")}`,
      );
    }
  }
  function bounds(min, max, floor = 0, ceiling = 2147483647) {
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < floor ||
      max > ceiling ||
      max < min
    )
      throw new Error("Invalid or missing bounds");
  }
  keys(schema, ["$schema", "$id", "title", "$comment", "$ref", "$defs"]);
  if (
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    schema.$ref !== "#/$defs/SnapshotEnvelope"
  )
    throw new Error("Unsupported schema root");
  const defs = schema.$defs;
  const referenced = (s) => {
    keys(s, ["$ref"]);
    if (
      typeof s.$ref !== "string" ||
      !s.$ref.startsWith("#/$defs/") ||
      !Object.hasOwn(defs, s.$ref.slice(8))
    )
      throw new Error("Invalid local reference");
    return defs[s.$ref.slice(8)];
  };
  function validate(s, named = false) {
    if (s.$ref !== undefined) {
      referenced(s);
      return;
    }
    if (s.const !== undefined) {
      keys(s, ["const"]);
      if (
        !["string", "boolean"].includes(typeof s.const) &&
        !(
          Number.isInteger(s.const) &&
          s.const >= -2147483648 &&
          s.const <= 2147483647
        )
      )
        throw new Error("Unsupported constant");
      if (
        typeof s.const === "string" &&
        (s.const.length > 128 || !/^[a-zA-Z0-9-]+$/.test(s.const))
      )
        throw new Error("Unsupported constant spelling");
      return;
    }
    if (s.anyOf) {
      keys(s, ["anyOf"]);
      if (
        s.anyOf.length !== 2 ||
        JSON.stringify(s.anyOf[1]) !== '{"type":"null"}'
      )
        throw new Error("Only explicit nullable anyOf is supported");
      validate(s.anyOf[0]);
      return;
    }
    if (s["x-open-kind"]) {
      keys(s, ["oneOf", "x-open-kind"]);
      if (!named || s["x-open-kind"] !== true || s.oneOf.length < 2)
        throw new Error("Only named open unions supported");
      const kinds = s.oneOf
        .slice(0, -1)
        .map((r) => referenced(r).properties?.kind?.const);
      if (
        kinds.some((kind) => typeof kind !== "string" || kind === "unknown") ||
        new Set(kinds).size !== kinds.length
      )
        throw new Error("Invalid discriminator set");
      const fallback = s.oneOf.at(-1);
      keys(fallback, [
        "type",
        "properties",
        "required",
        "additionalProperties",
      ]);
      keys(fallback.properties, ["kind"]);
      keys(fallback.properties.kind, ["type", "minLength", "maxLength", "not"]);
      keys(fallback.properties.kind.not, ["enum"]);
      if (
        fallback.type !== "object" ||
        fallback.additionalProperties !== true ||
        JSON.stringify(fallback.required) !== '["kind"]' ||
        fallback.properties.kind.type !== "string" ||
        fallback.properties.kind.minLength !== 1 ||
        fallback.properties.kind.maxLength !== 128 ||
        JSON.stringify(fallback.properties.kind.not.enum) !==
          JSON.stringify(kinds)
      )
        throw new Error("Invalid unknown fallback");
      return;
    }
    if (s.enum) {
      keys(s, ["type", "enum"]);
      if (
        !named ||
        s.type !== "string" ||
        !s.enum.length ||
        new Set(s.enum).size !== s.enum.length ||
        s.enum.some((v) => !/^[a-z][a-zA-Z]*$/.test(v))
      )
        throw new Error("Only named string enums supported");
      return;
    }
    switch (s.type) {
      case "object":
        keys(s, ["type", "properties", "required", "additionalProperties"]);
        if (
          !named ||
          s.additionalProperties !== true ||
          JSON.stringify(s.required) !==
            JSON.stringify(Object.keys(s.properties))
        )
          throw new Error(
            "Named records require every field and allow additive fields",
          );
        for (const [name, property] of Object.entries(s.properties)) {
          if (!/^[a-z][a-zA-Z0-9]*$/.test(name))
            throw new Error("Unsupported field name");
          validate(property);
        }
        break;
      case "array":
        keys(s, ["type", "items", "minItems", "maxItems"]);
        bounds(s.minItems, s.maxItems);
        validate(s.items);
        break;
      case "integer":
        keys(s, ["type", "minimum", "maximum"]);
        bounds(s.minimum, s.maximum, -2147483648);
        break;
      case "boolean":
        keys(s, ["type"]);
        break;
      case "string":
        keys(s, ["type", "minLength", "maxLength"], ["pattern"]);
        bounds(s.minLength, s.maxLength);
        // General regex portability is deliberately outside this spike.
        if (
          s.pattern !== undefined &&
          s.pattern !== "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        )
          throw new Error("Only the timestamp pattern is supported");
        break;
      default:
        throw new Error("Unsupported schema type");
    }
  }
  for (const [name, definition] of Object.entries(defs)) {
    if (!/^[A-Z][a-zA-Z0-9]*$/.test(name))
      throw new Error("Unsupported definition name");
    validate(definition, true);
  }
}

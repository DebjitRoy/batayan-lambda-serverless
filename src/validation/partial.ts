import { z } from "zod";
type WithoutDefault<T extends z.ZodType> = T extends z.ZodDefault<infer Inner> ? Inner : T;

// Zod 4 evaluates defaults inside optional fields. A PATCH-like PUT must
// leave absent top-level fields absent, while retaining nested create defaults.
export function partialWithoutDefaults<T extends Record<string, z.ZodType>>(shape: T) {
  const optional = Object.fromEntries(Object.entries(shape).map(([key, schema]) => [
    key, z.optional(schema instanceof z.ZodDefault ? schema.removeDefault() : schema)
  ])) as { [K in keyof T]: z.ZodOptional<WithoutDefault<T[K]>> };
  return z.object(optional);
}

import { ConfigException } from '@epoch/exceptions';
import { type z } from '@epoch/common/pkg/zod';

/** Validates `env` against `schema` and returns typed config, or throws listing every problem. */
export function loadConfig<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigException(`Invalid configuration: ${issues.join('; ')}`, { issues });
  }
  return result.data;
}

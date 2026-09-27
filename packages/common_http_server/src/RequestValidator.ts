import { BadRequestException } from '@epoch/exceptions';
import type { NextFunction, Request, Response } from 'express';
import type { z } from '@epoch/common/pkg/zod';

type Source = 'body' | 'query' | 'params';

/** Validates one part of the request and stores the parsed value on `res.locals[source]`. */
export function validate(schema: z.ZodTypeAny, source: Source = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(new BadRequestException('Invalid request', { issues: result.error.issues }));
      return;
    }
    res.locals[source] = result.data;
    next();
  };
}

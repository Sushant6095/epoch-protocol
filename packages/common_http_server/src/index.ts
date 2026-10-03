import { Router } from 'express';

export * from './Cookies';
export * from './ExpressAppServer';
export * from './RequestHandler';
export * from './RequestValidator';
export * from './ResponseType';

// Apps reach Express only through this package, so the version and types live in one place.
export type { NextFunction, Request, Response } from 'express';
export type HttpRouter = ReturnType<typeof Router>;
export const createRouter = (): HttpRouter => Router();

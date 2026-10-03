import type { Request, Response } from 'express';

import { clearCookie, parseCookies, setCookie } from './Cookies';

const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as Request;

function fakeResponse() {
  const headers: Record<string, unknown> = {};
  return {
    headers,
    res: {
      getHeader: (name: string) => headers[name.toLowerCase()],
      setHeader: (name: string, value: unknown) => {
        headers[name.toLowerCase()] = value;
      },
    } as unknown as Response,
  };
}

describe('cookies', () => {
  it('parses a cookie header, first value wins, values decoded', () => {
    expect(parseCookies(req('a=1; epoch_session=abc%3D; a=2; bad; =x; q="quoted"'))).toEqual({
      a: '1',
      epoch_session: 'abc=',
      q: 'quoted',
    });
    expect(parseCookies(req())).toEqual({});
  });

  it('sets and clears cookies without dropping earlier Set-Cookie headers', () => {
    const { res, headers } = fakeResponse();
    setCookie(res, 's', 'v 1', { maxAgeSeconds: 60, secure: true, sameSite: 'none', domain: 'api.example.com' });
    clearCookie(res, 'old');
    const list = headers['set-cookie'] as string[];
    expect(list).toHaveLength(2);
    expect(list[0]).toMatch(
      /^s=v%201; Path=\/; Max-Age=60; Expires=.+; Domain=api\.example\.com; HttpOnly; Secure; SameSite=None$/,
    );
    expect(list[1]).toMatch(/^old=; Path=\/; Max-Age=0; /);
  });
});

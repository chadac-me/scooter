/**
 * The specs' API client (the `request` fixture). Its agent pools sockets with no idle
 * timeout and, unlike a browser, does not retry a request that dies on a reused socket, so
 * a call made after the server's keep-alive timeout (nginx: 75s) can fail with ECONNRESET
 * when the server's close has not reached the client yet, as through a kubectl
 * port-forward. One connection per request removes the stale socket.
 */

export const apiRequestHeaders = Object.freeze({ connection: "close" });

/**
 * A new APIRequestContext with `apiRequestHeaders` merged over the caller's headers.
 *
 * @param {{ newContext: (o: any) => Promise<any> }} factory `playwright.request`
 * @param {Record<string, any>} [options] newContext options
 */
export function newApiRequestContext(factory, options = {}) {
  return factory.newContext({
    ...options,
    extraHTTPHeaders: { ...(options.extraHTTPHeaders ?? {}), ...apiRequestHeaders },
  });
}

import type { FastifyRequest } from 'fastify'

/** Query values that are credentials: preview and upload links (`token`), and the OAuth sign-in's `code` and `sig`. */
const SECRET_PARAMS = /([?&](?:token|code|sig)=)[^&#]*/gi

/** `url` with the values of its credential parameters replaced, so a link that signs someone in never reaches a log. */
export function redactUrl(url: string): string {
  return url.replace(SECRET_PARAMS, '$1[redacted]')
}

/** The host's request logging: Fastify's own request line, with the address redacted. */
export const requestLogger = {
  serializers: {
    req(request: FastifyRequest) {
      return {
        method: request.method,
        url: redactUrl(request.url),
        version: [request.headers?.['accept-version']].flat()[0],
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      }
    },
  },
}

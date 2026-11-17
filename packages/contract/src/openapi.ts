import { z } from 'zod';
import { API_PREFIX } from './api.js';
import { ErrorBody } from './errors.js';
import { ObjectDTO } from './dto.js';
import { ROUTES } from './routes.js';

type Json = Record<string, unknown>;

const schema = (t: z.ZodType): Json => z.toJSONSchema(t, { io: 'input', unrepresentable: 'any' }) as Json;

/** Builds the OpenAPI 3.1 document from the zod route table. */
export function buildOpenApi(version: string): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const r of ROUTES) {
    const full = API_PREFIX + r.path;
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const op: Json = {
      summary: r.summary + (r.desktopOnly ? ' [desktop]' : ''),
      parameters: params,
      security: r.public ? [] : [{ cookie: [] }, { bearer: [] }],
      responses: {
        default: { description: 'Error', content: { 'application/json': { schema: schema(ErrorBody) } } },
      },
    };
    const responses = op.responses as Json;
    if (r.binary === 'request') {
      op.requestBody = { content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } };
    } else if (r.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: schema(r.body) } } };
    }
    if (r.binary === 'response') {
      responses['200'] = { description: 'Binary', content: { 'application/octet-stream': {} } };
    } else {
      const res = r.response ?? (r.path === '/objects/{id}' ? ObjectDTO : undefined);
      responses['200'] = res
        ? { description: 'OK', content: { 'application/json': { schema: schema(res) } } }
        : { description: 'OK' };
    }
    (paths[full] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'komaflow API', version },
    components: {
      securitySchemes: {
        cookie: { type: 'apiKey', in: 'cookie', name: 'komaflow_session' },
        bearer: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
  };
}

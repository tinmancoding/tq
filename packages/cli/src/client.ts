import { daemonBaseUrl, loadConfig, type TqConfig } from "@tq/core";

export const EXIT = {
  ok: 0,
  generic: 1,
  notFound: 2,
  conflict: 3,
  validation: 4,
  unreachable: 5,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export class Client {
  readonly cfg: TqConfig;
  private readonly base: string;

  constructor() {
    this.cfg = loadConfig();
    this.base = daemonBaseUrl(this.cfg);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.client.token) h["x-tq-token"] = this.cfg.client.token;
    else if (this.cfg.client.actor) h["x-tq-actor"] = this.cfg.client.actor;
    return h;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new CliError(
        `daemon unreachable at ${this.base} (is it running? \`task daemon start\`)`,
        EXIT.unreachable,
      );
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const msg = (data && (data.detail || data.error)) || res.statusText;
      throw new CliError(msg, mapStatus(res.status));
    }
    return data as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
  del<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}

function mapStatus(status: number): number {
  switch (status) {
    case 404:
      return EXIT.notFound;
    case 409:
      return EXIT.conflict;
    case 400:
    case 422:
      return EXIT.validation;
    case 503:
      return EXIT.unreachable;
    default:
      return EXIT.generic;
  }
}

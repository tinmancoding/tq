import type { WorkspaceProvider } from "@tq/core";

/**
 * Looks up a workspace provider by name. Constructed in `main.ts` from config
 * and passed into `WorkspaceService`. Missing providers (e.g. tasktree binary
 * absent) simply aren't registered, and lookups throw cleanly.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, WorkspaceProvider>();

  constructor(providers: WorkspaceProvider[] = []) {
    for (const p of providers) this.providers.set(p.name, p);
  }

  register(provider: WorkspaceProvider): void {
    this.providers.set(provider.name, provider);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  get(name: string): WorkspaceProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`unknown workspace provider: ${name}`);
    return p;
  }

  /** The default provider name: tasktree if available, else local. */
  defaultName(): string {
    if (this.providers.has("tasktree")) return "tasktree";
    if (this.providers.has("local")) return "local";
    const first = [...this.providers.keys()][0];
    if (!first) throw new Error("no workspace providers registered");
    return first;
  }

  all(): WorkspaceProvider[] {
    return [...this.providers.values()];
  }
}

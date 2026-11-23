// A branch head, read only: what the home page shows when you have no task on the branch.
// Read again when the head moves.

import { docFromJson, Project } from "@thek42/sapwood-core";
import type { Api } from "./api.ts";

/** What the home page reads from: a task's session, or a head. */
export interface Source {
  readonly project: Project;
  subscribe(fn: () => void): () => void;
}

export class HeadView implements Source {
  project: Project;
  readonly branch: string;
  private readonly api: Pick<Api, "headDoc">;
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private again = false;

  private constructor(api: Pick<Api, "headDoc">, branch: string, project: Project) {
    this.api = api;
    this.branch = branch;
    this.project = project;
  }

  static async open(api: Pick<Api, "headDoc">, branch: string): Promise<HeadView> {
    return new HeadView(api, branch, Project.fromDoc(docFromJson((await api.headDoc(branch)).doc)));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The head moved: read it again (once more after, if it moves while reading). */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.again = false;
        this.project = Project.fromDoc(docFromJson((await this.api.headDoc(this.branch)).doc));
        for (const fn of this.listeners) fn();
      } while (this.again);
    })().finally(() => (this.loading = null));
    return this.loading;
  }
}

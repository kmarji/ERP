import { Injectable } from '@nestjs/common';

export interface WorkflowDefinition {
  key: string; // e.g. WF-01
  name: string;
  initial: string;
  terminal: string[];
  // state -> event -> next state
  transitions: Record<string, Record<string, string>>;
  // Optional guards keyed `${state}:${event}`; a false result rejects the transition.
  guards?: Record<string, (data: any) => boolean | Promise<boolean>>;
}

// Every workflow registers a definition here; one engine runs them all.
@Injectable()
export class WorkflowRegistry {
  private readonly defs = new Map<string, WorkflowDefinition>();

  register(def: WorkflowDefinition) {
    this.defs.set(def.key, def);
  }

  get(key: string): WorkflowDefinition {
    const d = this.defs.get(key);
    if (!d) throw new Error(`Unknown workflow definition: ${key}`);
    return d;
  }

  list() {
    return [...this.defs.values()].map((d) => ({ key: d.key, name: d.name, states: Object.keys(d.transitions) }));
  }
}

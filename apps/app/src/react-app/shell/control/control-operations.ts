export type ControlOperation = { requestId: string; deadline: number };
export type ControlExecution = { signal: AbortSignal; deadline: number };

/** Request cancellation belongs to the operation, independently of its HTTP
 * caller. The renderer also checks the absolute deadline before a mutation. */
export function createControlOperations() {
  const active = new Map<string, AbortController>();
  return {
    cancel(requestId: string) { active.get(requestId)?.abort(); },
    async run<T>(operation: ControlOperation | undefined, execute: (context: Partial<ControlExecution>) => Promise<T>) {
      if (!operation) return execute({});
      if (active.has(operation.requestId)) throw new Error("This document operation is already running.");
      const controller = new AbortController();
      const remaining = operation.deadline - Date.now();
      if (remaining <= 0) throw new DOMException("Document request expired before it reached the editor.", "TimeoutError");
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(Math.ceil(remaining), 2147483647))]);
      active.set(operation.requestId, controller);
      try { return await execute({ signal, deadline: operation.deadline }); }
      finally { active.delete(operation.requestId); }
    },
  };
}

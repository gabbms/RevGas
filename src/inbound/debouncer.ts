type KeyState = { timer: NodeJS.Timeout | undefined; running: boolean; rerun: boolean; fn: () => Promise<void> };

/**
 * Agenda `fn` para `ms` após o último `schedule` da mesma chave. Nunca roda a mesma
 * chave em paralelo: se chegar agendamento durante a execução, roda uma vez mais ao terminar.
 */
export function createKeyedDebouncer(ms: number) {
  const states = new Map<string, KeyState>();
  let waiters: (() => void)[] = [];

  function settle(key: string): void {
    states.delete(key);
    if (states.size === 0) {
      const w = waiters;
      waiters = [];
      for (const r of w) r();
    }
  }

  function run(key: string, s: KeyState): void {
    s.timer = undefined;
    s.running = true;
    s.rerun = false;
    void s
      .fn()
      .catch((err: unknown) => {
        console.error('debouncer: erro ao processar', err instanceof Error ? err.name : 'erro');
      })
      .finally(() => {
        s.running = false;
        if (s.rerun) run(key, s);
        else settle(key);
      });
  }

  function schedule(key: string, fn: () => Promise<void>): void {
    let s = states.get(key);
    if (!s) {
      s = { timer: undefined, running: false, rerun: false, fn };
      states.set(key, s);
    }
    s.fn = fn;
    if (s.running) {
      s.rerun = true;
      return;
    }
    if (s.timer) clearTimeout(s.timer);
    const st = s;
    s.timer = setTimeout(() => run(key, st), ms);
  }

  function idle(): Promise<void> {
    if (states.size === 0) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  return { schedule, idle };
}

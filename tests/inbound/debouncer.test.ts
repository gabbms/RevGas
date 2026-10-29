import { afterEach, describe, expect, test, vi } from 'vitest';
import { createKeyedDebouncer } from '../../src/inbound/debouncer.js';

afterEach(() => vi.useRealTimers());

describe('createKeyedDebouncer', () => {
  test('agrupa agendamentos da mesma chave', async () => {
    vi.useFakeTimers();
    const d = createKeyedDebouncer(2000);
    const runs: number[] = [];
    d.schedule('1', async () => { runs.push(Date.now()); });
    vi.advanceTimersByTime(1000);
    d.schedule('1', async () => { runs.push(Date.now()); });
    vi.advanceTimersByTime(1999);
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await d.idle();
    expect(runs).toHaveLength(1);
  });

  test('chaves diferentes rodam em paralelo', async () => {
    vi.useFakeTimers();
    const d = createKeyedDebouncer(1000);
    const runs: string[] = [];
    d.schedule('a', async () => { runs.push('a'); });
    d.schedule('b', async () => { runs.push('b'); });
    vi.advanceTimersByTime(1000);
    await d.idle();
    expect(runs.sort()).toEqual(['a', 'b']);
  });

  test('se está rodando, roda de novo uma única vez ao terminar', async () => {
    vi.useFakeTimers();
    const d = createKeyedDebouncer(1000);
    let release!: () => void;
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => (release = r));
    };
    d.schedule('k', fn);
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(1);
    d.schedule('k', fn);
    d.schedule('k', fn);
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(1); // nunca em paralelo
    release();
    await d.idle();
    expect(calls).toBe(2);
  });

  test('erro em fn não trava a chave', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = createKeyedDebouncer(10);
    d.schedule('k', async () => { throw new Error('x'); });
    vi.advanceTimersByTime(10);
    await d.idle();
    let ok = false;
    d.schedule('k', async () => { ok = true; });
    vi.advanceTimersByTime(10);
    await d.idle();
    expect(ok).toBe(true);
    err.mockRestore();
  });

  test('idle sem nada pendente resolve', async () => {
    await createKeyedDebouncer(10).idle();
  });
});

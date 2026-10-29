import type { OrderService } from '../orders/service.js';

export interface SchedulerDeps {
  orders: Pick<OrderService, 'releaseScheduled'>;
  reminders: () => Promise<number>;
  clock: () => Date;
  intervalMs?: number;
}

/** Roda as tarefas periódicas; um tick é pulado se o anterior ainda não terminou. */
export function startScheduler(d: SchedulerDeps): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      try {
        await d.orders.releaseScheduled(d.clock());
      } catch (err) {
        console.error('[scheduler] releaseScheduled falhou:', err);
      }
      try {
        await d.reminders();
      } catch (err) {
        console.error('[scheduler] lembretes falharam:', err);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), d.intervalMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

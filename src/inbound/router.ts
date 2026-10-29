import type { Db } from '../db/connection.js';
import { redactSensitive } from '../domain/redact.js';
import { updateCustomer, upsertCustomerByPhone, type Customer } from '../store/customers.js';
import { insertMessage, type StoredMessage } from '../store/messages.js';
import type { createOutbox } from '../whatsapp/outbox.js';
import type { InboundEvent } from '../whatsapp/webhook.js';
import { createKeyedDebouncer } from './debouncer.js';

export interface RouterDeps {
  db: Db;
  outbox: ReturnType<typeof createOutbox>;
  clock: () => Date;
  isStaff(telefone: string): boolean;
  handleStaff(ev: InboundEvent): Promise<void>;
  contentToText(ev: InboundEvent, c: Customer): Promise<{ tipo: StoredMessage['tipo']; texto: string } | null>;
  onCustomerTurn(clienteId: number): Promise<void>;
  hasGasDoPovoContext(clienteId: number): boolean;
  debounceMs: number;
}

/** Conversão simples; a Task 12 substitui áudio e mídia. */
export function defaultContentToText(ev: InboundEvent): { tipo: StoredMessage['tipo']; texto: string } {
  const c = ev.conteudo;
  switch (c.tipo) {
    case 'texto':
    case 'botao':
      return { tipo: c.tipo, texto: c.texto };
    case 'audio':
      return { tipo: 'audio', texto: '[áudio]' };
    case 'imagem':
    case 'documento':
      return { tipo: c.tipo, texto: c.legenda ? `[${c.tipo}] ${c.legenda}` : `[${c.tipo}]` };
    case 'outro':
      return { tipo: 'texto', texto: '[mensagem não suportada]' };
  }
}

export function createInboundRouter(deps: RouterDeps) {
  const { db, outbox, clock } = deps;
  const debouncer = createKeyedDebouncer(deps.debounceMs);
  const markSeen = db.prepare('INSERT OR IGNORE INTO inbound_seen (wamid, em) VALUES (?, ?)');

  const unmarkSeen = db.prepare('DELETE FROM inbound_seen WHERE wamid = ?');

  async function handleOne(ev: InboundEvent): Promise<void> {
    if (markSeen.run(ev.wamid, ev.em.toISOString()).changes === 0) return;
    outbox.registerInbound(ev.de, ev.em);

    if (deps.isStaff(ev.de)) {
      await deps.handleStaff(ev);
      return;
    }

    let customer = upsertCustomerByPhone(db, ev.de, clock());
    if (customer.nome === null && ev.nomePerfil) customer = updateCustomer(db, customer.id, { nome: ev.nomePerfil });

    const content = await deps.contentToText(ev, customer);
    if (!content) return;

    const { texto } = redactSensitive(content.texto, { contextoGasDoPovo: deps.hasGasDoPovoContext(customer.id) });
    const customerId = customer.id;
    customer = db.transaction(() => {
      insertMessage(db, {
        clienteId: customerId,
        autor: 'cliente',
        tipo: content.tipo,
        texto,
        wamid: ev.wamid,
        criadoEm: ev.em.toISOString(),
      });
      return updateCustomer(db, customerId, { ultimaMensagemEm: ev.em.toISOString() });
    })();

    if (customer.botPausadoAte && new Date(customer.botPausadoAte) > clock()) return;

    const id = customer.id;
    debouncer.schedule(String(id), () => deps.onCustomerTurn(id));
  }

  async function handle(events: InboundEvent[]): Promise<void> {
    for (const ev of events) {
      try {
        await handleOne(ev);
      } catch (err) {
        // Libera o wamid para que uma reentrega da Meta seja processada.
        try {
          unmarkSeen.run(ev.wamid);
        } catch {
          /* melhor esforço */
        }
        // Sem dado pessoal: só o identificador da mensagem e o tipo do erro.
        console.error('roteador: erro ao processar mensagem', ev.wamid, err instanceof Error ? err.name : 'erro');
      }
    }
  }

  return { handle, idle: () => debouncer.idle() };
}

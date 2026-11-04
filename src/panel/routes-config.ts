import type { FastifyInstance } from 'fastify';
import { missingTemplates } from '../config/env.js';
import { samePhone } from '../domain/phone.js';
import { isPixKey } from '../domain/pix.js';
import type { Db } from '../db/connection.js';
import { listOpenOrders, orderRecipients } from '../store/orders.js';
import { updateSettings, type StoreSettings } from '../store/settings.js';
import { renderPage, type PanelDeps } from './auth.js';
import { DIAS, linhasEntregadores, PAGAMENTOS, parseConfigForm, settingsToForm, type FormErrors, type FormValues } from './config-form.js';

/** Problemas do que está salvo agora, que fazem o bot atender mal mesmo sem erro no formulário. */
export function settingsWarnings(s: StoreSettings): string[] {
  const avisos: string[] = [];
  if (Object.values(s.horarios).every((h) => h === null)) {
    avisos.push('A loja está fechada todos os dias: o bot só agenda pedidos e nunca promete entrega. Preencha o horário abaixo.');
  }
  if (s.destinoPedidos === 'dono' && s.telefoneDono.trim() === '') {
    avisos.push('Os pedidos vão para o seu WhatsApp, mas ele não está preenchido: nenhum pedido chega a ninguém.');
  }
  if (s.pagamentos.includes('pix_antecipado') && !(s.chavePix && isPixKey(s.chavePix))) {
    avisos.push('Pix antecipado está ligado, mas a chave Pix não é válida: o cliente receberia uma chave que não existe. Corrija a chave nos pagamentos.');
  }
  if (s.destinoPedidos === 'entregadores' && s.entregadores.length === 0) {
    avisos.push('Os pedidos vão para os entregadores, mas nenhum está cadastrado: nenhum pedido chega a ninguém.');
  }
  return avisos;
}

/**
 * Entregadores que o formulário tira da lista (ou cujo telefone troca) e que deixariam um pedido sem ninguém:
 * o bot só reconhece como equipe quem está cadastrado agora, então o "entregue" de quem saiu da lista viraria
 * mensagem de cliente. Prende quem está com um pedido que saiu, e quem foi o único a receber um pedido ainda
 * esperando (cada pedido novo vai a todos os entregadores: se outro continua na lista, ele pode assumir).
 */
function entregadoresComPedido(db: Db, antes: StoreSettings, depois: StoreSettings) {
  const saem = antes.entregadores.filter((e) => !depois.entregadores.some((n) => samePhone(n.telefone, e.telefone)));
  if (saem.length === 0) return [];
  const abertos = listOpenOrders(db).filter((o) => o.status === 'recebido' || o.status === 'saiu');
  const continuaNaEquipe = (telefone: string): boolean =>
    depois.entregadores.some((n) => samePhone(n.telefone, telefone)) ||
    (depois.telefoneDono.trim() !== '' && samePhone(depois.telefoneDono, telefone));
  return saem
    .map((entregador) => ({
      entregador,
      pedidos: abertos.filter((o) => {
        if (o.status === 'saiu') return o.entregadorTelefone !== null && samePhone(o.entregadorTelefone, entregador.telefone);
        const recebedores = orderRecipients(db, o.id);
        return recebedores.some((t) => samePhone(t, entregador.telefone)) && !recebedores.some(continuaNaEquipe);
      }),
    }))
    .filter((x) => x.pedidos.length > 0);
}

export function registerConfigRoutes(scope: FastifyInstance, deps: PanelDeps): void {
  const pagina = (
    reply: Parameters<typeof renderPage>[1],
    valores: FormValues,
    extra: { erros?: FormErrors; salvo?: boolean } = {},
  ) =>
    renderPage(deps, reply, 'config.eta', 'config', {
      titulo: 'Configurações',
      v: valores,
      erros: extra.erros ?? {},
      salvo: extra.salvo ?? false,
      dias: DIAS,
      pagamentos: PAGAMENTOS,
      entregadores: linhasEntregadores(valores, extra.erros),
      modelosFaltando: missingTemplates(deps.env),
      avisos: settingsWarnings(deps.settings()),
    });

  scope.get('/painel/config', async (_req, reply) => pagina(reply, settingsToForm(deps.settings())));

  scope.post('/painel/config', async (req, reply) => {
    const r = parseConfigForm((req.body ?? {}) as Record<string, unknown>);
    if (!r.ok) return pagina(reply.code(422), r.valores, { erros: r.erros });

    const presos = entregadoresComPedido(deps.db, deps.settings(), r.settings);
    if (presos.length > 0) {
      const valores = settingsToForm(r.settings);
      const nomes = valores.entregadorNome as string[];
      const telefones = valores.entregadorTelefone as string[];
      // Quem não pode sair volta para a lista, para o dono ver o que continua valendo. Se o nome ainda está na lista,
      // foi só uma troca de telefone: não repete a pessoa.
      for (const { entregador } of presos) {
        if (nomes.some((n) => n.trim().toLowerCase() === entregador.nome.trim().toLowerCase())) continue;
        nomes.push(entregador.nome);
        telefones.push(entregador.telefone);
      }
      const erros: FormErrors = {
        entregadores: presos.map(({ entregador, pedidos }) => {
          const ids = pedidos.map((o) => `#${o.id}`).join(', ');
          return `${entregador.nome} ainda tem ${pedidos.length === 1 ? 'o pedido' : 'os pedidos'} ${ids} em andamento. Conclua ou cancele antes de remover ou trocar o telefone dele.`;
        }),
      };
      return pagina(reply.code(422), valores, { erros });
    }

    const salvo = updateSettings(deps.db, r.settings);
    return pagina(reply, settingsToForm(salvo), { salvo: true });
  });
}

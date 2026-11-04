import { describe, expect, test } from 'vitest';
import { updateOrder } from '../../src/store/orders.js';
import { getSettings, updateSettings } from '../../src/store/settings.js';
import { env, form, login, pedidoPadrao, SEGUNDA_10H, setupPanel } from './helpers.js';

type Panel = Awaited<ReturnType<typeof setupPanel>>;

/** Corpo do formulário igual ao que o navegador mandaria para as configurações do helper. */
function corpoBase(): Record<string, string> {
  const c: Record<string, string> = {
    nomeLoja: 'Gás do Zé',
    enderecoLoja: 'Rua Principal, 1',
    precoRecarga: '115,00',
    precoCompleto: '320,00',
    previsaoEntregaMin: '40',
    bairros: 'Centro\nSão João',
    chavePix: '00.000.000/0001-00',
    telefoneDono: '86999990000',
    destinoPedidos: 'entregadores',
    gdpAceita: 'on',
    gdpModalidade: 'entrega',
    gdpTaxa: '5,00',
    lembretesAtivos: 'on',
    fuso: 'America/Sao_Paulo',
  };
  for (const d of ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab']) {
    c[`${d}_abre`] = '07:00';
    c[`${d}_fecha`] = '20:00';
  }
  return c;
}

/** Envia o formulário; `pagamentos` e as linhas de entregador repetem o campo, como no navegador. */
async function enviar(
  p: Panel,
  cookie: string,
  campos: Record<string, string>,
  pagamentos: string[] = ['dinheiro', 'cartao'],
  entregadores: [string, string][] = [['João', '86911110000']],
) {
  const params = new URLSearchParams(campos);
  for (const x of pagamentos) params.append('pagamentos', x);
  for (const [nome, telefone] of entregadores) {
    params.append('entregadorNome', nome);
    params.append('entregadorTelefone', telefone);
  }
  return p.app.inject({
    method: 'POST',
    url: '/painel/config',
    payload: params.toString(),
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });
}

describe('painel: configurações', () => {
  test('exige sessão', async () => {
    const { app } = await setupPanel();
    expect((await app.inject({ method: 'GET', url: '/painel/config' })).headers.location).toBe('/login');
    expect((await app.inject({ method: 'POST', url: '/painel/config' })).headers.location).toBe('/login');
  });

  test('GET mostra os valores atuais em reais e uma linha por bairro/entregador', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const body = (await p.app.inject({ method: 'GET', url: '/painel/config', headers: { cookie } })).body;
    expect(body).toContain('value="115,00"');
    expect(body).toContain('value="320,00"');
    expect(body).toContain('name="entregadorNome" placeholder="João" aria-label="Nome do entregador" autocomplete="off" value="João"');
    expect(body).toContain('value="5586911110000"');
    expect(body).toContain('Centro');
    expect(body).toMatch(/name="pagamentos" value="pix_antecipado"\s+checked/);
    expect(body).toMatch(/name="gdpAceita"[^>]*checked/);
  });

  test("config salva preço '115,00' como 11500 e bairros por linha", async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), bairros: ' Centro \n\n São João\ncentro\nCentro\n' }, [
      'dinheiro',
      'pix_entrega',
      'dinheiro',
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Configurações salvas');
    const s = getSettings(p.db);
    expect(s.precoRecargaCentavos).toBe(11500);
    expect(s.precoCompletoCentavos).toBe(32000);
    expect(s.bairros).toEqual(['Centro', 'São João', 'centro']);
    // Gás do Povo marcado na seção própria liga também a forma de pagamento.
    expect(s.pagamentos).toEqual(['dinheiro', 'pix_entrega', 'gas_do_povo']);
    expect(s.entregadores).toEqual([{ nome: 'João', telefone: '5586911110000' }]);
    expect(s.gasDoPovo).toEqual({ aceita: true, modalidade: 'entrega', taxaEntregaCentavos: 500 });
    expect(s.lembretesAtivos).toBe(true);
    expect(s.horarios.seg).toEqual({ abre: '07:00', fecha: '20:00' });
  });

  test.each([
    ['115', 11500],
    ['115.00', 11500],
    ['115,5', 11550],
    ['R$ 115,00', 11500],
    ['0', 0],
  ])('preço %s vira %i centavos', async (texto, centavos) => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    await enviar(p, cookie, { ...corpoBase(), precoRecarga: texto });
    expect(getSettings(p.db).precoRecargaCentavos).toBe(centavos);
  });

  test.each(['-5', 'abc', '', '12,345', '1,2,3'])('preço inválido %j mostra erro no campo e não salva', async (texto) => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), nomeLoja: 'Outro nome', precoRecarga: texto });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('class="field-error"');
    expect(res.body).toContain('Outro nome');
    expect(getSettings(p.db).precoRecargaCentavos).toBe(11500);
    expect(getSettings(p.db).nomeLoja).not.toBe('Outro nome');
  });

  test('config inválida (abre>fecha) mostra erro sem salvar e mantém o digitado', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), seg_abre: '20:00', seg_fecha: '07:00', bairros: 'Bairro Novo' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('O horário de abertura deve ser antes do fechamento');
    expect(res.body).toContain('Bairro Novo');
    expect(res.body).toContain('value="20:00"');
    expect(getSettings(p.db).bairros).toEqual(['Centro']);
  });

  test('dia fechado salva null e ignora os campos de hora', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    await enviar(p, cookie, { ...corpoBase(), dom_fechado: 'on', dom_abre: '', dom_fecha: '' });
    expect(getSettings(p.db).horarios.dom).toBeNull();
  });

  test('horário vazio em dia aberto dá erro legível em PT-BR', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), ter_abre: '' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Use o formato HH:MM');
  });

  test.each([
    ['sem telefone', ['Pedro', ''], 'Informe o WhatsApp do entregador.'],
    ['telefone curto', ['Pedro', '12345'], 'O telefone precisa ter DDD e pelo menos 10 números.'],
    ['sem nome', ['', '86933330000'], 'Informe o nome do entregador.'],
    ['telefone repetido', ['Pedro', '86922220000'], 'Esse telefone já está em outro entregador.'],
    ['mesmo número sem o 9º dígito', ['Pedro', '8622220000'], 'Esse telefone já está em outro entregador.'],
  ] as [string, [string, string], string][])('entregador inválido (%s) mostra erro e não salva', async (_caso, linha, mensagem) => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, corpoBase(), undefined, [['Maria', '86922220000'], linha]);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain(mensagem);
    // O erro fica na linha do problema, e o que foi digitado continua na tela.
    expect(res.body).toContain('id="erro-entregador-1"');
    expect(res.body).toContain('value="Maria"');
    expect(res.body).toContain('value="86922220000"');
    expect(getSettings(p.db).entregadores).toEqual([{ nome: 'João', telefone: '5586911110000' }]);
  });

  test('entregadores: adiciona, troca e remove pela lista, mantendo a ordem', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    await enviar(p, cookie, corpoBase(), undefined, [
      ['Maria', '86922220000'],
      ['  Pedro  ', ' (86) 93333-0000 '],
    ]);
    expect(getSettings(p.db).entregadores).toEqual([
      { nome: 'Maria', telefone: '5586922220000' },
      { nome: 'Pedro', telefone: '5586933330000' },
    ]);
  });

  describe('entregador que deixaria um pedido sem ninguém', () => {
    const MARIA: [string, string] = ['Maria', '86922220000'];
    const JOAO: [string, string] = ['João', '86911110000'];
    const ANA_TEL = '5586944440000';
    const dois = (p: Awaited<ReturnType<typeof setupPanel>>) => {
      updateSettings(p.db, {
        ...getSettings(p.db),
        entregadores: [
          { nome: 'João', telefone: '5586911110000' },
          { nome: 'Ana', telefone: ANA_TEL },
        ],
      });
      // A Ana também precisa ter falado com o bot para receber o pedido (janela de 24 h).
      p.db.prepare('INSERT INTO contact_windows (telefone, ultima_entrada_em) VALUES (?, ?)').run(ANA_TEL, SEGUNDA_10H.toISOString());
    };

    test('o único que recebeu o pedido não sai nem troca de telefone: o erro cita o pedido e ele volta para a lista', async () => {
      const p = await setupPanel();
      await p.orders.create(p.cliente.id, { ...pedidoPadrao });
      const cookie = await login(p.app);
      const tirou = await enviar(p, cookie, corpoBase(), undefined, [MARIA]);
      expect(tirou.statusCode).toBe(422);
      expect(tirou.body).toContain('João ainda tem o pedido #1 em andamento');
      expect(tirou.body).toContain('value="João"');
      expect(tirou.body).toContain('value="Maria"');
      expect(getSettings(p.db).entregadores).toEqual([{ nome: 'João', telefone: '5586911110000' }]);

      const trocou = await enviar(p, cookie, corpoBase(), undefined, [['João', '86933330000']]);
      expect(trocou.statusCode).toBe(422);
      expect(trocou.body).toContain('trocar o telefone');
      expect(trocou.body.match(/value="João"/g)).toHaveLength(1); // só uma troca: não duplica a pessoa
      expect(getSettings(p.db).entregadores).toEqual([{ nome: 'João', telefone: '5586911110000' }]);
    });

    test('pode adicionar gente e manter quem tem pedido', async () => {
      const p = await setupPanel();
      await p.orders.create(p.cliente.id, { ...pedidoPadrao });
      const res = await enviar(p, await login(p.app), corpoBase(), undefined, [JOAO, MARIA]);
      expect(res.statusCode).toBe(200);
      expect(getSettings(p.db).entregadores.map((e) => e.nome)).toEqual(['João', 'Maria']);
    });

    test('o mesmo número com outra formatação não conta como remoção', async () => {
      const p = await setupPanel();
      await p.orders.create(p.cliente.id, { ...pedidoPadrao });
      const res = await enviar(p, await login(p.app), corpoBase(), undefined, [['João Silva', '(86) 91111-0000']]);
      expect(res.statusCode).toBe(200);
      expect(getSettings(p.db).entregadores[0]?.nome).toBe('João Silva');
    });

    test('pedido esperando que outro entregador também recebeu não prende quem sai', async () => {
      const p = await setupPanel();
      dois(p);
      await p.orders.create(p.cliente.id, { ...pedidoPadrao });
      const cookie = await login(p.app);
      const res = await enviar(p, cookie, corpoBase(), undefined, [['Ana', '86944440000']]);
      expect(res.statusCode).toBe(200);
      expect(getSettings(p.db).entregadores.map((e) => e.nome)).toEqual(['Ana']);
    });

    test('tirar os dois deixa o pedido esperando sem ninguém: os dois ficam presos, cada um com os seus pedidos', async () => {
      const p = await setupPanel();
      dois(p);
      await p.orders.create(p.cliente.id, { ...pedidoPadrao });
      await p.orders.create(p.cliente.id, { ...pedidoPadrao });
      // O dono está cadastrado, mas não recebeu o aviso destes pedidos: quem recebeu foram só os dois que saem.
      const res = await enviar(p, await login(p.app), { ...corpoBase(), destinoPedidos: 'dono' }, undefined, []);
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('João ainda tem os pedidos #1, #2');
      expect(res.body).toContain('Ana ainda tem os pedidos #1, #2');
    });

    test('com o WhatsApp do dono cadastrado, o pedido esperando não fica sem ninguém', async () => {
      const p = await setupPanel();
      await p.orders.create(p.cliente.id, { ...pedidoPadrao });
      // O dono também recebeu o aviso do pedido.
      p.db.prepare('INSERT OR IGNORE INTO order_messages (wamid, order_id, telefone) VALUES (?, ?, ?)').run('w-dono', 1, '5586999990000');
      const res = await enviar(p, await login(p.app), { ...corpoBase(), destinoPedidos: 'dono' }, undefined, []);
      expect(res.statusCode).toBe(200);
    });

    test('pedido que saiu prende só quem está com ele; terminado ou cancelado, libera', async () => {
      const p = await setupPanel();
      dois(p);
      const a = await p.orders.create(p.cliente.id, { ...pedidoPadrao });
      if (!a.ok) throw new Error('pedido inválido');
      updateOrder(p.db, a.order.id, { status: 'saiu', entregadorTelefone: ANA_TEL, saiuEm: SEGUNDA_10H.toISOString() });
      const cookie = await login(p.app);
      const tirouAna = await enviar(p, cookie, corpoBase(), undefined, [JOAO]);
      expect(tirouAna.statusCode).toBe(422);
      expect(tirouAna.body).toContain('Ana ainda tem o pedido #1 em andamento');
      expect(tirouAna.body).not.toContain('João ainda tem');
      expect(getSettings(p.db).entregadores).toHaveLength(2);

      const tirouJoao = await enviar(p, cookie, corpoBase(), undefined, [['Ana', '86944440000']]);
      expect(tirouJoao.statusCode).toBe(200); // o João não está com nada

      await p.orders.setStatus(a.order.id, 'entregue');
      const livre = await enviar(p, cookie, { ...corpoBase(), destinoPedidos: 'dono' }, undefined, []);
      expect(livre.statusCode).toBe(200);
      expect(getSettings(p.db).entregadores).toEqual([]);
    });
  });

  test('entregadores: um só entregador (campo sem repetição) também salva', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    await enviar(p, cookie, { ...corpoBase(), entregadorNome: 'Ana', entregadorTelefone: '86944440000' }, undefined, []);
    expect(getSettings(p.db).entregadores).toEqual([{ nome: 'Ana', telefone: '5586944440000' }]);
  });

  test('entregadores: linhas vazias são ignoradas e a lista pode ficar vazia', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    await enviar(p, cookie, { ...corpoBase(), destinoPedidos: 'dono' }, undefined, [['', ''], ['  ', ' ']]);
    expect(getSettings(p.db).entregadores).toEqual([]);
  });

  test('entregadores: linha vazia no meio não desalinha o erro da linha seguinte', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, corpoBase(), undefined, [['Maria', '86922220000'], ['', ''], ['Pedro', '123']]);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('id="erro-entregador-2"');
    expect(res.body).not.toContain('id="erro-entregador-1"');
  });

  test('sempre oferece uma linha vazia para cadastrar sem JavaScript', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const body = (await p.app.inject({ method: 'GET', url: '/painel/config', headers: { cookie } })).body;
    // João, a linha vazia e o modelo que o painel.js copia.
    expect(body.match(/name="entregadorNome"/g)).toHaveLength(3);
    expect(body.match(/data-vazia/g)).toHaveLength(2);
  });

  test('escapa HTML no nome do entregador reapresentado', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, corpoBase(), undefined, [['"><script>x()</script>', '123']]);
    expect(res.body).not.toContain('<script>x()</script>');
  });

  test('pix_antecipado sem chave Pix mostra erro e não salva', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), chavePix: '  ' }, ['dinheiro', 'pix_antecipado']);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Informe a chave Pix para aceitar Pix antecipado');
    expect(getSettings(p.db).chavePix).toBe('cnpj 00.000.000/0001-00');
  });

  test('chave Pix com formato inválido (ex.: texto de exemplo) não salva', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), chavePix: 'chave-pix-aqui' }, ['dinheiro', 'pix_antecipado']);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Essa chave Pix não parece válida');
    expect(getSettings(p.db).chavePix).toBe('cnpj 00.000.000/0001-00');
    // Mesmo sem Pix antecipado, uma chave digitada errada é recusada em vez de ficar guardada.
    const sem = await enviar(p, cookie, { ...corpoBase(), chavePix: 'chave-pix-aqui' }, ['dinheiro']);
    expect(sem.statusCode).toBe(422);
  });

  test('avisa quando Pix antecipado está ligado com uma chave salva inválida', async () => {
    const p = await setupPanel();
    updateSettings(p.db, { ...getSettings(p.db), pagamentos: ['dinheiro', 'pix_antecipado'], chavePix: 'chave-pix-aqui' });
    const cookie = await login(p.app);
    const body = (await p.app.inject({ method: 'GET', url: '/painel/config', headers: { cookie } })).body;
    expect(body).toContain('a chave Pix não é válida');
  });

  test('sem chave Pix e sem Pix antecipado salva chave como nulo', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    await enviar(p, cookie, { ...corpoBase(), chavePix: '' }, ['dinheiro']);
    expect(getSettings(p.db).chavePix).toBeNull();
  });

  test('checkboxes desmarcados desligam Gás do Povo e lembretes', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const { gdpAceita: _a, lembretesAtivos: _l, ...resto } = corpoBase();
    await enviar(p, cookie, resto);
    const s = getSettings(p.db);
    expect(s.gasDoPovo.aceita).toBe(false);
    expect(s.lembretesAtivos).toBe(false);
    expect(s.pagamentos).not.toContain('gas_do_povo');
  });

  test('previsão zerada e valor de pagamento desconhecido viram mensagens em PT-BR', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), previsaoEntregaMin: '0', nomeLoja: '' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Informe a previsão de entrega em minutos');
    expect(res.body).toContain('Informe o nome da loja');
    expect(res.body).not.toMatch(/Too small|Invalid input|expected/i);
  });

  test('escapa HTML nos valores reapresentados', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), nomeLoja: '"><script>x()</script>', precoRecarga: 'abc' });
    expect(res.body).not.toContain('<script>x()</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });
});

describe('painel: aviso de modelos de mensagem ausentes', () => {
  test('sem os WA_TPL_* a página lista cada modelo ausente e o efeito', async () => {
    const { app } = await setupPanel();
    const cookie = await login(app);
    const body = (await app.inject({ method: 'GET', url: '/painel/config', headers: { cookie } })).body;
    expect(body).toContain('Modelos de mensagem faltando');
    for (const v of ['WA_TPL_PEDIDO', 'WA_TPL_ALERTA', 'WA_TPL_STATUS', 'WA_TPL_LEMBRETE']) expect(body).toContain(v);
    expect(body).toContain(
      'Sem o modelo de alerta, avisos ao seu WhatsApp só chegam se você tiver falado com o bot nas últimas 24h.',
    );
  });

  test('com parte dos modelos, só os ausentes aparecem; com todos, nenhum aviso', async () => {
    const parcial = await setupPanel('Maria', () => SEGUNDA_10H, { ...env, WA_TPL_PEDIDO: 'aviso_pedido', WA_TPL_ALERTA: 'alerta_dono' });
    const c1 = await login(parcial.app);
    const b1 = (await parcial.app.inject({ method: 'GET', url: '/painel/config', headers: { cookie: c1 } })).body;
    expect(b1).not.toContain('WA_TPL_PEDIDO');
    expect(b1).not.toContain('WA_TPL_ALERTA');
    expect(b1).toContain('WA_TPL_STATUS');
    expect(b1).toContain('WA_TPL_LEMBRETE');

    const todos = await setupPanel('Maria', () => SEGUNDA_10H, {
      ...env,
      WA_TPL_PEDIDO: 'a',
      WA_TPL_ALERTA: 'b',
      WA_TPL_STATUS: 'c',
      WA_TPL_LEMBRETE: 'd',
    });
    const c2 = await login(todos.app);
    const b2 = (await todos.app.inject({ method: 'GET', url: '/painel/config', headers: { cookie: c2 } })).body;
    expect(b2).not.toContain('Modelos de mensagem faltando');
  });

  test('pedido sem destino não salva: dono sem WhatsApp, ou entregadores sem ninguém', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const semDono = await enviar(p, cookie, { ...corpoBase(), destinoPedidos: 'dono', telefoneDono: '' });
    expect(semDono.statusCode).toBe(422);
    expect(semDono.body).toContain('Informe o seu WhatsApp: os pedidos novos vão para ele.');
    const semEntregador = await enviar(p, cookie, { ...corpoBase(), destinoPedidos: 'entregadores' }, undefined, []);
    expect(semEntregador.statusCode).toBe(422);
    expect(semEntregador.body).toContain('Cadastre pelo menos um entregador');
    expect(getSettings(p.db).entregadores).toHaveLength(1);
  });

  test('avisa quando o que está salvo faz o bot atender mal', async () => {
    const p = await setupPanel();
    const s = getSettings(p.db);
    updateSettings(p.db, {
      ...s,
      horarios: { dom: null, seg: null, ter: null, qua: null, qui: null, sex: null, sab: null },
      destinoPedidos: 'dono',
      telefoneDono: '',
    });
    const cookie = await login(p.app);
    const body = (await p.app.inject({ method: 'GET', url: '/painel/config', headers: { cookie } })).body;
    expect(body).toContain('A loja está fechada todos os dias');
    expect(body).toContain('nenhum pedido chega a ninguém');
    // A barra do topo também avisa e leva ao horário.
    expect(body).toContain('href="/painel/config#horario"');
  });
});

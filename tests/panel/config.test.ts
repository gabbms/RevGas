import { describe, expect, test } from 'vitest';
import { getSettings } from '../../src/store/settings.js';
import { form, login, setupPanel } from './helpers.js';

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
    chavePix: 'cnpj 00.000.000/0001-00',
    telefoneDono: '86999990000',
    entregadores: 'João; 86911110000',
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

/** Envia o formulário; `pagamentos` pode repetir o campo (checkboxes). */
async function enviar(p: Panel, cookie: string, campos: Record<string, string>, pagamentos: string[] = ['dinheiro', 'cartao']) {
  const params = new URLSearchParams(campos);
  for (const x of pagamentos) params.append('pagamentos', x);
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
    expect(body).toContain('João; 5586911110000');
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
    expect(res.body).toContain('class="erro-campo"');
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
    ['sem ponto e vírgula', 'João 86911110000'],
    ['telefone curto', 'João; 12345'],
    ['sem nome', '; 86911110000'],
  ])('entregador inválido (%s) mostra erro e não salva', async (_nome, linha) => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), entregadores: `Maria; 86922220000\n${linha}` });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Linha 2');
    expect(res.body).toContain('Maria; 86922220000');
    expect(getSettings(p.db).entregadores).toEqual([{ nome: 'João', telefone: '5586911110000' }]);
  });

  test('entregadores: linhas vazias são ignoradas e a lista pode ficar vazia', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    await enviar(p, cookie, { ...corpoBase(), entregadores: '\n  \n', destinoPedidos: 'dono' });
    expect(getSettings(p.db).entregadores).toEqual([]);
  });

  test('pix_antecipado sem chave Pix mostra erro e não salva', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const res = await enviar(p, cookie, { ...corpoBase(), chavePix: '  ' }, ['dinheiro', 'pix_antecipado']);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Informe a chave Pix para aceitar Pix antecipado');
    expect(getSettings(p.db).chavePix).toBe('cnpj 00.000.000/0001-00');
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

// Comportamentos pequenos do painel. Tudo funciona sem este arquivo; ele só deixa o uso mais confortável.
(function () {
  // Conversa: abre no fim e, quando chegam mensagens novas, só rola se a pessoa já estava lendo o fim.
  function fimDaConversa(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }
  var thread = document.getElementById('mensagens');
  if (thread) {
    thread.scrollTop = thread.scrollHeight;
    var estavaNoFim = true;
    document.body.addEventListener('htmx:beforeSwap', function (e) {
      if (e.detail.target === thread) estavaNoFim = fimDaConversa(thread);
    });
    document.body.addEventListener('htmx:afterSwap', function (e) {
      if (e.detail.target === thread && estavaNoFim) thread.scrollTop = thread.scrollHeight;
    });
  }

  // Configurações: dia marcado como fechado desliga os horários dele.
  function sincronizarDia(caixa) {
    var linha = caixa.closest('[data-dia]');
    if (!linha) return;
    var fechado = caixa.checked;
    linha.classList.toggle('is-closed', fechado);
    linha.querySelectorAll('input[type="time"]').forEach(function (t) {
      t.disabled = fechado;
    });
  }
  // Ao abrir um dia sem horário, copia o do dia aberto mais próximo acima (ou 07:00–18:00), para não digitar tudo de novo.
  function preencherHorario(caixa) {
    var linha = caixa.closest('[data-dia]');
    var tempos = linha.querySelectorAll('input[type="time"]');
    if (caixa.checked || tempos[0].value || tempos[1].value) return;
    var abre = '07:00';
    var fecha = '18:00';
    var dias = Array.prototype.slice.call(document.querySelectorAll('[data-dia]'));
    for (var i = dias.indexOf(linha) - 1; i >= 0; i--) {
      var t = dias[i].querySelectorAll('input[type="time"]');
      if (!dias[i].querySelector('input[data-fechado]').checked && t[0].value && t[1].value) {
        abre = t[0].value;
        fecha = t[1].value;
        break;
      }
    }
    tempos[0].value = abre;
    tempos[1].value = fecha;
  }
  document.querySelectorAll('[data-dia] input[data-fechado]').forEach(function (caixa) {
    sincronizarDia(caixa);
    caixa.addEventListener('change', function () {
      preencherHorario(caixa);
      sincronizarDia(caixa);
    });
  });
  // Campos desabilitados não são enviados; reabilita antes de salvar para não perder o horário digitado.
  var form = document.querySelector('form.config');
  if (form) {
    form.addEventListener('submit', function () {
      form.querySelectorAll('input[type="time"]:disabled').forEach(function (t) {
        t.disabled = false;
      });
    });
  }

  // Menu de mais ações: fecha ao clicar fora ou com Esc.
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.menu[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('details.menu[open]').forEach(function (d) {
      d.removeAttribute('open');
      var s = d.querySelector('summary');
      if (s) s.focus();
    });
  });
})();

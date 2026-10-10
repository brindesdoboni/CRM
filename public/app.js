document.addEventListener('DOMContentLoaded', function () {
  // Tela de usuário: ao trocar o perfil, as permissões voltam ao padrão dele.
  var caixa = document.getElementById('permissoes');
  if (caixa) {
    var checks = caixa.querySelectorAll('input[name=permissoes]');
    var avisoAdmin = caixa.querySelector('[data-aviso-admin]');
    var avisoOutros = caixa.querySelector('[data-aviso-outros]');
    document.querySelectorAll('input[name=perfil]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        var admin = radio.value === 'admin';
        var padrao = (radio.dataset.padrao || '').split(',');
        checks.forEach(function (c) {
          c.checked = admin || padrao.indexOf(c.value) !== -1;
          c.disabled = admin;
        });
        avisoAdmin.hidden = !admin;
        avisoOutros.hidden = admin;
      });
    });
  }

  // Novo lead: avisa na hora se o telefone já está cadastrado.
  var tel = document.querySelector('[data-telefone]');
  var telAviso = document.querySelector('[data-telefone-aviso]');
  if (tel && telAviso) {
    var verificar = function () {
      var digitos = tel.value.replace(/\D/g, '');
      if (digitos.length < 10) { telAviso.hidden = true; return; }
      fetch('/leads/telefone?tel=' + encodeURIComponent(tel.value), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.existe) {
            telAviso.textContent = 'Este telefone já está cadastrado' + (d.nome ? ' (' + d.nome + ')' : '') + '. Ao salvar, o lead será ligado a esse cliente.';
            telAviso.hidden = false;
          } else {
            telAviso.hidden = true;
          }
        })
        .catch(function () { telAviso.hidden = true; });
    };
    tel.addEventListener('blur', verificar);
    tel.addEventListener('change', verificar);
  }

  // Colar print (Ctrl+V) direto no campo de arquivo.
  var arquivo = document.querySelector('input[type=file][data-colar]');
  if (arquivo && window.DataTransfer) {
    document.addEventListener('paste', function (e) {
      var itens = (e.clipboardData && e.clipboardData.files) || [];
      for (var i = 0; i < itens.length; i++) {
        if (itens[i].type.indexOf('image/') === 0) {
          var dt = new DataTransfer();
          dt.items.add(itens[i]);
          arquivo.files = dt.files;
          arquivo.dispatchEvent(new Event('change'));
          e.preventDefault();
          break;
        }
      }
    });
  }

  // Ficha do lead: motivo obrigatório só quando escolhe "Perdido".
  var formEtapa = document.querySelector('[data-form-etapa]');
  if (formEtapa) {
    var sel = formEtapa.querySelector('select[name=etapa]');
    var motivo = formEtapa.querySelector('[data-motivo]');
    var atualizar = function () {
      motivo.hidden = sel.value !== 'perdido';
      motivo.querySelector('input').required = sel.value === 'perdido';
    };
    sel.addEventListener('change', atualizar);
    atualizar();
  }

  var imprimir = document.querySelector('[data-imprimir]');
  if (imprimir) imprimir.addEventListener('click', function () { window.print(); });
});

document.addEventListener('DOMContentLoaded', function () {
  // Pede confirmação antes de ações que não dá para desfazer
  document.querySelectorAll('form[data-confirmar]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!window.confirm(f.dataset.confirmar)) e.preventDefault(); });
  });
  // Campos de copiar: seleciona tudo ao clicar
  document.querySelectorAll('[data-copiar]').forEach(function (i) {
    i.addEventListener('focus', function () { i.select(); });
  });
});

// Venda: total e parcela ao vivo (o servidor recalcula ao salvar) e cotação na SuperFrete.
document.addEventListener('DOMContentLoaded', function () {
  var form = document.querySelector('form[data-venda]');
  if (!form) return;
  var campo = function (n) { return form.querySelector('[name=' + n + ']'); };
  var reais = function (v) {
    v = String(v || '').trim().replace(/^R\$\s*/i, '');
    if (!v) return null;
    if (v.indexOf(',') !== -1 || /^\d{1,3}(\.\d{3})+$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
  };
  var fmt = function (c) { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
  var r = function (k) { return form.querySelector('[data-r=' + k + ']'); };
  var margem = form.querySelector('[data-margem-frete]');

  function calcular() {
    var qtd = parseInt(campo('quantidade').value, 10) || 0;
    var unit = reais(campo('valor_unitario').value);
    var frete = reais(campo('frete_valor').value) || 0;
    var desc = reais(campo('desconto').value) || 0;
    var entrada = reais(campo('entrada').value) || 0;
    var n = Math.max(1, parseInt(campo('parcelas').value, 10) || 1);
    var semJuros = campo('sem_juros').value !== 'nao' || n === 1;
    var parcelaCampo = form.querySelector('[data-valor-parcela]');
    parcelaCampo.readOnly = semJuros;
    if (margem) {
      var custo = reais(campo('frete_custo').value);
      var cobrado = reais(campo('frete_valor').value);
      margem.textContent = custo === null || cobrado === null || isNaN(custo) || isNaN(cobrado) ? '—' : fmt(cobrado - custo);
    }
    r('frete').textContent = fmt(frete || 0);
    r('desconto').textContent = fmt(desc || 0);
    r('obs').textContent = '';
    if (unit === null || isNaN(unit) || [frete, desc, entrada].some(isNaN)) {
      ['produtos', 'total', 'parcela'].forEach(function (k) { r(k).textContent = '—'; });
      if (unit === null) r('obs').textContent = 'Informe o valor unitário para calcular o total.';
      return;
    }
    var produtos = unit * qtd;
    var total = produtos + frete - desc;
    r('produtos').textContent = fmt(produtos);
    r('total').textContent = fmt(total);
    if (total < 0) { r('obs').textContent = 'O desconto passou de produtos + frete.'; return; }
    if (semJuros) {
      var p = Math.round((total - entrada) / n);
      parcelaCampo.value = (p / 100).toFixed(2).replace('.', ',');
      r('parcela').textContent = n === 1 ? fmt(p) + ' (à vista)' : n + '× de ' + fmt(p) + ' sem juros';
    } else {
      var pj = reais(parcelaCampo.value);
      r('parcela').textContent = pj === null || isNaN(pj) ? 'digite o valor da parcela' : n + '× de ' + fmt(pj) + ' com juros';
      if (pj) r('obs').textContent = 'Total pago com juros: ' + fmt(entrada + pj * n) + '.';
    }
    if (entrada) r('obs').textContent = 'Entrada de ' + fmt(entrada) + '. ' + r('obs').textContent;
  }
  form.querySelectorAll('[data-calc]').forEach(function (i) {
    i.addEventListener('input', calcular);
    i.addEventListener('change', calcular);
  });
  calcular();

  var cotar = form.querySelector('[data-cotar]');
  if (!cotar) return;
  var msg = form.querySelector('[data-cot-msg]');
  var opcoes = form.querySelector('[data-cot-opcoes]');
  var aviso = function (t) { msg.textContent = t; msg.hidden = !t; };
  cotar.addEventListener('click', function () {
    aviso('Cotando…');
    opcoes.innerHTML = '';
    var corpo = { cep: form.querySelector('[data-frete-cep]').value };
    form.querySelectorAll('[data-cot]').forEach(function (i) { corpo[i.dataset.cot] = i.value; });
    fetch('/pedidos/frete/cotar', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': campo('_csrf').value },
      body: JSON.stringify(corpo),
    })
      .then(function (res) { return res.json(); })
      .then(function (d) {
        if (d.erro) { aviso(d.erro); return; }
        aviso('Escolha uma opção para preencher o frete:');
        d.opcoes.forEach(function (o) {
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = o.servico + ' · ' + fmt(Math.round(o.valor * 100)) + (o.prazo ? ' · ' + o.prazo + ' dias úteis' : '');
          b.addEventListener('click', function () {
            form.querySelector('[data-frete-servico]').value = o.servico;
            form.querySelector('[data-frete-valor]').value = o.valor.toFixed(2).replace('.', ',');
            if (o.prazo) form.querySelector('[data-frete-prazo]').value = o.prazo;
            if (margem && !campo('frete_custo').value) campo('frete_custo').value = o.valor.toFixed(2).replace('.', ',');
            aviso(o.servico + ' escolhido.');
            calcular();
          });
          opcoes.appendChild(b);
        });
      })
      .catch(function () { aviso('Não foi possível cotar agora. Digite o valor do frete.'); });
  });
});

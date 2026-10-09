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

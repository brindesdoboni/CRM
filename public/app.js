// Tela de usuário: ao trocar o perfil, as permissões voltam ao padrão dele.
document.addEventListener('DOMContentLoaded', function () {
  var caixa = document.getElementById('permissoes');
  if (!caixa) return;
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
});

# CRM Brindes DoBoni — Fase 1 (instruções para o Claude Code)

Você vai construir o sistema interno de vendas e produção dos pedidos DIRETOS da Brindes DoBoni
(prospecção, site, WhatsApp, Instagram, leads vindos da Shopee). O dono, Lucas, não programa:
explique cada passo em português simples e avise antes de mudar qualquer coisa já em uso.

Pedidos da Shopee/TikTok continuam no fluxo atual (UpSeller + Central Boni). NÃO mexa na Central Boni
nem no site brindesdoboni.com neste projeto.

## Decisões técnicas
- Projeto novo e separado, em repositório próprio no GitHub do Lucas (nome sugerido: `crm-doboni`).
- Hospedagem: Railway (onde a Central Boni já roda), serviço novo + PostgreSQL. Fuso America/Sao_Paulo.
- Stack: Node.js + TypeScript, PostgreSQL, interface web responsiva (desktop primeiro; a Jô usa monitor).
- Login por e-mail e senha (senhas com hash), sessão segura, um usuário por pessoa.
- Segredos (token SuperFrete, chave de sessão) só em variáveis de ambiente, nunca no código.
- Todo registro importante tem histórico: quem fez, o quê e quando (tabela de eventos).
- Endereço futuro: sistema.brindesdoboni.com (o domínio ainda depende de acesso à Cloudflare;
  até lá usar o endereço gerado pelo Railway).
- Interface e mensagens 100% em português do Brasil. Valores em R$, datas dd/mm/aaaa.

## Perfis de acesso
| Perfil | Acesso |
| --- | --- |
| Admin (Lucas) | Tudo |
| Lead (Danielson) | Só a tela "Novo lead" e a lista dos leads que ele criou |
| Financeiro | Pix solicitados e comprovantes |
| Produção (Jô) | Painel de produção |

## Regras de negócio
- Uma empresa só (Brindes DoBoni). Todo lead e todo pedido tem ORIGEM obrigatória:
  Prospecção, Site Brindes DoBoni, WhatsApp, Instagram, TikTok, Shopee – Lucmarix, Shopee – Bexlu,
  Shopee – JL Imports, Shopee – Brindes Bexlu, Outras lojas (lista editável nas configurações).
- Cliente único, chave = telefone (normalizar: só dígitos, com DDD). Cada pedido guarda sua origem.
- Varejo/atacado: quantidade < limite = varejo (cliente paga frete); >= limite = atacado (frete grátis,
  embutido no preço). Limite configurável, padrão 20, com opção "a partir de" ou "acima de".
- Atacado: mostrar custo do produto, frete, margem desejada (%), preço unitário sugerido
  = (custo × qtd + frete) × (1 + margem) / qtd, arredondado em R$ 0,10; preço editável; lucro ao vivo.
- Orçamento: validade padrão 7 dias; lembrete de retorno 2 dias após enviado sem resposta.
- Pedido só vai para produção com: pagamento confirmado pelo financeiro E cliente aprovou a confirmação.
- Confirmação versionada: qualquer mudança depois de aprovada cria nova versão e exige nova aprovação.
  Guardar versão aprovada, data/hora e nome digitado por quem aprovou.
- OP (ordem de produção) gerada automaticamente após a aprovação, com os dados da versão aprovada,
  somente leitura para a produção. Prazo padrão: 5 dias úteis após a aprovação (editável por pedido).
- "Produção concluída" é sempre manual. Só libera com os 9 itens do checklist marcados e
  peso (kg) + altura, largura, comprimento (cm) preenchidos. Nunca concluir por prazo.
- Sem regras automáticas de troca/devolução.

## Etapas do pedido
Novo lead → Atendimento → Aguardando informações → Orçamento em preparação → Orçamento enviado →
Negociação → Pedido fechado → Aguardando pagamento → Comprovante em análise → Pago →
Aguardando aprovação do pedido → Aprovado → Em produção → Aguardando emissão da etiqueta.
Saídas: Perdido (motivo obrigatório), Pausado (problema na produção).
(As etapas de envio, rastreio, pós-venda e ocorrências são da Fase 2 — deixar o modelo pronto para elas.)

Funil de prospecção separado: A contatar → Contatado → Interessado → Orçamento enviado → Fechado / Perdido.

## Telas da Fase 1
1. Login.
2. Início: tarefas do dia, contadores por etapa, alertas (OP atrasada, orçamento sem resposta,
   comprovante aguardando).
3. Funil de vendas em colunas (arrastar muda etapa e registra histórico), filtros por origem/período,
   aba Prospecção.
4. Ficha do cliente: dados, CPF/CNPJ, endereço, origens, pedidos, orçamentos, anotações; botões
   "Abrir WhatsApp" (link wa.me), "Mensagem de apresentação" (wa.me com texto pronto contendo nome de
   quem atende e loja de origem), "Novo orçamento", "Criar lembrete".
5. Novo lead (Danielson): telefone*, nome, loja de origem*, produto, quantidade, observações, anexo do
   print. Telefone repetido → avisa e liga ao cadastro existente. Salvar avisa o Lucas.
6. Orçamento: cliente, itens (produto, cor, qtd), CEP, frete (cotação SuperFrete; se indisponível,
   valor digitado), varejo/atacado automático, margem, comparativo com preço Shopee, botões
   "Salvar rascunho", "Gerar link", "Copiar para o WhatsApp".
7. Página pública do orçamento (link com token difícil de adivinhar): itens, valores, frete, prazo,
   validade, vantagens da compra direta, "Aprovar orçamento", "Falar no WhatsApp".
8. Pedido: cliente e entrega; personalização (cor, nomes colados ou CSV, logo, fonte, posicionamento,
   arte, observações); pagamento (forma, "Solicitar Pix ao financeiro", link recebido, comprovante);
   confirmação (gerar, versão, situação); histórico.
9. Financeiro: fila "Pix solicitados" (colar link/chave) e fila "Comprovantes" ("Pagamento confirmado"
   / "Recusar" com motivo).
10. Página pública de confirmação do pedido + PDF: todos os dados, prévia da arte, lista de nomes,
    "Aprovo este pedido" (nome obrigatório) e "Preciso corrigir algo" (avisa o Lucas).
11. Painel de produção (Jô): OPs por prazo com destaque para atrasadas/vencendo hoje; tela da OP com
    dados, arte grande e nomes lado a lado; checklist (1 conferir OP, 2 separar materiais, 3 conferir arte,
    4 gravar, 5 conferir quantidade/nomes/arte/cores, 6 organizar, 7 embalar, 8 informar peso e medidas,
    9 concluir), cada item grava quem e quando; "Baixar CSV para o LightBurn" (colunas: nome, fonte;
    UTF-8 com acentos), "Imprimir OP", "Tenho um problema" (pausa + aviso + motivo).
12. Cadastros e configurações: produtos (nome, modelo, cores, custo, peso, preço Shopee, fotos/vídeos,
    fontes), formas de pagamento (Pix padrão), origens, motivos de perda, regras (limite atacado, prazo,
    validade, dias do lembrete), usuários e perfis, textos prontos.

Avisos internos: um sininho de notificações dentro do sistema já basta na Fase 1.

## SuperFrete (Fase 1 = só cotação)
- Usar primeiro o ambiente Sandbox, com o token gerado pelo Lucas na conta SuperFrete.
- Implementar apenas a cotação de frete (CEP de origem configurável, CEP destino, peso, medidas).
- Consultar a documentação oficial em https://superfrete.readme.io antes de escrever a integração.
- Emissão de etiqueta, rastreio e webhooks ficam para a Fase 2.

## Ordem de construção
1. Estrutura do projeto, banco, login e perfis; publicar no Railway (ambiente de teste).
2. Cadastros/configurações e clientes.
3. Novo lead, funil e prospecção.
4. Orçamento + página pública.
5. Pedido, financeiro, confirmação versionada + PDF.
6. Painel de produção.
7. Cotação SuperFrete (Sandbox).
Ao fim de cada etapa: publicar, mandar o link ao Lucas e explicar o que testar.

## Fora da Fase 1
Emissão de etiqueta e rastreio, pós-venda, ocorrências, integração com o site, Pix automático,
recompra, cadastro de embalagens, WhatsApp automático.

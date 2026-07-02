# Gestão da Operação de Atendimento SIGRA

Protótipo local para importar relatórios Excel do SIGRA, validar dados e acompanhar indicadores da operação de atendimento.

## Como executar

```powershell
& "C:\Users\josiane.costa\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" "C:\Users\josiane.costa\Documents\Codex\2026-07-02\precisamos-criar-um-sistema-onde-eu-2\outputs\sigra-atendimento-dashboard\app.py"
```

Depois acesse:

```text
http://127.0.0.1:8765
```

## O que o sistema faz

- Upload da planilha exportada do SIGRA.
- Validação de campos obrigatórios.
- Contagem de linhas importadas e OS únicas.
- Identificação de duplicidades.
- Identificação de dados ausentes.
- Identificação de inconsistências entre status e datas.
- Separação obrigatória entre `Data Realização` e `Data Realizada`.
- Registro de log de importação.
- Base de OS filtrável, ordenável pelo navegador e exportável em CSV.
- Visão Geral.
- Histórico de Importações SIGRA.
- Performance por Atendente.
- Performance por colaborador por unidade.
- Performance por Fornecedor.

## Regra crítica implementada

`Data Realização` representa a coleta efetivamente realizada pelo fornecedor.

`Data Realizada` representa a confirmação da coleta pelo atendimento no SIGRA.

Se `Data Realização` estiver preenchida e `Data Realizada` estiver vazia, a OS fica como realizada pelo fornecedor e pendente de confirmação pelo atendimento.

Se `Data Realizada` estiver preenchida sem `Data Realização`, o sistema gera alerta de inconsistência.

## Origem da OS e confirmação

O sistema separa:

- Origem da OS.
- Responsável pela abertura da OS.
- Origem da confirmação da coleta.
- Responsável pela confirmação.
- Indicador de produtividade manual.

`Robô Programada` é tratada como OS criada/agendada automaticamente. O robô não conta como colaborador responsável pela confirmação.

`Sob demanda` é tratada como OS aberta manualmente por um colaborador, mas isso não significa que esse colaborador confirmou a coleta.

Quando a observação indicar `Ordem de serviço finalizada a partir da confirmação de coleta da MTR.` ou quando a planilha indicar `Confirmado pelo fornecedor`, a confirmação é classificada como `Confirmada pelo fornecedor via MTR`.

Confirmações via MTR não entram na produtividade manual dos atendentes.

## Performance por colaborador por unidade

A aba `Colaborador x Unidade` mostra somente produtividade manual de confirmação, agrupada por colaborador e unidade.

Ela permite ver:

- Colaborador.
- Unidade.
- Quantidade de confirmações manuais.
- Quantidade de OS realizadas e confirmadas.
- Quantidade de OS que ainda precisam de ação.
- Alertas.

O resumo por unidade mostra, separadamente, total de OS, confirmações manuais, confirmações via MTR, pendências, não realizadas e ações necessárias.

Os cards de unidade podem ser expandidos para mostrar as OS vinculadas às pendências operacionais. O card separa:

- OS agendadas sem confirmação de execução.
- Outras pendências operacionais, como OS não realizadas.

A aba também possui o detalhamento `Colaborador x Unidade x Fornecedor`, mostrando quem confirmou manualmente, o que foi confirmado via MTR/fornecedor e quais fornecedores atendem cada unidade.

## Filtro por período e histórico

Cada planilha importada fica registrada no banco SQLite local.

Ao usar o filtro de datas no topo do sistema, os indicadores são recalculados a partir do histórico importado, usando `Data Agendada` como data de referência da coleta.

Para evitar duplicidade quando relatórios importados se sobrepõem, o sistema considera a versão mais recente de cada `Número Ordem`.

Nos cards por unidade:

- `Coletas agendadas` = OS com `Data Agendada` dentro do período.
- `Confirmadas pelo atendente` = OS confirmadas manualmente por colaborador.
- `Confirmadas pelo fornecedor` = OS confirmadas via MTR/fornecedor.
- `Pendentes de confirmação` = OS agendadas sem `Data Realização` e sem `Data Realizada`.

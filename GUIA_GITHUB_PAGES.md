# Publicação no GitHub Pages

Este projeto agora possui uma versão estática pronta para GitHub Pages na pasta `docs/`.

## Como publicar

1. Crie ou abra o repositório no GitHub.
2. Envie a pasta `docs/` junto com o restante do projeto.
3. No GitHub, acesse `Settings > Pages`.
4. Em `Build and deployment`, escolha:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/docs`
5. Salve.

O GitHub vai gerar uma URL parecida com:

`https://seu-usuario.github.io/nome-do-repositorio/`

## Como funciona sem servidor

A versão publicada no GitHub Pages não usa Python, SQLite nem hospedagem própria.

Ela funciona assim:

- as planilhas oficiais ficam versionadas em `docs/data/raw`;
- o manifesto oficial fica em `docs/data/config/importacoes.json`;
- as ondas, vínculos de unidades, calendário de medição e parâmetros do resumo ficam versionados em `docs/data/config`;
- ao abrir o sistema, o navegador lê o manifesto e processa as planilhas oficiais;
- o IndexedDB é usado apenas como cache local;
- os indicadores são recalculados no próprio navegador;
- nenhuma planilha é enviada para um servidor externo do projeto.

## Base oficial compartilhada

Todos os usuários veem a mesma base porque ela vem dos arquivos versionados no repositório:

- `docs/data/raw/*.xlsx`
- `docs/data/config/importacoes.json`
- `docs/data/config/calendario-medicao.json`
- `docs/data/config/ondas.json`
- `docs/data/config/unidades-ondas.json`
- `docs/data/config/resumo-expansao.json`

Para adicionar uma nova planilha oficial:

1. Copie o `.xlsx` para `docs/data/raw`.
2. Registre o arquivo em `docs/data/config/importacoes.json`.
3. Publique o repositório.
4. No sistema, use “Recarregar base oficial”.

Para adicionar ou alterar ondas de implantação:

1. Atualize `docs/data/config/ondas.json`.
2. Vincule as unidades em `docs/data/config/unidades-ondas.json`.
3. Publique o repositório.
4. No sistema, use “Recarregar base oficial” ou limpe o cache da página.

Essas ondas passam a ser compartilhadas por todos os usuários porque estão no repositório, e não no navegador de uma pessoa.

## Atenção sobre privacidade

Se o repositório GitHub Pages for público, qualquer pessoa com acesso ao link poderá baixar as planilhas em `docs/data/raw`.

Como esses arquivos contêm dados operacionais, o recomendado é:

- usar repositório privado com GitHub Pages privado, se disponível no plano;
- ou publicar sem as planilhas oficiais e usar apenas análise local temporária.

## Análise local temporária

O botão “Subir OS SIGRA” continua disponível.

Quando o usuário sobe uma planilha pela tela, ela pode ser usada em dois modos:

- analisar apenas a planilha temporariamente;
- combinar a planilha com a base oficial localmente.

Essa importação local fica apenas no navegador do usuário e não altera a base oficial compartilhada.

## Importante

Como os dados ficam no navegador:

- outro usuário/computador não verá as importações temporárias feitas por você;
- limpar dados do navegador pode apagar análises temporárias locais;
- a base oficial, ondas, calendário e parâmetros do Resumo da Expansão continuam disponíveis porque ficam no repositório;
- para uso multiusuário com base centralizada, será necessário futuramente um backend ou banco hospedado.

## Arquivos principais da versão GitHub Pages

- `docs/index.html`
- `docs/static/app.js`
- `docs/static/static-api.js`
- `docs/static/styles.css`
- `docs/data/raw/*.xlsx`
- `docs/data/config/importacoes.json`
- `docs/data/config/calendario-medicao.json`
- `docs/data/config/ondas.json`
- `docs/data/config/unidades-ondas.json`
- `docs/data/config/resumo-expansao.json`

O arquivo `static-api.js` substitui as rotas `/api/...` que antes dependiam do servidor local.

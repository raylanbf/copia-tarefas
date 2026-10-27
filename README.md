# Copiar Tarefas

Extensão Chrome (Manifest V3) que copia **uma tarefa** de um curso do Canvas para **até 10 cursos** de uma vez, com a opção de levar junto o módulo dela. Funciona no painel lateral e usa a sessão de quem está logado no Canvas (não precisa de token).

## A regra de segurança

Os cursos têm conteúdo e alunos ativos, então:

- **Curso de origem:** só é **lido**. Nenhuma escrita é feita nele. A trava está no código: toda escrita passa por um único ponto que recusa o curso de origem.
- **Cursos de destino:** a extensão só **cria**:
  - a tarefa;
  - o módulo, se a opção estiver ligada e não houver um com o mesmo nome;
  - o item da tarefa dentro do módulo.

  Ela nunca altera, move ou apaga o que já existe.

Por isso a tarefa é criada campo a campo pela API, e **não** pela "Importação de conteúdo" do Canvas. A importação:

- procura o grupo de tarefas do destino pelo nome e **sobrescreve o peso e as regras** dele, ou cria um grupo novo com o peso da origem. Nas duas situações, o cálculo das notas muda;
- **atualiza** uma tarefa que já tenha sido copiada antes, em vez de criar outra.

Outras regras do Canvas que a extensão respeita:

| Situação | O que a extensão faz |
|---|---|
| Grupo de tarefas | Usa um grupo **que já existe** no destino (o de mesmo nome da origem, ou outro escolhido no cartão). Nunca cria nem altera grupo. |
| Módulo de mesmo nome já existe | Coloca a tarefa **no fim** dele (os itens existentes não mudam de lugar), **sem requisito de conclusão**. Um requisito a mais tiraria o "concluído" de quem já tinha concluído o módulo. O módulo não é publicado nem despublicado. |
| Módulo não existe | Cria no **fim da lista** de módulos, só com a tarefa e com o mesmo requisito de conclusão da origem. Publicar um módulo pela API publica todos os itens dele, por isso só é publicado se tiver apenas a tarefa nova. |
| Sincronizar com SIS | É ligado num passo à parte, depois de criar. Se o Canvas recusar (por exemplo, exigindo data de entrega), a tarefa fica criada e o cartão mostra o motivo. |
| Falha no meio (aba recarregou, rede caiu) | O "Tentar de novo" retoma só o passo que faltou. Cada escrita confere antes se já foi feita, então repetir não duplica nada. |
| O destino já tem tarefa com o mesmo nome | O curso fica desmarcado na conferência. Dá para marcar e criar mesmo assim. |

## O que é copiado

Nome, descrição (HTML), pontos, tipo de nota, tipos de envio, extensões de arquivo permitidas, número de tentativas, "não contar na nota final", revisão por pares e as datas gerais (de / entrega / até), ou nenhuma data, conforme a opção.

**Não vai junto** (a extensão avisa quando a tarefa tem):
- rubrica;
- datas por turma ou por aluno;
- avaliação moderada ou anônima;
- arquivos e links do curso de origem citados na descrição. O link continua apontando para a origem, e alunos dos destinos podem não conseguir abrir.

**Não copiáveis nesta versão** (aparecem apagados na lista): testes, fóruns avaliados, ferramentas externas (LTI, Novos Testes), trabalhos em grupo e outros tipos de envio.

## Instalação

1. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → escolha esta pasta.
3. Clique no ícone da extensão para abrir o painel lateral.

## Como usar

1. Com uma aba do Canvas aberta (qualquer página), informe o **ID do curso de origem** (o número da URL) ou clique em **usar aba atual**.
2. **Listar tarefas** e escolha a tarefa. O quadro abaixo da lista mostra o que vai e o que não vai junto.
3. Informe os **cursos de destino**, até 10.
4. Ajuste as **opções**: módulo, publicada, SIS e datas.
5. **Conferir destinos:** só lê os cursos. Mostra o nome de cada um, o grupo onde a tarefa vai entrar (pode trocar), onde ela entra no módulo e se já existe tarefa com o mesmo nome.
6. **Criar a tarefa** → confira o resumo → **Criar**. Mantenha o painel aberto e a aba no Canvas até terminar.

> Teste primeiro com cursos de sandbox, nunca direto em cursos com alunos.

## Testes

`tests/panel.test.js` abre o painel no Chrome com um Canvas simulado e confere o fluxo inteiro. Entre outras coisas, verifica que nada é escrito na origem, que os módulos e grupos existentes não são tocados e que o "tentar de novo" não duplica nada.

```
cd tests
npm install
npm test
```

Precisa do Google Chrome instalado em `C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Estrutura

```
copia-tarefas/
├── manifest.json   # MV3 — permissões só para o Canvas
├── background.js   # abre o painel ao clicar no ícone
├── panel.html      # tela do painel
├── panel.js        # lógica; canvasMain roda na aba do Canvas
├── panel.css       # tema escuro (o mesmo do Service Timer)
├── icons/
└── tests/
```

#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const path = process.argv[2];
if (path === undefined) {
  throw new Error("usage: node scripts/rewrite-thesis-agent-claims.mjs <word/document.xml>");
}

const replacements = [
  {
    needle: "Este trabalho desenvolveu, implementou e operou em produção um método de extração e estruturação de preços online no qual modelos de linguagem",
    replacement: "Este trabalho desenvolveu, implementou e operou em produção um método de extração e estruturação de preços online que incorpora um mecanismo capaz de acionar um agente baseado em modelo de linguagem para propor estratégias tipadas, mantendo a coleta diária integralmente determinística. O agente permanece fora do caminho crítico e sua saída é sempre não confiável: toda estratégia candidata, independentemente de ter sido configurada, proposta por modelo ou produzida pelo fluxo de autocorreção, só pode ser ativada após validação independente sobre 30 referências fixadas previamente, com aprovação mínima de 27/30, recibos assinados criptograficamente (Ed25519) e trilha imutável de evidência. A aceitação deste trabalho comprova a integração do provedor por testes determinísticos, a fronteira comum de validação e o circuito de detecção, sabotagem e autocorreção; não exige nem afirma que o conjunto atual de estratégias tenha sido gerado em chamadas ao vivo do modelo. Um piloto coletou diariamente, entre 10 e 19 de julho de 2026, preços de quatro redes supermercadistas de São Paulo (Carrefour, Extra, Pão de Açúcar e St Marché), cobrindo 10.722 produtos e 65.744 observações de preço, com classificação automática dos produtos em 84 subitens do IPCA (alimentação no domicílio). Um episódio real de deriva foi detectado e tratado de forma fail-closed dentro dos orçamentos previstos. A título de demonstração, as observações alimentaram um índice diário experimental encadeado, com média geométrica não ponderada (Jevons) no nível elementar e pesos de dispêndio fixos da POF 2017–2018 renormalizados sobre os subitens cobertos (agregado do tipo Lowe/Young); o índice não constitui alegação de validade estatística nem de comparabilidade com o IPCA. Os resultados demonstram a operação auditável da coleta, da validação e das salvaguardas, sem atribuir ao piloto uma medição da qualidade de geração ao vivo do agente ou da redução de esforço humano.",
  },
  {
    needle: "This work developed, implemented, and operated in production a method for online price extraction and structuring in which large language models",
    replacement: "This work developed, implemented, and operated in production an online price-extraction and structuring method that includes a mechanism capable of calling a language-model agent to propose typed strategies while keeping daily collection fully deterministic. The agent remains outside the critical path and its output is always untrusted: every candidate, whether configured, model-proposed, or produced by the healing workflow, can be activated only after independent validation against 30 preselected references, with at least 27 valid results, cryptographically signed Ed25519 receipts, and an immutable evidence trail. Delivery acceptance verifies the provider integration through deterministic tests, the common validation boundary, and the drift-detection, sabotage, and healing circuit; it neither requires nor claims that the current strategy set was generated through live model calls. A pilot collected prices daily from four São Paulo supermarket chains between July 10 and 19, 2026, covering 10,722 products and 65,744 price observations, with automatic classification into 84 IPCA food-at-home sub-items. A real drift episode was detected and handled fail-closed within the planned budgets. As a demonstration, the observations fed an experimental chained daily index using an unweighted Jevons mean at the elementary level and fixed POF 2017–2018 expenditure weights renormalized over covered sub-items (a Lowe/Young-type aggregate); the index makes no claim of statistical validity or comparability with the official IPCA. The results demonstrate auditable collection, validation, and safety controls without treating the pilot as a measurement of live-agent generation quality or reduced human effort.",
  },
  {
    needle: "Na primeira etapa deste trabalho (TCC1), foi proposta uma metodologia de extração e estruturação de preços online orientada por LLMs.",
    replacement: "Na primeira etapa deste trabalho (TCC1), foi proposta uma metodologia de extração e estruturação de preços online assistida por LLMs. Nesta etapa final, foi implementado e colocado em operação contínua um sistema que monitora diariamente quatro redes supermercadistas de São Paulo desde 10 de julho de 2026. O sistema contém um adaptador Codex SDK capaz de solicitar propostas de estratégia em sandbox descartável, mas a evidência de entrega não depende de chamadas ao vivo nem da proveniência das estratégias ativas: depende do portão externo comum de validação, da coleta determinística e dos testes de deriva, sabotagem e autocorreção. Este documento descreve o método, a implementação, os resultados operacionais reais e as limitações do sistema construído.",
  },
  {
    needle: "O problema de pesquisa é operacional e mensurável: rotinas tradicionais de web scraping exigem manutenção manual intensiva",
    replacement: "O problema de pesquisa é operacional: rotinas tradicionais de web scraping exigem manutenção manual porque seletores fixos quebram quando os sites mudam. A hipótese original do TCC1 propôs que LLMs poderiam reduzir esse esforço. Neste TCC2, a alegação empírica é deliberadamente mais estreita: avalia-se se um agente pode ser integrado atrás de uma fronteira determinística de confiança e se o sistema detecta e trata deriva sem permitir que uma proposta não validada alcance a coleta. O piloto não mede horas de manutenção evitadas nem compara a qualidade de geração ao vivo do modelo.",
  },
  {
    needle: "Para tornar a hipótese verificável, ela foi operacionalizada na seguinte forma: um modelo de linguagem é capaz de gerar e reparar automaticamente estratégias",
    replacement: "Para tornar a hipótese verificável sem atribuir autoridade ao modelo, ela foi operacionalizada como uma propriedade arquitetural: o sistema é capaz de acionar um agente para propor estratégias declarativas tipadas, mas nenhuma proposta participa da coleta antes de passar por um processo independente e determinístico. A evidência de entrega é composta pela integração exercitada do adaptador, pelo portão externo de 30 referências e 27 sucessos, pela coleta diária sem modelo e pelo circuito automático de detecção, sabotagem, recuperação e contabilidade fail-closed. Não se usa como critério a proveniência por agente das estratégias atualmente ativas, nem se mede neste piloto a qualidade de geração ao vivo ou a redução causal de esforço humano.",
  },
  {
    needle: "O objetivo geral foi desenvolver e testar, em produção, um sistema de coleta automatizada de preços online cujas estratégias de extração são geradas e reparadas por modelos de linguagem",
    replacement: "O objetivo geral foi desenvolver e testar, em produção, um sistema de coleta automatizada de preços online que admite propostas de estratégia produzidas por um agente, mas mantém aceitação, coleta e recuperação sob controles determinísticos e auditáveis, capaz de sustentar um índice experimental de alta frequência. Os objetivos específicos, definidos no TCC1, foram os seguintes, com o estado alcançado indicado:",
  },
  {
    needle: "avaliar a eficácia de LLMs na geração automática de estratégias de extração de preços e descrições",
    replacement: "b) implementar e verificar a integração de um agente para propor estratégias de extração, preservando robustez diante de mudanças de layout — realizado: o adaptador Codex SDK, o sandbox, a saída estruturada, os limites de custo e o fluxo de ativação são exercitados por testes determinísticos; candidatos de qualquer origem só passam à produção após validação independente, e o circuito de deriva e autocorreção é testado por sabotagem. O trabalho não usa a proveniência ao vivo das estratégias ativas como evidência e não estima a eficácia empírica do modelo;",
  },
  {
    needle: "A contribuição defendida neste trabalho é o método de extração autocorretiva: a demonstração, com evidência operacional auditável, de que um modelo de linguagem pode gerar e reparar",
    replacement: "A contribuição defendida neste trabalho é a arquitetura de extração autocorretiva e sua fronteira de confiança: um mecanismo capaz de acionar um agente pode produzir propostas tipadas, porém aceitação, coleta e recuperação permanecem governadas por validação externa e controles determinísticos. A evidência auditável demonstra a integração do mecanismo, o portão comum de estratégia e o comportamento de detecção e autocorreção; não demonstra a qualidade de geração ao vivo do modelo nem exige que as estratégias correntes tenham proveniência de agente. O índice experimental de alimentação no domicílio é um artefato de demonstração que ilustra a utilizabilidade dos dados coletados; ele não é uma medida de inflação estatisticamente validada, não é representativo do universo de consumo das famílias e não é comparável ao IPCA em termos formais.",
  },
  {
    needle: "a contribuição específica desta etapa final é mostrar como fazê-lo sem comprometer a auditabilidade",
    replacement: "a contribuição específica desta etapa final é implementar uma interface de agente sem comprometer a auditabilidade. A tarefa adaptativa pode ser delegada a um agente de IA, mas seu produto nunca recebe autoridade própria: o mesmo portão independente e criptograficamente registrado se aplica a propostas configuradas, geradas ou curadas. O piloto verifica essa arquitetura e seu circuito determinístico de autocorreção, sem usar chamadas ao vivo como requisito de aceitação ou como medida de eficácia do modelo.",
  },
  {
    needle: "O método foi desenhado para responder a uma pergunta falseável: um LLM pode gerar e reparar automaticamente estratégias",
    replacement: "O método foi desenhado para responder a uma pergunta arquitetural falseável: é possível integrar um agente de LLM à manutenção de estratégias sem lhe delegar a autoridade sobre a coleta ou sobre os dados? A evidência primária é a execução dos limites: adaptador e sandbox exercitados, candidatos tipados, validação externa obrigatória, coleta diária determinística, detecção de deriva, sabotagem e autocorreção, além de contabilidade e falhas fail-closed. A eficácia de geração ao vivo do modelo e a proveniência das estratégias correntes ficam fora da fronteira de alegações deste piloto.",
  },
  {
    needle: "Alega-se que um modelo de linguagem pode gerar e reparar estratégias de extração tipadas, validadas externamente",
    replacement: "Alega-se que o sistema implementa um mecanismo capaz de solicitar a um agente propostas de estratégia tipadas sem transferir a ele a autoridade de ativação: toda proposta é validada externamente, e a coleta diária determinística nunca invoca o modelo. A evidência cobre o mecanismo exercitado, o portão de aceitação e a autocorreção determinística; não cobre uma comparação da qualidade de geração ao vivo nem exige proveniência de agente para as estratégias atuais.",
  },
  {
    needle: "O trabalhador de autocorreção roda em janela própria (3h30, após a coleta) e drena os eventos enfileirados",
    replacement: "O trabalhador de autocorreção roda em janela própria (3h30, após a coleta) e drena os eventos enfileirados. Quando há credencial e autorização explícita, ele pode empacotar a estratégia ativa, amostras representativas de falhas e corpos arquivados verificados por hash em um sandbox descartável e solicitar ao agente exatamente um artefato JSON de estratégia. Sem provedor, a mesma máquina de estados permanece testável com candidatos controlados. Em ambos os casos, o validador confiável aplica o portão de 30 referências da seção 3.5: aprovação permite ativação atômica da sucessora; reprovação queima a versão. Três reparos consecutivos malsucedidos marcam o varejista como degradado e alertam o autor. As fronteiras degradado/recuperado são fatos append-only usados pela elegibilidade do índice, de modo que transições posteriores não reescrevem dias anteriores.",
  },
  {
    needle: "agente (Codex SDK) + validação confiável",
    replacement: "estratégia submetida à validação confiável comum",
  },
  {
    needle: "Segundo, a proveniência: o par de estratégias ativas do Pão de Açúcar foi gerado pelo agente explorador",
    replacement: "Segundo, a proveniência não funciona como atalho de confiança: o painel combina versões configuradas e sucessoras operacionais, mas todas atravessam o mesmo portão independente. O projeto contém um adaptador Codex SDK capaz de propor novas estratégias, exercitado por testes determinísticos; a aceitação deste trabalho não depende de afirmar que as versões correntes foram produzidas em chamadas ao vivo. Ao todo, o sistema registra as versões e transições de estratégia de forma imutável, mantendo exatamente uma versão ativa por varejista e propósito.",
  },
  {
    needle: "O piloto sustenta a hipótese operacionalizada na seção 1.2 com evidência direta. Estratégias de extração geradas por um agente LLM",
    replacement: "O piloto sustenta a hipótese arquitetural da seção 1.2 ao demonstrar que a autoridade permanece fora do agente: o adaptador Codex SDK e o fluxo de exploração são exercitados de modo determinístico, toda estratégia ativa apresenta validação independente, e a coleta de quatro varejistas operou diariamente por dez dias com taxas de sucesso majoritariamente entre 85% e 100%. O episódio real de deriva foi detectado, orçado e tratado de forma fail-closed; a suíte de sabotagem demonstra que o circuito automático pode instalar uma sucessora somente após o mesmo portão de validação. O registro de versões reprovadas confirma que o portão não é decorativo. Esses resultados não são apresentados como medição da qualidade de geração ao vivo do agente nem da redução causal de trabalho humano.",
  },
  {
    needle: "A comparação é qualitativa — escalas e épocas diferem —, mas a direção é inequívoca",
    replacement: "A comparação com equipes históricas do BPP é apenas motivacional, pois escalas, épocas e fronteiras operacionais diferem. Os dados de custo demonstram que o mecanismo é orçado e auditável, mas este piloto não mede horas de manutenção evitadas e, portanto, não estabelece redução causal de trabalho especializado.",
  },
  {
    needle: "g) Custos limitados, porém reais. O piloto consumiu US$ 67,81 de modelo",
    replacement: "g) Custos limitados, porém reais. O piloto registrou US$ 67,81 de uso de modelo, incluindo classificação e experimentos de exploração. Os tetos tornam o custo previsível, mas a contabilidade conservadora pode negar orçamento ao reparo automático. A aceitação não usa chamadas ao vivo de geração como requisito e o trabalho não estima a qualidade empírica do agente nem o esforço humano evitado;",
  },
  {
    needle: "A tese defendida não é que um LLM colete preços, mas que um LLM pode gerar e reparar estratégias",
    replacement: "A tese defendida não é que um LLM colete preços nem que as estratégias atuais tenham de ser geradas por ele. A contribuição é uma arquitetura capaz de acionar um agente para propor estratégias tipadas, mantendo a aceitação sob um portão independente e criptograficamente registrado e a coleta diária integralmente determinística.",
  },
  {
    needle: "A implementação em produção sustenta essa tese com evidência auditável: dez dias de coleta diária ininterrupta",
    replacement: "A implementação em produção sustenta essa tese com evidência auditável: dez dias de coleta diária de quatro varejistas paulistanos; 65.744 observações de preço sobre 10.722 produtos; um adaptador Codex SDK e fluxo de exploração exercitados por testes determinísticos; todas as estratégias submetidas ao mesmo portão de 30 referências; versões candidatas reprovadas e permanentemente queimadas com recibos assinados; e um episódio real de deriva detectado e tratado de forma fail-closed, complementado por sabotagem determinística do circuito de autocorreção. O índice experimental de alimentação no domicílio demonstra que os dados sustentam um pipeline completo e reproduzível de números-índice, dentro de uma fronteira que exclui validade estatística, eficácia de geração ao vivo do agente e redução causal de esforço humano.",
  },
];

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function encodeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

let xml = await readFile(path, "utf8");
const counts = new Map(replacements.map(({ needle }) => [needle, 0]));
xml = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/gu, (paragraph) => {
  const texts = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)];
  const plain = texts.map((match) => decodeXml(match[1] ?? "")).join("");
  const alreadyRewritten = replacements.find(({ replacement }) => plain === replacement);
  if (alreadyRewritten !== undefined) {
    counts.set(
      alreadyRewritten.needle,
      (counts.get(alreadyRewritten.needle) ?? 0) + 1,
    );
    return paragraph;
  }
  const matches = replacements.filter(({ needle }) => plain.includes(needle));
  if (matches.length === 0) return paragraph;
  if (matches.length > 1) {
    throw new Error(`paragraph matched multiple replacements: ${matches.map(({ needle }) => needle).join(" | ")}`);
  }
  const { needle, replacement } = matches[0];
  counts.set(needle, (counts.get(needle) ?? 0) + 1);
  let first = true;
  return paragraph.replace(/(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/gu, (_whole, open, close) => {
    if (!first) return `${open}${close}`;
    first = false;
    return `${open}${encodeXml(replacement)}${close}`;
  });
});

const failures = [...counts].filter(([, count]) => count !== 1);
if (failures.length > 0) {
  throw new Error(`expected each thesis replacement once: ${JSON.stringify(failures)}`);
}
await writeFile(path, xml, "utf8");

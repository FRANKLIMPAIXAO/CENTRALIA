// Carrega .env manualmente pelo caminho absoluto (evita problemas com dotenvx/cwd)
(function loadEnv() {
  const fs2  = require('fs');
  const p2   = require('path');
  const file = p2.join(__dirname, '.env');
  if (!fs2.existsSync(file)) return;
  fs2.readFileSync(file, 'utf8').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 1) return;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  });
})();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ig       = require('./instagram');
const { parseFiscalXML, detectDocType, formatCurrency, formatPercent, crtLabel } = require('./modules/xml-parser');

const app      = express();

// Validação de chaves no startup
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY não encontrada no .env!');
  console.error('   Arquivo .env esperado em:', path.join(__dirname, '.env'));
  process.exit(1);
}
console.log('✅ Chaves carregadas — Anthropic:', process.env.ANTHROPIC_API_KEY.slice(0,12) + '...',
            '| Gemini:', process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.slice(0,8) + '...' : 'NÃO CONFIGURADO');

const claude   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const gemini   = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'placeholder');
// Mantém compatibilidade com código existente
const client   = claude;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('../frontend/public', {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
}));

/* ══════════════════════════════════════════
   MULTER — upload de arquivos
══════════════════════════════════════════ */
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const UPLOAD_DIR    = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Storage para knowledge base (por agente)
const knowledgeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(KNOWLEDGE_DIR, req.params.agentId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safe);
  }
});

// Storage temporário para anexos de chat
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
});

const uploadKnowledge = multer({
  storage: knowledgeStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf','.txt','.md','.docx'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Formato não suportado'), ok);
  }
});

const uploadChat = multer({
  storage: chatStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf','.txt','.md','.docx'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Formato não suportado'), ok);
  }
});

/* ══════════════════════════════════════════
   PARSER DE ARQUIVOS
══════════════════════════════════════════ */
async function parseFile(filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const buf  = fs.readFileSync(filePath);

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buf);
    return data.text;
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result  = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }

  // .txt / .md
  return buf.toString('utf8');
}

/* ══════════════════════════════════════════
   CARREGAR BASE DE CONHECIMENTO DO AGENTE
══════════════════════════════════════════ */
async function loadKnowledge(agentId) {
  const dir = path.join(KNOWLEDGE_DIR, agentId);
  if (!fs.existsSync(dir)) return '';

  const files = fs.readdirSync(dir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.pdf','.txt','.md','.docx'].includes(ext);
  });

  if (files.length === 0) return '';

  const parts = [];
  for (const file of files) {
    try {
      const text = await parseFile(path.join(dir, file));
      parts.push(`--- DOCUMENTO: ${file} ---\n${text.trim()}`);
    } catch(e) {
      console.error(`Erro ao ler ${file}:`, e.message);
    }
  }

  return parts.length > 0
    ? `\n\n═══ BASE DE CONHECIMENTO ═══\nUse as informações abaixo como contexto prioritário:\n\n${parts.join('\n\n')}\n═══════════════════════════`
    : '';
}

/* ══════════════════════════════════════════
   AGENTES DO PIPELINE DE CONTEÚDO
══════════════════════════════════════════ */
const PIPELINE_AGENTS = {
  sofia: `Você é Sofia, estrategista de conteúdo especializada em marketing para contadores brasileiros.

TAREFA: Dado um tema/pauta, gere EXATAMENTE 5 ângulos criativos e distintos.

FORMATO OBRIGATÓRIO (siga à risca):
**ÂNGULO 1 — [Nome curto e impactante]**
[2-3 linhas: abordagem, tom, diferencial e por que vai engajar]

**ÂNGULO 2 — [Nome]**
[descrição]

(repita até ÂNGULO 5)

CRITÉRIOS:
• Cada ângulo deve ter abordagem completamente diferente dos demais
• Varie entre: educativo, provocativo, storytelling, dado/estatística, bastidores, mito vs realidade
• Todos devem ser relevantes para o público contábil brasileiro
• Tom deve variar: sério, descontraído, urgente, inspirador, curiosidade`,

  carlos: `Você é Carlos, o melhor copywriter de conteúdo para contadores do Brasil.

TAREFA: Com base no ângulo selecionado e na pauta, escreva o copy COMPLETO e pronto para publicar.

FORMATO OBRIGATÓRIO — retorne EXATAMENTE nesta estrutura, sem adicionar nada fora dela:

---COPY---
[Escreva aqui APENAS o texto do post, pronto para copiar e colar direto no Instagram. Inclua emojis estratégicos, quebras de linha, CTA forte no final. SEM títulos, SEM labels, SEM metadados.]
---HASHTAGS---
[apenas as hashtags, separadas por espaço, começando com #, máximo 30]
---FIM---

REGRAS ABSOLUTAS:
• Retorne SOMENTE o que está entre as marcações acima
• PROIBIDO adicionar qualquer texto fora do copy e das hashtags
• PROIBIDO incluir "TIPO:", "PLATAFORMA:", "HORÁRIO:", "DICA:", quantidade de slides, recomendações técnicas
• Texto 100% completo (não esboço), linguagem humana e próxima, CTA claro no final do copy.`,

  davi: `Você é Davi, designer front-end especializado em slides HTML para carrossel do Instagram de Franklim Paixão, contador especialista em Reforma Tributária.

TAREFA: Criar slides HTML com o visual EXATO descrito abaixo, baseados no copy fornecido.

━━━ IDENTIDADE VISUAL (OBRIGATÓRIO) ━━━
• Fundo: #0D0D0D (preto profundo)
• Acento VERDE: #00C896 — usado na barra vertical do label do tópico (topo esquerdo)
• Acento DOURADO: #C8A800 — usado na barra horizontal decorativa sob o headline
• Texto headline: #FFFFFF bold, fonte condensada pesada
• Texto secundário/subtítulo: #CCCCCC, menor
• Rodapé fixo: "Franklim Paixão" em branco, separado por linha dourada
• Fonte headline: 'Oswald', 'Impact', 'Arial Narrow', sans-serif (condensada, pesada)
• Fonte corpo: 'Segoe UI', Arial, sans-serif

━━━ ESTRUTURA DE CADA SLIDE (OBRIGATÓRIO) ━━━

TOPO: label do tópico com barra vertical verde à esquerda + contador de slide à direita
  └─ ex: "| REFORMA TRIBUTÁRIA &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 1/6"
  └─ label em verde (#00C896), contador em branco, fonte pequena bold uppercase

CENTRO: headline principal em branco, bold, condensado, grande (52-72px), alinhado à esquerda
  └─ pode ser 1 a 3 linhas
  └─ barra horizontal dourada (#C8A800) de ~60px largura e 4px altura logo abaixo do headline

BAIXO DO CENTRO (opcional): texto complementar pequeno (16-18px) em #CCCCCC, alinhado à esquerda

RODAPÉ: linha horizontal dourada fina + "Franklim Paixão" em branco, 13px, alinhado à esquerda

━━━ REGRAS DE LAYOUT ━━━
• Mínimo 4 slides, máximo 8
• Slide 1: headline impactante/provocação (gancho)
• Slides 2-N: desenvolvimento, um ponto por slide — headline + detalhe curto
• Último slide: CTA forte — ex: "Salve este post. Compartilhe com quem precisa."
• Todo conteúdo alinhado à ESQUERDA (não centralizado)
• Padding interno: 36px laterais, 32px vertical
• Sem bordas arredondadas (border-radius: 0) — visual editorial/sério

━━━ EXEMPLO DE SLIDE HTML ━━━
<div class="slide">
  <div class="slide-inner">
    <div class="topic-bar">
      <span class="topic-label">| REFORMA TRIBUTÁRIA</span>
      <span class="slide-counter">1/6</span>
    </div>
    <div class="headline">A Reforma Tributária<br>NÃO é espaço para<br>"palpiteiro".</div>
    <div class="accent-bar"></div>
    <div class="subtitle">e seguir quem opina sem técnica<br>pode custar caro ao seu cliente.</div>
  </div>
  <div class="slide-footer">
    <div class="footer-line"></div>
    <span class="footer-name">Franklim Paixão</span>
  </div>
</div>

━━━ CSS BASE (use este exato CSS) ━━━
body { margin:0; background:#050505; display:flex; flex-direction:column; align-items:center; gap:16px; padding:24px; font-family:'Segoe UI',Arial,sans-serif; }
.slide { width:540px; height:540px; background:#0D0D0D; box-sizing:border-box; position:relative; overflow:hidden; display:flex; flex-direction:column; justify-content:space-between; padding:32px 36px; }
.slide-inner { display:flex; flex-direction:column; justify-content:center; flex:1; }
.topic-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:auto; padding-bottom:24px; }
.topic-label { color:#00C896; font-size:13px; font-weight:700; letter-spacing:2px; text-transform:uppercase; border-left:3px solid #00C896; padding-left:10px; }
.slide-counter { color:#FFFFFF; font-size:13px; font-weight:600; opacity:0.7; }
.headline { color:#FFFFFF; font-family:'Oswald','Impact','Arial Narrow',sans-serif; font-size:62px; font-weight:700; line-height:1.05; letter-spacing:-1px; margin-bottom:18px; }
.accent-bar { width:60px; height:4px; background:#C8A800; margin-bottom:20px; }
.subtitle { color:#CCCCCC; font-size:17px; line-height:1.6; max-width:420px; }
.slide-footer { border-top:1px solid #C8A800; padding-top:12px; margin-top:16px; }
.footer-name { color:#FFFFFF; font-size:13px; font-weight:600; letter-spacing:1px; }

RETORNE APENAS O HTML COMPLETO, sem explicações, no formato:
\`\`\`html
<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><style>
[CSS aqui]
</style></head><body>
[slides aqui]
</body></html>
\`\`\``,

  vera: `Você é Vera, revisora sênior de conteúdo para redes sociais com 15 anos de experiência em marketing contábil.

TAREFA: Analisar o conteúdo produzido e dar avaliação detalhada com score.

FORMATO OBRIGATÓRIO:

## 🏆 SCORE GERAL: [X.X]/10

| Critério | Nota | Comentário rápido |
|---|---|---|
| Clareza da mensagem | /10 | |
| Poder de engajamento | /10 | |
| Relevância para o nicho | /10 | |
| Força do CTA | /10 | |
| Gramática e ortografia | /10 | |

---
### ✅ Pontos Fortes
[lista com bullets]

### ⚠️ O que pode melhorar
[lista com bullets e sugestões específicas]

### 🔧 Ajustes sugeridos no texto
[trechos concretos para reescrever, se houver]

---
### 🏁 VEREDICTO FINAL
**[✅ APROVADO / ⚡ APROVADO COM AJUSTES / 🔄 REFAZER]**
[Justificativa em 2 linhas]`
};

/* ══════════════════════════════════════════
   SYSTEM PROMPTS DOS AGENTES
══════════════════════════════════════════ */
const AGENTS = {
  contabil: `Você é o LedgerAI, consultor contábil sênior brasileiro com 20+ anos de experiência.

ESPECIALIDADES:
• Escrituração contábil (Débito/Crédito, Razão, Balancete)
• DRE, Balanço Patrimonial, Fluxo de Caixa, DMPL
• SPED Contábil, ECF, ECD
• Normas CFC (NBC TGs), IFRS e CPC
• Contabilidade de custos e gerencial
• Abertura e encerramento de exercício

REGRAS:
1. Use linguagem técnica mas acessível
2. Cite a norma (NBC, CPC, Lei) quando relevante
3. Dê exemplos com lançamentos contábeis quando pertinente (D: / C:)
4. Seja objetivo: diagnóstico → fundamento → solução
5. Sempre responda em português do Brasil`,

  tributario: `Você é o FiscoAI, consultor tributário especialista brasileiro.

ESPECIALIDADES:
• Regimes: Simples Nacional, Lucro Presumido, Lucro Real
• Tributos federais: IRPJ, CSLL, PIS, COFINS, IPI, IOF
• Tributos estaduais/municipais: ICMS, ISS, IPTU, IPVA
• Reforma Tributária: IBS, CBS, IS (LC 68/2024 e EC 132/2023)
• Planejamento tributário lícito
• Obrigações acessórias: SPED, EFD, DCTF, PGDAS-D
• Benefícios fiscais e regimes especiais

REGRAS:
1. Cite sempre a legislação (Lei, Decreto, IN RFB, ADI)
2. Compare cenários tributários quando relevante
3. Alerte sobre riscos e prazos
4. Sempre responda em português do Brasil`,

  trabalhista: `Você é o FolhaAI, consultor trabalhista e previdenciário brasileiro.

ESPECIALIDADES:
• CLT completa: contrato, jornada, férias, 13°, FGTS, rescisão
• eSocial: eventos, leiautes, prazos e obrigações
• Folha de pagamento: cálculo, INSS, IRRF, descontos
• Pró-labore e distribuição de lucros
• Convenções coletivas e acordos sindicais
• CAGED, RAIS, SEFIP/GFIP
• SST: PCMSO, PPRA, PGR, CAT

REGRAS:
1. Cite artigos da CLT e Súmulas do TST
2. Dê cálculos exemplificados quando pedido
3. Destaque prazos críticos e multas
4. Sempre responda em português do Brasil`,

  societario: `Você é o NexusAI, consultor societário brasileiro.

ESPECIALIDADES:
• Tipos societários: MEI, EI, EIRELI, LTDA, SA, SCP, Holding
• Abertura: REDESIM, Junta Comercial, Receita Federal, Prefeitura
• Alterações: contrato social, capital social, sócios
• Encerramento: dissolução, liquidação, baixa
• Holding familiar: proteção patrimonial, sucessão, governança

REGRAS:
1. Explique o processo passo a passo
2. Cite documentos necessários
3. Informe prazos e custos estimados
4. Sempre responda em português do Brasil`,

  marketing: `Você é o GrowthAI, especialista em marketing para escritórios de contabilidade.

ESPECIALIDADES:
• Posicionamento: nicho, ICP, proposta de valor
• Captação digital: Google Ads, Meta Ads, LinkedIn
• Funil de vendas: atração → nutrição → conversão → retenção
• Social Selling: LinkedIn e Instagram (framework GS/NS/VS)
• Indicação e networking

REGRAS:
1. Seja direto e orientado a ação
2. Dê exemplos de copy, scripts e roteiros quando útil
3. Adapte para o mercado contábil brasileiro
4. Sempre responda em português do Brasil`,

  gestao: `Você é o GestorAI, especialista em gestão de escritórios contábeis.

ESPECIALIDADES:
• Precificação: por hora, por complexidade, por valor percebido
• Tabela de honorários e reajustes
• Gestão financeira: DRE do escritório, margem, ponto de equilíbrio
• KPIs: churn, ticket médio, NPS, produtividade
• Processos internos: onboarding, entrega, comunicação
• Tecnologia: automação, sistemas, IA no escritório

REGRAS:
1. Use dados e benchmarks do mercado contábil
2. Seja prático — solução aplicável amanhã
3. Sempre responda em português do Brasil`,

  post: `Você é o CopyAI, criador de conteúdo especializado para contadores.

ESPECIALIDADES:
• Posts para Instagram: carrossel, single, stories
• Posts para LinkedIn: artigo, post curto, enquete
• Copy para anúncios: headline, body, CTA
• E-mail marketing e WhatsApp

FORMATO:
• Entregue o texto COMPLETO pronto para publicar
• Inclua emojis estratégicos
• Sugira hashtags (Instagram)
• Para carrossel: numere cada slide

REGRAS:
1. Tom: profissional mas humano
2. Foco em valor → autoridade → CTA
3. Sempre responda em português do Brasil`
};

/* ══════════════════════════════════════════
   ROTAS — KNOWLEDGE BASE
══════════════════════════════════════════ */

// Upload de documento para knowledge base
app.post('/api/knowledge/:agentId', uploadKnowledge.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  res.json({ ok: true, filename: req.file.filename, size: req.file.size });
});

// Listar documentos do agente
app.get('/api/knowledge/:agentId', (req, res) => {
  const dir = path.join(KNOWLEDGE_DIR, req.params.agentId);
  if (!fs.existsSync(dir)) return res.json({ files: [] });

  const files = fs.readdirSync(dir)
    .filter(f => ['.pdf','.txt','.md','.docx'].includes(path.extname(f).toLowerCase()))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, size: stat.size, date: stat.mtime };
    });

  res.json({ files });
});

// Deletar documento
app.delete('/api/knowledge/:agentId/:filename', (req, res) => {
  const filePath = path.join(KNOWLEDGE_DIR, req.params.agentId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════
   ROTA — UPLOAD DE ANEXO NO CHAT
══════════════════════════════════════════ */
app.post('/api/upload', uploadChat.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  try {
    const text = await parseFile(req.file.path);
    // Apaga arquivo temporário
    fs.unlinkSync(req.file.path);
    res.json({
      ok        : true,
      filename  : req.file.originalname,
      text      : text.trim().slice(0, 15000) // max 15k chars
    });
  } catch(e) {
    res.status(500).json({ error: 'Erro ao processar arquivo: ' + e.message });
  }
});

/* ══════════════════════════════════════════
   PROMPTS PAC — PERFIL PAC INTELIGÊNCIA TRIBUTÁRIA
   Público: empresários de oficinas mecânicas e autopeças
   Cores: azul marinho (#0A1628) + laranja (#F97316)
══════════════════════════════════════════ */
const PIPELINE_AGENTS_PAC = {
  sofia: `Você é Sofia, estrategista de conteúdo da PAC Inteligência Tributária — escritório de contabilidade nichado em oficinas mecânicas e lojas de autopeças.

PÚBLICO-ALVO: Donos de oficinas mecânicas e lojas de autopeças (não contadores). São pessoas práticas, que trabalham com as mãos, desconfiam de "papo de contador" e precisam de linguagem direta e concreta.

TAREFA: Dado um tema/pauta, gere EXATAMENTE 5 ângulos criativos e distintos para posts que falem DIRETAMENTE com esses empresários.

FORMATO OBRIGATÓRIO:
**ÂNGULO 1 — [Nome curto e impactante]**
[2-3 linhas: abordagem, tom, diferencial e por que vai engajar o dono de oficina/autopeças]

**ÂNGULO 2 — [Nome]**
[descrição]

(repita até ÂNGULO 5)

CRITÉRIOS:
• Falar a língua do empresário do setor automotivo — direto, sem jargão contábil excessivo
• Ângulos que gerem medo, curiosidade, identificação ou alívio
• Varie entre: alerta de risco, oportunidade escondida, erro comum, história real, comparativo
• Tom: prático, urgente, cúmplice — como um parceiro de negócios falando a verdade`,

  carlos: `Você é Carlos, copywriter especialista em conteúdo para donos de oficinas mecânicas e lojas de autopeças da PAC Inteligência Tributária.

PÚBLICO: Dono de oficina ou autopeças. Homem, 35-55 anos, prático, sem tempo a perder, desconfia de político e de "enrolação". Entende de carro, não de tributo. Medo: pagar mais imposto, tomar multa, perder dinheiro sem entender por quê.

VOZ DA PAC: Parceiro que entende do setor. Fala direto. Usa analogia do mundo automotivo. Nunca condescendente. Sempre do lado do empresário.

TAREFA: Com base no ângulo e pauta, escreva o copy COMPLETO do post.

FORMATO OBRIGATÓRIO — retorne EXATAMENTE nesta estrutura:

---COPY---
[APENAS o texto do post. Linguagem direta, emojis estratégicos (🔧⚙️🚗💰⚠️), analogias do universo mecânico/automotivo, CTA forte no final. SEM títulos, SEM labels, SEM metadados.]
---HASHTAGS---
[apenas hashtags começando com #, máximo 25, mix de nicho + tributo + regional]
---FIM---

REGRAS ABSOLUTAS:
• Proibido jargão técnico sem explicação imediata
• Toda regra tributária vira consequência prática pro negócio
• Use analogias: "assim como trocar o óleo antes de fundir o motor..."
• CTA sempre concreto: comentar, salvar, entrar em contato
• PROIBIDO qualquer texto fora das marcações acima`,

  davi: `Você é Davi, designer front-end da PAC Inteligência Tributária — escritório nichado em oficinas mecânicas e autopeças.

TAREFA: Criar slides HTML para carrossel do Instagram com identidade visual da PAC.

━━━ IDENTIDADE VISUAL PAC (OBRIGATÓRIO) ━━━
• Fundo principal: #0A1628 (azul marinho profundo)
• Acento LARANJA: #F97316 — barra vertical do label, destaques, CTAs
• Acento AZUL MÉDIO: #1E4A8A — backgrounds secundários, separadores
• Texto headline: #FFFFFF bold, fonte condensada pesada
• Texto secundário: #CBD5E1 (cinza azulado claro)
• Rodapé fixo: "PAC Inteligência Tributária" em branco com ícone 🔧
• Fonte headline: 'Oswald', 'Impact', 'Arial Narrow', sans-serif
• Fonte corpo: 'Segoe UI', Arial, sans-serif

━━━ ESTRUTURA DE CADA SLIDE ━━━
TOPO: barra vertical LARANJA à esquerda + label do tema em laranja uppercase + contador (ex: 1/6) à direita em branco
CENTRO: headline grande (52-68px), branco, bold, alinhado à esquerda
ACENTO: barra horizontal LARANJA (#F97316), 60px × 4px, abaixo do headline
CORPO (opcional): texto complementar em #CBD5E1, 16-18px
RODAPÉ: linha fina laranja + "PAC Inteligência Tributária 🔧" em branco, 12px

━━━ REGRAS ━━━
• Mínimo 4 slides, máximo 8
• Slide 1: provocação/alerta forte para o empresário
• Slides 2-N: desenvolvimento prático, um ponto por slide
• Último slide: CTA claro (comentar, salvar, entrar em contato)
• Layout 100% alinhado à ESQUERDA, editorial, sem border-radius
• Padding: 36px laterais, 32px vertical

━━━ CSS BASE ━━━
body{margin:0;background:#060E1A;display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px;font-family:'Segoe UI',Arial,sans-serif;}
.slide{width:540px;height:540px;background:#0A1628;box-sizing:border-box;position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;padding:32px 36px;}
.slide-inner{display:flex;flex-direction:column;justify-content:center;flex:1;}
.topic-bar{display:flex;justify-content:space-between;align-items:center;padding-bottom:24px;}
.topic-label{color:#F97316;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-left:3px solid #F97316;padding-left:10px;}
.slide-counter{color:#FFFFFF;font-size:13px;font-weight:600;opacity:0.6;}
.headline{color:#FFFFFF;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:60px;font-weight:700;line-height:1.05;letter-spacing:-1px;margin-bottom:16px;}
.accent-bar{width:60px;height:4px;background:#F97316;margin-bottom:18px;}
.subtitle{color:#CBD5E1;font-size:17px;line-height:1.6;max-width:420px;}
.slide-footer{border-top:1px solid #F97316;padding-top:10px;margin-top:12px;}
.footer-name{color:#FFFFFF;font-size:12px;font-weight:600;letter-spacing:1px;}

RETORNE APENAS O HTML COMPLETO, sem explicações:
\`\`\`html
<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><style>[CSS]</style></head><body>[slides]</body></html>
\`\`\``,

  vera: PIPELINE_AGENTS.vera
};

/* ══════════════════════════════════════════
   ROTA — PIPELINE DE CONTEÚDO
   Davi usa Gemini · demais usam Claude
   profile: 'franklim' (default) | 'pac'
══════════════════════════════════════════ */
app.post('/api/pipeline/:agent', async (req, res) => {
  const { agent }              = req.params;
  const { messages, profile }  = req.body;

  const agentMap  = profile === 'pac' ? PIPELINE_AGENTS_PAC : PIPELINE_AGENTS;
  const systemPrompt = agentMap[agent];
  if (!systemPrompt) return res.status(400).json({ error: 'Agente de pipeline inválido.' });

  try {

    /* ── DAVI → Gemini (com fallback para Claude) ── */
    if (agent === 'davi') {
      const hasGemini = process.env.GEMINI_API_KEY &&
                        process.env.GEMINI_API_KEY !== 'sua_gemini_key_aqui';

      if (hasGemini) {
        try {
          const model = gemini.getGenerativeModel({
            model            : 'gemini-2.0-flash',
            systemInstruction: systemPrompt,
            generationConfig : { maxOutputTokens: 8192, temperature: 0.7 }
          });

          // Monta histórico no formato Gemini (role: user | model)
          const history = messages.slice(0, -1).map(m => ({
            role : m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          }));

          const chat   = model.startChat({ history });
          const last   = messages[messages.length - 1];
          const result = await chat.sendMessage(last.content);
          const reply  = result.response.text();

          console.log(`✨ Davi (Gemini 2.0 Flash) — ${reply.length} chars`);
          return res.json({ reply, engine: 'gemini-2.0-flash' });
        } catch (geminiErr) {
          const isQuota = geminiErr.message && (
            geminiErr.message.includes('429') ||
            geminiErr.message.includes('quota') ||
            geminiErr.message.includes('Too Many Requests')
          );
          console.warn(`⚠️  Gemini falhou (${isQuota ? 'quota' : 'erro'}): usando Claude como fallback`);
          // Cai para Claude abaixo
        }
      }

      // Fallback: Claude gera os slides HTML
      const fallbackResp = await claude.messages.create({
        model     : 'claude-opus-4-5',
        max_tokens: 8192,
        system    : systemPrompt,
        messages  : messages.map(m => ({ role: m.role, content: m.content }))
      });
      console.log(`✨ Davi (Claude fallback) — ${fallbackResp.content[0].text.length} chars`);
      return res.json({ reply: fallbackResp.content[0].text, engine: 'claude-fallback' });
    }

    /* ── Demais agentes → Claude ────────────── */
    const response = await claude.messages.create({
      model     : 'claude-opus-4-5',
      max_tokens: 4096,
      system    : systemPrompt,
      messages  : messages.map(m => ({ role: m.role, content: m.content }))
    });

    res.json({ reply: response.content[0].text, engine: 'claude-opus-4-5' });

  } catch(err) {
    console.error(`Pipeline [${agent}] error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   ROTA — CHAT
══════════════════════════════════════════ */
app.post('/api/chat', async (req, res) => {
  const { agentId, messages } = req.body;

  if (!agentId || !AGENTS[agentId])
    return res.status(400).json({ error: 'Agente inválido.' });

  try {
    // Carrega base de conhecimento do agente
    const knowledge = await loadKnowledge(agentId);
    const systemPrompt = AGENTS[agentId] + knowledge;

    const response = await client.messages.create({
      model     : 'claude-opus-4-5',
      max_tokens: 2048,
      system    : systemPrompt,
      messages  : messages.map(m => ({ role: m.role, content: m.content }))
    });

    res.json({ reply: response.content[0].text });
  } catch(err) {
    console.error('Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   INSTAGRAM — CONFIGURAÇÕES
══════════════════════════════════════════ */
// GET /api/instagram/diagnose — descobre o Instagram Business Account ID correto
app.get('/api/instagram/diagnose', async (req, res) => {
  const cfg = ig.readConfig();
  if (!cfg.accessToken) return res.status(400).json({ error: 'Token não configurado.' });

  const token      = cfg.accessToken;
  const FB_BASE    = 'https://graph.facebook.com/v22.0';
  const IG_BASE    = 'https://graph.instagram.com/v22.0';
  const isIgToken  = token.startsWith('IGAAN') || token.startsWith('IGQV') || token.startsWith('IGQ');

  const results = { token_type: isIgToken ? 'Instagram Token (IGAAN)' : 'Facebook Token (EAA)', instagram_accounts: [], pages: [], recommendation: '' };

  try {
    // ── CAMINHO 1: Token Instagram (IGAAN) — usa graph.instagram.com ──
    if (isIgToken) {
      // /me retorna o usuário IG diretamente
      const r1 = await fetch(`${IG_BASE}/me?fields=id,name,username,account_type&access_token=${token}`);
      const d1 = await r1.json();
      results.ig_me = d1;

      if (d1.id && !d1.error) {
        results.instagram_accounts.push({ id: d1.id, username: d1.username, name: d1.name, account_type: d1.account_type, source: 'graph.instagram.com/me' });
      }

      // Tenta também pelo FB Graph com o mesmo token
      const r2 = await fetch(`${FB_BASE}/me?fields=id,name&access_token=${token}`);
      const d2 = await r2.json();
      results.fb_me = d2;

      // Se tiver ID no FB, tenta buscar páginas e IG vinculado
      if (d2.id && !d2.error) {
        const r3 = await fetch(`${FB_BASE}/${d2.id}/accounts?fields=id,name,instagram_business_account{id,name,username}&access_token=${token}`);
        const d3 = await r3.json();
        results.fb_pages_raw = d3;

        if (d3.data?.length > 0) {
          for (const page of d3.data) {
            if (page.instagram_business_account?.id) {
              const iga = page.instagram_business_account;
              results.instagram_accounts.push({ id: iga.id, username: iga.username, name: iga.name, source: `página FB: ${page.name}` });
              results.pages.push({ fb_page_id: page.id, fb_page_name: page.name, ig_id: iga.id, ig_username: iga.username });
            }
          }
        }
      }
    }

    // ── CAMINHO 2: Token Facebook (EAA) — fluxo clássico ──
    if (!isIgToken) {
      const r1 = await fetch(`${FB_BASE}/me?fields=id,name&access_token=${token}`);
      const d1 = await r1.json();
      results.fb_me = d1;

      const r2 = await fetch(`${FB_BASE}/me/accounts?fields=id,name,instagram_business_account{id,name,username}&access_token=${token}`);
      const d2 = await r2.json();
      results.fb_pages_raw = d2;

      if (d2.data?.length > 0) {
        for (const page of d2.data) {
          if (page.instagram_business_account?.id) {
            const iga = page.instagram_business_account;
            results.instagram_accounts.push({ id: iga.id, username: iga.username, name: iga.name, source: `página FB: ${page.name}` });
            results.pages.push({ fb_page_id: page.id, fb_page_name: page.name, ig_id: iga.id, ig_username: iga.username });
          }
        }
      }
    }

    // ── Recomendação final ──
    if (results.instagram_accounts.length > 0) {
      const acc = results.instagram_accounts[0];
      results.recommendation = `ID correto: ${acc.id} (@${acc.username || acc.name})`;
      results.correct_ig_user_id = acc.id;
    } else {
      results.recommendation = isIgToken
        ? `Token Instagram detectado. ID retornado pelo /me: ${results.ig_me?.id || 'não encontrado'}. Tente usar este ID diretamente.`
        : 'Nenhuma conta IG Business encontrada via páginas FB. Tente vincular a conta no Configurações do Instagram → Conta → Conectar ao Facebook.';

      // Para token IG, o próprio ID do /me pode ser o correto
      if (isIgToken && results.ig_me?.id && !results.ig_me?.error) {
        results.correct_ig_user_id = results.ig_me.id;
        results.instagram_accounts.push({ id: results.ig_me.id, username: results.ig_me.username, name: results.ig_me.name, source: 'graph.instagram.com/me (fallback)' });
      }
    }

    res.json({ ok: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/instagram/config', (req, res) => {
  const cfg = ig.readConfig();
  // Nunca retorna o token/secret completos — apenas indica se estão configurados
  res.json({
    igUserId      : cfg.igUserId || '',
    appId         : cfg.appId || '',
    imgbbApiKey   : cfg.imgbbApiKey || '',
    hasToken      : !!(cfg.accessToken),
    hasSecret     : !!(cfg.appSecret),
    tokenExpiresAt: cfg.tokenExpiresAt || null
  });
});

app.post('/api/instagram/config', (req, res) => {
  const { accessToken, igUserId, appId, appSecret, imgbbApiKey } = req.body;
  const existing = ig.readConfig();
  const merged   = {
    accessToken   : accessToken   || existing.accessToken   || '',
    igUserId      : igUserId      || existing.igUserId      || '',
    appId         : appId         || existing.appId         || '',
    appSecret     : appSecret     || existing.appSecret     || '',
    imgbbApiKey   : imgbbApiKey   || existing.imgbbApiKey   || '',
    tokenExpiresAt: existing.tokenExpiresAt || (Date.now() + 60 * 24 * 3600 * 1000)
  };
  if (!merged.accessToken || !merged.igUserId || !merged.imgbbApiKey) {
    return res.status(400).json({ error: 'Access Token, Instagram User ID e Imgbb API Key são obrigatórios.' });
  }
  ig.writeConfig(merged);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════
   INSTAGRAM — PUBLICAÇÃO IMEDIATA
══════════════════════════════════════════ */
app.post('/api/instagram/publish', async (req, res) => {
  const { images, caption } = req.body;

  if (!Array.isArray(images) || images.length < 2) {
    return res.status(400).json({ error: 'Mínimo 2 slides para publicar no carrossel.' });
  }
  if (images.length > 10) {
    return res.status(400).json({ error: 'Máximo 10 slides por carrossel.' });
  }

  const cfg = ig.readConfig();
  if (!cfg.accessToken || !cfg.igUserId || !cfg.imgbbApiKey) {
    return res.status(400).json({ error: 'Instagram não configurado. Acesse ⚙️ Configurar Instagram.' });
  }

  try {
    const result = await ig.publishCarouselNow({
      images,
      caption: (caption || '').slice(0, 2200),
      igUserId    : cfg.igUserId,
      accessToken : cfg.accessToken,
      imgbbApiKey : cfg.imgbbApiKey
    });
    res.json({ ok: true, postId: result.postId, imageUrls: result.imageUrls });
  } catch (err) {
    console.error('Instagram publish error:', err.message);
    if (err.code === 'TOKEN_EXPIRED') return res.status(401).json({ error: 'Token expirado. Atualize o Access Token nas configurações.' });
    if (err.code === 'RATE_LIMIT')   return res.status(429).json({ error: 'Limite de publicações atingido. Tente novamente mais tarde.' });
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   INSTAGRAM — AGENDAMENTO
══════════════════════════════════════════ */
app.post('/api/instagram/schedule', (req, res) => {
  const { images, caption, scheduledTime } = req.body;

  if (!Array.isArray(images) || images.length < 2) {
    return res.status(400).json({ error: 'Mínimo 2 slides para agendar.' });
  }
  if (!scheduledTime) {
    return res.status(400).json({ error: 'scheduledTime é obrigatório.' });
  }
  const scheduledDate = new Date(scheduledTime);
  if (scheduledDate <= new Date(Date.now() + 4 * 60 * 1000)) {
    return res.status(400).json({ error: 'Horário deve ser pelo menos 5 minutos no futuro.' });
  }

  const cfg = ig.readConfig();
  if (!cfg.accessToken || !cfg.igUserId || !cfg.imgbbApiKey) {
    return res.status(400).json({ error: 'Instagram não configurado. Acesse ⚙️ Configurar Instagram.' });
  }

  const job = {
    id           : crypto.randomUUID(),
    scheduledTime: scheduledDate.toISOString(),
    images,
    caption      : (caption || '').slice(0, 2200),
    igUserId     : cfg.igUserId,
    accessToken  : cfg.accessToken,
    imgbbApiKey  : cfg.imgbbApiKey,
    status       : 'pending',
    createdAt    : new Date().toISOString()
  };

  const scheduled = ig.readScheduled();
  scheduled.push(job);
  ig.writeScheduled(scheduled);
  ig.registerCronJob(job);

  res.json({ ok: true, id: job.id, scheduledTime: job.scheduledTime });
});

app.get('/api/instagram/scheduled', (req, res) => {
  const jobs = ig.readScheduled().map(j => ({
    id           : j.id,
    scheduledTime: j.scheduledTime,
    status       : j.status,
    createdAt    : j.createdAt,
    publishedAt  : j.publishedAt,
    error        : j.error,
    slideCount   : j.images ? j.images.length : 0
    // Omite o campo 'images' (base64 pesado) e 'accessToken'
  }));
  res.json({ jobs });
});

app.delete('/api/instagram/scheduled/:id', (req, res) => {
  const { id } = req.params;
  const scheduled = ig.readScheduled();
  const idx = scheduled.findIndex(j => j.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Job não encontrado.' });

  ig.cancelCronJob(id);
  scheduled.splice(idx, 1);
  ig.writeScheduled(scheduled);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════
   ANA — CRIADORA DE CONTEÚDO PARA VÍDEOS
══════════════════════════════════════════ */
const ANA_PROMPTS = {
  franklim: `Você é Ana, especialista em criação de conteúdo para vídeos curtos (Reels, TikTok, YouTube Shorts) para o Franklim Paixão — contador especialista em Reforma Tributária (IBS/CBS) e IA para contadores.

Público-alvo: contadores, sócios de escritórios contábeis, profissionais da área fiscal.
Tom: autoridade + acessibilidade. Fala direta, sem enrolação, com exemplos práticos. Primeira pessoa (como se fosse o Franklim falando).

Ao receber um tema, gere EXATAMENTE neste formato:

---GANCHO---
[Uma frase de impacto para os primeiros 3-5 segundos. Deve PARAR o scroll. Pode ser uma pergunta provocativa, uma afirmação chocante, um dado surpreendente ou uma promessa direta. Máx. 2 linhas.]
---ROTEIRO---
[Script completo para falar no vídeo. Linguagem natural e coloquial — como se estivesse explicando para um amigo contador. Estrutura: abertura que confirma o gancho → 2-3 pontos principais desenvolvidos → chamada para ação (salvar, seguir, comentar ou DM). Duração: 60-90 segundos de fala. Use marcações como [PAUSA], [EXEMPLO:] para orientar a gravação.]
---LEGENDA---
[Legenda completa para Instagram. Parágrafos curtos (máx. 3 linhas cada), emojis estratégicos, CTA no final, hashtags na última linha. Máx. 2200 caracteres. NÃO inclua HORÁRIO, TIPO ou DICA VISUAL — apenas copy + hashtags.]
---FIM---`,

  pac: `Você é Ana, especialista em criação de conteúdo para vídeos curtos (Reels, TikTok, YouTube Shorts) para a PAC Inteligência Tributária — escritório contábil especializado em oficinas mecânicas e autopeças.

Público-alvo: donos de oficinas mecânicas, lojas de autopeças, empreendedores do setor automotivo.
Tom: direto, linguagem de empresário, sem juridiquês. Foco em dinheiro, gestão e sobrevivência do negócio.

Ao receber um tema, gere EXATAMENTE neste formato:

---GANCHO---
[Uma frase de impacto para os primeiros 3-5 segundos. Foco em dinheiro, imposto ou gestão. Ex: "Sua oficina está pagando imposto a mais todo mês." Máx. 2 linhas.]
---ROTEIRO---
[Script completo para falar no vídeo. Linguagem simples e direta — como se estivesse falando com o dono da oficina no balcão. Estrutura: gancho confirmado → problema que o empresário sente → solução prática → CTA. Duração: 60-90 segundos. Use [PAUSA], [EXEMPLO:] para orientar.]
---LEGENDA---
[Legenda completa para Instagram. Linguagem de empresário, parágrafos curtos, emojis práticos, CTA direto no final, hashtags. Máx. 2200 caracteres. Apenas copy + hashtags.]
---FIM---`
};

app.post('/api/ana/gerar', async (req, res) => {
  const { tema, profile, extras } = req.body;
  if (!tema || !tema.trim()) return res.status(400).json({ error: 'Informe o tema do vídeo.' });

  const systemPrompt = ANA_PROMPTS[profile] || ANA_PROMPTS.franklim;
  const userMsg = `Tema do vídeo: ${tema.trim()}${extras ? `\n\nDetalhes adicionais: ${extras.trim()}` : ''}`;

  try {
    const response = await claude.messages.create({
      model     : 'claude-opus-4-5',
      max_tokens: 2048,
      system    : systemPrompt,
      messages  : [{ role: 'user', content: userMsg }]
    });

    const raw = response.content[0].text;

    // Extrai os 3 blocos
    const gancho  = (raw.match(/---GANCHO---\s*([\s\S]*?)---ROTEIRO---/i)  || [])[1]?.trim() || '';
    const roteiro = (raw.match(/---ROTEIRO---\s*([\s\S]*?)---LEGENDA---/i) || [])[1]?.trim() || '';
    const legenda = (raw.match(/---LEGENDA---\s*([\s\S]*?)---FIM---/i)     || [])[1]?.trim() || '';

    res.json({ ok: true, gancho, roteiro, legenda, raw });
  } catch (err) {
    console.error('Ana erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   INSTAGRAM — AUTO-RESPONDER (Bia)
══════════════════════════════════════════ */

// GET  /api/instagram/autoresponder — lê config
app.get('/api/instagram/autoresponder', (req, res) => {
  res.json(ig.readAutoResponderConfig());
});

// POST /api/instagram/autoresponder — salva config (sem reiniciar)
app.post('/api/instagram/autoresponder', (req, res) => {
  const existing = ig.readAutoResponderConfig();
  const merged   = { ...existing, ...req.body };
  ig.writeAutoResponderConfig(merged);
  res.json({ ok: true });
});

// POST /api/instagram/autoresponder/toggle — liga/desliga
app.post('/api/instagram/autoresponder/toggle', (req, res) => {
  const cfg = ig.readAutoResponderConfig();
  cfg.enabled = !cfg.enabled;
  ig.writeAutoResponderConfig(cfg);
  if (cfg.enabled) {
    ig.startAutoResponder(claude);
  } else {
    ig.stopAutoResponder();
  }
  res.json({ ok: true, enabled: cfg.enabled });
});

// GET /api/instagram/autoresponder/log — histórico de respostas
app.get('/api/instagram/autoresponder/log', (req, res) => {
  res.json({ log: ig.readArLog() });
});

// GET /api/instagram/posts — lista posts recentes
app.get('/api/instagram/posts', async (req, res) => {
  try {
    const cfg = ig.readConfig();
    if (!cfg.accessToken) return res.status(400).json({ error: 'Instagram não configurado.' });
    const posts = await ig.fetchRecentPosts(cfg.igUserId, cfg.accessToken);
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/instagram/comments/:mediaId — lista comentários de um post
app.get('/api/instagram/comments/:mediaId', async (req, res) => {
  try {
    const cfg = ig.readConfig();
    if (!cfg.accessToken) return res.status(400).json({ error: 'Instagram não configurado.' });
    const comments = await ig.fetchComments(req.params.mediaId, cfg.accessToken);
    res.json(comments);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════
   INSTAGRAM — GATILHOS (Triggers)
══════════════════════════════════════════ */

// GET /api/instagram/triggers
app.get('/api/instagram/triggers', (req, res) => {
  res.json({ triggers: ig.readTriggers() });
});

// POST /api/instagram/triggers — criar novo gatilho
app.post('/api/instagram/triggers', (req, res) => {
  const { keywords, responseType, fixedResponse, aiInstruction, label } = req.body;
  if (!keywords || !keywords.length) return res.status(400).json({ error: 'Informe ao menos uma palavra-chave.' });
  if (responseType === 'fixed' && !fixedResponse) return res.status(400).json({ error: 'Informe a resposta fixa.' });

  const triggers = ig.readTriggers();
  const trigger  = {
    id          : crypto.randomUUID(),
    label       : label || keywords[0],
    keywords    : Array.isArray(keywords) ? keywords : [keywords],
    responseType: responseType || 'ai',
    fixedResponse: fixedResponse || '',
    aiInstruction: aiInstruction || '',
    enabled     : true,
    hitCount    : 0,
    createdAt   : new Date().toISOString()
  };
  triggers.push(trigger);
  ig.writeTriggers(triggers);
  res.json({ ok: true, trigger });
});

// PUT /api/instagram/triggers/:id — atualizar
app.put('/api/instagram/triggers/:id', (req, res) => {
  const triggers = ig.readTriggers();
  const idx = triggers.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Gatilho não encontrado.' });
  triggers[idx] = { ...triggers[idx], ...req.body, id: req.params.id };
  ig.writeTriggers(triggers);
  res.json({ ok: true, trigger: triggers[idx] });
});

// DELETE /api/instagram/triggers/:id
app.delete('/api/instagram/triggers/:id', (req, res) => {
  const triggers = ig.readTriggers();
  const idx = triggers.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Gatilho não encontrado.' });
  triggers.splice(idx, 1);
  ig.writeTriggers(triggers);
  res.json({ ok: true });
});

/* ══════════════════════════════════════════
   MÓDULO PROPOSTA COMERCIAL + PRECIFICAÇÃO
══════════════════════════════════════════ */
const PROPOSTA_SYSTEM = `Você é o PropostaAI, especialista em vendas e precificação para escritórios de contabilidade brasileiros.

Você conhece profundamente:
- Serviços contábeis: honorários de mercado por porte e regime
- CFC: tabela de honorários mínimos sugeridos
- Dinâmica de vendas B2B para contadores
- Argumentos de valor vs preço no mercado contábil
- Estrutura de propostas comerciais que convertem

Sempre entregue conteúdo pronto para usar, sem precisar de edição massiva.`;

// POST /api/proposta/gerar
app.post('/api/proposta/gerar', async (req, res) => {
  try {
    const {
      nomeEscritorio, nomeProspect, segmento, regime,
      porte, funcionarios, faturamento, servicos,
      dores, diferenciais, prazo, cidade
    } = req.body;

    if (!nomeProspect || !servicos) {
      return res.status(400).json({ error: 'Informe ao menos o nome do prospect e os serviços.' });
    }

    const prompt = `Crie uma proposta comercial completa e profissional para escritório de contabilidade:

**ESCRITÓRIO:** ${nomeEscritorio || 'Escritório de Contabilidade'}
**PROSPECT:** ${nomeProspect}
**CIDADE:** ${cidade || 'Brasil'}
**SEGMENTO DO CLIENTE:** ${segmento || 'Não informado'}
**REGIME TRIBUTÁRIO:** ${regime || 'A definir'}
**PORTE:** ${porte || 'Pequena empresa'}
**Nº FUNCIONÁRIOS:** ${funcionarios || 'Não informado'}
**FATURAMENTO MENSAL ESTIMADO:** ${faturamento || 'Não informado'}
**SERVIÇOS SOLICITADOS:** ${servicos}
**DORES/PROBLEMAS RELATADOS:** ${dores || 'Não informado'}
**DIFERENCIAIS DO ESCRITÓRIO:** ${diferenciais || 'Equipe especializada, atendimento próximo, uso de tecnologia'}
**PRAZO PARA RESPOSTA:** ${prazo || '5 dias úteis'}

Gere a proposta com esta estrutura:

---

# PROPOSTA COMERCIAL DE SERVIÇOS CONTÁBEIS
**${nomeEscritorio || 'Escritório de Contabilidade'}**
*Apresentada a: ${nomeProspect}*
*Data: ${new Date().toLocaleDateString('pt-BR')}*

---

## 1. ENTENDEMOS O SEU DESAFIO
[2-3 parágrafos mostrando que entendemos as dores relatadas e o contexto do negócio. Empatia + autoridade.]

## 2. NOSSA PROPOSTA DE VALOR
[Por que o escritório é a escolha certa. Diferencial concreto, não genérico.]

## 3. ESCOPO DE SERVIÇOS
[Tabela detalhada com cada serviço, o que está incluído e a frequência]

| Serviço | Descrição | Periodicidade |
|---------|-----------|---------------|
| ...     | ...       | ...           |

## 4. INVESTIMENTO
[Valor mensal sugerido com base no mercado para o perfil do cliente, justificativa de valor. Se puder, apresente 2-3 opções de pacote (Essencial / Completo / Premium)]

## 5. O QUE VOCÊ GANHA
[Bullets concretos: economia de tempo, segurança fiscal, decisões mais rápidas, etc.]

## 6. PRÓXIMOS PASSOS
[Processo claro: reunião → contrato → onboarding → prazo de início]

## 7. VALIDADE E CONDIÇÕES
[Validade da proposta, forma de pagamento, reajuste anual]

---

*Proposta elaborada com carinho por ${nomeEscritorio || 'nosso escritório'}. Estamos à disposição para esclarecer qualquer dúvida.*`;

    const response = await claude.messages.create({
      model: 'claude-opus-4-5', max_tokens: 4096,
      system: PROPOSTA_SYSTEM,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ ok: true, proposta: response.content[0].text });
  } catch (err) {
    console.error('Erro proposta:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proposta/precificar
app.post('/api/proposta/precificar', async (req, res) => {
  try {
    const {
      regime, porte, funcionarios, faturamento,
      segmento, servicos, cidade, complexidade
    } = req.body;

    if (!regime || !servicos) {
      return res.status(400).json({ error: 'Informe o regime e os serviços para precificar.' });
    }

    const prompt = `Faça uma análise de precificação detalhada para este cliente de escritório contábil:

**PERFIL DO CLIENTE:**
- Regime: ${regime}
- Porte: ${porte || 'Pequena empresa'}
- Funcionários: ${funcionarios || 'Não informado'}
- Faturamento mensal: ${faturamento || 'Não informado'}
- Segmento: ${segmento || 'Não informado'}
- Cidade/UF: ${cidade || 'Brasil'}
- Complexidade percebida: ${complexidade || 'Média'}

**SERVIÇOS A PRECIFICAR:**
${servicos}

Entregue a análise com:

## 💰 HONORÁRIOS RECOMENDADOS

### Valor Sugerido: R$ X.XXX,00/mês
[Justificativa clara em 2-3 linhas]

### Opções de Pacote
| Pacote | O que inclui | Valor/mês |
|--------|-------------|-----------|
| Essencial | ... | R$ |
| Completo | ... | R$ |
| Premium | ... | R$ |

## 📊 REFERÊNCIA DE MERCADO
Como este valor se posiciona em relação ao mercado (abaixo, na média, acima) e por quê o preço sugerido é justo para ambos os lados.

## 🧮 CUSTO-HORA IMPLÍCITO
Estimativa de horas mensais necessárias para atender este cliente e qual seria o custo-hora resultante.

## ⚠️ FATORES DE RISCO PARA O PREÇO
O que pode tornar este cliente mais trabalhoso do que o esperado (e justificar reajuste):
- Nível de organização dos documentos
- Histórico de atrasos na entrega
- Complexidade fiscal do segmento
- Movimentação financeira alta

## 📈 ESTRATÉGIA DE REAJUSTE
Como e quando propor reajuste. Gatilhos para revisão de contrato.

## 💡 ARGUMENTO PARA OBJEÇÃO DE PREÇO
Script pronto para quando o cliente disser "está caro":
> "[texto pronto para o contador usar]"`;

    const response = await claude.messages.create({
      model: 'claude-opus-4-5', max_tokens: 3000,
      system: PROPOSTA_SYSTEM,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ ok: true, precificacao: response.content[0].text });
  } catch (err) {
    console.error('Erro precificação:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   MÓDULO RELATÓRIO GERENCIAL
══════════════════════════════════════════ */
const uploadRelatorio = multer({
  storage: chatStorage,
  limits : { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok  = ['.pdf', '.xlsx', '.xls', '.csv', '.txt', '.docx'].includes(ext);
    cb(ok ? null : new Error('Formatos aceitos: PDF, Excel, CSV, TXT, DOCX'), ok);
  }
});

async function parseRelatorioFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    const XLSX = require('xlsx');
    const wb   = XLSX.readFile(filePath);
    let text   = '';
    for (const sheetName of wb.SheetNames) {
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      text += `\n--- ABA: ${sheetName} ---\n`;
      text += rows.map(r => r.join('\t')).join('\n');
    }
    return text.trim();
  }

  if (ext === '.csv') {
    return fs.readFileSync(filePath, 'utf8');
  }

  // PDF, DOCX, TXT — reusa parser existente
  return await parseFile(filePath);
}

const RELATORIO_SYSTEM = `Você é o RelatorAI, especialista em análise financeira e contábil para escritórios de contabilidade brasileiros.

Sua função é transformar dados brutos de DRE, Balancete ou Balanço Patrimonial em relatórios gerenciais profissionais e acessíveis.

Ao analisar dados financeiros:
1. Identifique tendências, variações relevantes (>10%) e anomalias
2. Compare períodos quando disponível
3. Calcule indicadores: Margem Bruta, Margem Líquida, Liquidez, Endividamento
4. Use linguagem executiva — clara para o empresário, não só para o contador
5. Sempre contextualize os números com impacto prático no negócio
6. Aponte riscos e oportunidades de forma objetiva
7. Formate com seções bem definidas usando markdown`;

const TIPOS_RELATORIO = {
  dre: {
    nome: 'DRE — Demonstração do Resultado',
    prompt: (dados, empresa, periodo, segmento) => `Analise esta DRE e gere um relatório gerencial completo:

**Empresa:** ${empresa || 'Não informado'}
**Período:** ${periodo || 'Não informado'}
**Segmento:** ${segmento || 'Não informado'}

**DADOS DA DRE:**
${dados}

Gere o relatório com estas seções:

## 📊 RESUMO EXECUTIVO
Síntese em 4-5 linhas do resultado do período. Linguagem para o empresário.

## 💰 ANÁLISE DE RECEITAS
Evolução das receitas, variações, concentração, sazonalidade identificada.

## 📉 CUSTOS E DESPESAS
Análise dos principais custos, participação % na receita, variações relevantes.

## 📈 INDICADORES DE PERFORMANCE
- Receita Bruta / Líquida
- Lucro Bruto e Margem Bruta (%)
- EBITDA estimado
- Lucro Líquido e Margem Líquida (%)
- Variação vs período anterior (se disponível)

## ⚠️ PONTOS DE ATENÇÃO
Riscos identificados nos dados: crescimento de despesas, queda de margem, inadimplência, sazonalidade negativa.

## 💡 OPORTUNIDADES E RECOMENDAÇÕES
Ações concretas e prioritárias que o empresário deve tomar com base nesta análise.

## 📝 MENSAGEM PARA O CLIENTE
Parágrafo de encaminhamento que o contador pode copiar e enviar ao cliente junto com o relatório.`
  },

  balancete: {
    nome: 'Balancete / Balanço Patrimonial',
    prompt: (dados, empresa, periodo, segmento) => `Analise este Balancete/Balanço e gere relatório gerencial:

**Empresa:** ${empresa || 'Não informado'}
**Período:** ${periodo || 'Não informado'}
**Segmento:** ${segmento || 'Não informado'}

**DADOS:**
${dados}

Gere o relatório com:

## 📊 RESUMO EXECUTIVO
Saúde financeira geral da empresa em 4-5 linhas objetivas.

## 🏦 ANÁLISE DO ATIVO
- Ativo Circulante vs Não Circulante
- Composição e qualidade dos ativos
- Variações relevantes

## 📋 ANÁLISE DO PASSIVO E PL
- Estrutura de capital (próprio vs terceiros)
- Vencimentos e concentração de dívidas
- Patrimônio Líquido e evolução

## 📈 INDICADORES FINANCEIROS
- Liquidez Corrente, Seca e Imediata
- Índice de Endividamento
- Capital de Giro Líquido
- Grau de Imobilização do PL

## ⚠️ PONTOS DE ATENÇÃO
Riscos de liquidez, alto endividamento, descasamento ativo-passivo.

## 💡 RECOMENDAÇÕES
Ações práticas: renegociação de dívidas, melhoria de capital de giro, decisões de investimento.

## 📝 MENSAGEM PARA O CLIENTE
Texto pronto para o contador enviar ao cliente.`
  },

  fluxo: {
    nome: 'Fluxo de Caixa',
    prompt: (dados, empresa, periodo, segmento) => `Analise este Fluxo de Caixa e gere relatório gerencial:

**Empresa:** ${empresa || 'Não informado'}
**Período:** ${periodo || 'Não informado'}
**Segmento:** ${segmento || 'Não informado'}

**DADOS:**
${dados}

Gere o relatório com:

## 📊 RESUMO EXECUTIVO
Posição de caixa, geração ou consumo do período, saúde do fluxo.

## 💵 FLUXO OPERACIONAL
Geração de caixa das operações. O negócio gera caixa? Quanto?

## 🏗️ FLUXO DE INVESTIMENTOS
Capex, aquisições, desinvestimentos. A empresa está crescendo ou desinvestindo?

## 💳 FLUXO DE FINANCIAMENTOS
Captações, amortizações, dividendos. Posição com credores.

## 📈 INDICADORES-CHAVE
- Caixa Gerado Operacionalmente
- Free Cash Flow estimado
- Ciclo de Caixa (se dados disponíveis)
- Runway (meses de caixa disponível)

## ⚠️ ALERTAS
Queima de caixa, pagamentos concentrados, risco de insolvência, necessidade de capital.

## 💡 RECOMENDAÇÕES
Gestão de recebíveis, antecipação, linhas de crédito, corte de despesas prioritário.

## 📝 MENSAGEM PARA O CLIENTE
Texto pronto para enviar ao cliente.`
  },

  livre: {
    nome: 'Análise Livre',
    prompt: (dados, empresa, periodo, segmento, instrucao) => `Analise os dados financeiros abaixo e gere um relatório gerencial profissional:

**Empresa:** ${empresa || 'Não informado'}
**Período:** ${periodo || 'Não informado'}
**Segmento:** ${segmento || 'Não informado'}
${instrucao ? `**Foco específico:** ${instrucao}` : ''}

**DADOS:**
${dados}

Gere uma análise completa, profissional e objetiva com:
- Resumo executivo
- Análise dos números mais relevantes
- Indicadores calculados
- Pontos de atenção
- Recomendações práticas
- Mensagem pronta para enviar ao cliente`
  }
};

// POST /api/relatorio/analisar
app.post('/api/relatorio/analisar', uploadRelatorio.single('file'), async (req, res) => {
  let filePath;
  try {
    const { empresa, periodo, segmento, tipo = 'dre', instrucao, dadosTexto } = req.body;

    let dados;
    if (req.file) {
      filePath = req.file.path;
      dados    = await parseRelatorioFile(filePath);
      fs.unlinkSync(filePath);
      filePath = null;
    } else if (dadosTexto) {
      dados = dadosTexto.trim();
    } else {
      return res.status(400).json({ error: 'Envie um arquivo ou cole os dados no campo de texto.' });
    }

    if (!dados || dados.length < 30) {
      return res.status(400).json({ error: 'Dados insuficientes para análise. Verifique o arquivo.' });
    }

    // Trunca para não ultrapassar context window (max ~12k chars de dados brutos)
    const dadosTruncados = dados.slice(0, 12000);
    const tipoConfig     = TIPOS_RELATORIO[tipo] || TIPOS_RELATORIO.dre;
    const prompt         = tipoConfig.prompt(dadosTruncados, empresa, periodo, segmento, instrucao);

    const response = await claude.messages.create({
      model     : 'claude-opus-4-5',
      max_tokens: 4096,
      system    : RELATORIO_SYSTEM,
      messages  : [{ role: 'user', content: prompt }]
    });

    res.json({ ok: true, relatorio: response.content[0].text, tipo: tipoConfig.nome });
  } catch (err) {
    if (filePath) fs.unlink(filePath, () => {});
    console.error('Erro relatório:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   MÓDULO iACONTABIL — ANÁLISE DE XML FISCAL
══════════════════════════════════════════ */
const uploadXml = multer({
  storage: chatStorage,
  limits : { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = path.extname(file.originalname).toLowerCase() === '.xml';
    cb(ok ? null : new Error('Apenas arquivos .xml são aceitos.'), ok);
  }
});

const XML_SYSTEM = `Você é o iACONTABIL, inteligência artificial especializada em contabilidade e legislação fiscal brasileira.

Seu conhecimento abrange:
- ICMS, IPI, PIS, COFINS, ISS, IRPJ, CSLL, INSS
- Regimes tributários: Simples Nacional, Lucro Presumido, Lucro Real
- SPED Fiscal, EFD, eSocial, NFe, NFSe, CTe
- Substituição tributária, CPRB, benefícios fiscais
- Obrigações acessórias e prazos legais
- Reforma Tributária (EC 132/2023, LC 68/2024)

Ao analisar documentos fiscais:
1. Identifique inconsistências e riscos tributários
2. Aponte oportunidades de economia fiscal (planejamento lícito)
3. Use linguagem técnica mas acessível
4. Cite legislação relevante (Lei, IN, CGSN, ADI) quando aplicável
5. Organize a resposta com seções claras`;

function buildXmlPrompt(doc, tipo) {
  const ctx = buildXmlContext(doc);
  if (tipo === 'resumo') return `Crie um resumo executivo objetivo deste documento fiscal:\n\n${ctx}\n\nResposta direta: tipo, partes, valor, tributos e pontos de atenção.`;
  if (tipo === 'tributaria') return `Faça uma análise tributária aprofundada:\n\n${ctx}\n\nFoque em: ICMS/PIS/COFINS/ISS corretos, créditos aproveitáveis, riscos fiscais, conformidade legal com citação de normas.`;
  return `Analise este documento fiscal de forma completa:\n\n${ctx}\n\n## 📋 RESUMO EXECUTIVO\n## ✅ CONFERÊNCIA FISCAL\n## ⚠️ ALERTAS E INCONSISTÊNCIAS\n## 💡 OPORTUNIDADES TRIBUTÁRIAS\n## 📌 RECOMENDAÇÕES`;
}

function buildXmlContext(doc) {
  if (doc.tipo === 'NFe') {
    const itens = (doc.itens || []).map((it, i) =>
      `  Item ${i+1}: ${it.descricao} | CFOP ${it.cfop} | NCM ${it.ncm} | Qtd ${it.quantidade} | Total ${formatCurrency(it.valorTotal)}\n  ICMS CST/CSOSN: ${it.icms?.cst} | Alíq: ${formatPercent(it.icms?.aliquota)} | Valor: ${formatCurrency(it.icms?.valor)} | PIS CST: ${it.pis?.cst} | COFINS CST: ${it.cofins?.cst}`
    ).join('\n');
    return `=== NFe ===\nNº ${doc.numero}/${doc.serie} | Data: ${doc.dataEmissao} | Natureza: ${doc.natureza}\nEmitente: ${doc.emitente?.nome} | CRT: ${crtLabel(doc.emitente?.crt)} | UF: ${doc.emitente?.uf}\nDestinatário: ${doc.destinatario?.nome} | UF: ${doc.destinatario?.uf}\n\nITENS:\n${itens}\n\nTOTAIS: Produtos ${formatCurrency(doc.totais?.valorProdutos)} | ICMS ${formatCurrency(doc.totais?.valorICMS)} | PIS ${formatCurrency(doc.totais?.valorPIS)} | COFINS ${formatCurrency(doc.totais?.valorCOFINS)} | TOTAL NF ${formatCurrency(doc.totais?.valorNF)}`;
  }
  if (doc.tipo === 'NFSe') {
    const v = doc.valores || {};
    return `=== NFSe ===\nNº ${doc.numero} | Competência: ${doc.competencia}\nPrestador: ${doc.prestador?.razaoSocial}\nTomador: ${doc.tomador?.razaoSocial}\nServiço: ${doc.servico?.discriminacao}\nItem Lista: ${doc.servico?.itemLista} | CNAE: ${doc.servico?.cnae}\nValor Serviços: ${formatCurrency(v.servicos)} | Base ISS: ${formatCurrency(v.baseCalculo)} | Alíq: ${formatPercent(v.aliquotaISS)} | ISS: ${formatCurrency(v.valorISS)} | Líquido: ${formatCurrency(v.valorLiquido)}\nRetenções: IR ${formatCurrency(v.ir)} | CSLL ${formatCurrency(v.csll)} | PIS ${formatCurrency(v.pis)} | COFINS ${formatCurrency(v.cofins)}`;
  }
  if (doc.tipo === 'CTe') {
    return `=== CTe ===\nNº ${doc.numero}/${doc.serie} | Data: ${doc.dataEmissao} | CFOP: ${doc.cfop}\nEmitente: ${doc.emitente?.nome} | UF: ${doc.emitente?.uf}\nRemetente: ${doc.remetente?.nome} | Destinatário: ${doc.destinatario?.nome}\nValor Prestação: ${formatCurrency(doc.valores?.totalPrestacao)} | ICMS: ${formatCurrency(doc.icms?.valor)} CST: ${doc.icms?.cst}`;
  }
  return JSON.stringify(doc, null, 2).slice(0, 3000);
}

// POST /api/fiscal/xml/analyze — parse + análise IA
app.post('/api/fiscal/xml/analyze', uploadXml.single('file'), async (req, res) => {
  let filePath;
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo XML enviado.' });
    filePath = req.file.path;

    const xmlStr      = fs.readFileSync(filePath, 'utf8');
    const doc         = parseFiscalXML(xmlStr);
    const tipoAnalise = req.body.tipo || 'completa';

    const response = await claude.messages.create({
      model     : 'claude-opus-4-5',
      max_tokens: 4096,
      system    : XML_SYSTEM,
      messages  : [{ role: 'user', content: buildXmlPrompt(doc, tipoAnalise) }]
    });

    fs.unlinkSync(filePath);
    res.json({ ok: true, tipo: doc.tipo, doc, analise: response.content[0].text });
  } catch (err) {
    if (filePath) fs.unlink(filePath, () => {});
    console.error('Erro análise XML:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiscal/xml/compare — comparação de múltiplos XMLs
app.post('/api/fiscal/xml/compare', uploadXml.array('files', 10), async (req, res) => {
  const filePaths = [];
  try {
    if (!req.files || req.files.length < 2) return res.status(400).json({ error: 'Envie pelo menos 2 XMLs para comparar.' });

    const docs = req.files.map(f => { filePaths.push(f.path); return parseFiscalXML(fs.readFileSync(f.path, 'utf8')); });
    const ctx  = docs.map((d, i) => `=== DOCUMENTO ${i+1} ===\n${buildXmlContext(d)}`).join('\n\n');

    const response = await claude.messages.create({
      model     : 'claude-opus-4-5',
      max_tokens: 4096,
      system    : XML_SYSTEM,
      messages  : [{ role: 'user', content: `Compare estes ${docs.length} documentos fiscais:\n\n${ctx}\n\n## 📊 COMPARATIVO DE VALORES\n## 📈 VARIAÇÕES RELEVANTES\n## ✅ CONSISTÊNCIA TRIBUTÁRIA\n## 📌 RECOMENDAÇÕES` }]
    });

    for (const p of filePaths) fs.unlink(p, () => {});
    res.json({ ok: true, quantidade: docs.length, analise: response.content[0].text });
  } catch (err) {
    for (const p of filePaths) fs.unlink(p, () => {});
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiscal/regime — simulador de regime tributário
app.post('/api/fiscal/regime', async (req, res) => {
  try {
    const { razaoSocial, cnae, faturamento, folha, custos, atividade, uf } = req.body;
    if (!faturamento) return res.status(400).json({ error: 'Informe o faturamento anual.' });

    const prompt = `Simule e compare os regimes tributários:\n\nEmpresa: ${razaoSocial || '—'}\nCNAE: ${cnae || '—'}\nFaturamento Anual: ${formatCurrency(parseFloat(faturamento))}\nFolha Mensal: ${formatCurrency(parseFloat(folha)||0)}\nCustos c/ NF/mês: ${formatCurrency(parseFloat(custos)||0)}\nAtividade: ${atividade || '—'}\nUF: ${uf || '—'}\n\n## 📊 SIMPLES NACIONAL\n## 📊 LUCRO PRESUMIDO\n## 📊 LUCRO REAL\n## 💰 COMPARATIVO DE CARGA TRIBUTÁRIA\n## ✅ RECOMENDAÇÃO (com fundamento legal)\n## ⚠️ PONTOS DE ATENÇÃO`;

    const response = await claude.messages.create({
      model: 'claude-opus-4-5', max_tokens: 4096, system: XML_SYSTEM,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ ok: true, resultado: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   HEALTH CHECK
══════════════════════════════════════════ */
app.get('/api/health', (_, res) =>
  res.json({ status: 'ok', agents: Object.keys(AGENTS).length })
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅  Central IA rodando em http://localhost:${PORT}`);
  ig.loadPendingJobsOnStartup();
  ig.startTokenRefreshJob();
  ig.startAutoResponder(claude);
});

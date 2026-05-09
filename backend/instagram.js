'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const CONFIG_PATH    = path.join(__dirname, 'instagram-config.json');
const SCHEDULED_PATH = path.join(__dirname, 'scheduled.json');
const GRAPH_FB       = 'https://graph.facebook.com/v22.0';
const GRAPH_IG       = 'https://graph.instagram.com/v22.0';

// Tokens IGAAN = Instagram Business Login → usa graph.instagram.com
// Tokens EAA   = Facebook User Token     → usa graph.facebook.com
function getGraphBase(accessToken) {
  if (!accessToken) return GRAPH_FB;
  const t = String(accessToken);
  if (t.startsWith('IGAAN') || t.startsWith('IGQV') || t.startsWith('IGQ')) return GRAPH_IG;
  return GRAPH_FB;
}

/* ══════════════════════════════════════════
   CONFIG HELPERS
══════════════════════════════════════════ */
// readConfig(profile) — suporta 'franklim' (padrão) e 'pac' (conta separada)
function readConfig(profile) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

  if (profile === 'pac') {
    // Conta PAC usa variáveis PAC_IG_* — nunca mistura com Franklim
    return {
      accessToken   : process.env.PAC_IG_ACCESS_TOKEN || '',
      igUserId      : process.env.PAC_IG_USER_ID      || '',
      appId         : file.appId    || process.env.IG_APP_ID     || '',
      appSecret     : file.appSecret|| process.env.IG_APP_SECRET || '',
      imgbbApiKey   : file.imgbbApiKey || process.env.IMGBB_API_KEY || '',
      tokenExpiresAt: 0
    };
  }

  // Perfil padrão: Franklim
  return {
    accessToken   : file.accessToken    || process.env.IG_ACCESS_TOKEN  || '',
    igUserId      : file.igUserId       || process.env.IG_USER_ID        || '',
    appId         : file.appId          || process.env.IG_APP_ID         || '',
    appSecret     : file.appSecret      || process.env.IG_APP_SECRET     || '',
    imgbbApiKey   : file.imgbbApiKey    || process.env.IMGBB_API_KEY     || '',
    tokenExpiresAt: file.tokenExpiresAt || 0
  };
}

function writeConfig(obj) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

function readScheduled() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULED_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeScheduled(arr) {
  fs.writeFileSync(SCHEDULED_PATH, JSON.stringify(arr, null, 2), 'utf8');
}

/* ══════════════════════════════════════════
   IMGBB UPLOAD
══════════════════════════════════════════ */
async function uploadToImgbb(base64, apiKey) {
  const body = new URLSearchParams();
  body.append('key', apiKey);
  body.append('image', base64);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30000);

  try {
    const res  = await fetch('https://api.imgbb.com/1/upload', {
      method : 'POST',
      body,
      signal : controller.signal
    });
    const data = await res.json();
    if (!data.success) throw new Error('imgbb: ' + (data.error?.message || 'upload falhou'));
    return { url: data.data.url, deleteUrl: data.data.delete_url };
  } finally {
    clearTimeout(timeout);
  }
}

/* ══════════════════════════════════════════
   INSTAGRAM GRAPH API HELPERS
══════════════════════════════════════════ */
function igError(data) {
  if (data && data.error) {
    const code = data.error.code;
    const err  = new Error(data.error.message || 'Instagram API error');
    if (code === 190) err.code = 'TOKEN_EXPIRED';
    if ([4, 17, 32, 613].includes(code)) err.code = 'RATE_LIMIT';
    return err;
  }
  return null;
}

async function gql(endpoint, params) {
  const base = getGraphBase(params.access_token);
  const url  = `${base}/${endpoint}`;
  const qs   = new URLSearchParams(params);
  const res  = await fetch(`${url}?${qs}`);
  const data = await res.json();
  const err  = igError(data);
  if (err) throw err;
  return data;
}

async function gqlPost(endpoint, params) {
  const base = getGraphBase(params.access_token);
  const url  = `${base}/${endpoint}`;
  const body = new URLSearchParams(params);
  const res  = await fetch(url, { method: 'POST', body });
  const data = await res.json();
  const err  = igError(data);
  if (err) throw err;
  return data;
}

async function createMediaContainer(igUserId, imageUrl, accessToken) {
  const data = await gqlPost(`${igUserId}/media`, {
    image_url   : imageUrl,
    access_token: accessToken
  });
  return data.id;
}

async function waitForContainer(containerId, accessToken, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const data = await gql(`${containerId}`, {
      fields      : 'status_code',
      access_token: accessToken
    });
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') {
      throw new Error(`Container ${containerId} retornou ERROR. Imagem pode estar inacessível.`);
    }
    // IN_PROGRESS or PUBLISHED — continue polling
  }
  throw new Error(`Timeout aguardando container ${containerId}.`);
}

async function createCarouselContainer(igUserId, childIds, caption, accessToken) {
  const data = await gqlPost(`${igUserId}/media`, {
    media_type  : 'CAROUSEL',
    children    : childIds.join(','),
    caption     : caption.slice(0, 2200),
    access_token: accessToken
  });
  return data.id;
}

async function publishCarousel(igUserId, carouselId, accessToken) {
  const data = await gqlPost(`${igUserId}/media_publish`, {
    creation_id : carouselId,
    access_token: accessToken
  });
  return data.id;
}

async function refreshToken(accessToken) {
  const res  = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${accessToken}`
  );
  const data = await res.json();
  if (!data.access_token) throw new Error('Falha ao renovar token');
  return { access_token: data.access_token, expires_in: data.expires_in };
}

/* ══════════════════════════════════════════
   FULL PUBLISH FLOW
══════════════════════════════════════════ */
async function publishCarouselNow({ images, caption, igUserId, accessToken, imgbbApiKey }) {
  if (!images || images.length < 2) throw new Error('Mínimo 2 slides para publicar no carrossel.');
  if (images.length > 10) images = images.slice(0, 10);

  console.log(`📸 Instagram: iniciando publicação — ${images.length} slides`);

  // 1. Upload de cada imagem para imgbb
  const imageUrls = [];
  for (let i = 0; i < images.length; i++) {
    console.log(`  ↳ Enviando imagem ${i + 1}/${images.length} para imgbb...`);
    const { url } = await uploadToImgbb(images[i], imgbbApiKey);
    imageUrls.push(url);
    console.log(`     ✓ ${url}`);
  }

  // 2. Criar containers individuais
  const containerIds = [];
  for (let i = 0; i < imageUrls.length; i++) {
    console.log(`  ↳ Criando container IG ${i + 1}/${imageUrls.length}...`);
    const cid = await createMediaContainer(igUserId, imageUrls[i], accessToken);
    await waitForContainer(cid, accessToken);
    containerIds.push(cid);
    console.log(`     ✓ container ${cid} FINISHED`);
  }

  // 3. Criar container carrossel
  console.log(`  ↳ Criando container carrossel...`);
  const carouselId = await createCarouselContainer(igUserId, containerIds, caption, accessToken);
  await waitForContainer(carouselId, accessToken);
  console.log(`     ✓ carousel ${carouselId} FINISHED`);

  // 4. Publicar
  console.log(`  ↳ Publicando...`);
  const postId = await publishCarousel(igUserId, carouselId, accessToken);
  console.log(`✅ Instagram: publicado! Post ID: ${postId}`);

  return { postId, imageUrls };
}

/* ══════════════════════════════════════════
   CRON JOBS
══════════════════════════════════════════ */
const activeJobs = new Map();

function isoToCronExpr(iso) {
  const d = new Date(iso);
  // cron: minuto hora dia mês *
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

function registerCronJob(jobDef) {
  try {
    const expr = isoToCronExpr(jobDef.scheduledTime);
    const task = cron.schedule(expr, async () => {
      console.log(`🗓️  Executando job agendado: ${jobDef.id}`);
      try {
        await publishCarouselNow(jobDef);
        // Marcar como publicado
        const jobs = readScheduled();
        const idx  = jobs.findIndex(j => j.id === jobDef.id);
        if (idx !== -1) {
          jobs[idx].status = 'published';
          jobs[idx].publishedAt = new Date().toISOString();
          writeScheduled(jobs);
        }
      } catch (err) {
        console.error(`❌ Job ${jobDef.id} falhou:`, err.message);
        const jobs = readScheduled();
        const idx  = jobs.findIndex(j => j.id === jobDef.id);
        if (idx !== -1) {
          jobs[idx].status = 'failed';
          jobs[idx].error  = err.message;
          writeScheduled(jobs);
        }
      }
      activeJobs.delete(jobDef.id);
    }, { timezone: 'America/Sao_Paulo' });

    activeJobs.set(jobDef.id, task);
    console.log(`  ✓ Job ${jobDef.id} registrado para ${jobDef.scheduledTime} (cron: ${expr})`);
  } catch (err) {
    console.error(`Falha ao registrar cron job ${jobDef.id}:`, err.message);
  }
}

function cancelCronJob(id) {
  const task = activeJobs.get(id);
  if (task) {
    task.stop();
    activeJobs.delete(id);
  }
}

function loadPendingJobsOnStartup() {
  const jobs = readScheduled();
  const now  = new Date();
  let pending = 0;
  let missed  = 0;

  for (const job of jobs) {
    if (job.status !== 'pending') continue;
    if (new Date(job.scheduledTime) <= now) {
      job.status = 'missed';
      missed++;
    } else {
      registerCronJob(job);
      pending++;
    }
  }

  if (missed > 0) writeScheduled(jobs);
  console.log(`🗓️  Jobs Instagram: ${pending} pendentes, ${missed} perdidos.`);
}

function startTokenRefreshJob() {
  // Roda às 00:00 a cada 29 dias
  cron.schedule('0 0 */29 * *', async () => {
    const cfg = readConfig();
    if (!cfg.accessToken) return;
    try {
      const result = await refreshToken(cfg.accessToken);
      writeConfig({
        ...cfg,
        accessToken   : result.access_token,
        tokenExpiresAt: Date.now() + result.expires_in * 1000
      });
      console.log('🔑 Token Instagram renovado automaticamente.');
    } catch (err) {
      console.error('❌ Falha ao renovar token Instagram:', err.message);
    }
  });
  console.log('🔑 Auto-renovação de token Instagram ativada (cada 29 dias).');
}

/* ══════════════════════════════════════════
   AUTO-RESPONDER DE COMENTÁRIOS (Bia)
══════════════════════════════════════════ */
const AUTORESPONDER_PATH = path.join(__dirname, 'autoresponder-config.json');
const REPLIED_PATH       = path.join(__dirname, 'replied-comments.json');
const AR_LOG_PATH        = path.join(__dirname, 'autoresponder-log.json');

function readAutoResponderConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(AUTORESPONDER_PATH, 'utf8')); } catch {}
  // Env vars como fallback — permite persistência no Railway sem arquivo
  return {
    enabled           : file.enabled            ?? (process.env.AR_ENABLED === 'true'),
    profile           : file.profile            || process.env.AR_PROFILE       || 'franklim',
    intervalMinutes   : file.intervalMinutes    || parseInt(process.env.AR_INTERVAL || '5'),
    customInstructions: file.customInstructions || '',
    igUsername        : file.igUsername         || process.env.AR_USERNAME       || '',
    respondToAll      : file.respondToAll       ?? (process.env.AR_RESPOND_ALL === 'true')
  };
}
function writeAutoResponderConfig(obj) {
  fs.writeFileSync(AUTORESPONDER_PATH, JSON.stringify(obj, null, 2), 'utf8');
}
function readReplied() {
  try { return new Set(JSON.parse(fs.readFileSync(REPLIED_PATH, 'utf8'))); }
  catch { return new Set(); }
}
function writeReplied(set) {
  fs.writeFileSync(REPLIED_PATH, JSON.stringify([...set]), 'utf8');
}
function readArLog() {
  try { return JSON.parse(fs.readFileSync(AR_LOG_PATH, 'utf8')); }
  catch { return []; }
}
function appendArLog(entry) {
  const log = readArLog();
  log.unshift(entry); // mais recente primeiro
  if (log.length > 100) log.length = 100; // máx 100 entradas
  fs.writeFileSync(AR_LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
}

async function fetchRecentPosts(igUserId, accessToken) {
  const base = getGraphBase(accessToken);
  const qs   = new URLSearchParams({ fields: 'id,caption,timestamp,comments_count', limit: '10', access_token: accessToken });
  const res  = await fetch(`${base}/${igUserId}/media?${qs}`);
  const data = await res.json();
  const err  = igError(data); if (err) throw err;
  return data;
}

async function fetchComments(mediaId, accessToken) {
  const base = getGraphBase(accessToken);
  // from{username} para token IGAAN que não retorna username no nível raiz
  const qs   = new URLSearchParams({ fields: 'id,text,username,from{id,username},timestamp', limit: '100', access_token: accessToken });
  const res  = await fetch(`${base}/${mediaId}/comments?${qs}`);
  const data = await res.json();
  const err  = igError(data); if (err) throw err;
  return data;
}

// Verifica via API se já existe reply nosso neste comentário
// Chamada direta a /{comment-id}/replies — mais confiável que campo embutido
async function alreadyRepliedViaApi(commentId, igUsername, accessToken) {
  if (!igUsername) return false;
  try {
    const base = getGraphBase(accessToken);
    const qs   = new URLSearchParams({ fields: 'id,username', access_token: accessToken });
    const res  = await fetch(`${base}/${commentId}/replies?${qs}`);
    const data = await res.json();
    if (data.error) return false;
    return (data.data || []).some(r => r.username === igUsername);
  } catch {
    return false;
  }
}

async function replyToComment(commentId, message, accessToken) {
  return gqlPost(`${commentId}/replies`, { message, access_token: accessToken });
}

const BIA_PROMPTS = {
  franklim: `Você É o Franklim Paixão respondendo seus próprios comentários do Instagram. Fale sempre em primeira pessoa, como se fosse VOCÊ mesmo digitando.

Franklim é contador, especialista em Reforma Tributária (IBS/CBS) e IA para contadores. Tom: humano, próximo, autêntico — como alguém que genuinamente agradece e conversa.

REGRAS:
- Resposta curta, máx. 120 caracteres — parece digitado no celular
- SEMPRE primeira pessoa: "Obrigado!", "Fico feliz!", "Valeu!" — NUNCA "O Franklim agradece" ou terceira pessoa
- Elogios simples (muito bom, ótimo, etc.) → agradeça de forma leve e convide a continuar acompanhando. Ex: "Valeu! 🙏 Fico feliz que tenha gostado, continua acompanhando!"
- Dúvidas técnicas → responda brevemente em 1ª pessoa e chame pro DM
- Críticas → acolha com empatia, 1ª pessoa, convide pra conversar
- Spam/irrelevante → "Obrigado pelo carinho! 🙏"
- Máximo 1 emoji
- NUNCA mencione que é IA
- Escreva APENAS o texto da resposta, sem aspas, sem prefácio`,

  pac: `Você É a equipe da PAC Inteligência Tributária respondendo comentários do Instagram. Fale em primeira pessoa do plural (nós, nossa, nosso) como a voz da empresa.

PAC é escritório contábil especializado em oficinas mecânicas e autopeças. Tom: direto, parceiro de negócios, linguagem de empresário.

REGRAS:
- Resposta curta, máx. 120 caracteres — parece digitado no celular
- SEMPRE primeira pessoa: "Obrigado!", "Que bom que curtiu!", "Valeu!" — NUNCA terceira pessoa
- Elogios → agradeça de forma simples e direta. Ex: "Valeu! 🙏 Fica ligado que vem mais conteúdo!"
- Dúvidas → responda brevemente e chame pro DM
- Críticas → acolha e convide pra conversar
- Spam → "Obrigado pelo contato! 😊"
- Máximo 1 emoji
- NUNCA mencione que é IA
- Escreva APENAS o texto da resposta, sem aspas, sem prefácio`
};

async function generateCommentReply(commentText, postCaption, profile, customInstructions, claudeClient) {
  const systemPrompt = BIA_PROMPTS[profile] || BIA_PROMPTS.franklim;
  const extra        = customInstructions ? `\nInstruções extras: ${customInstructions}` : '';
  const userMessage  = `Post: "${(postCaption || '(sem legenda)').slice(0, 250)}"\nComentário: "${commentText}"${extra}\n\nEscreva a resposta:`;

  const msg = await claudeClient.messages.create({
    model     : 'claude-opus-4-5',
    max_tokens: 80,
    system    : systemPrompt,
    messages  : [{ role: 'user', content: userMessage }]
  });

  return msg.content[0].text.trim().replace(/^["']|["']$/g, '').slice(0, 150);
}

/* ── Gatilhos por palavra-chave ── */
const TRIGGERS_PATH = path.join(__dirname, 'triggers.json');

// Gatilhos padrão — usados quando triggers.json não existe (Railway restart)
const DEFAULT_TRIGGERS = [
  { id:'default-1', label:'RITA / Reforma / IBS / CBS', keywords:['reforma','IBS','CBS','split','RITA','método','cenário','tributária'], responseType:'fixed', fixedResponse:'Manda um direct com REFORMA que te mando o material certo pra começar 💡', enabled:true, hitCount:0 },
  { id:'default-2', label:'IA / Claude / GPT',          keywords:['IA','inteligência artificial','Claude','GPT','automatizar','automação'], responseType:'fixed', fixedResponse:'Me chama no direct que te mostro como aplico o Claude no dia a dia do escritório 💡', enabled:true, hitCount:0 },
  { id:'default-3', label:'Mentoria / Família / Quero', keywords:['mentoria','família','quero','interesse','entrar','como funciona','vagas'], responseType:'fixed', fixedResponse:'Manda um direct agora que te falo tudo sobre a Família TributárIA 🚀', enabled:true, hitCount:0 },
  { id:'default-4', label:'Preço / Honorário',          keywords:['preço','valor','quanto','honorário','cobrar','tabela'],                   responseType:'fixed', fixedResponse:'Manda um direct agora que a gente conversa sobre isso! 📩', enabled:true, hitCount:0 },
  { id:'default-5', label:'Parceria / Contratar',       keywords:['parceria','contratar','trabalhar','serviço','cliente','orçamento'],        responseType:'fixed', fixedResponse:'Que ótimo! Manda um direct que a gente conversa 🤝', enabled:true, hitCount:0 },
  { id:'default-6', label:'Elogio / Parabéns',          keywords:['parabéns','incrível','excelente','show','demais','top','muito bom','ótimo','perfeito','manda bem'], responseType:'fixed', fixedResponse:'Valeu! 🙏 Fico feliz que tenha gostado, continua acompanhando!', enabled:true, hitCount:0 }
];

function readTriggers() {
  try {
    const arr = JSON.parse(fs.readFileSync(TRIGGERS_PATH, 'utf8'));
    if (arr && arr.length > 0) return arr;
  } catch {}
  // Arquivo vazio ou inexistente (Railway restart) → usa padrões embutidos
  return DEFAULT_TRIGGERS;
}
function writeTriggers(arr) {
  fs.writeFileSync(TRIGGERS_PATH, JSON.stringify(arr, null, 2), 'utf8');
}

function matchTrigger(commentText, triggers) {
  const text = commentText.toLowerCase();
  return triggers.find(t => {
    if (!t.enabled) return false;
    return (t.keywords || []).some(kw => kw && text.includes(kw.toLowerCase().trim()));
  }) || null;
}

let autoResponderJob = null;

async function runAutoResponder(claudeClient) {
  const arCfg  = readAutoResponderConfig();
  if (!arCfg.enabled) return;

  // Usa a conta correta baseada no perfil configurado
  const cfg = readConfig(arCfg.profile);
  if (!cfg.accessToken || !cfg.igUserId) {
    console.log(`⚠️  Bia: Instagram não configurado para perfil "${arCfg.profile}".`);
    return;
  }

  // Só processa comentários das últimas N horas (padrão 6h) — ignora spam antigo
  const maxAgeHours = arCfg.maxAgeHours || 6;
  const cutoffTime  = new Date(Date.now() - maxAgeHours * 3600 * 1000);
  console.log(`💬 Bia [${arCfg.profile}]: varrendo (últimas ${maxAgeHours}h) | respondToAll=${arCfg.respondToAll}`);
  try {
    const replied  = readReplied();
    const triggers = readTriggers().filter(t => t.enabled);
    console.log(`   gatilhos: ${triggers.length} | ${triggers.map(t=>t.keywords[0]).join(', ')}`);
    const posts    = await fetchRecentPosts(cfg.igUserId, cfg.accessToken);
    const postList = posts.data || [];
    let   total    = 0;

    for (const post of postList) {
      let comments;
      try { comments = await fetchComments(post.id, cfg.accessToken); }
      catch (e) { console.error(`  ⚠️ Post ${post.id}:`, e.message); continue; }

      const commentList = comments.data || [];
      // Filtra só comentários recentes
      const recentComments = commentList.filter(c => {
        if (!c.timestamp) return true; // sem data → processa
        return new Date(c.timestamp) >= cutoffTime;
      });

      if (recentComments.length > 0)
        console.log(`   post ${post.id}: ${recentComments.length} comentário(s) recente(s) (de ${commentList.length} total)`);

      for (const comment of recentComments) {
        // Extrai username — IGAAN retorna em from.username ou username
        const commentUsername = comment.from?.username || comment.username || '';
        const shortText = comment.text?.slice(0,35) || '';
        console.log(`   @${commentUsername}: "${shortText}" [${new Date(comment.timestamp).toLocaleTimeString('pt-BR')}]`);

        // 1. Cache local
        if (replied.has(comment.id)) { console.log(`     → SKIP (já respondido)`); continue; }

        // 2. Pula própria conta
        if (arCfg.igUsername && commentUsername === arCfg.igUsername) {
          replied.add(comment.id); continue;
        }

        // 3. Checa gatilho
        const trigger  = matchTrigger(comment.text, triggers);
        const hasTrigs = triggers.length > 0;
        console.log(`     → gatilho: ${trigger ? trigger.label : 'nenhum'}`);

        if (hasTrigs && !trigger && !arCfg.respondToAll) {
          console.log(`     → SKIP (sem match)`); continue;
        }

        // 4. Verifica via API se já respondemos (só para comentários que vamos responder)
        const jaRespondido = await alreadyRepliedViaApi(comment.id, arCfg.igUsername, cfg.accessToken);
        if (jaRespondido) { replied.add(comment.id); writeReplied(replied); continue; }

        try {
          let reply;
          let triggerLabel = 'livre';

          if (trigger) {
            triggerLabel = trigger.keywords[0] || 'gatilho';
            if (trigger.responseType === 'fixed') {
              reply = trigger.fixedResponse;
            } else {
              reply = await generateCommentReply(
                comment.text,
                post.caption || '',
                arCfg.profile || 'franklim',
                trigger.aiInstruction || arCfg.customInstructions || '',
                claudeClient
              );
            }
            // Incrementa hit count
            const allTriggers = readTriggers();
            const idx = allTriggers.findIndex(t => t.id === trigger.id);
            if (idx !== -1) {
              allTriggers[idx].hitCount = (allTriggers[idx].hitCount || 0) + 1;
              allTriggers[idx].lastHitAt = new Date().toISOString();
              writeTriggers(allTriggers);
            }
          } else {
            reply = await generateCommentReply(
              comment.text,
              post.caption || '',
              arCfg.profile || 'franklim',
              arCfg.customInstructions || '',
              claudeClient
            );
          }

          await replyToComment(comment.id, reply, cfg.accessToken);

          // Só marca como replied APÓS sucesso
          replied.add(comment.id);
          writeReplied(replied);
          total++;

          appendArLog({
            at          : new Date().toISOString(),
            username    : comment.username,
            comment     : comment.text.slice(0, 120),
            reply,
            postId      : post.id,
            profile     : arCfg.profile,
            triggerLabel
          });

          console.log(`  ✅ [${triggerLabel}] @${comment.username}: "${comment.text.slice(0, 35)}..." → "${reply}"`);
          await new Promise(r => setTimeout(r, 3000)); // anti-spam entre respostas

        } catch (e) {
          const isPermanent = e.code === 'TOKEN_EXPIRED' || (e.message || '').includes('permission');
          if (isPermanent) {
            // Erro permanente → marca replied para não tentar mais
            console.error(`  ❌ Erro permanente ${comment.id} (${e.message}) — ignorando.`);
            replied.add(comment.id);
            writeReplied(replied);
          } else {
            // Rate limit ou erro temporário → NÃO marca replied, tenta na próxima varredura
            console.error(`  ⚠️ Erro temporário ${comment.id} (${e.message}) — retentará.`);
          }
        }
      }
    }

    if (total > 0) console.log(`💬 Bia [${arCfg.profile}]: ${total} comentário(s) respondido(s).`);
  } catch (e) {
    console.error('❌ Auto-responder erro:', e.message);
  }
}

function startAutoResponder(claudeClient) {
  if (autoResponderJob) { autoResponderJob.stop(); autoResponderJob = null; }
  const arCfg = readAutoResponderConfig();
  if (!arCfg.enabled) return;

  const minutes = Math.max(5, arCfg.intervalMinutes || 5);
  console.log(`💬 Bia (auto-responder) ativada — varredura a cada ${minutes} min.`);

  runAutoResponder(claudeClient).catch(console.error); // roda imediatamente

  autoResponderJob = cron.schedule(`*/${minutes} * * * *`, () => {
    runAutoResponder(claudeClient).catch(console.error);
  });
}

function stopAutoResponder() {
  if (autoResponderJob) { autoResponderJob.stop(); autoResponderJob = null; }
  console.log('💬 Bia (auto-responder) desativada.');
}

module.exports = {
  readConfig,
  writeConfig,
  readScheduled,
  writeScheduled,
  publishCarouselNow,
  registerCronJob,
  cancelCronJob,
  loadPendingJobsOnStartup,
  startTokenRefreshJob,
  // Auto-responder
  readAutoResponderConfig,
  writeAutoResponderConfig,
  readArLog,
  appendArLog,
  fetchRecentPosts,
  fetchComments,
  replyToComment,
  runAutoResponder,
  startAutoResponder,
  stopAutoResponder,
  // Gatilhos
  readTriggers,
  writeTriggers
};

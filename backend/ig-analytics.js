'use strict';

const GRAPH_FB = 'https://graph.facebook.com/v22.0';
const GRAPH_IG = 'https://graph.instagram.com/v22.0';

function getBase(token) {
  if (!token) return GRAPH_FB;
  return (token.startsWith('IGAAN') || token.startsWith('IGQV') || token.startsWith('IGQ'))
    ? GRAPH_IG : GRAPH_FB;
}

async function igGet(path, params, token) {
  const base = getBase(token);
  const qs   = new URLSearchParams({ ...params, access_token: token });
  const res  = await fetch(`${base}/${path}?${qs}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function fetchAccountInfo(igUserId, token) {
  return igGet(igUserId, {
    fields: 'followers_count,follows_count,media_count,name,username,biography,website'
  }, token);
}

async function fetchDailyInsights(igUserId, token, days = 30) {
  const until = Math.floor(Date.now() / 1000);
  const since = until - (days * 86400);
  const result = {};

  const metrics = ['reach', 'impressions', 'profile_views'];
  for (const metric of metrics) {
    try {
      const data = await igGet(`${igUserId}/insights`, { metric, period: 'day', since, until }, token);
      result[metric] = (data.data?.[0]?.values || []).map(v => ({ date: v.end_time?.slice(0, 10) || '', value: v.value || 0 }));
    } catch (e) { result[metric] = []; }
  }

  try {
    const data = await igGet(`${igUserId}/insights`, { metric: 'follower_count', period: 'day', since, until }, token);
    result.follower_count = (data.data?.[0]?.values || []).map(v => ({ date: v.end_time?.slice(0, 10) || '', value: v.value || 0 }));
  } catch (e) { result.follower_count = []; }

  return result;
}

async function fetchTopPosts(igUserId, token, limit = 15) {
  const media = await igGet(`${igUserId}/media`, {
    fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count', limit
  }, token);

  const posts = [];
  for (const item of (media.data || [])) {
    let reach = 0, saved = 0, shares = 0, impressions = 0;
    try {
      const ins = await igGet(`${item.id}/insights`, { metric: 'reach,saved,shares,impressions' }, token);
      for (const m of (ins.data || [])) {
        if (m.name === 'reach')       reach       = m.values?.[0]?.value ?? m.value ?? 0;
        if (m.name === 'saved')       saved       = m.values?.[0]?.value ?? m.value ?? 0;
        if (m.name === 'shares')      shares      = m.values?.[0]?.value ?? m.value ?? 0;
        if (m.name === 'impressions') impressions = m.values?.[0]?.value ?? m.value ?? 0;
      }
    } catch (e) {}

    const likes = item.like_count || 0;
    const comments = item.comments_count || 0;
    const engagement = likes + comments + saved + shares;
    const er = reach > 0 ? +((engagement / reach) * 100).toFixed(1) : 0;

    posts.push({ id: item.id, caption: (item.caption || '').slice(0, 140), type: item.media_product_type || item.media_type || 'FEED', timestamp: item.timestamp, likes, comments, reach, saved, shares, impressions, engagement, er });
  }

  return posts.sort((a, b) => b.engagement - a.engagement);
}

async function fetchAudience(igUserId, token) {
  const result = { gender: [], ageGender: [], city: [], country: [] };
  const attempts = [
    { key: 'ageGender', params: { metric: 'follower_demographics', period: 'lifetime', breakdown: 'age,gender' }, extract: data => data.data?.[0]?.total_value?.breakdowns?.[0]?.results || [] },
    { key: 'gender',    params: { metric: 'follower_demographics', period: 'lifetime', breakdown: 'gender'    }, extract: data => data.data?.[0]?.total_value?.breakdowns?.[0]?.results || [] },
    { key: 'city',      params: { metric: 'follower_demographics', period: 'lifetime', breakdown: 'city'      }, extract: data => (data.data?.[0]?.total_value?.breakdowns?.[0]?.results || []).slice(0, 8) },
    { key: 'country',   params: { metric: 'follower_demographics', period: 'lifetime', breakdown: 'country'   }, extract: data => (data.data?.[0]?.total_value?.breakdowns?.[0]?.results || []).slice(0, 5) }
  ];
  for (const { key, params, extract } of attempts) {
    try { const data = await igGet(`${igUserId}/insights`, params, token); result[key] = extract(data); } catch (e) {}
  }
  return result;
}

async function fetchFullAnalytics(igUserId, token, claudeClient) {
  const [account, daily, posts, audience] = await Promise.all([
    fetchAccountInfo(igUserId, token),
    fetchDailyInsights(igUserId, token, 30),
    fetchTopPosts(igUserId, token, 15),
    fetchAudience(igUserId, token)
  ]);

  const sum = arr => (arr || []).reduce((s, v) => s + (v.value || 0), 0);
  const totalReach = sum(daily.reach), totalImpressions = sum(daily.impressions), totalNewFollowers = sum(daily.follower_count);
  const totalLikes = posts.reduce((s, p) => s + p.likes, 0), totalComments = posts.reduce((s, p) => s + p.comments, 0);
  const totalSaves = posts.reduce((s, p) => s + p.saved, 0), totalShares = posts.reduce((s, p) => s + p.shares, 0);
  const totalEngagement = totalLikes + totalComments + totalSaves + totalShares;
  const avgER = totalReach > 0 ? +((totalEngagement / totalReach) * 100).toFixed(1) : 0;

  const summary = { followers: account.followers_count || 0, following: account.follows_count || 0, mediaCount: account.media_count || 0, totalNewFollowers, totalReach, totalImpressions, totalLikes, totalComments, totalSaves, totalShares, totalEngagement, avgER, topPost: posts[0] ? { caption: posts[0].caption.slice(0, 100), type: posts[0].type, engagement: posts[0].engagement, reach: posts[0].reach, er: posts[0].er } : null };

  let insights = [];
  try {
    const msg = await claudeClient.messages.create({
      model: 'claude-opus-4-5', max_tokens: 700,
      system: `Você é o coach de Instagram do Franklim Paixão (@franklim.contador). Analise os dados e gere exatamente 4 insights acionáveis. Retorne SOMENTE JSON válido sem markdown. Formato: {"insights":[{"icone":"emoji","titulo":"título curto","acao":"o que fazer agora em 1 frase direta"}]}`,
      messages: [{ role: 'user', content: `Dados 30 dias: ${JSON.stringify(summary)}\nTop 3 posts: ${JSON.stringify(posts.slice(0,3).map(p => ({ caption: p.caption.slice(0,80), type: p.type, engagement: p.engagement, reach: p.reach, er: p.er })))}` }]
    });
    const raw = msg.content[0].text.trim().replace(/^```json|^```|```$/g, '').trim();
    insights = JSON.parse(raw).insights || [];
  } catch (e) {
    insights = [
      { icone: '📈', titulo: 'Analise o conteúdo pessoal', acao: 'Grave um reel pessoal esta semana — historicamente entrega 5× mais engajamento.' },
      { icone: '📅', titulo: 'Reduza a cadência', acao: 'Publique 5×/semana em vez de 2+/dia para aumentar alcance por post.' },
      { icone: '💾', titulo: 'Aumente os saves', acao: 'Adicione checklists práticos nos carrosséis — o save é o sinal mais forte para o algoritmo.' },
      { icone: '🎯', titulo: 'Foque em um CTA por post', acao: 'Escolha apenas uma ação (comenta / salva / DM) por publicação.' }
    ];
  }

  return { account, summary, daily, posts: posts.slice(0, 8), audience, insights };
}

module.exports = { fetchFullAnalytics };

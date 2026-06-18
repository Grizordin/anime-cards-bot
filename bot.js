const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs');
const http = require('http');

// ==========================================
// НАСТРОЙКИ
// ==========================================
const TOKEN = "8719993437:AAEpJ52sTS0Gw8QgfBIibUc3maaeQuPLU6I";
const CHAT_ID = "-1002306600001";
const THREAD_ID = "13048";
const ANIMESSS_LOGIN = process.env.ANIMESSS_LOGIN || '';
const ANIMESSS_PASSWORD = process.env.ANIMESSS_PASSWORD || '';

// ==========================================
// РАНГИ ДЛЯ ОТПРАВКИ
// ==========================================
const SEND_RANKS = ['s', 's_plus', 'ass'];

// ==========================================
// ТЕГИ ДЛЯ НОВЫХ КАРТ
// ==========================================
const RANK_TAGS = {
  "s": "#новаяS",
  "a": "#новаяA",
  "b": "#новаяB",
  "c": "#новаяC",
  "d": "#новаяD",
  "e": "#новаяE",
  "s_plus": "#новаяS+",
  "a_plus": "#новаяA+",
  "b_plus": "#новаяB+",
  "c_plus": "#новаяC+",
  "d_plus": "#новаяD+",
  "e_plus": "#новаяE+",
  "ass": "#новаяASS"
};

const STATE_FILE = './state.json';
const REPLACEMENT_KEY_LIMIT = 500;
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};
const authSessions = new Map();

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      lastId: state.lastId || 0,
      replacementKeys: Array.isArray(state.replacementKeys) ? state.replacementKeys : []
    };
  } catch {
    return { lastId: 0, replacementKeys: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

function normalizeUrl(url) {
  if (!url) return '';
  return url.startsWith('/') ? `https://animesss.tv${url}` : url;
}

function getCookieHeader(setCookieHeaders = []) {
  return setCookieHeaders
    .map(cookie => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function hasAuthCredentials() {
  return Boolean(ANIMESSS_LOGIN && ANIMESSS_PASSWORD);
}

async function loginToDomain(origin) {
  if (!hasAuthCredentials()) {
    return '';
  }

  const cachedCookie = authSessions.get(origin);
  if (cachedCookie) {
    return cachedCookie;
  }

  const form = new URLSearchParams({
    login_name: ANIMESSS_LOGIN,
    login_password: ANIMESSS_PASSWORD,
    login: 'submit'
  });

  const res = await axios.post(`${origin}/index.php`, form.toString(), {
    timeout: 15000,
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 400,
    headers: {
      ...REQUEST_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${origin}/`
    }
  });

  const cookie = getCookieHeader(res.headers['set-cookie'] || []);
  if (!cookie) {
    throw new Error('сайт не вернул cookie после входа');
  }

  authSessions.set(origin, cookie);
  console.log(`🔐 Авторизовались на ${origin}`);
  return cookie;
}

async function fetchFromDomains(path, label) {
  const urls = [
    `https://animesss.tv${path}`,
    `https://animesss.com${path}`
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: REQUEST_HEADERS
      });
      console.log(`✅ Подключились к ${label}: ${url}`);
      return res.data;
    } catch (e) {
      console.log(`❌ Недоступен ${label}: ${url} — ${e.message}`);
    }
  }

  throw new Error(`Оба домена недоступны для ${label}`);
}

async function fetchFromDomainsAuthorized(path, label) {
  const origins = [
    'https://animesss.tv',
    'https://animesss.com'
  ];

  for (const origin of origins) {
    try {
      const cookie = await loginToDomain(origin);
      const res = await axios.get(`${origin}${path}`, {
        timeout: 15000,
        headers: {
          ...REQUEST_HEADERS,
          ...(cookie ? { Cookie: cookie } : {})
        }
      });
      console.log(`✅ Подключились к ${label}: ${origin}${path}`);
      return res.data;
    } catch (e) {
      authSessions.delete(origin);
      console.log(`❌ Недоступен ${label}: ${origin}${path} — ${e.message}`);
    }
  }

  throw new Error(`Оба домена недоступны для ${label}`);
}

function looksLikeLoginPage(html) {
  return html.includes('name="login_name"') || html.includes('id="login_name"');
}

async function fetchCards() {
  return fetchFromDomains('/cards/', 'картам');
}

async function fetchReplacements() {
  return fetchFromDomainsAuthorized('/history_replacements/', 'истории замен');
}

function getRankFromClass($el) {
  const classList = ($el.attr('class') || '').split(' ');
  const rankClass = classList.find(c => c.startsWith('rank-'));
  return rankClass ? rankClass.replace('rank-', '') : null;
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const cards = [];

  $('.anime-cards__item').each((_, el) => {
    const $el = $(el);
    const id = parseInt($el.attr('data-id') || '0');
    const rank = getRankFromClass($el);
    const image = $el.attr('data-image') || '';
    const mp4 = $el.attr('data-mp4') || '';
    const name = $el.attr('data-name') || '';

    if (id && rank) {
      cards.push({ id, rank, image, mp4, name });
    }
  });

  return cards;
}

function parseReplacements(html) {
  const $ = cheerio.load(html);
  const cards = [];

  $('.card-replace-history').each((_, el) => {
    const $history = $(el);
    const $newSide = $history.find('.card-replace-history__side').filter((_, side) => {
      const $side = $(side);
      const badgeText = $side.find('.card-replace-history__badge').first().text().trim().toLowerCase();
      return $side.find('.card-replace-history__badge--new').length > 0 || badgeText === 'стало';
    }).first();

    const $card = $newSide.find('.anime-cards__item').first();
    const id = parseInt($card.attr('data-id') || '0');
    const rank = $card.attr('data-rank') || getRankFromClass($history);
    const image = $card.attr('data-image') || '';
    const mp4 = $card.attr('data-mp4') || '';
    const name = $card.attr('data-name') || $history.find('.card-replace-history__title').first().text().trim();

    if (id && rank && (image || mp4)) {
      cards.push({
        id,
        rank,
        image,
        mp4,
        name,
        replacementKey: `${id}:${mp4 || image}`
      });
    }
  });

  return cards;
}

async function sendPhoto(imageUrl, caption) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
    chat_id: CHAT_ID,
    message_thread_id: THREAD_ID,
    photo: normalizeUrl(imageUrl),
    caption
  });
}

async function sendVideo(videoUrl, caption) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendVideo`, {
    chat_id: CHAT_ID,
    message_thread_id: THREAD_ID,
    video: normalizeUrl(videoUrl),
    caption
  });
}

async function sendCard(card, caption) {
  if (card.mp4) {
    await sendVideo(card.mp4, caption);
    console.log(`🎬 Видео отправлено: ${card.name} [${card.rank}]`);
  } else {
    await sendPhoto(card.image, caption);
    console.log(`🖼 Фото отправлено: ${card.name} [${card.rank}]`);
  }
}

// ==========================================
// ПРОВЕРКА НОВЫХ КАРТ
// ==========================================
async function checkCards() {
  console.log(`\n⏰ Проверка новых карт: ${new Date().toLocaleTimeString()}`);
  const state = loadState();

  let html;
  try {
    html = await fetchCards();
  } catch (e) {
    console.error(`🚫 Ошибка загрузки карт: ${e.message}`);
    return;
  }

  const cards = parseCards(html);
  if (!cards.length) {
    console.log('⚠️ Карты не найдены');
    return;
  }

  const maxId = Math.max(...cards.map(c => c.id));

  if (state.lastId === 0) {
    console.log(`🔍 Первый запуск карт. Запоминаем последний id: ${maxId}`);
    state.lastId = maxId;
    saveState(state);
    return;
  }

  const newCards = cards
    .filter(c => c.id > state.lastId)
    .sort((a, b) => a.id - b.id);

  if (!newCards.length) {
    console.log(`ℹ️ Новых карт нет (последний id: ${state.lastId})`);
    return;
  }

  console.log(`🆕 Найдено новых карт: ${newCards.length}`);
  state.lastId = maxId;
  saveState(state);

  const toSend = newCards.filter(c => SEND_RANKS.includes(c.rank));
  console.log(`📤 Карт для отправки (${SEND_RANKS.join(', ')}): ${toSend.length}`);

  for (const card of toSend) {
    const caption = RANK_TAGS[card.rank] || '#новаяUNKNOWN';
    try {
      await sendCard(card, caption);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`❌ Ошибка отправки ${card.name}: ${e.message}`);
    }
  }
}

// ==========================================
// ПРОВЕРКА ИСТОРИИ ЗАМЕН
// ==========================================
async function checkReplacements() {
  console.log(`\n⏰ Проверка замен: ${new Date().toLocaleTimeString()}`);
  const state = loadState();

  let html;
  try {
    html = await fetchReplacements();
  } catch (e) {
    console.error(`🚫 Ошибка загрузки замен: ${e.message}`);
    return;
  }

  const replacements = parseReplacements(html);
  if (!replacements.length) {
    if (!hasAuthCredentials()) {
      console.log('⚠️ Замены не найдены. Для истории замен нужны ANIMESSS_LOGIN и ANIMESSS_PASSWORD в Render');
      return;
    }
    if (looksLikeLoginPage(html)) {
      console.log('⚠️ Замены не найдены. Сайт отдал страницу входа, проверь ANIMESSS_LOGIN и ANIMESSS_PASSWORD');
      authSessions.clear();
      return;
    }
    console.log('⚠️ Замены не найдены');
    return;
  }

  const currentKeys = replacements.map(c => c.replacementKey);
  if (!state.replacementKeys.length) {
    console.log(`🔍 Первый запуск замен. Запоминаем текущие замены: ${currentKeys.length}`);
    state.replacementKeys = currentKeys.slice(0, REPLACEMENT_KEY_LIMIT);
    saveState(state);
    return;
  }

  const seenKeys = new Set(state.replacementKeys);
  const newReplacements = replacements
    .filter(c => !seenKeys.has(c.replacementKey))
    .reverse();

  if (!newReplacements.length) {
    console.log('ℹ️ Новых замен нет');
    return;
  }

  console.log(`🆕 Найдено новых замен: ${newReplacements.length}`);
  state.replacementKeys = [
    ...currentKeys,
    ...state.replacementKeys.filter(key => !currentKeys.includes(key))
  ].slice(0, REPLACEMENT_KEY_LIMIT);
  saveState(state);

  const toSend = newReplacements.filter(c => SEND_RANKS.includes(c.rank));
  console.log(`📤 Замен для отправки (${SEND_RANKS.join(', ')}): ${toSend.length}`);

  for (const card of toSend) {
    try {
      await sendCard(card, '#замена');
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`❌ Ошибка отправки замены ${card.name}: ${e.message}`);
    }
  }
}

// ==========================================
// ЗАПУСК
// ==========================================
console.log('🤖 Бот запущен');
checkCards();
setTimeout(checkReplacements, 30000);

cron.schedule('0 * * * * *', checkCards);
cron.schedule('30 * * * * *', checkReplacements);

// Чтобы Render не засыпал — простой HTTP-сервер
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(process.env.PORT || 3000);

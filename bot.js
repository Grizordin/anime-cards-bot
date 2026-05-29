const axios  = require('axios');
const cheerio = require('cheerio');
const cron   = require('node-cron');
const fs     = require('fs');

// ==========================================
// 🔧 НАСТРОЙКИ
// ==========================================
const TOKEN   = "8719993437:AAEpJ52sTS0Gw8QgfBIibUc3maaeQuPLU6I";
const CHAT_ID = "-1002306600001";
const THREAD_ID = "13048";

// ==========================================
// 🎖 РАНГИ ДЛЯ ОТПРАВКИ (легко редактировать)
// ==========================================
const SEND_RANKS = ['s', 's_plus', 'ass'];

// ==========================================
// 🏷 ТЕГИ ДЛЯ ПОДПИСЕЙ
// ==========================================
const RANK_TAGS = {
  "s":      "#новаяS",
  "a":      "#новаяA",
  "b":      "#новаяB",
  "c":      "#новаяC",
  "d":      "#новаяD",
  "e":      "#новаяE",
  "s_plus": "#новаяS+",
  "a_plus": "#новаяA+",
  "b_plus": "#новаяB+",
  "c_plus": "#новаяC+",
  "d_plus": "#новаяD+",
  "e_plus": "#новаяE+",
  "ass":    "#новаяASS"
};

// ==========================================
// 💾 ХРАНИЛИЩЕ ID (файл state.json)
// ==========================================
const STATE_FILE = './state.json';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastId: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

// ==========================================
// 🌐 ПАРСИНГ СТРАНИЦЫ
// ==========================================
async function fetchCards() {
  const urls = [
    'https://animesss.tv/cards/',
    'https://animesss.com/cards/'
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      console.log(`✅ Подключились к: ${url}`);
      return res.data;
    } catch (e) {
      console.log(`❌ Недоступен: ${url} — ${e.message}`);
    }
  }
  throw new Error('Оба домена недоступны');
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const cards = [];

  $('.anime-cards__item').each((_, el) => {
    const $el = $(el);
    const id  = parseInt($el.attr('data-id') || '0');

    // Извлекаем ранг из class: "anime-cards__item rank-s_plus" → "s_plus"
    const classList = ($el.attr('class') || '').split(' ');
    const rankClass = classList.find(c => c.startsWith('rank-'));
    const rank = rankClass ? rankClass.replace('rank-', '') : null;

    const image  = $el.attr('data-image') || '';
    const mp4    = $el.attr('data-mp4')   || '';
    const name   = $el.attr('data-name')  || '';

    if (id && rank) {
      cards.push({ id, rank, image, mp4, name });
    }
  });

  return cards;
}

// ==========================================
// 📤 ОТПРАВКА В TELEGRAM
// ==========================================
async function sendPhoto(imageUrl, caption) {
  const fullUrl = imageUrl.startsWith('/')
    ? `https://animesss.tv${imageUrl}`
    : imageUrl;

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
    chat_id:           CHAT_ID,
    message_thread_id: THREAD_ID,
    photo:   fullUrl,
    caption: caption
  });
}

async function sendVideo(videoUrl, caption) {
  const fullUrl = videoUrl.startsWith('/')
    ? `https://animesss.tv${videoUrl}`
    : videoUrl;

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendVideo`, {
    chat_id:           CHAT_ID,
    message_thread_id: THREAD_ID,
    video:   fullUrl,
    caption: caption
  });
}

// ==========================================
// 🔄 ОСНОВНАЯ ПРОВЕРКА
// ==========================================
async function check() {
  console.log(`\n⏰ Проверка: ${new Date().toLocaleTimeString()}`);
  const state = loadState();

  let html;
  try {
    html = await fetchCards();
  } catch (e) {
    console.error(`🚫 Ошибка загрузки: ${e.message}`);
    return;
  }

  const cards = parseCards(html);
  if (!cards.length) {
    console.log('⚠️ Карты не найдены');
    return;
  }

  const maxId = Math.max(...cards.map(c => c.id));

  // Первый запуск — просто запоминаем id, ничего не шлём
  if (state.lastId === 0) {
    console.log(`🔍 Первый запуск. Запоминаем последний id: ${maxId}`);
    saveState({ lastId: maxId });
    return;
  }

  // Находим только новые карты (id > lastId)
  const newCards = cards
    .filter(c => c.id > state.lastId)
    .sort((a, b) => a.id - b.id); // от старых к новым

  if (!newCards.length) {
    console.log(`ℹ️ Новых карт нет (последний id: ${state.lastId})`);
    return;
  }

  console.log(`🆕 Найдено новых карт: ${newCards.length}`);

  // Обновляем lastId сразу
  saveState({ lastId: maxId });

  // Фильтруем по SEND_RANKS и отправляем
  const toSend = newCards.filter(c => SEND_RANKS.includes(c.rank));
  console.log(`📤 Карт для отправки (${SEND_RANKS.join(', ')}): ${toSend.length}`);

  for (const card of toSend) {
    const caption = RANK_TAGS[card.rank] || '#новаяUNKNOWN';
    try {
      if (card.mp4) {
        await sendVideo(card.mp4, caption);
        console.log(`🎬 Видео отправлено: ${card.name} [${card.rank}]`);
      } else {
        await sendPhoto(card.image, caption);
        console.log(`🖼 Фото отправлено: ${card.name} [${card.rank}]`);
      }
      // Задержка между отправками чтобы не флудить
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`❌ Ошибка отправки ${card.name}: ${e.message}`);
    }
  }
}

// ==========================================
// ▶️ ЗАПУСК
// ==========================================
console.log('🤖 Бот запущен');
check(); // первый запуск сразу

cron.schedule('* * * * *', check); // каждую минуту

// Чтобы Render не засыпал — простой HTTP-сервер
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(process.env.PORT || 3000);
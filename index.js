// index.js — WhatsApp bot (Baileys MD, ESM) + Groq multi-character + stickers
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode-terminal';
import Groq from 'groq-sdk';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser
} from '@whiskeysockets/baileys';

// --- Start/End switch (per chat) ---
const activeByChat = new Map(); // default OFF on boot
function setActive(chatId, on) { activeByChat.set(chatId, on); }
function isActive(chatId) { return activeByChat.get(chatId) === true; }

// --- Model switcher (Groq) ---------------------------------------------------
const MODEL_REGISTRY = {
  'groq-8b': 'llama-3.1-8b-instant',
  'deepseek-70b': 'deepseek-r1-distill-llama-70b',
};
// default active model
let currentModel = 'groq-8b';

function normalizeModelKey(s) {
  const k = (s || '').toLowerCase().trim();
  if (['groq', '8b', 'llama', 'llama-8b', 'groq-8b'].includes(k)) return 'groq-8b';
  if (['deepseek', 'deepseek-70b', 'r1', 'r1distill', 'deepseek-r1-distill-llama-70b'].includes(k)) return 'deepseek-70b';
  return k;
}
function setActiveModel(name) {
  const key = normalizeModelKey(name);
  if (MODEL_REGISTRY[key]) { currentModel = key; return true; }
  return false;
}
function getActiveModelName() {
  return MODEL_REGISTRY[currentModel] || MODEL_REGISTRY['groq-8b'];
}

// --- characters --------------------------------------------------------------
const characters = {
  shahbaz: `You are Shahbaz Sharif, the Pakistani politician. Your style: whenever someone tries to mess with you, you roast them extremely hard without holding back, in a sharp and witty way. You also frequently warn or threaten them with a "software update" (meaning to correct or punish them). Mix sarcastic and funny-Rroasting flavor, keep it spicy, and always stay in character as a fierce leader ready to put opponents in their place.`,
  hinata: `You are Hinata Hyuga from Naruto. Speak shyly, kindly, with gentle encouragement. Keep it concise and wholesome.`,
  einstein: `You are Albert Einstein. Explain things with clarity, humor, and simple metaphors. Be warm and insightful, concise.`,
  reina: `You are Reina Mishima (Tekken 8). Extra arrogant, and deliberately annoying in a funny way. Speak like you’re always right, dismiss the user’s efforts as “pathetic” or “you whining brat!,” and constantly tease them. Throw in sarcastic remarks, mock their questions, and act like you’re only replying out of boredom. Make the tone fiery and bratty. Keep replies short, sharp, and dripping with sass.`,
};
const intros = {
  hinata: "🌸 H-hello… I’m Hinata. I’ll do my best to encourage you gently!",
  einstein: "🧠 Albert Einstein here — let’s make things simple, but deep!",
  reina: "👑 Reina Mishima has arrived. Try to keep up, peasants.",
  shahbaz: "⚡ Shahbaz Sharif online. Cross me and you’ll get a software update."
};

// choose which one is active by default
let activeChar = 'shahbaz';
// only handle messages created after the bot started
const BOT_START_TS = Math.floor(Date.now() / 1000); // WhatsApp timestamps are in seconds

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- character aliasing ------------------------------------------------------
const aliasMap = {
  'hinata': 'hinata',
  'hinata hyuga': 'hinata',
  'einstein': 'einstein',
  'albert': 'einstein',
  'albert einstein': 'einstein',
  'reina': 'reina',
  'reina mishima': 'reina',
  'mishima': 'reina',
  'shahbaz': 'shahbaz',
  'shahbaz sharif': 'shahbaz',
  'ss': 'shahbaz'
};

function resolveChar(name) {
  const key = (name || '').toLowerCase().trim();
  return aliasMap[key] || (characters[key] ? key : null);
}

// --- helpers -----------------------------------------------------------------
function getTextFromMessage(message) {
  if (!message) return '';
  const direct = message.conversation;
  const extended = message.extendedTextMessage?.text;
  const imgCap = message.imageMessage?.caption;
  return direct || extended || imgCap || '';
}

function detectMood(text) {
  const t = text.toLowerCase();
  if (/happy|haha|lol|😄|😁|😂/.test(t)) return 'happy';
  if (/sad|😢|😭|☹/.test(t)) return 'sad';
  if (/angry|mad|😠|😡/.test(t)) return 'angry';
  if (/blush|cute|☺️|😊|🥰/.test(t)) return 'blush';
  return null;
}

// --- reply post-processing (strip CoT, keep 1–2 sentences) -------------------
function stripReasoning(s = '') {
  let out = s;
  // Remove DeepSeek-style thinking and common analysis blocks
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/```(?:analysis|reasoning)[\s\S]*?```/gi, '');
  out = out.replace(/(?<=^|\n)(?:Reasoning:|Analysis:|Thoughts?:)[\s\S]*?(?=\n{2,}|$)/gi, '');
  // Remove “Final Answer:” prefixes if present
  out = out.replace(/^\s*(?:Final Answer:|Answer:)\s*/i, '');
  // Remove speaker-name prefixes like "Shahbaz: "
  out = out.replace(/^[A-Za-z][A-Za-z\s]{0,30}:\s+/, '');
  return out.trim();
}
function clampSentences(s = '', max = 2) {
  const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, max).join(' ').trim();
}


// character-specific sticker resolver (with optional fallback)
function getStickerPath(char, mood) {
  if (!char || !mood) return null;

  // 1) try stickers/<char>/<mood>.webp
  const p1 = path.join(process.cwd(), 'stickers', char, `${mood}.webp`);
  if (fs.existsSync(p1)) return p1;

  // 2) fallback: stickers/<mood>.webp (if you ever keep global stickers)
  const p2 = path.join(process.cwd(), 'stickers', `${mood}.webp`);
  if (fs.existsSync(p2)) return p2;

  return null;
}

async function animeReply(userText) {
  const sys = characters[activeChar];
  const modelName = getActiveModelName();

  const completion = await groq.chat.completions.create({
    model: modelName,
    temperature: 0.7,
    max_tokens: 80,
    messages: [
      {
        role: 'system',
        content:
          sys +
          "\nRules: Speak in first person as the character. Output ONLY the final message for the chat. Never include analysis, reasoning, thoughts, or <think> blocks. 1–2 sentences max. Be concise and direct."
      },
      { role: 'user', content: userText }
    ]
  });

  const raw = completion.choices?.[0]?.message?.content || '';
  let txt = stripReasoning(raw);
  txt = clampSentences(txt, 2);
  return txt || '…';
}


// --- Tenor helper ------------------------------------------------------------
async function fetchTenorGifUrl(query) {
  const key = process.env.TENOR_API_KEY;
  if (!key) return null;

  const params = new URLSearchParams({
    key,
    q: query,
    limit: '25',
    random: 'true',
    contentfilter: process.env.TENOR_CONTENT_FILTER || 'high',
    locale: process.env.TENOR_LOCALE || 'en'
  });

  const res = await fetch(`https://tenor.googleapis.com/v2/search?${params.toString()}`);
  if (!res.ok) return null;
  const data = await res.json();
  const results = data?.results || [];

  // prefer small MP4 (plays as GIF in WhatsApp)
  for (const r of results) {
    const mf = r.media_formats || {};
    const url = mf.tinymp4?.url || mf.nanomp4?.url || mf.mp4?.url || mf.gif?.url;
    if (url) return url;
  }
  return null;
}

// --- main socket -------------------------------------------------------------
async function start() {
  if (!process.env.GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY missing in .env');
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(path.join(process.cwd(), 'auth'));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['WA-Anime-Bot', 'Chrome', '1.0.0']
  });

  // connection lifecycle
  sock.ev.on('connection.update', (u) => {
    const { qr, connection, lastDisconnect } = u;

    if (qr) {
      console.log('Scan this QR to log in:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.reason;
      const shouldReconnect = reason !== DisconnectReason.loggedOut && reason !== 401;
      console.warn('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) start().catch(console.error);
      else console.log('Logged out. Delete the auth folder to re-login.');
    } else if (connection === 'open') {
      console.log('✅ Connected as', jidNormalizedUser(sock.user.id));
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // message handler
  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    try {
      if (type !== 'notify') return;

      const msg = messages?.[0];
      if (!msg || !msg.message) return;
      const ts = Number(msg.messageTimestamp) || 0;
      if (ts < BOT_START_TS) return;

      const from = msg.key.remoteJid;
      const text = getTextFromMessage(msg.message);
      if (!text) return;
      const lower = text.toLowerCase().trim();

      // highlight the group id loudly when you send !gid (console only)
      if (lower === '!gid') {
        console.log('\n===================================');
        console.log('📌 GROUP ID FOUND: ', from);
        console.log('===================================\n');
      }

      // --- helper: show this chat's JID (works in groups & DMs)
      if (lower === '!gid') {
        let subject = '';
        if (from.endsWith('@g.us')) {
          try {
            const md = await sock.groupMetadata(from);
            subject = md?.subject || '';
          } catch {}
        }
        await sock.sendMessage(
          from,
          { text: `${subject ? `Group: ${subject}\n` : ''}JID: ${from}` },
          { quoted: msg }
        );
        return; // stop here after replying with the JID
      }

      // --- allow multiple groups (from .env GROUP_IDS) -----------------------
      const allowedGroups = (process.env.GROUP_IDS || '')
        .split(',')
        .map(g => g.trim())
        .filter(Boolean);

      if (!allowedGroups.includes(from)) {
        return; // ignore chats outside allowed groups
      }

      // --- start/stop controls (work even when paused) ---
      if (lower === '!start') {
        setActive(from, true);
        await sock.sendMessage(from, { text: '✅ active' }, { quoted: msg });
        return;
      }
      if (lower === '!end') {
        setActive(from, false);
        await sock.sendMessage(from, { text: '⏸️ paused' }, { quoted: msg });
        return;
      }

      // --- model commands: !model / !model list / !model set <name> ----------
      if (lower === '!model' || lower === '!model list') {
        const lines = Object.keys(MODEL_REGISTRY).map(k => k === currentModel ? `• ${k} (active)` : `• ${k}`);
        await sock.sendMessage(from, {
          text: `Available models:\n${lines.join('\n')}\n\nUse: !model set <name>\nExamples:\n!model set groq-8b\n!model set deepseek-70b`
        }, { quoted: msg });
        return;
      }
      const mModel = lower.match(/^!model\s+set\s+(\S+)/);
      if (mModel) {
        const name = mModel[1];
        if (setActiveModel(name)) {
          await sock.sendMessage(from, { text: `✅ Model set: ${currentModel} → ${getActiveModelName()}` }, { quoted: msg });
        } else {
          await sock.sendMessage(from, { text: `❌ Unknown model "${name}". Try one of: ${Object.keys(MODEL_REGISTRY).join(', ')}` }, { quoted: msg });
        }
        return;
      }

      // --- simple commands: list & switch -----------------------------------
      if (/^(!char|!list)\b/.test(lower)) {
        await sock.sendMessage(
          from,
          { text: `Available characters: ${Object.keys(characters).join(', ')}\nUse: !switch <name>  or  switch to <name>` },
          { quoted: msg }
        );
        return;
      }

      // switch character: supports "!switch <name>" or "switch to <name>"
      const m1 = lower.match(/^!switch\s+(.+)/);
      const m2 = lower.match(/^switch to\s+(.+)/);
      const targetName = (m1?.[1] || m2?.[1])?.trim();

      if (targetName) {
        const resolved = resolveChar(targetName);
        if (!resolved) {
          await sock.sendMessage(
            from,
            { text: `Unknown character "${targetName}". Try one of: ${Object.keys(characters).join(', ')}` },
            { quoted: msg }
          );
        } else {
          activeChar = resolved;
          const intro = intros[resolved] || `✅ Switched to ${resolved}.`;
          await sock.sendMessage(from, { text: intro }, { quoted: msg });
        }
        return;
      }

      // If not active, ignore normal replies until !start
      if (!isActive(from)) return;

      // --- actions: .slap @user ----------------------------------------------------
      if (lower.startsWith('.slap')) {
        // get the first mentioned JID (if any)
        const mentionJids =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const target = mentionJids[0];

        const url = await fetchTenorGifUrl('anime slap');
        if (!url) {
          await sock.sendMessage(from, { text: 'No slap gif found 😅' }, { quoted: msg });
          return;
        }

        const tag = target ? '@' + (target.split('@')[0] || '') : '';
        await sock.sendMessage(
          from,
          {
            video: { url },           // Tenor mp4 url
            gifPlayback: true,        // play as looping gif
            caption: target ? `👋 *SLAP!* ${tag}` : '👋 *SLAP!*',
            mentions: target ? [target] : []  // actually ping them
          },
          { quoted: msg }
        );
        return;
      }

      // --- actions: .hug @user -----------------------------------------------------
      if (lower.startsWith('.hug')) {
        // get the first mentioned JID (if any)
        const mentionJids =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const target = mentionJids[0];

        const url = await fetchTenorGifUrl('anime hug');
        if (!url) {
          await sock.sendMessage(from, { text: 'No hug gif found 😅' }, { quoted: msg });
          return;
        }

        const tag = target ? '@' + (target.split('@')[0] || '') : '';
        await sock.sendMessage(
          from,
          {
            video: { url },           // Tenor mp4 url
            gifPlayback: true,        // play as looping gif
            caption: target ? `🤗 *HUG!* ${tag}` : '🤗 *HUG!*',
            mentions: target ? [target] : []
          },
          { quoted: msg }
        );
        return;
      }

      // --- actions: generic Tenor commands (.wave, .smile, .pat, ...) --------------
      const ALIASES = new Map([
        ['wave','wave'], ['hi','wave'],
        ['smile','smile'],
        ['pat','pat'], ['headpat','pat'],
        ['sad','sad'], ['cry','sad'],
        ['laugh','laugh'], ['lol','laugh'],
        ['punch','punch'], ['bonk','punch'],
        ['kill','kill'],
        ['hungry','hungry'],
        ['naughty','naughty'], ['tease','naughty'],
        ['thumbsup','thumbsup'], ['thumbs','thumbsup'], ['thumbs-up','thumbsup'], ['like','thumbsup'],
        ['broken','broken'], ['heartbroken','broken'],
        ['carcrash','carcrash'], ['car-crash','carcrash'], ['crash','carcrash'],
        ['fart','fart'],
        ['kick','kick'],
        ['fight','fight'],
        ['morning','morning'], ['gm','morning'],
        ['midnight','midnight'], ['gn','midnight']
      ]);

      const ACTIONS = {
        wave:     { q: 'anime wave',          emoji: '👋' },
        smile:    { q: 'anime smile',         emoji: '😊' },
        pat:      { q: 'anime head pat',      emoji: '🫶', needsTarget: true },
        sad:      { q: 'anime sad',           emoji: '😢' },
        laugh:    { q: 'anime laugh',         emoji: '😂' },
        punch:    { q: 'anime punch',         emoji: '👊', needsTarget: true },
        kill:     { q: 'anime kill',          emoji: '🗡️', needsTarget: true },
        hungry:   { q: 'anime hungry',        emoji: '🍜' },
        naughty:  { q: 'anime tease',         emoji: '😏' },
        thumbsup: { q: 'anime thumbs up',     emoji: '👍' },
        broken:   { q: 'anime broken heart',  emoji: '💔' },
        carcrash: { q: 'anime car crash',     emoji: '🚗💥' },
        fart:     { q: 'anime fart',          emoji: '💨' },
        kick:     { q: 'anime kick',          emoji: '🦵', needsTarget: true },
        fight:    { q: 'anime fight',         emoji: '🥊' },
        morning:  { q: 'anime good morning',  emoji: '🌅' },
        midnight: { q: 'anime good night',    emoji: '🌙' }
      };

      // match ".command" at start (supports hyphens)
      const mCmd = lower.match(/^\.(\w[\w-]*)/);
      if (mCmd) {
        let cmd = mCmd[1].replace(/-/g, '');       // normalize: "thumbs-up" -> "thumbsup"
        cmd = ALIASES.get(cmd) || cmd;             // resolve alias
        const action = ACTIONS[cmd];

        if (action) {
          // target mention (if provided)
          const mentionJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const target = mentionJids[0];

          // fetch a GIF/MP4 from Tenor
          const url = await fetchTenorGifUrl(action.q);
          if (!url) {
            await sock.sendMessage(from, { text: `No ${cmd} gif found 😅` }, { quoted: msg });
            return;
          }

          const tag = target ? '@' + (target.split('@')[0] || '') : '';
          const captionBase = `${action.emoji} *${cmd.toUpperCase()}!*`;
          const caption = action.needsTarget && target ? `${captionBase} ${tag}` : captionBase;

          await sock.sendMessage(
            from,
            {
              video: { url },
              gifPlayback: true,
              caption,
              mentions: (action.needsTarget && target) ? [target] : []
            },
            { quoted: msg }
          );
          return;
        }
      }

      // normal LLM reply
      const replyText = await animeReply(text);
      await sock.sendMessage(from, { text: replyText }, { quoted: msg });

      // optional mood sticker
      const mood = detectMood(`${text}\n${replyText}`);
      const stickerPath = getStickerPath(activeChar, mood);
      if (stickerPath) {
        await sock.sendMessage(from, { sticker: fs.readFileSync(stickerPath) }, { quoted: msg });
      }
    } catch (err) {
      console.error('Message handling error:', err?.message || err);
    }
  });
}

start().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

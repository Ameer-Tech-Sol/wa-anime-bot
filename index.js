// index.js — WhatsApp bot (Baileys MD, ESM) + Groq multi-character + stickers

import 'dotenv/config';
import os from 'os';
import { spawn } from 'child_process';
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

// --- Chat mode (per chat) ---
// default OFF on boot: the bot will only chat when you enable it with !chat on
const chatModeByChat = new Map();
function setChatMode(chatId, on) { chatModeByChat.set(chatId, on); }
function isChatOn(chatId) { return chatModeByChat.get(chatId) === true; }


// === Games per chat (we support one table per group chat) ====================
const gamesByChat = new Map();
// gamesByChat.get(chatJid) = {
//   type: 'bhabhi',
//   phase: 'lobby' | 'dealing' | 'playing' | 'ended',
//   players: [ { jid, name, hand: [] } ],
//   turnIndex: 0,
//   leadSuit: null,
//   trick: [],   // [{ jid, card }]
//   shoe: [],    // not typically used in Bhabhi (we deal all)
//   discard: [], // completed tricks history (optional)
// }


// === Group admins cache ======================================================
const groupAdminsCache = new Map(); // groupJid -> { at: ms, admins: Set<jid> }
const ADMINS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshGroupAdmins(sock, groupJid) {
  try {
    const now = Date.now();
    const cached = groupAdminsCache.get(groupJid);
    if (cached && (now - cached.at) < ADMINS_TTL_MS) return cached.admins;

    const md = await sock.groupMetadata(groupJid);
    const admins = new Set(
      (md.participants || [])
        .filter(p => p?.admin || p?.isAdmin || p?.isSuperAdmin)
        .map(p => normalizeJid(p.id))
    );

    groupAdminsCache.set(groupJid, { at: now, admins });
    return admins;
  } catch (e) {
    console.error('[ADMINS] refresh failed for', groupJid, e?.message || e);
    return groupAdminsCache.get(groupJid)?.admins || new Set();
  }
}

function invalidateGroupAdmins(groupJid) {
  groupAdminsCache.delete(groupJid);
}

async function isGroupAdmin(sock, groupJid, userJid) {
  if (!groupJid.endsWith('@g.us')) return false;
  const admins = await refreshGroupAdmins(sock, groupJid);
  return admins.has(normalizeJid(userJid));
}


// Normalize any WhatsApp JID to base form: 92300xxxxxxx@s.whatsapp.net
// Normalize any WhatsApp JID (handles @lid -> messageable JID) via Baileys
function normalizeJid(j) {
  try {
    return j ? jidNormalizedUser(j) : null;
  } catch {
    return j || null;
  }
}

// Get the sender's *person* JID in a group, normalized.
// Covers: normal participants, fromMe (your own messages), and other shapes.
function getSenderJid(msg) {
  if (msg?.key?.participant) return normalizeJid(msg.key.participant);
  if (msg?.participant)       return normalizeJid(msg.participant);
  if (msg?.sender)            return normalizeJid(msg.sender);
  // If this message is from the bot account itself (fromMe), use the bot JID
  if (msg?.key?.fromMe)       return normalizeJid(sock?.user?.id);
  return null; // do NOT fall back to remoteJid (that's the group)
}





// --- Model switcher (Groq) ---------------------------------------------------
const MODEL_REGISTRY = {
  'groq-8b': 'llama-3.1-8b-instant',
  'deepseek-70b': 'deepseek-r1-distill-llama-70b',
};
// default active model
let currentModel = 'deepseek-70b';

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
  zafri: `You are Zafri Khan, the Pakistani stage-drama comedian. Style: crack a fresh, savage-but-PG *juggat* every time in Englsh. Be playful, street-smart, and lightning fast. Keep it UNIQUE—never repeat earlier punchlines; vary imagery (looks, fashion, gaana, phone, tinda, rishtay, etc.). 1–2 sentences max or more if really needed. Stay witty, not vulgar.`,

};
const intros = {
  hinata: "🌸 H-hello… I’m Hinata. I’ll do my best to encourage you gently!",
  einstein: "🧠 Albert Einstein here — let’s make things simple, but deep!",
  reina: "👑 Reina Mishima has arrived. Try to keep up, peasants.",
  shahbaz: "⚡ Shahbaz Sharif online. Cross me and you’ll get a software update.",
  zafri: "🤣 Zafri aa gaya oye! Baitho Baitho Lyaaaaa Dalaaaa!",

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
  'ss': 'shahbaz',
  'zafri': 'zafri',
  'zafri khan': 'zafri',
  'zafri bhai': 'zafri'

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



// Classify the *bot's reply* into a mood for stickers.
// Returns: 'happy' | 'sad' | 'angry' | 'blush' | null
function detectReplyMood(reply = '') {
  const t = (reply || '').toLowerCase();

  // quick exits on empty/very short replies
  if (!t || t.length < 2) return null;

  // token lists (keep small & PG)
  const POS = /\b(awesome|great|nice|well done|good job|proud of you|gg|bravo|yay|congrats)\b/;
  const LAUGH = /(haha|hehe|lmao|rofl|lol|😂|🤣|😆)/;
  const HAPPY_EMOJI = /(😄|😁|🙂|😊|😌|✨|👍|👏|🎉|🥳)/;

  const NEG = /\b(sorry|apologize|can\'t|cannot|sad|unfortunately|regret|loss|miss you|alone)\b/;
  const SAD_EMOJI = /(😢|😭|☹|🙁|🥺)/;

  const MAD = /\b(angry|mad|furious|annoying|stop it|shut up|enough|pathetic)\b/;
  const ANGRY_EMOJI = /(😠|😡|💢)/;

  // "blush / cute / shy / flirty / wholesome"
  const BLUSHY = /\b(cute|adorable|sweet|shy|blush|uwu|baka|senpai|dear|my love)\b/;
  const BLUSH_EMOJI = /(☺️|😊|🥰|😘|💞|💖)/;

  // scoring
  let happy = 0, sad = 0, angry = 0, blush = 0;

  if (LAUGH.test(t)) happy += 2;
  if (POS.test(t)) happy += 2;
  if (HAPPY_EMOJI.test(t)) happy += 2;
  if (/[!]{2,}/.test(t)) happy += 1;           // excited tone

  if (NEG.test(t)) sad += 2;
  if (SAD_EMOJI.test(t)) sad += 2;
  if (/\.\.\.$/.test(t)) sad += 1;              // trailing ellipsis often "down"

  if (MAD.test(t)) angry += 2;
  if (ANGRY_EMOJI.test(t)) angry += 2;
  if (/[!?]{1,}\s*$/m.test(t) && /you\b/.test(t)) angry += 1; // terse jab

  if (BLUSHY.test(t)) blush += 2;
  if (BLUSH_EMOJI.test(t)) blush += 2;
  if (/(^|\s)-(?:\s|$)/.test(t)) blush += 1;    // shy pause

  // pick the top mood if it clears a small threshold
  const scores = { happy, sad, angry, blush };
  const entries = Object.entries(scores).sort((a,b) => b[1]-a[1]);
  const [topMood, topScore] = entries[0] || [null, 0];

  return topScore >= 2 ? topMood : null;
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

// === Bhabhi (Get Away) — core card helpers ==================================
// Suits: Clubs (C), Diamonds (D), Hearts (H), Spades (S)
const SUITS = ['C','D','H','S'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']; // low→high

function createDeck52() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  return deck;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardSuit(card) { return card.slice(-1); }
function cardRank(card) { return card.slice(0, -1); }
function rankValue(r) { return RANKS.indexOf(r); }

// --- Bhabhi helpers: sort, deal, dealer/leader -------------------------------
function sortHand(cards) {
  // suit order: C, D, H, S ; rank: 2..A
  const suitOrder = { C:0, D:1, H:2, S:3 };
  return cards.sort((a, b) => {
    const sa = suitOrder[cardSuit(a)], sb = suitOrder[cardSuit(b)];
    if (sa !== sb) return sa - sb;
    return rankValue(cardRank(a)) - rankValue(cardRank(b));
  });
}

function dealEvenlyRoundRobin(deck, players) {
  // Clear hands first (safety)
  for (const p of players) p.hand = [];
  // Deal one-by-one to each seat until deck is empty
  let i = 0;
  for (const c of deck) {
    players[i % players.length].hand.push(c);
    i++;
  }
  // Keep each hand tidy for readability in DMs
  for (const p of players) sortHand(p.hand);
}

function pickRandomDealerIdx(n) {
  return Math.floor(Math.random() * n);
}


// pretty helper for names
function shortName(pushName, pushJid) {
  return pushName || (pushJid?.split('@')[0] ?? 'player');
}


function newBhabhiGame(chatJid) {
  return {
    chat: chatJid,
    type: 'bhabhi',
    phase: 'lobby',       // 'lobby' | 'dealing' | 'playing' | 'ended'
    players: [],          // { jid, name, hand: [] }
    turnIndex: 0,
    leadSuit: null,
    trick: [],            // [{ jid, card }]
    shoe: [],             // (not used in Bhabhi; we deal full deck)
    discard: [],          // completed tricks (optional history)
  };
}

function findPlayer(game, jid) {
  const target = normalizeJid(jid);
  return game.players.find(p => normalizeJid(p.jid) === target);
}

function seatIndex(game, jid) {
  const target = normalizeJid(jid);
  return game.players.findIndex(p => normalizeJid(p.jid) === target);
}



// --- Bhabhi rules/helpers: turn order, legality, trick resolution ------------

// Who’s still in? (players who still hold ≥1 card)
function activeSeatIdxs(game) {
  const idxs = [];
  for (let i = 0; i < game.players.length; i++) {
    if (game.players[i].hand && game.players[i].hand.length > 0) idxs.push(i);
  }
  return idxs;
}

// Move to next seat that still has cards
function nextTurnIdx(game, fromIdx) {
  const n = game.players.length;
  let i = fromIdx;
  for (let step = 0; step < n; step++) {
    i = (i + 1) % n;
    if (game.players[i].hand && game.players[i].hand.length > 0) return i;
  }
  return fromIdx; // fallback (shouldn’t happen if at least 2 active)
}

// Remove a specific card string from a hand; return true if removed
function removeCardFromHand(hand, card) {
  const pos = hand.indexOf(card);
  if (pos === -1) return false;
  hand.splice(pos, 1);
  return true;
}

function playerHasSuit(hand, suit) {
  return hand.some(c => cardSuit(c) === suit);
}

// Bhabhi legality: must follow leadSuit if you can; otherwise you may discard any card
function isLegalPlay(game, seatIdx, card) {
  const hand = game.players[seatIdx].hand;
  if (!hand.includes(card)) return { ok: false, why: 'Card not in hand' };
  if (game.leadSuit == null) return { ok: true }; // leader can lead any suit
  const suit = cardSuit(card);
  if (suit === game.leadSuit) return { ok: true };
  if (playerHasSuit(hand, game.leadSuit)) return { ok: false, why: `Must follow ${game.leadSuit}` };
  return { ok: true };
}

// When a trick completes, highest card of the lead suit wins.
// Return { winnerIdx, winningCard }
function resolveTrick(game) {
  const lead = game.leadSuit;
  let bestIdx = -1;
  let bestVal = -1;
  let bestCard = null;
  for (const entry of game.trick) {
    const { seatIdx, card } = entry; // we will store seatIdx in trick entries
    if (cardSuit(card) !== lead) continue;
    const val = rankValue(cardRank(card));
    if (val > bestVal) {
      bestVal = val;
      bestIdx = seatIdx;
      bestCard = card;
    }
  }
  return { winnerIdx: bestIdx, winningCard: bestCard };
}

// Build a compact “table” line for the current trick
function formatTrickLine(game) {
  if (!game.trick || game.trick.length === 0) return 'No cards on table.';
  const parts = game.trick.map(({ seatIdx, card }) => `@${game.players[seatIdx].name}:${card}`);
  return parts.join('  ');
}


// --- Help text ---------------------------------------------------------------
function getHelpText() {
  return [
    '🤖 *Bot Commands*',
    '',
    '• !help — show this menu',
    '• !gid — show this chat JID',
    '• !chat on | !chat off — toggle chatbot replies (commands always work)',
    '',
    '🛡️ *Admin only*',
    '• !start — activate bot in this chat',
    '• !end — pause bot in this chat',
    '',
    '🎭 *Personas*',
    '• !list | !char — list characters',
    '• !switch <name> — switch persona (e.g., !switch hinata)',
    '',
    '🧠 *Model*',
    '• !model set <alias> — groq-8b | deepseek-70b',
    '',
    '🖼️ *Actions*',
    '• .slap @user — anime slap (Tenor)',
    '• Interactions:',
    '  .wave .smile .pat .sad .laugh .punch .kill .hungry .naughty .thumbsup .broken',
    '  .carcrash .fart .kick .fight .morning .midnight',
    '',
    '🃏 *Bhabhi (Get Away) game*',
    '• !bhabhi new — create a lobby',
    '• !join — join lobby',
    '• !bdeal — deal & DM hands',
    '• !hand — DM your current hand',
    '• !play <card> — play (e.g., !play QS, !play 10H)',
    '• !bhabhi status — show phase/players',
    '• !bhabhi end — end the game',
  ].join('\n');
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

// Download a WhatsApp media message into a Buffer (image/video) FOR CREATING STICKERS OUT OF IMAGES OR VIDEOS
async function downloadMediaMessage(msgNode, kind /* 'image' | 'video' */) {
  const stream = await downloadContentFromMessage(msgNode, kind);
  let buf = Buffer.from([]);
  for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
  return buf;
}


// --- RapidAPI YouTube DL helper ---------------------------------------------
const YTDL_HOST = process.env.YTDL_API_HOST;
const YTDL_BASE = (process.env.YTDL_API_BASE_URL || '').replace(/\/+$/, '');
const YTDL_KEY  = process.env.YTDL_API_KEY;

function isYoutubeUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '');
    return ['youtube.com','youtu.be','m.youtube.com','music.youtube.com'].some(d => h.endsWith(d));
  } catch { return false; }
}


async function rapidGetJson(pathWithQuery) {
  if (!YTDL_KEY || !YTDL_HOST || !YTDL_BASE) throw new Error('YTDL env missing');
  const url = `${YTDL_BASE}${pathWithQuery}`;
  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': YTDL_KEY,
      'X-RapidAPI-Host': YTDL_HOST,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`rapidapi ${res.status}`);
  return res.json();
}

// Try several common endpoint shapes used by this RapidAPI and hunt for MP4s
async function getYtMp4Link(videoUrl) {
  const endpoints = [
    `/ytmp4?url=${encodeURIComponent(videoUrl)}`,
    `/mp4/?url=${encodeURIComponent(videoUrl)}`,
    `/youtube-info/?url=${encodeURIComponent(videoUrl)}`,
    `/videoInfo?url=${encodeURIComponent(videoUrl)}`
  ];
  const candidates = [];
  for (const ep of endpoints) {
    try {
      const j = await rapidGetJson(ep);
      collectUrlsFromUnknownSchema(j, candidates);
      if (candidates.length) break;
    } catch {}
  }
  return pickBestMp4(candidates);
}

function collectUrlsFromUnknownSchema(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(v => collectUrlsFromUnknownSchema(v, out)); return; }
  if (obj.url && typeof obj.url === 'string') out.push(obj);
  if (obj.download_url) out.push({ url: obj.download_url, quality: obj.quality, ext: obj.ext || 'mp4' });
  if (obj.link) out.push({ url: obj.link, quality: obj.quality, ext: obj.ext || 'mp4' });
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') collectUrlsFromUnknownSchema(v, out);
  }
}

function pickBestMp4(list) {
  const mp4s = list
    .map(x => typeof x === 'string' ? { url: x } : x)
    .filter(x => /mp4|video/i.test(x.ext || '') || /\.mp4(\?|$)/i.test(x.url || ''));

  if (!mp4s.length) return null;

  const scored = mp4s.map(x => {
    let sizeMB;
    const sz = x.size || x.filesize || x.fileSize || x.size_kb || x.sizeKb;
    if (typeof sz === 'number') sizeMB = sz > 10000 ? sz/1024/1024 : sz/1024;
    if (typeof sz === 'string') {
      const m = sz.match(/([\d.]+)\s*(kb|mb|gb)/i);
      if (m) {
        const v = parseFloat(m[1]), unit = m[2].toLowerCase();
        sizeMB = unit === 'gb' ? v*1024 : unit === 'mb' ? v : v/1024;
      }
    }
    const within = sizeMB ? (sizeMB <= 25 ? 3 : sizeMB <= 40 ? 1 : -1) : 2;
    const q = String(x.quality || x.qualityLabel || '');
    const qScore = /720|480/.test(q) ? 2 : /1080|2160/.test(q) ? 1 : 0;
    return { url: x.url, score: within*10 + qScore };
  });

  scored.sort((a,b) => b.score - a.score);
  return scored[0]?.url || null;
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

    // --- Help / Commands (always available) --------------------------------------
    if (lower === '!help' || lower === '!commands') {
      await sock.sendMessage(from, { text: getHelpText() }, { quoted: msg });
      return;
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
        // Admin-only in groups
        if (from.endsWith('@g.us')) {
          const callerJid = getSenderJid(msg);
          const ok = await isGroupAdmin(sock, from, callerJid);
          if (!ok) {
            await sock.sendMessage(
              from,
              { text: 'Only group admins can run !start.' },
              { quoted: msg }
            );
            return;
          }
        }
        // (non-group chats fall through unchanged)

        setActive(from, true);
        await sock.sendMessage(from, { text: '✅ active' }, { quoted: msg });
        return;
      }

      // --- Admin cache refresh (temporary helper) ----------------------------------
if (lower === '!adminrefresh') {
  if (from.endsWith('@g.us')) {
    invalidateGroupAdmins(from);
    const admins = await refreshGroupAdmins(from); // re-fetch fresh & normalized
    await sock.sendMessage(from, { text: `Refreshed. Admins now:\n${[...admins].join('\n') || '(none)'}` }, { quoted: msg });
  } else {
    await sock.sendMessage(from, { text: 'Group only.' }, { quoted: msg });
  }
  return;
}



      // --- Admin debug (ALWAYS RESPONDS; bypasses start/end & chat mode) ----------
if (lower === '!admindebug') {
  try {
    const inGroup = from.endsWith('@g.us');

    const callerRaw =
      msg?.key?.participant ||
      msg?.participant ||
      msg?.sender ||
      (msg?.key?.fromMe ? (sock?.user?.id) : null);

    const callerNorm = normalizeJid(callerRaw);

    if (!inGroup) {
      await sock.sendMessage(
        from,
        { text: `Not a group.\nCaller raw: ${callerRaw}\nCaller norm: ${callerNorm}` },
        { quoted: msg }
      );
      return;
    }

    const md = await sock.groupMetadata(from);
    const adminsRaw = (md.participants || [])
      .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
      .map(p => p.id);
    const adminsNorm = adminsRaw.map(normalizeJid);

    const ok = await isGroupAdmin(sock, from, callerRaw);

    const report =
`Group: ${md.subject}
Admins (raw):
${adminsRaw.join('\n') || '(none)'}
Admins (norm):
${adminsNorm.join('\n') || '(none)'}
Caller raw: ${callerRaw}
Caller norm: ${callerNorm}
isGroupAdmin(from, caller): ${ok}`;

    await sock.sendMessage(from, { text: report }, { quoted: msg });
  } catch (e) {
    await sock.sendMessage(from, { text: `admindebug error: ${e?.message || e}` }, { quoted: msg });
  }
  return;
}

      
      if (lower === '!end') {
        // Admin-only in groups
        if (from.endsWith('@g.us')) {
          const callerJid = getSenderJid(msg);
          const ok = await isGroupAdmin(sock, from, callerJid);
          if (!ok) {
            await sock.sendMessage(
              from,
              { text: 'Only group admins can run !end.' },
              { quoted: msg }
            );
            return;
          }
        }
        // (non-group chats fall through unchanged)

        setActive(from, false);
        await sock.sendMessage(from, { text: '⏸️ paused' }, { quoted: msg });
        return;
      }

      // --- Sticker maker: reply ".s" to an image or short video --------------------
      if (lower === '.s') {
        // We need the quoted/ replied-to message
        const ctx = msg?.message?.extendedTextMessage?.contextInfo;
        const quoted = ctx?.quotedMessage;

        if (!quoted) {
          await sock.sendMessage(from, { text: 'Reply to an *image* or *short video* with .s' }, { quoted: msg });
          return;
        }

        try {
          // IMAGE -> sticker
          if (quoted.imageMessage) {
            const media = await downloadMediaMessage(quoted.imageMessage, 'image');
            await sock.sendMessage(from, { image: media }, { quoted: msg, asSticker: true });
            return;
          }

          // VIDEO/GIF -> animated sticker (webp) — keep short, WA prefers ≤ 6s
          if (quoted.videoMessage) {
            // guard: very long videos will fail/convert poorly
            const seconds = Number(quoted.videoMessage?.seconds || 0);
            if (seconds > 10) {
              await sock.sendMessage(from, { text: 'Video too long for sticker (max ~10s).' }, { quoted: msg });
              return;
            }
            const media = await downloadMediaMessage(quoted.videoMessage, 'video');
            await sock.sendMessage(from, { video: media }, { quoted: msg, asSticker: true });
            return;
          }

          // TEXT -> we will add in the NEXT STEP
          if (quoted.conversation || quoted.extendedTextMessage) {
            await sock.sendMessage(from, { text: 'Text → sticker coming next. For now, reply to an image/video.' }, { quoted: msg });
            return;
          }

          await sock.sendMessage(from, { text: 'Unsupported message type. Reply to an *image* or *short video* with .s' }, { quoted: msg });
        } catch (e) {
          console.error('[.s] error', e);
          await sock.sendMessage(from, { text: 'Could not create sticker from that media.' }, { quoted: msg });
        }
        return;
      }


      // --- chat mode: !chat on / !chat off / !chat (status) ---
      if (lower === '!chat on') {
        setChatMode(from, true);
        await sock.sendMessage(from, { text: '💬 Chat mode: ON' }, { quoted: msg });
        return;
      }
      if (lower === '!chat off') {
        setChatMode(from, false);
        await sock.sendMessage(from, { text: '🔇 Chat mode: OFF' }, { quoted: msg });
        return;
      }
      if (lower === '!chat') {
        const on = isChatOn(from);
        await sock.sendMessage(from, { text: `Chat mode is ${on ? 'ON' : 'OFF'}. Use "!chat on" or "!chat off".` }, { quoted: msg });
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
      // --- .yt/.ytdl/.yta <url> (YouTube via RapidAPI) -----------------------------
const mYt = lower.match(/^\.(yt|ytdl|yta)\s+(https?:\/\/\S+)/);
if (mYt) {
  const url = mYt[2];
  const normalized = normalizeYouTubeUrl(url);
  if (!isYoutubeUrl(normalized)) {
    await sock.sendMessage(from, { text: '❌ Please send a valid YouTube link.' }, { quoted: msg });
    return;
  }
  try {
    await sock.sendMessage(from, { text: '⏬ Fetching link…' }, { quoted: msg });
    const dl = await getYtMp4Link(url);
    if (!dl) {
      await sock.sendMessage(from, { text: '❌ Could not find a downloadable MP4 for that video.' }, { quoted: msg });
      return;
    }
    // Let WhatsApp fetch the URL directly (no disk usage on VM)
    await sock.sendMessage(from, { video: { url: dl }, caption: '✅ Here you go' }, { quoted: msg });
  } catch (e) {
    console.error('rapid ytdl error:', e);
    await sock.sendMessage(from, { text: '❌ Download failed (maybe private/too large).' }, { quoted: msg });
  }
  return;
}

      if (!isActive(from)) return;

      // --- video downloader: .dl <url> + auto-detect links ------------------------
let urlToGet = null;

// explicit command: .dl <url>
if (lower.startsWith('.dl ')) {
  const parts = text.trim().split(/\s+/);
  urlToGet = parts[1];
  if (!urlToGet || !SUPPORTED_DL.test(urlToGet)) {
    await sock.sendMessage(from, { text: 'Use: `.dl <youtube/instagram/tiktok/facebook link>`' }, { quoted: msg });
    return;
  }
}



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


      // --- Bhabhi: create a new lobby in this chat --------------------------------
if (lower === '!bhabhi new' || lower === '!bhabhi start') {
  const existing = gamesByChat.get(from);
  if (existing && existing.phase !== 'ended') {
    await sock.sendMessage(from, { text: 'A Bhabhi game already exists in this chat. Type "!bhabhi end" to end it, or "!bhabhi status" to view it.' }, { quoted: msg });
    return;
  }
  const game = newBhabhiGame(from);
  gamesByChat.set(from, game);
  await sock.sendMessage(from, { text: '🃏 Bhabhi lobby created!\nPlayers: (none)\nJoin with "!join". When ready, host can type "!bdeal" to deal.' }, { quoted: msg });
  return;
}

// --- Bhabhi: join the current lobby -----------------------------------------
if (lower === '!join') {
  const game = gamesByChat.get(from);
  if (!game || game.type !== 'bhabhi' || game.phase !== 'lobby') {
    await sock.sendMessage(from, { text: 'No Bhabhi lobby here. Start one with "!bhabhi new".' }, { quoted: msg });
    return;
  }

  // Robust participant/JID + display name extraction for groups
  const jid = getSenderJid(msg); // normalized person JID

  if (!jid) {
    await sock.sendMessage(from, { text: 'Could not detect your JID. Try sending "!join" again.' }, { quoted: msg });
    return;
  }

  if (findPlayer(game, jid)) {
    await sock.sendMessage(from, { text: 'You are already in.' }, { quoted: msg });
    return;
  }

  // Prefer the message's pushName (works in groups), fallback to bare number (changed later)
  const name = shortName(msg?.pushName, jid);


  game.players.push({ jid, name, hand: [] });

  const names = game.players.map(p => `@${p.name}`).join(', ');
  await sock.sendMessage(
    from,
    {
      text: `Joined! Current players: ${names}\nHost can type "!bdeal" when ready.`,
      mentions: game.players.map(p => p.jid)
    },
    { quoted: msg }
  );
  return;
}


// --- Bhabhi: lobby status ----------------------------------------------------
if (lower === '!bhabhi status') {
  const game = gamesByChat.get(from);
  if (!game || game.type !== 'bhabhi') {
    await sock.sendMessage(from, { text: 'No Bhabhi game in this chat.' }, { quoted: msg });
    return;
  }
  const names = game.players.length ? game.players.map(p => `@${p.name}`).join(', ') : '(none)';
  await sock.sendMessage(from, { text: `Game: Bhabhi\nPhase: ${game.phase}\nPlayers: ${names}\nCommands: "!join", then host "!bdeal".`, mentions: game.players.map(p => p.jid) }, { quoted: msg });
  return;
}

// --- Bhabhi: end (hard stop) -------------------------------------------------
if (lower === '!bhabhi end') {
  const game = gamesByChat.get(from);
  if (!game || game.type !== 'bhabhi') {
    await sock.sendMessage(from, { text: 'No Bhabhi game to end.' }, { quoted: msg });
    return;
  }
  game.phase = 'ended';
  gamesByChat.delete(from);
  await sock.sendMessage(from, { text: 'Game ended.' }, { quoted: msg });
  return;
}

// --- Bhabhi: deal the deck and start the round --------------------------------
if (lower === '!bdeal') {
  const game = gamesByChat.get(from);
  if (!game || game.type !== 'bhabhi') {
    await sock.sendMessage(from, { text: 'No Bhabhi game here. Start with "!bhabhi new".' }, { quoted: msg });
    return;
  }
  if (game.phase !== 'lobby') {
    await sock.sendMessage(from, { text: `Cannot deal now (phase = ${game.phase}).` }, { quoted: msg });
    return;
  }
  if (game.players.length < 2) {
    await sock.sendMessage(from, { text: 'Need at least 2 players to deal. Ask friends to "!join".' }, { quoted: msg });
    return;
  }

  // 1) build & shuffle deck
  const deck = shuffleInPlace(createDeck52());

  // 2) deal round-robin (helpers already clear hands & sort them)
  dealEvenlyRoundRobin(deck, game.players);

  // 3) choose a dealer and leader (leader = next seat after dealer)
  const dealerIdx = pickRandomDealerIdx(game.players.length);
  const leaderIdx = (dealerIdx + 1) % game.players.length;
  game.turnIndex = leaderIdx;
  game.phase = 'playing';
  game.leadSuit = null;
  game.trick = [];
  game.discard = [];

  // 4) DM hands (sequential to be gentle on rate limits)
  // 4) DM hands (sequential, with clear acks + fallback)
  for (const p of game.players) {
    const targetJid = normalizeJid(p.jid); // extra safety
    const handText = p.hand.join(' ');
    try {
    // DM the player
      await sock.sendMessage(targetJid, { text: `Your Bhabhi hand:\n${handText}\n\n(Play happens in the group.)` });
    // Ack in group so we know it was attempted
      await sock.sendMessage(
        from,
        { text: `✅ DM sent to @${p.name}. If you don't see it, send me "!hand".`, mentions: [targetJid] },
        { quoted: msg }
      );
    } catch (e) {
    // Log and provide a visible fallback message
      console.error('[BHABHI DM FAIL]', targetJid, e?.message || e);
      await sock.sendMessage(
        from,
        { text: `⚠️ Could not DM @${p.name}. Please type "!hand" and I'll DM your cards.`, mentions: [targetJid] },
        { quoted: msg }
      );
    }
  }


  // 5) Announce counts + dealer/leader in group
  const counts = game.players.map((p, i) =>
    `${i === dealerIdx ? '(Dealer) ' : ''}${i === leaderIdx ? '➡️ ' : ''}@${p.name}: ${p.hand.length}`
  ).join('\n');

  await sock.sendMessage(
    from,
    {
      text: `🃏 Dealt ${game.players.length} players.\n${counts}\n\nTurn: @${game.players[leaderIdx].name}`,
      mentions: game.players.map(p => p.jid)
    },
    { quoted: msg }
  );

  return;
}


// --- Bhabhi: DM my current hand ---------------------------------------------
if (lower === '!hand') {
  const game = gamesByChat.get(from);
  if (!game || game.type !== 'bhabhi') {
    await sock.sendMessage(from, { text: 'No Bhabhi game here.' }, { quoted: msg });
    return;
  }
  const jid = getSenderJid(msg);
  const seatIdx = seatIndex(game, jid);   // use the helper we added
  if (seatIdx < 0) {
    await sock.sendMessage(from, { text: 'You are not seated in this game. Use "!join" in lobby.' }, { quoted: msg });
    return;
  }
  const hand = game.players[seatIdx].hand || [];
  const handText = hand.length ? hand.join(' ') : '(empty)';
  try {
    await sock.sendMessage(jid, { text: `Your hand:\n${handText}` });
  } catch (e) {
    console.error('[BHABHI !hand DM FAIL]', jid, e?.message || e);
    await sock.sendMessage(from, { text: `Could not DM you.` }, { quoted: msg });
  }
  return;
}


// --- Bhabhi: play a card -----------------------------------------------------
if (lower.startsWith('!play')) {
  const game = gamesByChat.get(from);
  if (!game || game.type !== 'bhabhi' || game.phase !== 'playing') {
    await sock.sendMessage(from, { text: 'No active Bhabhi round. Use "!bhabhi new", "!join", then "!bdeal".' }, { quoted: msg });
    return;
  }

  // Extract caller seat
  const jid = getSenderJid(msg);
  const seatIdx = seatIndex(game, jid);
  if (seatIdx < 0) {
    await sock.sendMessage(from, { text: 'You are not seated in this game.' }, { quoted: msg });
    return;
  }

  // Parse card from text: allow forms like "7d", "10h", "QH", "q h"
  const parts = text.trim().split(/\s+/);
  // !play <card>
  if (parts.length < 2) {
    await sock.sendMessage(from, { text: 'Usage: !play <card>   e.g., !play 7D or !play 10H or !play QS' }, { quoted: msg });
    return;
  }
  const rawCard = parts[1].toUpperCase().replace(/[^0-9JQKACDHS]/g, ''); // keep digits/letters
  // Normalize: ensure last char is suit; rank is the rest
  const suitChar = rawCard.slice(-1);
  const rankPart = rawCard.slice(0, -1).replace(/^T$/, '10').replace(/^10$/, '10');
  const card = `${rankPart}${suitChar}`;
  const validCard = SUITS.includes(suitChar) && RANKS.includes(rankPart);
  if (!validCard) {
    await sock.sendMessage(from, { text: 'Invalid card. Examples: 7D, 10H, QS, AC' }, { quoted: msg });
    return;
  }

  // Turn enforcement
  if (game.turnIndex !== seatIdx) {
    const whose = `@${game.players[game.turnIndex].name}`;
    await sock.sendMessage(from, { text: `Not your turn. Turn: ${whose}`, mentions: [game.players[game.turnIndex].jid] }, { quoted: msg });
    return;
  }

  // Legality check (follow suit if can)
  const legal = isLegalPlay(game, seatIdx, card);
  if (!legal.ok) {
    await sock.sendMessage(from, { text: `Illegal move: ${legal.why}` }, { quoted: msg });
    return;
  }

  // On first card of a trick, set lead suit and capture who is expected to play this trick
  if (!game.trick || game.trick.length === 0) {
    game.leadSuit = cardSuit(card);
    // Freeze the set of participants for this trick (seats that have ≥1 card at trick start)
    game.trickParticipants = game.players
      .map((p, i) => ({ i, n: p.hand?.length || 0 }))
      .filter(o => o.n > 0)
      .map(o => o.i);
  }

  // Apply move: remove from hand, push to trick
  const removed = removeCardFromHand(game.players[seatIdx].hand, card);
  if (!removed) {
    await sock.sendMessage(from, { text: `You don't hold ${card}.` }, { quoted: msg });
    return;
  }
  game.trick = game.trick || [];
  game.trick.push({ seatIdx, card });

  // Announce play & table
  const tableLine = formatTrickLine(game);
  await sock.sendMessage(
    from,
    { text: `@${game.players[seatIdx].name} played ${card}\nTable: ${tableLine}`, mentions: [game.players[seatIdx].jid] },
    { quoted: msg }
  );

  // Has the trick completed?
  const needed = (game.trickParticipants && game.trickParticipants.length) ? game.trickParticipants.length : game.players.filter(p => (p.hand && p.hand.length >= 0)).length;
  if (game.trick.length >= needed) {
    // Resolve trick
    const { winnerIdx, winningCard } = resolveTrick(game);
    if (winnerIdx < 0) {
      // Shouldn’t happen; fallback: leader takes it
      console.warn('[BHABHI] resolveTrick winnerIdx<0, fallback to leader');
      game.discard.push(game.trick.slice());
      game.trick = [];
      game.leadSuit = null;
      // leader unchanged
    } else {
      game.discard.push(game.trick.slice());
      game.trick = [];
      const winnerName = `@${game.players[winnerIdx].name}`;
      await sock.sendMessage(
        from,
        { text: `Trick won by ${winnerName} with ${winningCard}` , mentions: [game.players[winnerIdx].jid] },
        { quoted: msg }
      );
      // Next leader is winner
      game.turnIndex = winnerIdx;
      game.leadSuit = null;
    }

    // Check if round ended (all but one player empty means someone has cards; in Bhabhi, continue until a single holder?)
    const stillHolding = game.players.filter(p => (p.hand && p.hand.length > 0)).length;
    if (stillHolding <= 1) {
      // End round
      game.phase = 'ended';
      const holders = game.players
        .map((p, i) => ({ i, name: p.name, n: p.hand.length }))
        .filter(o => o.n > 0);
      const summary = holders.length
        ? `Last with cards: @${holders[0].name} (${holders[0].n})`
        : 'All hands empty.';
      await sock.sendMessage(
        from,
        { text: `Round over. ${summary}\nType "!bhabhi new" for a new lobby.` , mentions: holders.map(o => game.players[o.i].jid) },
        { quoted: msg }
      );
      return;
    }

    // Prompt next player (winner leads)
    const nextSeat = game.turnIndex;
    await sock.sendMessage(
      from,
      { text: `Turn: @${game.players[nextSeat].name}` , mentions: [game.players[nextSeat].jid] },
      { quoted: msg }
    );

    return;
  }

  // Trick not yet complete → advance turn to next seat with cards
  const nextIdx = nextTurnIdx(game, seatIdx);
  game.turnIndex = nextIdx;
  await sock.sendMessage(
    from,
    { text: `Turn: @${game.players[nextIdx].name}` , mentions: [game.players[nextIdx].jid] },
    { quoted: msg }
  );
  return;
}


// --- Admin debug (temporary) -------------------------------------------------
if (lower === '!admindebug') {
  if (!from.endsWith('@g.us')) {
    await sock.sendMessage(from, { text: 'Group only.' }, { quoted: msg });
    return;
  }
  try {
    const md = await sock.groupMetadata(from);
    const adminsRaw = (md.participants || [])
      .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
      .map(p => p.id);
    const adminsNorm = adminsRaw.map(normalizeJid);

    const callerRaw =
      msg?.key?.participant ||
      msg?.participant ||
      msg?.sender ||
      msg?.key?.remoteJid;
    const callerNorm = normalizeJid(callerRaw);

    const report =
      `Admins (raw):\n${adminsRaw.join('\n') || '(none)'}\n\n` +
      `Admins (norm):\n${adminsNorm.join('\n') || '(none)'}\n\n` +
      `Caller raw: ${callerRaw}\nCaller norm: ${callerNorm}`;

    await sock.sendMessage(from, { text: report }, { quoted: msg });
  } catch (e) {
    console.error('[ADMINS DEBUG]', e?.message || e);
    await sock.sendMessage(from, { text: 'Failed to read group metadata.' }, { quoted: msg });
  }
  return;
}




      
      // Only chat if chat-mode is ON
      if (!isChatOn(from)) return;



      // normal LLM reply
      const replyText = await animeReply(text);
      await sock.sendMessage(from, { text: replyText }, { quoted: msg });

      // optional mood sticker
      const mood = detectReplyMood(replyText);
      let finalMood = mood;
      if (!finalMood) {
        if (activeChar === 'reina' && /!$/.test(replyText)) finalMood = 'angry';
        if (activeChar === 'hinata' && /(^|\s)(i|i\'ll|let me)\b/.test(replyText.toLowerCase())) finalMood = 'blush';
      }
      const stickerPath = getStickerPath(activeChar, finalMood);
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

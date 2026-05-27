import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import pkg from '@whiskeysockets/baileys';
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = pkg;
import { Boom } from '@hapi/boom';
import pino from 'pino';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { handleMessage } from './lib/router.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Supabase Setup ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SESSION_ID = 'adez-tech-session';
const SESSION_DIR = path.join(__dirname, 'session');

// ─── Express + Socket.IO Setup ────────────────────────────────────
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    bot: process.env.BOT_NAME || 'ADEZ TECH',
    timestamp: new Date().toISOString()
  });
});

app.get('/pair', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

httpServer.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// ─── Supabase Session Functions ───────────────────────────────────
async function saveSessionToSupabase() {
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(SESSION_DIR);
    const zipBuffer = zip.toBuffer();
    const base64Data = zipBuffer.toString('base64');

    const { error } = await supabase
      .from('bu_sessions')
      .upsert({ id: SESSION_ID, data: base64Data });

    if (error) throw error;
    console.log('💾 Session saved to Supabase');
  } catch (err) {
    console.error('❌ Failed to save session:', err.message);
  }
}

async function loadSessionFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('bu_sessions')
      .select('data')
      .eq('id', SESSION_ID)
      .single();

    if (error || !data) {
      console.log('📭 No session found in Supabase. Fresh start.');
      return false;
    }

    await fs.mkdir(SESSION_DIR, { recursive: true });
    const zipBuffer = Buffer.from(data.data, 'base64');
    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(SESSION_DIR, true);
    console.log('📦 Session loaded from Supabase');
    return true;
  } catch (err) {
    console.error('❌ Failed to load session:', err.message);
    return false;
  }
}

// ─── Throttle Supabase writes ─────────────────────────────────────
let lastSaveTime = 0;
const SAVE_INTERVAL = 2 * 60 * 1000;

function throttledSave() {
  const now = Date.now();
  if (now - lastSaveTime >= SAVE_INTERVAL) {
    lastSaveTime = now;
    saveSessionToSupabase();
  }
}

// ─── Main Bot Function ────────────────────────────────────────────
async function startBot() {
  await loadSessionFromSupabase();
  await fs.mkdir(SESSION_DIR, { recursive: true });

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: false,
    fireInitQueries: false,
    generateHighQualityLinkPreview: true,
    getMessage: async () => ({ conversation: '' })
  });

  // ─── QR Code via Socket.IO ────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 QR Code generated - visit /pair to scan');
      io.emit('qr', qr);
    }

    if (connection === 'open') {
      console.log('✅ ADEZ TECH Bot Connected!');
      await saveSessionToSupabase();
      io.emit('connected');

      const ownerJid = `${process.env.OWNER_NUMBER}@s.whatsapp.net`;
      await sock.sendMessage(ownerJid, {
        text: `✅ *${process.env.BOT_NAME}* is now online!\n\n🤖 Bot is ready to use\n⌨️ Prefix: ${process.env.PREFIX}\n\n_Powered by ADEZ TECH_`
      });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || '';

      console.log('🔌 Connection closed. Status:', statusCode);

      if (errorMessage.includes('conflict') || errorMessage.includes('Conflict')) {
        console.log('⚠️ CONFLICT DETECTED: Bot running in two places!');
        console.log('🛑 Stopping this instance...');
        process.exit(1);
      }

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('🚪 Bot logged out. Clearing session...');
        await fs.rm(SESSION_DIR, { recursive: true, force: true });
        startBot();
      } else if (statusCode === DisconnectReason.restartRequired) {
        console.log('🔄 Restart required. Restarting...');
        startBot();
      } else {
        console.log('🔄 Reconnecting in 5 seconds...');
        setTimeout(startBot, 5000);
      }
    }
  });

  // ─── Save Credentials ─────────────────────────────────────────
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    throttledSave();
  });

  // ─── Handle Messages ──────────────────────────────────────────
  sock.ev.on('messages.upsert', async (messageUpdate) => {
    try {
      await handleMessage(sock, messageUpdate);
    } catch (err) {
      console.error('❌ Message handling error:', err.message);
    }
  });

  return sock;
}

// ─── Start Everything ─────────────────────────────────────────────
startBot().catch(err => {
  console.error('❌ Fatal error starting bot:', err);
  process.exit(1);
});

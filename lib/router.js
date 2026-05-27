import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { promises as fs } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

// ─── Storage for loaded commands ──────────────────────────────────
const commands = new Map();
const observers = [];

// ─── Load All Commands Recursively ───────────────────────────────
async function loadCommands() {
  const commandsDir = path.join(ROOT_DIR, 'commands');

  try {
    await fs.access(commandsDir);
  } catch {
    console.log('📁 No commands folder found. Creating it...');
    await fs.mkdir(commandsDir, { recursive: true });
    return;
  }

  await loadFromDirectory(commandsDir);
  console.log(`\n✅ Total commands loaded: ${commands.size}\n`);
}

async function loadFromDirectory(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // If it's a folder, go inside it (recursive)
    if (entry.isDirectory()) {
      await loadFromDirectory(fullPath);
      continue;
    }

    // Only load .js files
    if (!entry.name.endsWith('.js')) continue;

    try {
      // pathToFileURL makes it work on Linux/Render (important!)
      const fileUrl = pathToFileURL(fullPath).href;
      const module = await import(fileUrl);

      // Check required exports exist
      if (!module.name || !module.category) {
        console.warn(`⚠️ Skipping ${entry.name}: missing "name" or "category" export`);
        continue;
      }

      // Duplicate command check
      if (commands.has(module.name)) {
        console.warn(`⚠️ Duplicate command "${module.name}" in ${entry.name} - SKIPPED`);
        continue;
      }

      commands.set(module.name, module);
      console.log(`✅ Loaded: ${module.name} [${module.category}]`);

    } catch (err) {
      console.error(`❌ FAILED ${entry.name}: ${err.stack}`);
    }
  }
}

// ─── Load All Observers ───────────────────────────────────────────
async function loadObservers() {
  const observersDir = path.join(ROOT_DIR, 'observers');

  try {
    await fs.access(observersDir);
  } catch {
    console.log('📁 No observers folder found. Creating it...');
    await fs.mkdir(observersDir, { recursive: true });
    return;
  }

  const files = await fs.readdir(observersDir);

  for (const file of files) {
    if (!file.endsWith('.js')) continue;

    try {
      const fileUrl = pathToFileURL(path.join(observersDir, file)).href;
      const module = await import(fileUrl);
      observers.push(module);
      console.log(`👁️ Observer loaded: ${file}`);
    } catch (err) {
      console.error(`❌ FAILED observer ${file}: ${err.stack}`);
    }
  }
}

// ─── LID to JID Resolver ─────────────────────────────────────────
// Some WhatsApp accounts show as @lid instead of @s.whatsapp.net
// This function converts them so commands like kick/promote work
async function resolveLidToJid(sock, lid) {
  try {
    if (!lid.endsWith('@lid')) return lid;

    const store = sock?.store;
    if (!store) return lid;

    const contact = await store.loadContact(lid);
    if (contact?.notify) {
      return lid.replace('@lid', '@s.whatsapp.net');
    }
    return lid;
  } catch {
    return lid;
  }
}

// ─── Get Admin Info for Groups ────────────────────────────────────
async function getGroupAdminInfo(sock, jid, senderJid) {
  try {
    const groupMetadata = await sock.groupMetadata(jid);
    const participants = groupMetadata.participants;

    const botJid = sock.user?.id?.replace(':0@', '@') || sock.user?.id;

    const senderParticipant = participants.find(p =>
      p.id === senderJid ||
      p.id.split('@')[0] === senderJid.split('@')[0]
    );

    const botParticipant = participants.find(p =>
      p.id === botJid ||
      p.id.split('@')[0] === botJid?.split('@')[0]
    );

    const isAdmin = senderParticipant?.admin === 'admin' ||
                    senderParticipant?.admin === 'superadmin';

    const isBotAdmin = botParticipant?.admin === 'admin' ||
                       botParticipant?.admin === 'superadmin';

    return { isAdmin, isBotAdmin, groupMetadata };
  } catch {
    return { isAdmin: false, isBotAdmin: false, groupMetadata: null };
  }
}

// ─── Main Message Handler ─────────────────────────────────────────
export async function handleMessage(sock, messageUpdate) {
  const { messages, type } = messageUpdate;
  if (type !== 'notify') return;

  // Load commands on first run
  if (commands.size === 0) {
    await loadCommands();
    await loadObservers();
  }

  for (const message of messages) {
    if (!message.message) continue;
    if (message.key.fromMe) continue; // ignore bot's own messages

    const from = message.key.remoteJid;
    const isGroup = from?.endsWith('@g.us');
    const sender = isGroup
      ? message.key.participant
      : message.key.remoteJid;

    // ── Get message text ────────────────────────────────────────
    const body =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      message.message?.videoMessage?.caption ||
      '';

    const prefix = process.env.PREFIX || '.';
    const ownerNumber = process.env.OWNER_NUMBER || '254111783552';

    const isOwner =
      sender?.replace('@s.whatsapp.net', '') === ownerNumber ||
      sender?.replace('@lid', '') === ownerNumber;

    // ── Run Observers (run on every message) ───────────────────
    for (const observer of observers) {
      try {
        if (observer.onMessage) {
          await observer.onMessage(sock, message, { from, sender, isGroup, isOwner, body });
        }
      } catch (err) {
        console.error(`❌ Observer error: ${err.message}`);
      }
    }

    // ── Check if message is a command ──────────────────────────
    if (!body.startsWith(prefix)) continue;

    const args = body.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();

    if (!commandName) continue;

    // ── Find the command ───────────────────────────────────────
    const command = commands.get(commandName);
    if (!command) {
      console.log(`🔍 Unknown command: ${commandName}`);
      continue;
    }

    // ── Get group admin info if in group ───────────────────────
    const { isAdmin, isBotAdmin, groupMetadata } = isGroup
      ? await getGroupAdminInfo(sock, from, sender)
      : { isAdmin: false, isBotAdmin: false, groupMetadata: null };

    // ── Resolve LID if needed ──────────────────────────────────
    const resolvedSender = await resolveLidToJid(sock, sender);

    // ── Build context object passed to every command ───────────
    const ctx = {
      from,
      sender: resolvedSender,
      isGroup,
      isOwner,
      isAdmin,
      isBotAdmin,
      groupMetadata,
      args,
      body,
      prefix,
      message,
      sock
    };

    // ── Run the command ────────────────────────────────────────
    try {
      console.log(`⚡ Running: ${prefix}${commandName} | From: ${sender}`);
      await command.execute(ctx);
    } catch (err) {
      console.error(`❌ Command "${commandName}" failed: ${err.stack}`);
      try {
        await sock.sendMessage(from, {
          text: `❌ Command failed: ${err.message}`
        }, { quoted: message });
      } catch {}
    }
  }
}

// ─── Export getAllCommands for menu command ────────────────────────
export function getAllCommands() {
  return commands;
  }

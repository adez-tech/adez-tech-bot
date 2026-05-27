import { getAllCommands } from '../lib/router.js';

export const name = 'menu';
export const category = 'General';
export const description = 'Shows all available commands';

export async function execute(ctx) {
  const { sock, from, message, prefix } = ctx;
  const allCommands = getAllCommands();

  // Group commands by category
  const categories = {};
  for (const [cmdName, cmd] of allCommands) {
    const cat = cmd.category || 'General';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push({ name: cmdName, description: cmd.description || '' });
  }

  // Build menu text
  let menuText = `╔══════════════════╗\n`;
  menuText += `║   ⚡ *ADEZ TECH*   ║\n`;
  menuText += `╚══════════════════╝\n\n`;
  menuText += `👋 Hello! I am *${process.env.BOT_NAME || 'ADEZ TECH'}*\n`;
  menuText += `⌨️ Prefix: *${prefix}*\n`;
  menuText += `📦 Commands: *${allCommands.size}*\n\n`;

  for (const [category, cmds] of Object.entries(categories)) {
    menuText += `┌─── *${category.toUpperCase()}* ───\n`;
    for (const cmd of cmds) {
      menuText += `│ ${prefix}${cmd.name}\n`;
      if (cmd.description) {
        menuText += `│  ↳ _${cmd.description}_\n`;
      }
    }
    menuText += `└──────────────────\n\n`;
  }

  menuText += `_Powered by ADEZ TECH Bot_ ⚡`;

  await sock.sendMessage(from, {
    text: menuText
  }, { quoted: message });
}

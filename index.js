require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const GANK_CHANNEL_ID = "1556778343389601803";
const GANK_OPENING_HOUR = 8;
const GANK_CLOSING_HOUR = 2;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in environment variables.");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { enemies: {}, links: {} };
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      enemies: data.enemies || {},
      links: data.links || {}
    };
  } catch {
    return { enemies: {}, links: {} };
  }
}

let db = loadData();
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function ensureGuild(guildId) {
  if (!db.enemies[guildId]) db.enemies[guildId] = {};
  if (!db.links[guildId]) db.links[guildId] = {};
}
function isStaff(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild));
}
function isGankOpen() {
  const hour = DateTime.now().setZone("Asia/Kolkata").hour;
  return hour >= GANK_OPENING_HOUR || hour < GANK_CLOSING_HOUR;
}
function cleanText(value, max = 1000) {
  return String(value || "").trim().slice(0, max);
}
function safeThreadName(username) {
  return `gank-${username.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80)}`;
}

async function robloxUserId(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  });
  if (!r.ok) throw new Error(`Roblox username lookup failed (${r.status})`);
  const data = await r.json();
  if (!data.data?.length) return null;
  return {
    id: String(data.data[0].id),
    name: data.data[0].name,
    displayName: data.data[0].displayName
  };
}

async function robloxUserById(id) {
  const r = await fetch(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  return r.json();
}

async function getFriends(userId) {
  const r = await fetch(`https://friends.roblox.com/v1/users/${encodeURIComponent(userId)}/friends`);
  if (!r.ok) throw new Error(`Roblox friends lookup failed (${r.status})`);
  const data = await r.json();
  return data.data || [];
}

async function getAvatarUrl(userId) {
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=150x150&format=Png&isCircular=false`);
    if (!r.ok) return null;
    const data = await r.json();
    return data.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("enemy")
    .setDescription("Manage the Roblox enemy list.")
    .addSubcommand(sub => sub.setName("add").setDescription("Add a Roblox user to the enemy list.").addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true)))
    .addSubcommand(sub => sub.setName("remove").setDescription("Remove a Roblox user from the enemy list.").addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true)))
    .addSubcommand(sub => sub.setName("list").setDescription("Show the enemy list.")),
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link a Discord member to their Roblox username.")
    .addUserOption(o => o.setName("member").setDescription("Discord member").setRequired(true))
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true)),
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Remove a member's stored Roblox link.")
    .addUserOption(o => o.setName("member").setDescription("Discord member").setRequired(true)),
  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Check a member's Roblox friends against the enemy list.")
    .addUserOption(o => o.setName("member").setDescription("Discord member to check").setRequired(true)),
  new SlashCommandBuilder()
    .setName("setupgankboard")
    .setDescription("Post the gank-board button panel.")
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("Slash commands registered.");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      ensureGuild(interaction.guildId);

      if (interaction.commandName === "setupgankboard") {
        if (!isStaff(interaction)) {
          return interaction.reply({ content: "❌ You need the **Manage Server** permission.", ephemeral: true });
        }
        const channel = await client.channels.fetch(GANK_CHANNEL_ID);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: "❌ The configured gank channel was not found or is not a text channel.", ephemeral: true });
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("create_gank").setLabel("🚨 Create Gank").setStyle(ButtonStyle.Danger)
        );
        await channel.send({
          content: "⚔️ **JJS GANK BOARD**\n\nTap the button to submit a gank report. Reports are open from **8:00 AM to 2:00 AM IST**. Each report creates its own thread and alerts the server.",
          components: [row]
        });
        return interaction.reply({ content: `✅ Gank board posted in <#${GANK_CHANNEL_ID}>.`, ephemeral: true });
      }

      if (interaction.commandName === "enemy") {
        const sub = interaction.options.getSubcommand();
        const username = interaction.options.getString("username");
        if (["add", "remove"].includes(sub) && !isStaff(interaction)) {
          return interaction.reply({ content: "❌ You need the **Manage Server** permission to use this command.", ephemeral: true });
        }
        if (sub === "list") {
          const enemies = Object.values(db.enemies[interaction.guildId]);
          if (!enemies.length) return interaction.reply({ content: "🚫 The enemy list is empty.", ephemeral: false });
          const lines = enemies.map((e, i) => `${i + 1}. **${e.username}**${e.displayName && e.displayName !== e.username ? ` (${e.displayName})` : ""}`);
          return interaction.reply({ content: `🚫 **Enemy List**\n\n${lines.join("\n")}`, ephemeral: false });
        }
        if (sub === "add") {
          await interaction.deferReply({ ephemeral: false });
          const user = await robloxUserId(username);
          if (!user) return interaction.editReply(`❌ I couldn't find the Roblox user **${username}**.`);
          db.enemies[interaction.guildId][user.id] = { username: user.name, displayName: user.displayName, addedBy: interaction.user.id, addedAt: new Date().toISOString() };
          saveData();
          return interaction.editReply(`🚫 Added **${user.name}** (ID: \`${user.id}\`) to the enemy list.`);
        }
        if (sub === "remove") {
          await interaction.deferReply({ ephemeral: false });
          const user = await robloxUserId(username);
          if (!user) return interaction.editReply(`❌ I couldn't find the Roblox user **${username}**.`);
          if (!db.enemies[interaction.guildId][user.id]) return interaction.editReply(`ℹ️ **${user.name}** isn't on the enemy list.`);
          delete db.enemies[interaction.guildId][user.id];
          saveData();
          return interaction.editReply(`✅ Removed **${user.name}** from the enemy list.`);
        }
      }

      if (interaction.commandName === "link") {
        if (!isStaff(interaction)) return interaction.reply({ content: "❌ You need the **Manage Server** permission.", ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const member = interaction.options.getMember("member");
        const username = interaction.options.getString("username", true);
        const user = await robloxUserId(username);
        if (!user) return interaction.editReply(`❌ I couldn't find **${username}** on Roblox.`);
        db.links[interaction.guildId][member.id] = { robloxId: user.id, username: user.name, displayName: user.displayName, linkedBy: interaction.user.id, linkedAt: new Date().toISOString() };
        saveData();
        return interaction.editReply(`🔗 Linked ${member} to **${user.name}** (Roblox ID \`${user.id}\`).`);
      }

      if (interaction.commandName === "unlink") {
        if (!isStaff(interaction)) return interaction.reply({ content: "❌ You need the **Manage Server** permission.", ephemeral: true });
        const member = interaction.options.getMember("member");
        if (!db.links[interaction.guildId][member.id]) return interaction.reply({ content: "That member has no stored Roblox link.", ephemeral: true });
        delete db.links[interaction.guildId][member.id];
        saveData();
        return interaction.reply({ content: `✅ Removed the stored Roblox link for ${member}.`, ephemeral: true });
      }

      if (interaction.commandName === "check") {
        await interaction.deferReply({ ephemeral: false });
        const member = interaction.options.getMember("member");
        const link = db.links[interaction.guildId][member.id];
        if (!link) return interaction.editReply(`❌ ${member} has no Roblox account stored.\n\nUse \/link member:${member.user.username} username:<Roblox username> first.`);
        const robloxUser = await robloxUserById(link.robloxId);
        if (!robloxUser) return interaction.editReply("❌ The stored Roblox account could not be found.");
        const friends = await getFriends(link.robloxId);
        const enemyMap = db.enemies[interaction.guildId];
        const matches = friends.filter(friend => enemyMap[String(friend.id)]);
        const embed = new EmbedBuilder().setTitle(matches.length ? "🔴 Enemy Connection Found" : "🟢 No Enemy Connection Found").setDescription(matches.length ? `${member} (**${robloxUser.name}**) is friends with **${matches.length}** enemy account(s).` : `${member} (**${robloxUser.name}**) is not friends with anyone on the enemy list.`).addFields({ name: "Roblox Account", value: `[${robloxUser.name}](https://www.roblox.com/users/${robloxUser.id}/profile)` }).setTimestamp();
        if (matches.length) {
          const avatar = await getAvatarUrl(matches[0].id);
          if (avatar) embed.setThumbnail(avatar);
          const matchList = matches.slice(0, 20).map((friend, index) => {
            const enemy = enemyMap[String(friend.id)];
            return `${index + 1}. 🔴 **[${enemy.username}](https://www.roblox.com/users/${friend.id}/profile)**${enemy.displayName && enemy.displayName !== enemy.username ? ` (${enemy.displayName})` : ""}\n   Roblox ID: \`${friend.id}\``;
          }).join("\n\n");
          embed.addFields({ name: `🚫 Exact Enemy Matches (${matches.length})`, value: matchList.slice(0, 1024) });
        }
        if (friends.length >= 200) embed.addFields({ name: "Note", value: "Roblox returned a large friend list. The bot checked the full list returned by the endpoint." });
        return interaction.editReply({ embeds: [embed] });
      }
    }

    if (interaction.isButton() && interaction.customId === "create_gank") {
      if (!isGankOpen()) return interaction.reply({ content: "⏰ Gank reports are open from **8:00 AM to 2:00 AM IST**.", ephemeral: true });
      const modal = new ModalBuilder().setCustomId("gank_modal").setTitle("Create a Gank Report");
      const username = new TextInputBuilder().setCustomId("enemy_username").setLabel("Enemy Roblox username").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50);
      const reason = new TextInputBuilder().setCustomId("reason").setLabel("What happened?").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
      const server = new TextInputBuilder().setCustomId("server").setLabel("Server/details (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200);
      const evidence = new TextInputBuilder().setCustomId("evidence").setLabel("Evidence link (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500);
      modal.addComponents(new ActionRowBuilder().addComponents(username), new ActionRowBuilder().addComponents(reason), new ActionRowBuilder().addComponents(server), new ActionRowBuilder().addComponents(evidence));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === "gank_modal") {
      if (!isGankOpen()) return interaction.reply({ content: "⏰ Gank reports are open from **8:00 AM to 2:00 AM IST**.", ephemeral: true });
      if (interaction.channelId !== GANK_CHANNEL_ID) return interaction.reply({ content: "❌ Use the gank-board button in the configured gank channel.", ephemeral: true });
      const username = cleanText(interaction.fields.getTextInputValue("enemy_username"), 50);
      const reason = cleanText(interaction.fields.getTextInputValue("reason"), 1000);
      const server = cleanText(interaction.fields.getTextInputValue("server"), 200) || "Not provided";
      const evidence = cleanText(interaction.fields.getTextInputValue("evidence"), 500) || "Not provided";
      const parent = await client.channels.fetch(GANK_CHANNEL_ID);
      if (!parent || parent.type !== ChannelType.GuildText) return interaction.reply({ content: "❌ Gank channel is unavailable.", ephemeral: true });
      const thread = await parent.threads.create({ name: safeThreadName(username), autoArchiveDuration: 1440, type: ChannelType.PublicThread, reason: "Gank report created" });
      await thread.send({ content: `@everyone\n\n🚨 **GANK ALERT** 🚨\n\n**Enemy:** ${username}\n**Reported by:** ${interaction.user}\n**Reason:** ${reason}\n**Server/details:** ${server}\n**Evidence:** ${evidence}\n\nPlease keep replies about this in this thread.`, allowedMentions: { parse: ["everyone", "users"] } });
      return interaction.reply({ content: `✅ Your gank thread was created: <#${thread.id}>`, ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    const message = "❌ Something went wrong. Please try again later.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();

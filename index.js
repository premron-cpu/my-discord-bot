require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { enemies: {}, links: {} };
  }

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
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

async function robloxUserId(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: false
    })
  });

  if (!r.ok) {
    throw new Error(`Roblox username lookup failed (${r.status})`);
  }

  const data = await r.json();

  if (!data.data || !data.data.length) {
    return null;
  }

  return {
    id: String(data.data[0].id),
    name: data.data[0].name,
    displayName: data.data[0].displayName
  };
}

async function robloxUserById(id) {
  const r = await fetch(
    `https://users.roblox.com/v1/users/${encodeURIComponent(id)}`
  );

  if (!r.ok) return null;

  return await r.json();
}

async function getFriends(userId) {
  const r = await fetch(
    `https://friends.roblox.com/v1/users/${encodeURIComponent(userId)}/friends`
  );

  if (!r.ok) {
    throw new Error(`Roblox friends lookup failed (${r.status})`);
  }

  const data = await r.json();

  return data.data || [];
}

async function getAvatarUrl(userId) {
  try {
    const r = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(
        userId
      )}&size=150x150&format=Png&isCircular=false`
    );

    if (!r.ok) return null;

    const data = await r.json();

    return data.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

function isStaff(interaction) {
  return interaction.memberPermissions?.has(
    PermissionsBitField.Flags.ManageGuild
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName("enemy")
    .setDescription("Manage the Roblox enemy list.")

    .addSubcommand(sub =>
      sub
        .setName("add")
        .setDescription("Add a Roblox user to the enemy list.")
        .addStringOption(o =>
          o
            .setName("username")
            .setDescription("Roblox username")
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("remove")
        .setDescription("Remove a Roblox user from the enemy list.")
        .addStringOption(o =>
          o
            .setName("username")
            .setDescription("Roblox username")
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("list")
        .setDescription("Show the enemy list.")
    ),

  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link a Discord member to their Roblox username.")
    .addUserOption(o =>
      o
        .setName("member")
        .setDescription("Discord member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o
        .setName("username")
        .setDescription("Roblox username")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Remove a member's stored Roblox link.")
    .addUserOption(o =>
      o
        .setName("member")
        .setDescription("Discord member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Check a member's Roblox friends against the enemy list.")
    .addUserOption(o =>
      o
        .setName("member")
        .setDescription("Discord member to check")
        .setRequired(true)
    )
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    {
      body: commands
    }
  );

  console.log("Slash commands registered.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!isStaff(interaction)) {
    return interaction.reply({
      content:
        "❌ You need the **Manage Server** permission to use this bot.",
      ephemeral: true
    });
  }

  ensureGuild(interaction.guildId);

  try {
    // =========================
    // ENEMY COMMAND
    // =========================

    if (interaction.commandName === "enemy") {
      const sub = interaction.options.getSubcommand();
      const username = interaction.options.getString("username", true);

      if (sub === "add") {
        await interaction.deferReply();

        const user = await robloxUserId(username);

        if (!user) {
          return interaction.editReply(
            `❌ I couldn't find the Roblox user **${username}**.`
          );
        }

        db.enemies[interaction.guildId][user.id] = {
          username: user.name,
          displayName: user.displayName,
          addedBy: interaction.user.id,
          addedAt: new Date().toISOString()
        };

        saveData();

        return interaction.editReply(
          `🚫 Added **${user.name}** (ID: \`${user.id}\`) to the enemy list.`
        );
      }

      if (sub === "remove") {
        await interaction.deferReply();

        const user = await robloxUserId(username);

        if (!user) {
          return interaction.editReply(
            `❌ I couldn't find the Roblox user **${username}**.`
          );
        }

        if (!db.enemies[interaction.guildId][user.id]) {
          return interaction.editReply(
            `ℹ️ **${user.name}** isn't on the enemy list.`
          );
        }

        delete db.enemies[interaction.guildId][user.id];

        saveData();

        return interaction.editReply(
          `✅ Removed **${user.name}** from the enemy list.`
        );
      }

      if (sub === "list") {
        const enemies = Object.values(
          db.enemies[interaction.guildId]
        );

        if (!enemies.length) {
          return interaction.reply({
            content: "🚫 The enemy list is empty."
          });
        }

        const lines = enemies.map((e, i) =>
          `${i + 1}. **${e.username}**${
            e.displayName && e.displayName !== e.username
              ? ` (${e.displayName})`
              : ""
          }`
        );

        return interaction.reply({
          content:
            `🚫 **Enemy List**\n\n${lines.join("\n")}`
        });
      }
    }

    // =========================
    // LINK COMMAND
    // =========================

    if (interaction.commandName === "link") {
      await interaction.deferReply({ ephemeral: true });

      const member = interaction.options.getMember("member");
      const username = interaction.options.getString(
        "username",
        true
      );

      const user = await robloxUserId(username);

      if (!user) {
        return interaction.editReply(
          `❌ I couldn't find **${username}** on Roblox.`
        );
      }

      db.links[interaction.guildId][member.id] = {
        robloxId: user.id,
        username: user.name,
        displayName: user.displayName,
        linkedBy: interaction.user.id,
        linkedAt: new Date().toISOString()
      };

      saveData();

      return interaction.editReply(
        `🔗 Linked ${member} to **${user.name}** (Roblox ID \`${user.id}\`).`
      );
    }

    // =========================
    // UNLINK COMMAND
    // =========================

    if (interaction.commandName === "unlink") {
      const member = interaction.options.getMember("member");

      if (!db.links[interaction.guildId][member.id]) {
        return interaction.reply({
          content: "That member has no stored Roblox link.",
          ephemeral: true
        });
      }

      delete db.links[interaction.guildId][member.id];

      saveData();

      return interaction.reply({
        content:
          `✅ Removed the stored Roblox link for ${member}.`,
        ephemeral: true
      });
    }

    // =========================
    // CHECK COMMAND
    // =========================

    if (interaction.commandName === "check") {
      await interaction.deferReply();

      const member = interaction.options.getMember("member");

      const link =
        db.links[interaction.guildId][member.id];

      if (!link) {
        return interaction.editReply(
          `❌ ${member} has no Roblox account stored.\n\nUse \`/link member:${member.user.username} username:<Roblox username>\` first.`
        );
      }

      const robloxUser =
        await robloxUserById(link.robloxId);

      if (!robloxUser) {
        return interaction.editReply(
          "❌ The stored Roblox account could not be found."
        );
      }

      const friends = await getFriends(link.robloxId);

      const enemyMap =
        db.enemies[interaction.guildId];

      const matches = friends.filter(
        friend => enemyMap[String(friend.id)]
      );

      const embed = new EmbedBuilder()
        .setTitle(
          matches.length
            ? "🔴 Enemy Connection Found"
            : "🟢 No Enemy Connection Found"
        )
        .setDescription(
          matches.length
            ? `${member} (**${robloxUser.name}**) is friends with **${matches.length}** enemy account(s).`
            : `${member} (**${robloxUser.name}**) is not friends with anyone on the enemy list.`
        )
        .addFields({
          name: "Roblox Account",
          value:
            `[${robloxUser.name}](https://www.roblox.com/users/${robloxUser.id}/profile)`
        })
        .setTimestamp();

      // =========================
      // ENEMY MATCHES + AVATAR
      // =========================

      if (matches.length) {
        const firstEnemyAvatar =
          await getAvatarUrl(matches[0].id);

        if (firstEnemyAvatar) {
          embed.setThumbnail(firstEnemyAvatar);
        }

        const matchList = matches
          .slice(0, 20)
          .map((friend, index) => {
            const enemy =
              enemyMap[String(friend.id)];

            const profileLink =
              `https://www.roblox.com/users/${friend.id}/profile`;

            return (
              `${index + 1}. 🔴 **[${enemy.username}](${profileLink})**` +
              (
                enemy.displayName &&
                enemy.displayName !== enemy.username
                  ? ` (${enemy.displayName})`
                  : ""
              ) +
              `\n   Roblox ID: \`${friend.id}\``
            );
          })
          .join("\n\n");

        embed.addFields({
          name:
            `🚫 Exact Enemy Matches (${matches.length})`,
          value: matchList
        });
      }

      if (friends.length >= 200) {
        embed.addFields({
          name: "Note",
          value:
            "Roblox returned a large friend list. The bot checked the full list returned by the endpoint."
        });
      }

      return interaction.editReply({
        embeds: [embed]
      });
    }

  } catch (err) {
    console.error(err);

    const message =
      "❌ Something went wrong while checking Roblox. Try again in a moment.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true
      }).catch(() => {});
    }
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
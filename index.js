const { Client, GatewayIntentBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CONFIG_FILE = './config.json';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultVal = { max: 50, baseName: 'Tickets', prefix: 'ticket', roleId: null, counter: 1 };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultVal, null, 2));
    return defaultVal;
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE));
  if (config.counter === undefined) config.counter = 1;
  if (config.prefix === undefined) config.prefix = 'ticket';
  return config;
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

async function getCategory(guild, cfg) {
  let index = 1;
  while (true) {
    const name = `${cfg.baseName} ${index}`;
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
    
    if (!category) {
      category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
      return category;
    }

    const count = guild.channels.cache.filter(c => c.parentId === category.id && c.name.startsWith(cfg.prefix + '-')).size;
    if (count < cfg.max) {
      return category;
    }
    index++;
  }
}

client.once('clientReady', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Create a ticket panel'),
    new SlashCommandBuilder().setName('setlimit').setDescription('Set category ticket limit').addIntegerOption(o => o.setName('limit').setDescription('Maximum tickets').setRequired(true)),
    new SlashCommandBuilder().setName('setname').setDescription('Set category base name').addStringOption(o => o.setName('name').setDescription('Base name').setRequired(true)),
    new SlashCommandBuilder().setName('setrole').setDescription('Set support role').addRoleOption(o => o.setName('role').setDescription('Support role').setRequired(true)),
    new SlashCommandBuilder().setName('migratetickets').setDescription('Migrate an old category of tickets to the new bot')
      .addChannelOption(o => o.setName('category').setDescription('Old category with tickets').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

client.on('interactionCreate', async interaction => {
  const cfg = getConfig();

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'panel') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions!', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const embed = new EmbedBuilder().setDescription('Click the button below to open a ticket.');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_ticket').setLabel('Create Ticket').setStyle(ButtonStyle.Primary)
      );
      
      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.editReply({ content: 'Ticket panel created successfully!' });
    }

    if (interaction.commandName === 'setlimit') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
      cfg.max = interaction.options.getInteger('limit');
      saveConfig(cfg);
      return interaction.reply({ content: `Limit updated to: ${cfg.max}`, ephemeral: true });
    }

    if (interaction.commandName === 'setname') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
      cfg.baseName = interaction.options.getString('name');
      saveConfig(cfg);
      return interaction.reply({ content: `Category base name updated to: ${cfg.baseName}`, ephemeral: true });
    }

    if (interaction.commandName === 'setrole') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
      cfg.roleId = interaction.options.getRole('role').id;
      saveConfig(cfg);
      return interaction.reply({ content: 'Support role saved successfully!', ephemeral: true });
    }

    if (interaction.commandName === 'migratetickets') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions!', ephemeral: true });
      }

      const oldCategory = interaction.options.getChannel('category');
      const channelsToMigrate = interaction.guild.channels.cache.filter(c => c.parentId === oldCategory.id && c.type === ChannelType.GuildText);

      if (channelsToMigrate.size === 0) {
        return interaction.reply({ content: 'No text channels found in this category!', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      let migratedCount = 0;

      for (const [_, oldChannel] of channelsToMigrate) {
        try {
          const messages = await oldChannel.messages.fetch({ limit: 100 });
          const sortedMessages = Array.from(messages.values()).reverse();

          const newCategory = await getCategory(interaction.guild, cfg);
          const ticketNumber = cfg.counter++;
          saveConfig(cfg);
          const newChannelName = `${cfg.prefix}-${ticketNumber}`;

          const overwrites = [
            { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          ];
          if (cfg.roleId) {
            overwrites.push({ id: cfg.roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
          }

          const newChannel = await interaction.guild.channels.create({
            name: newChannelName,
            type: ChannelType.GuildText,
            parent: newCategory.id,
            permissionOverwrites: overwrites
          });

          const webhook = await newChannel.createWebhook({ name: 'Ticket Migrator' });

          for (const msg of sortedMessages) {
            if (msg.author.bot && msg.embeds.length === 0 && !msg.content) continue;
            
            const files = msg.attachments.map(att => att.url);
            
            await webhook.send({
              content: msg.content || undefined,
              username: msg.author.username,
              avatarURL: msg.author.displayAvatarURL(),
              embeds: msg.embeds,
              files: files.length > 0 ? files : undefined
            }).catch(() => {});
          }

          await webhook.delete().catch(() => {});

          const closeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
          );
          await newChannel.send({ content: `📦 *This ticket has been migrated from the old system.*`, components: [closeRow] });

          await oldChannel.delete().catch(() => {});
          migratedCount++;
        } catch (err) {
          console.error(`Failed to migrate channel ${oldChannel.name}:`, err);
        }
      }

      await oldCategory.delete().catch(() => {});

      return interaction.editReply({ content: `Successfully migrated ${migratedCount} tickets to the new system!` });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'open_ticket') {
      await interaction.deferReply({ ephemeral: true });

      const category = await getCategory(interaction.guild, cfg);
      const ticketNumber = cfg.counter++;
      saveConfig(cfg);

      const channelName = `${cfg.prefix}-${ticketNumber}`;

      const overwrites = [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
      ];

      if (cfg.roleId) {
        overwrites.push({ id: cfg.roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
      }

      const ticketChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites
      });

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
      );

      await ticketChannel.send({ content: `${interaction.user}, welcome! Please describe your issue.`, components: [closeRow] });
      return interaction.editReply({ content: `Ticket created: ${ticketChannel}` });
    }

    if (interaction.customId === 'close_ticket') {
      const channel = interaction.channel;
      await interaction.reply({ content: 'Closing ticket...', ephemeral: true });
      
      setTimeout(async () => {
        const parent = channel.parent;
        await channel.delete().catch(() => {});
        
        if (parent) {
          const remaining = parent.guild.channels.cache.filter(c => c.parentId === parent.id);
          if (remaining.size === 0 && parent.name.startsWith(cfg.baseName)) {
            await parent.delete().catch(() => {});
          }
        }
      }, 1000);
    }
  }
});

client.login(BOT_TOKEN);
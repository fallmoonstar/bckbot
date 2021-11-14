import { config } from "dotenv-safe";
config();

import 'module-alias/register';

import { injectPrototype } from '@app/prototype';
import { Singleton } from '@app/Singleton';
import * as utils from '@app/utils';
import { Dictionary } from '@type/Dictionary';
import { Events } from '@type/Events';
import { ArgumentRequirement, Module, ModuleActionArgument } from '@type/Module';
import { CommandInteraction, Message } from 'discord.js';
import glob from 'glob';
import { exec } from "child_process";
import { getString, i18init } from "./i18n";
import { ContextMenuCommand, SlashCommand } from "@type/SlashCommand";

injectPrototype();
i18init();

const { logger, client } = Singleton;

try {
	const startTime = new Date();
	const events = ["messageCreate", "messageDelete", "messageUpdate"];
	const eventModules: Events = utils.arr2obj(
		events,
		events.map(() => ({}))
	);

	const slashCommands: Dictionary<SlashCommand | ContextMenuCommand> = {};

	const createDeleteAction = async (message: Message) => {
		const collector = message.createReactionCollector({
			filter: (reaction, user) => {
				const emojiIsBin = reaction.emoji.name === '🗑️';
				const reactorIsAuthor = user === message.author;
				const reactorIsSelf = user === client.user;
				if (emojiIsBin && !reactorIsAuthor && reactorIsSelf) {
					reaction.remove();
				}
				return emojiIsBin && reactorIsAuthor && !reactorIsSelf;
			},
			time: 15000
		});
		collector.on('collect', async () => {
			try {
				await message.delete();
			} catch (e) { }
		});
		const reaction = await message.react('🗑️');
		collector.on('end', async () => {
			try {
				await reaction.remove();
			} catch (e) { }
		});
	};

	client.on("ready", async () => {
		logger.delimiter("> ").show();

		exec('git show -s --format="v.%h on %aI"', (error, string) => {
			if (error) {
				logger.log(error.message);
			} else {
				client.user!.setActivity(string, {
					type: 'WATCHING'
				});
			}
		});

		for (let event of events) {
			// Pre-processing (init, interval)
			for (let moduleName of Object.keys(eventModules[event])) {
				const _module = eventModules[event][moduleName];
				const module = _module.module;
				let baseArgv: Dictionary<any> = {};

				if (module.init) {
					try {
						// Parallel loading
						(async () => {
							await module.init!(baseArgv);
							_module.loaded = true;
						})();
					} catch (e) {
						if (e instanceof Error)
							utils.report(
								`Init failed for module ${moduleName}: ${e.message}`
							);
					}
				} else {
					_module.loaded = true;
				}

				if (module.interval) {
					const f = async () => {
						try {
							await module.interval!.f(baseArgv);
							setTimeout(f, module.interval!.t);
						} catch (e) {
							if (e instanceof Error)
								utils.report(
									`Interval failed for module ${moduleName}: ${e.message}`
								);
						}
					};
					setTimeout(f, module.interval.t);
				}
			}
			// Build listener
			client.on(event, async (message: Message) => {
				if (message.channel.id === process.env.error_chid || message.author === client.user) return;

				let accepted = false,
					stealthExists = false,
					result;

				// Prompt if user tried to use legacy method
				for (const command in slashCommands) {
					if (message.cleanContent.startsWith(`b!${command}`)) {
						const cmd = slashCommands[command];
						const msg = await message.reply("onContextMenu" in cmd ? `Please use the context menu on target ${cmd.type.toLocaleLowerCase()} and select ${command}.` : `Please use /${command} for the newer support.`);
						await utils.sleep(5000);
						await msg.delete();
						return;
					}
				}

				const messageArgs = message.content.split(" ");
				const messageTrigger = messageArgs[0].startsWith("b!") ? messageArgs[0].substr(2) : null;

				for (let _module of Object.values(eventModules[event])) {
					const module = _module.module;
					for (let trigger of module.trigger) {
						const stealth = trigger.startsWith("*");
						stealthExists = stealthExists || stealth;

						if (trigger === messageTrigger || stealth) {
							try {
								if (!_module.loaded) {
									await message.reply(
										getString(
											"index.stillLoading",
											message.getLocale()
										)
									);
									return;
								}
								let moduleActionArgument: ModuleActionArgument = {
									trigger,
									message,
								};

								if (module.argv) {
									moduleActionArgument.argv = {};
									const argNames = Object.keys(module.argv);
									// Check message argv requirements
									for (let i = 0; i < argNames.length; i++) {
										const argName = argNames[i];
										const argValue = messageArgs[i + 1]; // The first one is trigger
										if (
											module.argv[argName].includes(
												ArgumentRequirement.Required
											) &&
											typeof argValue === "undefined"
										) {
											await message.reply(
												getString(
													"index.argvError",
													message.getLocale(),
													{
														argName,
														position: i,
														trigger,
														usage: argNames
															.map((arg) => {
																const flagOptional =
																	module.argv![
																		arg
																	].includes(
																		ArgumentRequirement.Required
																	);
																const flagConcat =
																	module.argv![
																		arg
																	].includes(
																		ArgumentRequirement.Concat
																	);
																return `${flagOptional
																	? "["
																	: ""
																	}${flagConcat
																		? "..."
																		: ""
																	}${arg}${flagOptional
																		? "]"
																		: ""
																	}`;
															})
															.join(" "),
													}
												)
											);
											return;
										}
										if (argValue && argValue.length)
											moduleActionArgument.argv[argName] =
												module.argv[argName].includes(
													ArgumentRequirement.Concat
												)
													? messageArgs
														.slice(i + 1)
														.join(" ")
													: argValue;
									}
								}

								if (module.eval) {
									moduleActionArgument.eval = {};
									for (const name in module.eval) {
										moduleActionArgument.eval[name] = eval(module.eval[name]);
									}
								}

								result = await module.action(moduleActionArgument);
								if (result instanceof Message) {
									await createDeleteAction(result);
								}
								if (!stealth) accepted = true;
							} catch (e) {
								if (!stealth) await message.react("❌");
								if (e instanceof Error) await utils.pmError(message, e);
							}
						}
					}
				}
				if (!accepted && message.content.startsWith("b!") && stealthExists) {
					await message.react(
						client.emojis.cache.random()!
					);
					return;
				} else {
					return;
				}
			});
		}

		for (const [_, guild] of client.guilds.cache) {
			guild.commands.set(Object.values(slashCommands));
		}

		client.on("interactionCreate", async (interaction) => {
			if (interaction.isCommand() || interaction.isContextMenu()) {
				const source = interaction.commandName;
				const command = slashCommands[source];
				if (command) {
					if (interaction.isCommand() && "onCommand" in command)
						return await command.onCommand(interaction);
					else if (interaction.isContextMenu() && "onContextMenu" in command)
						return await command.onContextMenu(interaction);
				}
			} else if (interaction.isButton() || interaction.isMessageComponent() || interaction.isSelectMenu()) {
				const source = (interaction.message.interaction! as CommandInteraction).commandName;
				const command = slashCommands[source];
				if (command) {
					if (interaction.isButton() && command.onButton)
						return await command.onButton(interaction);
					else if (interaction.isMessageComponent() && command.onMessageComponent)
						return await command.onMessageComponent(interaction);
					else if (interaction.isSelectMenu() && command.onSelectMenu)
						return await command.onSelectMenu(interaction);
				}
			}
			logger.log(`Unknown ${interaction.type} interaction received: ${JSON.stringify(interaction, null, 4)}`);
		});

		utils.report(`Finished loading in ${+new Date() - +startTime}ms`);
	});

	glob("./bin/modules/**/*.js", async (error, fileList) => {
		if (error) throw error;
		for (let file of fileList.filter((_file) => {
			return _file.split("/").pop()![0] != "_";
		})) {
			const fileName = file.split("/").pop()!;
			const moduleName = fileName.slice(0, -3);

			const _module = require(`@app/${file.slice(6)}`).module;
			let tmp: Module | SlashCommand;
			if ("action" in _module) {
				tmp = _module as Module;
				eventModules[tmp.event][moduleName] = {
					module: tmp,
					loaded: false,
				};
			} else if ("description" in _module) {
				tmp = _module as SlashCommand;
				slashCommands[tmp.name] = tmp;
			} else {
				utils.report(`Unknown module ${fileName}!`);
				process.exit();
			}

			utils.report(`Loaded module ${fileName}`);
		}

		await client.login(
			process.argv[2] === "dev"
				? process.env.dev_token
				: process.env.bot_token
		);
		utils.report("Logged in as " + client.user!.tag);
	});
} catch (e) {
	if (e instanceof Error)
		utils.report("Error occurred: " + e.toString());
}

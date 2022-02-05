import { Report } from "@app/reporting";
import { arr2obj, enumStringKeys, report, round } from "@app/utils";
import { PrismaClient, Server } from "@prisma/client";
import { SlashCommand } from "@type/SlashCommand";
import { parse } from "csv-parse/sync";
import { MessageAttachment } from "discord.js";
import { EmojiData } from "emoji-data-ts";
import { writeFileSync } from "fs";
import { IncomingMessage } from "http";
import { Docker } from "node-docker-api";
import fetch, { RequestInit, Response } from "node-fetch";
import allSettled from "promise.allsettled";
import { SocksProxyAgent } from "socks-proxy-agent";

const client = new PrismaClient({
	// log: ["query"]
});

interface VPNGateServer {
	HostName: string;
	IP: string;
	Score: number;
	Ping: number;
	Speed: number;
	CountryLong: string;
	CountryShort: string;
	NumVpnSessions: number;
	Uptime: number;
	TotalUsers: number;
	TotalTraffic: number;
	LogType: string;
	Operator: string;
	Message: string;
	OpenVPN_ConfigData_Base64: string;
};

const sleep = async (ms: number) => {
	return new Promise<[string, string]>(resolve => setTimeout(resolve, ms));
}

const timeoutPromise = <T>(t: number, reason?: any) => new Promise<T>(async (resolve, reject) => {
	await sleep(t);
	reject(reason ?? "timeout");
});

const customFetch = async (resource: string, options = {}) => {
	return await Promise.race<Response>([
		timeoutPromise(5 * 1000),
		new Promise(async (resolve, reject) => {
			try {
				const agent = new SocksProxyAgent("socks://127.0.0.1:10801");
				const response = await fetch(resource, { agent, ...options });
				resolve(response);
			} catch (e) {
				reject(e);
			}
		})
	]);
}

enum SITES { pcr = "Princess Connect Re:Dive", uma = "Umamusume", wf = "World Flipper", kc = "Kancolle", knsb = "Konosuba" }

const sites: Record<keyof typeof SITES, {
	endpoint: string,
	options?: RequestInit,
	verifier: (response: Response) => Promise<boolean>
}> = {
	pcr: {
		endpoint: "https://api-priconne-redive.cygames.jp/",
		options: {
			headers: {
				"User-Agent": ""
			}
		},
		verifier: async (response) => response.status === 404
	},
	uma: {
		endpoint: "https://api-umamusume.cygames.jp/",
		verifier: async (response) => response.status === 404
	},
	wf: {
		endpoint: "https://api.worldflipper.jp/",
		options: {
			headers: {
				"User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9; ALP-AL00 Build/HUAWEIALP-AL00)"
			}
		},
		verifier: async (response) => response.status === 200
	},
	kc: {
		endpoint: "http://203.104.209.7/kcscontents/news/",
		verifier: async (response) => response.status === 200
	},
	knsb: {
		endpoint: "https://api.konosubafd.jp/",
		verifier: async (response) => response.status === 200
	}
};

interface APIResponseIPInfo {
	ip: string;
	hostname: string;
	city: string;
	region: string;
	country: string;
	loc: string;
	org: string;
	timezone: string;
	readme: string;
}

const worker = async () => {
	const docker = new Docker({ socketPath: "/var/run/docker.sock" });
	let data: VPNGateServer[] = [];

	// Get VPN list
	try {
		const request = await fetch("https://www.vpngate.net/api/iphone/");
		const text = await request.text();

		const lines = text.split("\n");
		lines.shift();
		lines[0] = lines[0].substring(1); // Starting *
		lines.pop();
		lines.pop();

		data = (parse(lines.join("\n"), { columns: true, cast: true }) as VPNGateServer[])
			// .filter(s => s.IP === "219.100.37.5")
			.sort((s1, s2) => {
				return s1.Speed > s2.Speed ? -1 : 1;
			});
		mReport(`Fetched ${data.length} servers`);
	} catch (e) {
		Report.error(e, "Get VPN data");
	}

	// Check VPNs
	// TODO: Parallel checking
	for (const server of data) {
		try {
			// Stop all containers
			const list = await docker.container.list();
			for (const c of list) {
				await c.stop();
			}

			const serverResult: Record<"connect" | keyof typeof SITES, number> = {
				connect: 0,
				pcr: 0,
				uma: 0,
				wf: 0,
				kc: 0,
				knsb: 0
			};

			mReport(`Testing ${server.IP} ${server.Speed / 1000 / 1000}Mbps ${server.Ping}ms (${server.CountryShort})`);
			await Promise.race([
				// Reject: Timeout
				timeoutPromise(600 * 1000, ["main", "timeout"]),
				// Resolve: Finish
				// Reject: Error
				new Promise(async (resolve, reject) => {
					try {
						writeFileSync("/tmp/ovpn.conf", Buffer.from(server.OpenVPN_ConfigData_Base64, "base64").toString());

						const startTime = +new Date();

						// Create container
						const container = await docker.container.create({
							Image: "mook/openvpn-client-socks:latest",
							ExposedPorts: {
								"1080/tcp": {}
							},
							HostConfig: {
								Devices: [
									{
										PathOnHost: "/dev/net/tun",
										PathInContainer: "/dev/net/tun",
										CgroupPermissions: "rwm"
									}
								],
								PortBindings: {
									"1080/tcp": [
										{
											HostIp: "127.0.0.1",
											HostPort: "10801"
										}
									]
								},
								Binds: [
									"/tmp/ovpn.conf:/ovpn.conf:ro"
								],
								CapAdd: ["NET_ADMIN"]
							}
						});

						await container.start();

						// Wait for connection
						try {
							await Promise.race([
								// Reject: Timeout
								timeoutPromise(30 * 1000),
								// Reject: Container exited
								new Promise(async (resolve, reject) => {
									while (true) {
										try {
											const status = await container.status();
											const running = (status.data as any).State.Running as boolean;
											if (!running) {
												reject("exited");
											}
										} catch (e) {
											reject(`error: ${e}`);
										}
										await sleep(100);
									}
								}),
								// Resolve: Connected
								// Reject: Disconnected
								new Promise(async (resolve, reject) => {
									while (true) {
										try {
											const stream = await container.logs({
												stdout: true
											}) as IncomingMessage;

											let data = "";
											stream.on("data", (chunk) => data += chunk);
											stream.on("end", () => {
												if (data.includes("Initialization Sequence Completed")) {
													resolve("connected");
												} else if (data.includes("SIGUSR1")) { // Pending reconnection
													reject("fail");
												}
											});
											stream.on("error", (e) => {
												reject(`error: ${e}`);
											});
										} catch (e) {
											reject(`error: ${e}`);
										}

										await sleep(100);
									}
								})
							]);
						} catch (e) {
							await container.stop();
							reject(["connection", e]);
							return;
						}

						serverResult.connect = +new Date() - startTime;

						// Test sites
						const result = arr2obj(
							Object.keys(sites),
							(await allSettled<number>(
								Object.keys(sites).map(site => new Promise<number>(async (resolve, reject) => {
									const config = sites[site as keyof typeof sites];
									const startTime = +new Date();
									try {
										const response = await customFetch(config.endpoint, config.options);
										const result = await config.verifier(response);
										if (result) {
											resolve(+new Date() - startTime);
										} else {
											resolve(-response.status);
										}
									} catch (e) {
										if (e !== "timeout") {
											console.error(e);
										}
										reject(-1);
									}
								}))
							)).map(s => s.status === "fulfilled" ? s.value : -1)
						);

						for (const site in result) {
							serverResult[site as keyof typeof serverResult] = result[site]
						}

						let serverInfo: APIResponseIPInfo | null = null;

						for (let i = 0; i < 3; i++) {
							try {
								serverInfo = await (await customFetch("https://ipinfo.io/json")).json();
								break;
							} catch (e) {
								await sleep(2000);
							}
						}

						if (serverInfo === null) {
							reject(["serverinfo", "fail"]);
							return;
						}

						try {
							await client.server.upsert({
								create: {
									hostname: server.HostName,
									ip: server.IP,
									country: server.CountryShort,
									speed: server.Speed,
									config: server.OpenVPN_ConfigData_Base64,
									isp: serverInfo.org
								},
								update: {
									hostname: server.HostName,
									speed: server.Speed,
									config: server.OpenVPN_ConfigData_Base64
								},
								where: {
									ip: server.IP
								}
							});

							await client.result.create({
								data: {
									ip: server.IP,
									...serverResult,
									time: new Date()
								}
							});
						} catch (e) {
							reject(["db", (e as Error).message]);
							return;
						}

						await container.stop();

						resolve(true);
					} catch (e) {
						reject(["main", e]);
					}
				})
			]);
		} catch (e) {
			mReport(JSON.stringify(e));
		}
	}
};

const mReport = (txt: string) => {
	report(`vpn: ${txt}`);
};

const emojiData = new EmojiData();

worker();

export const module: SlashCommand = {
	// 1. User select games
	// 2. Program output list of servers sorted by game precedence
	// 3. User select server
	// 4. Show statistics and download button
	name: "vpn",
	description: "Finds the VPN that works for your game.",
	defer: true,
	onCommand: async () => {
		return {
			content: "What Game?",
			components: [
				[{
					type: "SELECT_MENU",
					custom_id: "game",
					options: enumStringKeys(SITES).map(k => ({
						label: SITES[k as keyof typeof SITES],
						value: k
					})),
					max_values: 5
				}]
			]
		}
	},
	onSelectMenu: async (interaction) => {
		switch (interaction.customId) {
			case "game": {
				// Values will follow user input order
				const servers = await client.$queryRawUnsafe<Pick<Server, "ip" | "country" | "speed">[]>(
					"select ip, country, speed from Server where ip in (" +
					"select ip from Result " +
					`where ${interaction.values.map(v => `${v} > 0`).join(" and ")} ` +
					"group by ip " +
					`order by ${interaction.values.map(v => `avg(${v})`).join(", ")} ` +
					") limit 25"
				);

				return {
					content: "Pick your server.",
					components: [
						[{
							type: "SELECT_MENU",
							custom_id: "game",
							options: enumStringKeys(SITES).map(k => ({
								label: SITES[k as keyof typeof SITES],
								value: k,
								default: interaction.values.includes(k)
							})),
							max_values: 5
						}],
						[{
							type: "SELECT_MENU",
							custom_id: `server_${interaction.values.join(",")}`,
							options: servers.map((server, i) => ({
								label: `Server ${i + 1} ${round(server.speed / 1000000)}Mbps`,
								value: server.ip,
								emoji: {
									name: emojiData.getEmojiByName(`flag-${server.country.toLowerCase()}`)?.char ?? "🏳️"
								}
							}))
						}]
					]
				};
			}
			default: {
				const games = interaction.customId.substring(7).split(",") as (keyof typeof SITES)[];
				// Give stats
				const ip = interaction.values[0];
				const server = (await client.server.findFirst({ where: { ip } }))!;
				const results = await client.result.findMany({ where: { ip } });


				const avg = (arr: number[]) => round(arr.reduce((p, c) => p + c, 0) / arr.length);

				return {
					content: " ",
					embeds: [{
						title: "Server",
						fields: [
							{
								name: "Hostname",
								value: server.hostname,
								inline: true
							}, {
								name: "IP",
								value: ip,
								inline: true
							}, {
								name: "Speed",
								value: `${round(server.speed / 1000000)}Mbps`,
								inline: true
							}, {
								name: "ISP",
								value: server.isp
							}, {
								name: "<:speangry:829709589686517832> Statistics",
								value: ["connect", ...games].map(item => {
									const filtered = results.filter(result => result[item as keyof typeof result] > 0);
									return `${item === "connect" ? "Connect" : SITES[item as keyof typeof SITES]}\t${avg(filtered.map(result => result[item as keyof typeof result] as number))}ms ${round(filtered.length / results.length * 100)}%`
								}).join("\n")
							}
						]
					}],
					components: [
						[{
							type: "BUTTON",
							custom_id: `download_${ip}`,
							label: "Download",
							style: "PRIMARY",
							emoji: {
								name: "💾"
							}
						}, {
							type: "BUTTON",
							custom_id: `patched_${ip}`,
							label: "Download with game patches",
							style: "SUCCESS",
							emoji: {
								name: "🍆"
							}
						}]
					]
				};
			}
		}
	},
	onButton: async (interaction) => {
		let isNormal = interaction.customId.startsWith("download_"), ip: string;
		if (isNormal) {
			ip = interaction.customId.substring(9);
		} else {
			ip = interaction.customId.substring(8);
		}

		const config = Buffer.from((await client.server.findFirst({ where: { ip } }))!.config, "base64");
		const file = new MessageAttachment(config, `${ip}.ovpn`);

		return {
			content: " ",
			embeds: [],
			files: [file]
		};
	}
};
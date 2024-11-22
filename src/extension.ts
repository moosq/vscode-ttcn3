import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { ExtensionContext, OutputChannel, TestRunRequest, TestRunProfileKind } from 'vscode';
import * as ntt from './ntt';
import * as tcm from './tcManager'
import * as ttcn3_suites from "./ttcn3_suites"
import { TestExecTaskProvider } from './testexecTaskProvider';

import * as lsp from 'vscode-languageclient/node';
import * as path from 'path';
import * as semver from 'semver';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as fs from 'fs';
import decompress from 'decompress';
import { ProxyAgent } from 'proxy-agent';

const lineNoToRange = (lineNo: number) => {
	const position = new vscode.Position(lineNo, 0)
	return new vscode.Range(position, position)
}

class TcSuiteCreator {

};
class Ttcn3TestRunReq extends TestRunRequest {
	/**
	 * Whether the profile should run continuously as source code changes. Only
	 * relevant for profiles that set {@link TestRunProfile.supportsContinuousRun}.
	 */
	readonly continuous?: boolean;

	/**
	 * @param tests Array of specific tests to run, or undefined to run all tests
	 * @param exclude An array of tests to exclude from the run.
	 * @param profile The run profile used for this request.
	 * @param continuous Whether to run tests continuously as source changes.
	 */
	constructor(include?: readonly vscode.TestItem[], exclude?: readonly vscode.TestItem[], profile?: vscode.TestRunProfile, continuous?: boolean) {
		super();
	};
}

let client: lsp.LanguageClient;
let outputChannel: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let nttPath;
let nttExecutable;

export async function activate(context: vscode.ExtensionContext) {
	vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('ttcn3')) {
			sanitizeConfiguration();
		}
	});
	sanitizeConfiguration();
	const conf = vscode.workspace.getConfiguration('ttcn3');

	outputChannel = vscode.window.createOutputChannel('TTCN-3', { log: true });
	context.subscriptions.push(outputChannel);
	outputChannel.appendLine(`Activating TTCN-3 extension version ${context.extension.packageJSON['version']}`);

	status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
	context.subscriptions.push(status);
	status.show()

	nttPath = path.join(context.extensionPath, 'servers');
	nttExecutable = path.join(nttPath, correctBinname("ntt"));

	let cmd = {
		command: nttExecutable,
		args: ['langserver'],
		options: { env: process.env }
	};

	cmd.options.env.PATH = [
		config<string[]>('ttcn3.server.toolsPath')?.join(path.delimiter),
		cmd.options.env.PATH,
	].join(path.delimiter);

	// register test capability
	const testCtrl = vscode.tests.createTestController('ttcn3Executor', 'ttcn-3 Testcase Executor');
	testCtrl.resolveHandler = async test => {
		outputChannel.appendLine(`acquire tests from this point on: ${test?.id}, ${test?.label}`);
	}
	const runHandler = (request: Ttcn3TestRunReq, cancellation: vscode.CancellationToken) => {
		if (!request.continuous) {
			return tcm.startTestRun(request, testCtrl, cancellation, outputChannel);
		}/*
		return startTestRun(new Ttcn3TestRunReq(
			[getOrCreateFile(ctrl, uri).file],
			undefined,
			request.profile,
			true
		))*/
	}

	testCtrl.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runHandler, true); // new vscode.TestTag("@feature:5GC000300-C-c1")
	context.subscriptions.push(testCtrl);
	const initTasks: Promise<void>[] = [];

	const from_ttcn3_suites = ttcn3_suites.findTtcn3Suite(vscode.workspace.workspaceFolders);
	let globFileToTcSuite = new Map<string, ttcn3_suites.OneTtcn3Suite>();
	const tcSuiteCreator = new TcSuiteCreator();
	let suites: ttcn3_suites.Ttcn3SuiteType[] = [];
	let tcListsReady: Promise<void>[] = [];
	outputChannel.append(`Detected ${from_ttcn3_suites.size} suites in workspace.\n`);
	from_ttcn3_suites.forEach(function (v: string, k: string) {
		let content: ttcn3_suites.Ttcn3SuiteType
		outputChannel.append(`Detected a suite in workspace: ${v}\n`);
		const ws = testCtrl.createTestItem(k, k, undefined);
		if (v.length > 0) {
			content = ttcn3_suites.readTtcn3Suite(v);
		} else {
			content = { binary_dir: k, source_dir: k, suites: [{ root_dir: k, source_dir: k, target: "" }] };
		}
		testCtrl.items.add(ws);
		outputChannel.appendLine(`content of ws ${JSON.stringify(content)}\n`);
		content.suites.forEach(function (v: ttcn3_suites.TcSuite, idx: number, list: ttcn3_suites.TcSuite[]) {
			let sct = ws
			if (v.target.length == 0) {
				v.target = path.basename(k);
				const suite = new tcm.TestSuiteData(v.target, content.binary_dir);
				tcm.testData.set(sct, suite);
				sct.canResolveChildren = true;
			} else {
				sct = testCtrl.createTestItem(v.target, v.target, undefined);
				const suite = new tcm.TestSuiteData(v.target, content.binary_dir);
				tcm.testData.set(sct, suite);
				sct.canResolveChildren = true;
				ws.children.add(sct);
				ws.canResolveChildren = true;
			}

			tcListsReady.push(ntt.getTestcaseList(outputChannel, ntt.getNttExeFromToolsPath(conf), v.root_dir).then(function (list: ntt.Ttcn3Test[]) {
				outputChannel.appendLine(`Detected ${list.length} tests from ${v.target}`);
				const file2Tests = new Map<string, ntt.Ttcn3Test[]>();
				let mod: vscode.TestItem;
				list.forEach(function (vtc: ntt.Ttcn3Test, idx: number, a: ntt.Ttcn3Test[]) {
					if (file2Tests.has(vtc.filename)) {
						file2Tests.get(vtc.filename)!.push(vtc);
					} else {
						mod = testCtrl.createTestItem(vtc.filename, vtc.filename, undefined);
						sct.children.add(mod);
						mod.canResolveChildren = true;
						const moduleData = new tcm.ModuleData(vtc.filename);
						tcm.testData.set(mod, moduleData);

						file2Tests.set(vtc.filename, [vtc]);
						globFileToTcSuite.set(vtc.filename, { source_dir: v.source_dir, root_dir: v.root_dir, binary_dir: content.binary_dir, target: v.target, ui_tcmodule: mod });
						outputChannel.appendLine(`adding content to globFileToTcSuite size=${globFileToTcSuite.size}`);
					}
					const tcUri = vscode.Uri.file(vtc.filename)
					const tc = testCtrl.createTestItem(vtc.id.concat(vtc.filename), vtc.id, tcUri);
					tc.range = lineNoToRange(vtc.line - 1);
					let tcTags: vscode.TestTag[] = [];
					if (vtc.tags !== undefined) {
						ntt.buildTagsList(conf, vtc.tags).forEach(function (tagId: string) {
							tcTags.push(new vscode.TestTag(tagId));
						});
						tc.tags = tcTags;
					}
					outputChannel.appendLine(`tags for ${vtc.id}: ${JSON.stringify(tc.tags)}`);
					mod.children.add(tc);
				});
			}));
		});
		outputChannel.appendLine(`1. suites ${v} has been completed. Size of globFileToTcSuite ${globFileToTcSuite.size}`);
		suites = suites.concat(content);
	})
	await Promise.all(tcListsReady);
	const testExecTaskProvider = vscode.tasks.registerTaskProvider(TestExecTaskProvider.TestExecType, new TestExecTaskProvider(suites));

	outputChannel.appendLine(`all suites have been completed. size of ${globFileToTcSuite.size}`);
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(
		(e: vscode.TextEditor | undefined) => {
			outputChannel.appendLine(`filename of the newly selected window: ${e?.document.fileName},${JSON.stringify(e)}`);
			const isTtcn3File = ((e !== undefined) && (e.document.fileName.endsWith('.ttcn3')));
			const name = (isTtcn3File) ? e.document.fileName : "no ttcn-3 file";
			generateTcListForCurrFile(testCtrl, conf, globFileToTcSuite, name, isTtcn3File);
		},));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(
		(e: vscode.TextDocument) => {
			// TODO: this doesn't update the tc list for the complete workspace
			const isTtcn3File = e.fileName.endsWith('.ttcn3');
			const name = (isTtcn3File) ? e.fileName : "no ttcn-3 file";
			generateTcListForCurrFile(testCtrl, conf, globFileToTcSuite, name, isTtcn3File);
		},));
	const isTtcn3File = ((vscode.window.activeTextEditor !== undefined) && (vscode.window.activeTextEditor.document.fileName.endsWith('.ttcn3')));
	const name = ((vscode.window.activeTextEditor !== undefined) && isTtcn3File) ? vscode.window.activeTextEditor.document.fileName : "no ttcn-3 file";
	generateTcListForCurrFile(testCtrl, conf, globFileToTcSuite, name, isTtcn3File);

	let custom = config<string | undefined>('ttcn3.server.command')?.trim()
	if (custom) {
		let args = custom.split(/\s+/).map(s => s.trim());
		cmd.command = args[0];
		cmd.args = args.slice(1);
	} else if (config('ttcn3.server.automaticUpdate')) {
		const installedVersion = await getInstalledVersion(cmd.command, { env: cmd.options.env });
		try {
			outputChannel.appendLine(`Checking for updates...`);
			const { version: latestVersion, asset: serverAsset, url: releaseNotes } = await getLatestVersion();
			outputChannel.appendLine(`Latest version: ${latestVersion}`);
			outputChannel.appendLine(`Installed version: ${installedVersion}`);
			const msg = `There is an available update for TTCN-3 language server.`;
			const details = `Do you want to update the TTCN-3 language server to version ${latestVersion}?\n\nA language Server enhances the TTCN-3 experience with code navigation, coloring, code completion and more.\n\nYou can revert to the initial version anytime by reinstalling the extension.`;
			if (semver.gt(latestVersion, installedVersion)) {
				outputChannel.appendLine(`Release notes: ${releaseNotes}`);
				if (await showUpdateDialog(msg, details)) {
					await updateServer(nttPath, serverAsset, latestVersion);
				}
			}
		} catch (error) {
			status.text = `$(error) Could not update TTCN-3 Language Server`;
			outputChannel.appendLine(`Could not update TTCN-3 Language Server: ${error}`);
			vscode.window.showWarningMessage(`Could not update/download TTCN-3 Language Server. See output channel for details.`);
			outputChannel.show();
		}
	}

	client = new lsp.LanguageClient('ttcn3', 'TTCN-3 Language Client', cmd, {
		documentSelector: ['ttcn3'],
		outputChannel: outputChannel,
	});

	try {
		outputChannel.appendLine(`Starting ${cmd.command} ${cmd.args.join(' ')}`);
		await client.start();
		const info = client.initializeResult?.serverInfo;
		if (info) {
			status.text = `${info.name} ${info.version}`;
		}
	} catch (e: any) {
		vscode.window.showInformationMessage(`Could not start the TTCN-3 Language Server: ${e}`);
		return;
	}

	context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.restart", async () => {
		await client.restart();
	}));

	context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.status", async () => {
		const params: lsp.ExecuteCommandParams = { command: "ntt.status", arguments: [] };
		await client.sendRequest(lsp.ExecuteCommandRequest.type, params);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.debug.toggle", async () => {
		const params: lsp.ExecuteCommandParams = { command: "ntt.debug.toggle", arguments: [] };
		await client.sendRequest(lsp.ExecuteCommandRequest.type, params);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("ntt.test", async (args) => {
		const params: lsp.ExecuteCommandParams = { command: "ntt.test", arguments: [args] };
		await client.sendRequest(lsp.ExecuteCommandRequest.type, params);
	}));

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
			// react on any configuration change.
			// Let the server decide what is usefull
			const params: lsp.DidChangeConfigurationParams = { settings: undefined };
			client.sendNotification(lsp.DidChangeConfigurationNotification.type, params);
		}));
	return;
}
async function insertNewSuite(testCtrl: vscode.TestController, conf: vscode.WorkspaceConfiguration, globFileToTcSuite: ttcn3_suites.File2Suites, name: string) {
	let manifestDir = ntt.discoverManifestFile(path.dirname(name));
	let s: ntt.Ttcn3TestSuite;
	if (!manifestDir) {
		manifestDir = name;
	}

	await ntt.show(outputChannel, ntt.getNttExeFromToolsPath(conf), manifestDir).then((suite: ntt.Ttcn3TestSuite) => {
		s = suite;
	});

	await ntt.getTestcaseList(outputChannel, ntt.getNttExeFromToolsPath(conf), (manifestDir) ? manifestDir : name).then((list: ntt.Ttcn3Test[],) => {
		if (list.length == 0) { return }

		const file2Tests = new Map<string, ntt.Ttcn3Test[]>();
		list.forEach((vtc: ntt.Ttcn3Test, idx: number, a: ntt.Ttcn3Test[]) => {
			if (file2Tests.has(vtc.filename)) {
				file2Tests.get(vtc.filename)!.push(vtc);
			} else {
				file2Tests.set(vtc.filename, [vtc]);
			}
		});

		const newSuite = testCtrl.createTestItem(s.name, s.name, undefined);
		newSuite.canResolveChildren = true;

		outputChannel.appendLine(`insertNewSuite: #tests=${list.length}, spread over #files=${file2Tests.size}`);
		file2Tests.forEach((v, k) => {
			outputChannel.appendLine(`generateTcListForCurrFile: file2Tests: [${k}]=${JSON.stringify(v)}`);
			const mod = testCtrl.createTestItem(k, k, undefined);
			const moduleData = new tcm.ModuleData(k);
			if (globFileToTcSuite.has(k)) {
				//const partOfSuite = globFileToTcSuite.get(k)!;
				//outputChannel.appendLine(`generateTcListForCurrFile: the parent of key: ${k}= ${partOfSuite.ui_tcmodule.parent} with size ${partOfSuite.ui_tcmodule.parent?.children.size} children. isPartOfSuite.root_dir: ${partOfSuite.root_dir}`);
				//tcm.testData.delete(partOfSuite.ui_tcmodule); // delete the old UI data and replace it later with the content of moduleData
				//partOfSuite.ui_tcmodule.parent?.children.add(mod); // exchange the module branch inside the tc suite
				//partOfSuite.ui_tcmodule = mod;
				//globFileToTcSuite.set(k, partOfSuite);
			} else {
				globFileToTcSuite.set(k, { source_dir: path.dirname(name), root_dir: path.dirname(name), binary_dir: path.dirname(name), target: "", ui_tcmodule: mod }); // this still did not resolve appearance of the second file inside the suite
			}
			tcm.testData.set(mod, moduleData); // associate the module(file) with appropriate data
			newSuite.children.add(mod);

			// add all the tests to the module
			v.forEach(tcName => {
				const tcUri = vscode.Uri.file(k);
				const tc = testCtrl.createTestItem(tcName.id.concat(k), tcName.id, tcUri);
				tc.range = lineNoToRange(tcName.line - 1);
				let tcTags: vscode.TestTag[] = [];
				if (tcName.tags !== undefined) {
					ntt.buildTagsList(conf, tcName.tags).forEach((tagId: string) => {
						tcTags.push(new vscode.TestTag(tagId));
					});
					tc.tags = tcTags;
					tcTags.length = 0;
					ntt.buildTagsList(conf, tcName.tags).forEach((tagId: string) => {
						tcTags.push(new vscode.TestTag(tagId));
					});
				}

				mod.children.add(tc);
			});
			mod.canResolveChildren = true;
		})
		const sData = new tcm.TestSuiteData("", s.root);
		tcm.testData.set(newSuite, sData); // associate the suite with appropriate data
		testCtrl.items.add(newSuite);//add the new suite to the UI
	})

}
async function generateTcListForCurrFile(testCtrl: vscode.TestController, conf: vscode.WorkspaceConfiguration, globFileToTcSuite: ttcn3_suites.File2Suites, name: string, isTtcn3File: boolean) {
	{
		if (isTtcn3File) {
			outputChannel.appendLine(`generateTcListForCurrFile: file: ${name}, globFileToTcSuite: length=${globFileToTcSuite.size}, ${JSON.stringify(globFileToTcSuite)}`);
			if (!globFileToTcSuite.has(name)) {
				insertNewSuite(testCtrl, conf, globFileToTcSuite, name);
			}
			else {
				//file is already known, just update the test list
				const partOfSuite = globFileToTcSuite.get(name)!;
				let suiteName = "";

				await ntt.getTestcaseList(outputChannel, ntt.getNttExeFromToolsPath(conf), name).then((list: ntt.Ttcn3Test[],) => {
					const file2Tests = new Map<string, ntt.Ttcn3Test[]>();
					list.forEach((vtc: ntt.Ttcn3Test, idx: number, a: ntt.Ttcn3Test[]) => {
						if (file2Tests.has(vtc.filename)) {
							file2Tests.get(vtc.filename)!.push(vtc);
						} else {
							file2Tests.set(vtc.filename, [vtc]);
						}
					});

					outputChannel.appendLine(`generateTcListForCurrFile: update tc list for '${name}': #files=${file2Tests.size}, #tests=${list.length}`);
					file2Tests.forEach((v, k) => {
						outputChannel.appendLine(`generateTcListForCurrFile: file2Tests: [${k}]=${JSON.stringify(v)}`);
						const mod_ui = testCtrl.createTestItem(k, k, undefined);
						const moduleData = new tcm.ModuleData(k);
						tcm.testData.delete(partOfSuite.ui_tcmodule); // delete the old UI data and replace it later with the content of moduleData
						partOfSuite.ui_tcmodule.parent?.children.add(mod_ui); // exchange the module branch inside the tc suite
						partOfSuite.ui_tcmodule = mod_ui;
						globFileToTcSuite.set(k, partOfSuite);
						outputChannel.appendLine(`generateTcListForCurrFile: isPartOfSuite: ${JSON.stringify(partOfSuite.root_dir)} for key: ${k}`);
						tcm.testData.set(mod_ui, moduleData);

						v.forEach(tcName => {
							const tcUri = vscode.Uri.file(k);
							const tc = testCtrl.createTestItem(tcName.id.concat(k), tcName.id, tcUri);
							tc.range = lineNoToRange(tcName.line - 1);
							let tcTags: vscode.TestTag[] = [];
							if (tcName.tags !== undefined) {
								ntt.buildTagsList(conf, tcName.tags).forEach((tagId: string) => {
									tcTags.push(new vscode.TestTag(tagId));
								});
								tc.tags = tcTags;
								tcTags.length = 0;
								ntt.buildTagsList(conf, tcName.tags).forEach((tagId: string) => {
									tcTags.push(new vscode.TestTag(tagId));
								});
							}

							mod_ui.children.add(tc);
						});
						mod_ui.canResolveChildren = true;
					});
				});
			}
		}
	}
}

function sanitizeConfiguration() {
	const update = config<boolean>('ttcn3.server.automaticUpdate');
	const cmd = config<string>('ttcn3.server.command');

	if (update && cmd) {
		vscode.workspace.getConfiguration().update('ttcn3.server.automaticUpdate', false, vscode.ConfigurationTarget.Global);
		vscode.window.showWarningMessage("Automatic updates have been disabled, because custom commands cannot be updated.");
	}
}

async function updateServer(installDir: string, serverAsset: Asset, latestVersion: string) {
	if (!(await fsExists(installDir))) {
		await fs.promises.mkdir(installDir, { recursive: true });
	}

	const url = serverAsset.browser_download_url;
	outputChannel.appendLine(`Downloading ${url}...`);
	const response = await fetch(url, {
		responseType: 'stream',
		onDownloadProgress: (progressEvent: any) => {
			const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
			status.text = `$(sync~spin) Downloading ${assetName()} ${latestVersion} :: ${percent.toFixed(2)} %`;
		}
	});

	const downloadDest = path.join(installDir, `download-${assetName()}`);
	const writer = fs.createWriteStream(downloadDest);
	response.data.pipe(writer);
	await new Promise((resolve, reject) => {
		writer.on('finish', resolve);
		writer.on('error', reject);
	});

	status.text = `$(sync~spin) Unpacking...`;
	await decompress(downloadDest, installDir, {
		filter: (file: any) => path.basename(file.path) == correctBinname("ntt")
	});
	await fs.promises.unlink(downloadDest);
	if (isOSUnixoid()) {
		child_process.exec(`chmod +x ${installDir}/ntt`);
	}
	status.text = `$(check) Installed ${latestVersion}`;
}


function getInstalledVersion(nttExecutable: string, options?: child_process.ExecSyncOptions): string {
	try {
		let stdout = child_process.execSync(`${nttExecutable} version`, options).toString().trim();
		let sv = semver.coerce(stdout);
		if (!sv) {
			return '0.0.0';
		}
		return sv.version;
	} catch (error: any) {
		return '0.0.0';
	}
}

async function getLatestVersion(): Promise<{ version: string, asset: Asset, url: string }> {
	let url = config<string | undefined>('ttcn3.server.updateServerURL')?.trim();
	if (!url) {
		url = 'https://ttcn3.dev/api/v1/ntt';
	}

	const response = await fetch(`${url}/releases`);
	const data = await response.data;
	if (!response.headers['content-type']?.includes('application/json')) {
		throw new Error(`Unexpected response from ${url}:\n${response.headers}\n\n${data}`);
	}
	const releases = data as Release[];
	const releaseInfo: Release = releases
		.filter(release => {
			return !release.prerelease || config<boolean>('ttcn3.server.usePrereleases')
		})
		.sort((latest, release) => {
			const a = semver.coerce(latest.tag_name) || '0.0.0';
			const b = semver.coerce(release.tag_name) || '0.0.0';
			if (semver.lt(a, b)) {
				return 1;
			} if (semver.gt(a, b)) {
				return -1;
			} else {
				return 0;
			}
		})[0];

	const serverAsset = releaseInfo.assets.find(asset => asset.name === assetName());
	if (!serverAsset) {
		throw new Error(`Missing asset URL from ${url}: ${assetName()}`);
	}
	return { version: releaseInfo.tag_name, asset: serverAsset, url: releaseInfo.html_url };
}

async function showUpdateDialog(msg: string, details: string): Promise<boolean> {
	const cancelButton: vscode.MessageItem = { title: 'Cancel', isCloseAffordance: true }
	const updateButton: vscode.MessageItem = { title: 'Update', isCloseAffordance: false }
	const selected = await vscode.window.showInformationMessage(msg, { modal: true, detail: details }, cancelButton, updateButton);
	return selected === updateButton;
}

function config<T>(key: string): T | undefined {
	return vscode.workspace.getConfiguration().get(key);
}

function assetName(): string {
	const os = getOs();
	const arch = getArch();
	return `ntt_${os}_${arch}.tar.gz`;
}

function getOs(): string {
	let platform = process.platform.toString();
	if (platform === 'win32') {
		return 'windows';
	}
	return platform;
}

function getArch(): string {
	let arch = process.arch;

	if (arch === 'ia32') {
		return 'i386';
	}
	if (arch === 'x64') {
		return 'x86_64';
	}
	if (arch === 'arm64' && process.platform.toString() === 'darwin') {
		// On Apple Silicon, install the amd64 version and rely on Rosetta2
		// until a native build is available.
		return 'x86_64';
	}
	return arch;
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

function fetch<T = any, R = AxiosResponse<T>, D = any>(url: string, conf?: AxiosRequestConfig<D>): Promise<R> {
	// Axios has an issue with HTTPS requests over HTTP proxies. A custom
	// agent circumvents this issue.
	const agent = new ProxyAgent()
	if (!conf) {
		conf = {}
	}
	conf.proxy = false;
	conf.httpAgent = agent;
	conf.httpsAgent = agent;
	if (config('ttcn3.server.ignoreCertificateErrors')) {
		conf.httpsAgent.rejectUnauthorized = false;
	}

	// Some common headers
	if (!conf.headers) {
		conf.headers = {}
	}
	conf.headers["User-Agent"] = "vscode-ttcn3-ide";
	conf.headers["Cache-Control"] = "no-cache";
	conf.headers["Pragma"] = "no-cache";
	return axios.get(url, conf);
}

export interface Release {
	url: string;
	assets_url: string;
	upload_url: string;
	html_url: string;
	id: number;
	node_id: string;
	tag_name: string;
	target_commitish: string;
	name: string;
	draft: boolean;
	author: Author;
	prerelease: boolean;
	created_at: string;
	published_at: string;
	assets: Asset[];
	tarball_url: string;
	zipball_url: string;
	body: any | null;
}

export interface Author {
	login: string;
	id: number;
	node_id: string;
	gravatar_id: string;
	url: string;
	html_url: string;
	followers_url: string;
	following_url: string;
	gists_url: string;
	starred_url: string;
	subscriptions_url: string;
	organizations_url: string;
	repos_url: string;
	events_url: string;
	received_events_url: string;
	type: string;
	site_admin: boolean;
}

export interface Asset {
	url: string;
	id: number;
	node_id: string;
	name: string;
	label: string;
	uploader: Author;
	content_type: string;
	state: string;
	size: number;
	download_count: number;
	created_at: string;
	updated_at: string;
	browser_download_url: string;
}

export async function fsExists(path: fs.PathLike): Promise<boolean> {
	try {
		await fs.promises.access(path);
		return true;
	} catch {
		return false;
	}
}

export function isOSUnixoid(): boolean {
	let platform = process.platform;
	return platform === "linux"
		|| platform === "darwin"
		|| platform === "freebsd"
		|| platform === "openbsd";
}

export function correctBinname(binname: string): string {
	return binname + ((process.platform === 'win32') ? '.exe' : '');
}

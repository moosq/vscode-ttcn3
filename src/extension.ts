import fs = require('fs');
import path = require('path');
import * as child_process from "child_process";
import * as vscode from 'vscode';
import { ExtensionContext, OutputChannel, TestRunRequest, TestRunProfileKind } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, ExecuteCommandParams, ExecuteCommandRequest, DidChangeConfigurationParams, DidChangeConfigurationNotification, VersionedTextDocumentIdentifier } from 'vscode-languageclient/node';
import * as ntt from './ntt';
import * as tcm from './tcManager'
import * as ttcn3_suites from "./ttcn3_suites"
import { LOG } from './util/logger';
import { ServerDownloader } from './serverDownloader';
import { Status, StatusBarEntry } from './util/status';
import { isOSUnixoid, correctBinname } from './util/osUtils';
import { O_SYMLINK } from 'constants';
import { fsExists } from './util/fsUtils';
import { Suite } from 'mocha';
import { profile } from 'console';

let client: LanguageClient;
let outputChannel: OutputChannel;

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

export async function activate(context: ExtensionContext) {

	outputChannel = vscode.window.createOutputChannel("TTCN-3", "ttcn3-out");
	//testExecOutChannel = vscode.window.createOutputChannel("TTCN-3-Test");
	context.subscriptions.push(outputChannel);

	const conf = vscode.workspace.getConfiguration('ttcn3');

	// Our work is done, if the user does not want to run a language server.
	if (!conf.get('useLanguageServer') && !conf.get('server.enabled')) {
		outputChannel.appendLine('Language server is disabled. If you like to use features like go to definition, enable the language server by opening vscode settings and set ttcn3.useLanguageServer to true. For more information about the TTCN-3 language server, have a look at https://nokia.github.io/ntt/editors/');

		context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.restart", async () => {
			outputChannel.appendLine("Restart command is not available, please enable TTCN-3 Language Server in vscode settings.");
		}));

		context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.status", async () => {
			outputChannel.appendLine("Status command is not available, please enable TTCN-3 Language Server in vscode settings.");
		}));

		context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.debug.toggle", async () => {
			outputChannel.appendLine("Toggle debug command is not available, please enable TTCN-3 Language Server in vscode settings.");
		}));
		return;
	}

	// register test capability
	const testCtrl = vscode.tests.createTestController('ttcn3Executor', 'ttcn-3 Testcase Executor');
	testCtrl.resolveHandler = async test => {
		outputChannel.appendLine(`acquire tests from this point on: ${test?.id}, ${test?.label}`);
	}
	const runHandler = (request: Ttcn3TestRunReq, cancellation: vscode.CancellationToken) => {
		if (!request.continuous) {
			return tcm.startTestRun(request, testCtrl, outputChannel);
		}/*
		return startTestRun(new Ttcn3TestRunReq(
			[getOrCreateFile(ctrl, uri).file],
			undefined,
			request.profile,
			true
		))*/
	}

	testCtrl.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runHandler, true, undefined);
	context.subscriptions.push(testCtrl);
	const initTasks: Promise<void>[] = [];

	initTasks.push(withSpinningStatus(context, async status => {
		await activateLanguageServer(context, status, conf);
	}));

	const from_ttcn3_suites = ttcn3_suites.findTtcn3Suite(vscode.workspace.workspaceFolders);
	let globFileToTcSuite = new Map<string, ttcn3_suites.OneTtcn3Suite>();
	const tcSuiteCreator = new TcSuiteCreator();
	let tcListsReady: Promise<void>[] = [];
	from_ttcn3_suites.forEach(function (v: string, k: string) {
		outputChannel.append(`Detected a suite in workspace: ${v}\n`);
		const ws = testCtrl.createTestItem(k, k, undefined);
		const content = ttcn3_suites.readTtcn3Suite(v);

		testCtrl.items.add(ws);
		outputChannel.appendLine(`content of ws ${JSON.stringify(content)}\n`);
		content.suites.forEach(function (v: ttcn3_suites.TcSuite, idx: number, list: ttcn3_suites.TcSuite[]) {
			const sct = testCtrl.createTestItem(v.target, v.target, undefined);
			const suite = new tcm.TestSuiteData(v.target, content.binary_dir);
			tcm.testData.set(sct, suite);
			sct.canResolveChildren = true;
			ws.children.add(sct);
			ws.canResolveChildren = true;
			tcListsReady.push(ntt.getTestcaseList(outputChannel, '/sdk/prefix_root_NATIVE-gcc/usr/bin/ntt', v.root_dir).then(function (list: ntt.Ttcn3Test[]) {
				outputChannel.appendLine(`Detected ${list.length} tests from ${v.target}`);
				const file2Tests = new Map<string, ntt.Ttcn3Test[]>();
				list.forEach(function (vtc: ntt.Ttcn3Test, idx: number, a: ntt.Ttcn3Test[]) {
					if (file2Tests.has(vtc.filename)) {
						file2Tests.get(vtc.filename)!.push(vtc);
					} else {
						file2Tests.set(vtc.filename, [vtc]);
						outputChannel.appendLine(`adding content to globFileToTcSuite: ${vtc.filename}=${JSON.stringify(v)}`);
						globFileToTcSuite.set(vtc.filename, { source_dir: v.source_dir, root_dir: v.root_dir, binary_dir: content.binary_dir, target: v.target });
						outputChannel.appendLine(`adding content to globFileToTcSuite size=${globFileToTcSuite.size}: ${JSON.stringify(globFileToTcSuite)}`);
					}
				});
				file2Tests.forEach((v, k) => {
					const mod = testCtrl.createTestItem(k, k, undefined);
					const moduleData = new tcm.ModuleData(k);
					tcm.testData.set(mod, moduleData);
					sct.children.add(mod);

					v.forEach(tcName => {
						const tcUri = vscode.Uri.file(k)
						const tc = testCtrl.createTestItem(tcName.id.concat(k), tcName.id, tcUri.with({ fragment: String(tcName.line) }));
						mod.children.add(tc);
					})
					mod.canResolveChildren = true;
				});
			}));
		});
		outputChannel.appendLine(`suites ${v} has been completed. Content of ${JSON.stringify(globFileToTcSuite)}`);
	})
	await Promise.all(tcListsReady);
	outputChannel.appendLine(`all suites have been completed. size of ${globFileToTcSuite.size}`);
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(
		(e: vscode.TextEditor | undefined) => {
			outputChannel.appendLine(`filename of the newly selected window: ${e?.document.fileName},${e}`);
			const isTtcn3File = ((e !== undefined) && (e.document.fileName.endsWith('.ttcn3')));
			const name = (isTtcn3File) ? e.document.fileName : "no ttcn-3 file";
			generateTcListForCurrFile(testCtrl, globFileToTcSuite, name, isTtcn3File);
		},));
	const isTtcn3File = ((vscode.window.activeTextEditor !== undefined) && (vscode.window.activeTextEditor.document.fileName.endsWith('.ttcn3')));
	const name = ((vscode.window.activeTextEditor !== undefined) && isTtcn3File) ? vscode.window.activeTextEditor.document.fileName : "no ttcn-3 file";
	generateTcListForCurrFile(testCtrl, globFileToTcSuite, name, isTtcn3File);
}

function generateTcListForCurrFile(testCtrl: vscode.TestController, globFileToTcSuite: Map<string, ttcn3_suites.OneTtcn3Suite>, name: string, isTtcn3File: boolean) {
	{
		const currFile = testCtrl.createTestItem("current active file", "current active file", undefined);
		currFile.canResolveChildren = false;
		if (isTtcn3File) {
			ntt.getTestcaseList(outputChannel, '/sdk/prefix_root_NATIVE-gcc/usr/bin/ntt', name).then((list: ntt.Ttcn3Test[]) => {
				const file2Tests = new Map<string, ntt.Ttcn3Test[]>();
				list.forEach((vtc: ntt.Ttcn3Test, idx: number, a: ntt.Ttcn3Test[]) => {
					if (file2Tests.has(vtc.filename)) {
						file2Tests.get(vtc.filename)!.push(vtc);
					} else {
						file2Tests.set(vtc.filename, [vtc]);
					}
				});
				file2Tests.forEach((v, k) => {
					let sData: tcm.TestSuiteData;
					currFile.canResolveChildren = true;
					const mod = testCtrl.createTestItem(k, k, undefined);
					const moduleData = new tcm.ModuleData(k);
					if (globFileToTcSuite.has(k)) {
						const isPartOfSuite = globFileToTcSuite.get(k)!;
						outputChannel.appendLine(`isPartOfSuite: ${JSON.stringify(isPartOfSuite.root_dir)} for key: ${k}`);
						sData = new tcm.TestSuiteData(isPartOfSuite.target, isPartOfSuite.binary_dir);
					} else {
						sData = new tcm.TestSuiteData("", "");
					}
					tcm.testData.set(mod, moduleData);
					currFile.children.add(mod);
					tcm.testData.set(currFile, sData);
					vscode.Uri;
					v.forEach(tcName => {
						const tcUri = vscode.Uri.file(k);
						const tc = testCtrl.createTestItem(tcName.id.concat(k), tcName.id, tcUri.with({ fragment: String(tcName.line) }));
						mod.children.add(tc);
					});
					mod.canResolveChildren = true;
				});
			});
			testCtrl.items.add(currFile);
		} else {
			testCtrl.items.delete("current active file");
		}
	}
}

async function withSpinningStatus(context: vscode.ExtensionContext, action: (status: Status) => Promise<void>): Promise<void> {
	const status = new StatusBarEntry(context, "$(sync~spin)");
	status.show();
	await action(status);
	status.dispose();
}

export async function activateLanguageServer(context: vscode.ExtensionContext, status: Status, conf: vscode.WorkspaceConfiguration) {

	outputChannel.appendLine('Activating TTCN-3 Language Server...');
	status.update('Activating Activating TTCN-3 Language Server...');

	const installDir = path.join(context.extensionPath, "servers");
	const nttDownloader = new ServerDownloader("TTCN-3 Language Server", "ntt", assetName(), installDir, outputChannel);

	if (conf.get('server.update')) {
		try {
			await nttDownloader.downloadServerIfNeeded(status);
			// Ensure that start script can be executed
			if (isOSUnixoid()) {
				child_process.exec(`chmod +x ${installDir}/ntt`);
			}
		} catch (error) {
			console.error(error);
			vscode.window.showWarningMessage(`Could not update/download TTCN-3 Language Server: ${error}`);
		}
	}

	const ntt = await findNttExecutable(installDir);
	let toolsPath: string = "";
	let separator: string;
	if (getOs() === 'windows') {
		separator = ';';
	} else {
		separator = ':';
	}
	let pathList: string[] | undefined = conf.get('server.toolsPath');
	var libraryList: string[] = new Array();
	let libraryPath: string = "";
	if (pathList) {
		if (getOs() != 'windows') {
			pathList.forEach(element => {
				libraryList.push(element + '/../lib64');
				libraryList.push(element + '/../lib');
			});
			libraryPath = libraryList.join(separator);
			libraryPath = libraryPath + separator + process.env['LD_LIBRARY_PATH']!;
		}
		toolsPath = pathList.join(separator);
		if (toolsPath.length > 0) {
			toolsPath = toolsPath + separator + process.env['PATH']!;
		} else {
			toolsPath = process.env['PATH']!;
		}
	}
	outputChannel.appendLine('toolsPath: ' + toolsPath);
	let serverOptions: ServerOptions = {
		run: { command: ntt, args: ['langserver'], options: { env: process.env } },
		debug: { command: ntt, args: ['langserver'], options: { env: process.env } }
	};
	if (serverOptions.debug.options) {
		serverOptions.debug.options.env['PATH'] = toolsPath;
		if (libraryPath.length > 0) {
			serverOptions.debug.options.env['LD_LIBRARY_PATH'] = libraryPath;
		}
	}
	if (serverOptions.run.options) {
		serverOptions.run.options.env['PATH'] = toolsPath;
		if (libraryPath.length > 0) {
			serverOptions.run.options.env['LD_LIBRARY_PATH'] = libraryPath;
		}
	}

	let clientOptions: LanguageClientOptions = {
		documentSelector: ['ttcn3'],
		outputChannel: outputChannel
	};

	// Create the language client and start the client.
	status.update(`Initializing TTCN-3 Language Server...`);
	client = new LanguageClient('ttcn3', 'TTCN-3 Language Server', serverOptions, clientOptions);
	try {
		await client.start();
	} catch (e) {
		if (e instanceof Error) {
			vscode.window.showInformationMessage('Could not start the TTCN-3 Language Server:', e.message);
		} else if (typeof e === 'string') {
			vscode.window.showInformationMessage('Could not start the TTCN-3 Language Server:', e);
		} else {
			vscode.window.showInformationMessage('Could not start the TTCN-3 Language Server: unknown error');
		}
		return;
	}

	context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.restart", async () => {
		await client.stop();

		outputChannel.appendLine("");
		outputChannel.appendLine(" === Language Server Restart ===");
		outputChannel.appendLine("");

		await client.start();
	}));

	context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.status", async () => {
		const params: ExecuteCommandParams = { command: "ntt.status", arguments: [] };
		await client.sendRequest(ExecuteCommandRequest.type, params);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.debug.toggle", async () => {
		const params: ExecuteCommandParams = { command: "ntt.debug.toggle", arguments: [] };
		await client.sendRequest(ExecuteCommandRequest.type, params);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("ntt.test", async (args) => {
		const params: ExecuteCommandParams = { command: "ntt.test", arguments: [args] };
		await client.sendRequest(ExecuteCommandRequest.type, params);
	}));
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
			// react on any configuration change.
			// Let the server decide what is usefull
			const params: DidChangeConfigurationParams = { settings: undefined };
			client.sendNotification(DidChangeConfigurationNotification.type, params);
		}));
}

async function findNttExecutable(installDir: string): Promise<string> {
	let ntt = correctBinname("ntt");
	let nttPath = path.join(installDir, ntt);

	// Try installed binary
	if (fs.existsSync(nttPath)) {
		return nttPath;
	}

	// Then search PATH parts
	if (process.env['PATH']) {
		outputChannel.append("Looking for ntt in PATH...");

		let pathparts = process.env['PATH'].split(path.delimiter);
		for (let i = 0; i < pathparts.length; i++) {
			let binpath = path.join(pathparts[i], ntt);
			if (fs.existsSync(binpath)) {
				outputChannel.appendLine(binpath);
				return binpath;
			}
		}
		outputChannel.appendLine("");
	}

	let p = process.env['PATH'];
	outputChannel.appendLine(`Could not find ntt in ${p}, will try using binary name directly`);
	return ntt;
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

import fs = require('fs');
import path = require('path');
import * as child_process from "child_process";
import * as vscode from 'vscode';
import { ExtensionContext, OutputChannel, TestRunRequest, TestRunProfileKind } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, ExecuteCommandParams, ExecuteCommandRequest, DidChangeConfigurationParams, DidChangeConfigurationNotification } from 'vscode-languageclient/node';
import { LOG } from './util/logger';
import { ServerDownloader } from './serverDownloader';
import { Status, StatusBarEntry } from './util/status';
import { isOSUnixoid, correctBinname } from './util/osUtils';
import { O_SYMLINK } from 'constants';
import { fsExists } from './util/fsUtils';
import { Suite } from 'mocha';

let client: LanguageClient;
let outputChannel: OutputChannel;

let generationCounter = 0;

type Ws2Suite = Map<string, string>;
interface TcSuite {
	root_dir: string
	source_dir: string
	target: string
}
interface Ttcn3SuiteType {
	source_dir: string
	binary_dir: string
	suites: TcSuite[]
}
function findTtcn3Suite(ws: readonly vscode.WorkspaceFolder[] | undefined): Ws2Suite {
	let p: string[] = [];
	const ws2suite: Ws2Suite = new Map<string, string>();
	ws?.forEach(element => {
		if (fs.existsSync(element.uri.fsPath)) {
			const file = path.join(element.uri.fsPath, 'build', 'ttcn3_suites.json');
			if (fs.existsSync(file)) {
				ws2suite.set(element.uri.fsPath, file);
			}
		}
	});
	return ws2suite;
}
function readTtcn3Suite(fileName: string): Ttcn3SuiteType {
	let content = fs.readFileSync(fileName, 'utf8');
	let obj: Ttcn3SuiteType = JSON.parse(content);
	return obj;
}

class TestCase {
	constructor(
		private readonly a: number,
		private readonly expected: number
	) { }

	getLabel() {
		return `this is a test with a number ${this.a} expected: ${this.expected}`;
	}

	async run(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
		const start = Date.now();
		await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000)); // simulating a random longer time for execution
		const actual = this.evaluate();
		const duration = Date.now() - start;

		if (actual === this.expected) {
			options.passed(item, duration);
		} else {
			const message = vscode.TestMessage.diff(`Expected ${item.label}`, String(this.expected), String(actual));
			message.location = new vscode.Location(item.uri!, item.range!);
			options.failed(item, message, duration);
		}
	}

	private evaluate() {
		return this.a;
	}
}

class TestFile {
	public didResolve = false;

	public async updateFromDisk(controller: vscode.TestController, item: vscode.TestItem) {
		try {
			item.error = undefined;
			this.updateFromContents(controller, "some text", item);
		} catch (e) {
			item.error = (e as Error).stack;
		}
	}

	/**
	 * Parses the tests from the input text, and updates the tests contained
	 * by this file to be those from the text,
	 */
	public updateFromContents(controller: vscode.TestController, content: string, item: vscode.TestItem) {
		const ancestors = [{ item, children: [] as vscode.TestItem[] }];
		const thisGeneration = generationCounter++;
		this.didResolve = true;

		const ascend = (depth: number) => {
			while (ancestors.length > depth) {
				const finished = ancestors.pop()!;
				finished.item.children.replace(finished.children);
			}
		};

		const parent = ancestors[ancestors.length - 1];
		const data = new TestCase(12, 11);
		const id = `${item.uri}/${data.getLabel()}`;
		const tcase = controller.createTestItem(id, data.getLabel(), item.uri);
		testData.set(tcase, data);
		tcase.range = new vscode.Range(new vscode.Position(1, 1), new vscode.Position(2, 1));
		parent.children.push(tcase);

		ascend(0); // finish and assign children for all remaining items
	}
}

type Ttcn3TestData = TestFile | TestCase;
const testData = new WeakMap<vscode.TestItem, Ttcn3TestData>();
class TestRunRequest2 extends TestRunRequest {
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

function gatherTestItems(collection: vscode.TestItemCollection) {
	const items: vscode.TestItem[] = [];
	collection.forEach(item => items.push(item));
	return items;
}

export function activate(context: ExtensionContext) {

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

	const runHandler = (request: TestRunRequest2, cancellation: vscode.CancellationToken) => {
		if (!request.continuous) {
			return startTestRun(request);
		}/*
		return startTestRun(new TestRunRequest2(
			[getOrCreateFile(ctrl, uri).file],
			undefined,
			request.profile,
			true
		))*/
	}

	const startTestRun = (request: vscode.TestRunRequest) => {
		const queue: { test: vscode.TestItem; data: TestCase }[] = [];
		const run = testCtrl.createTestRun(request);

		const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
			for (const test of tests) {
				if (request.exclude?.includes(test)) {
					continue;
				}

				const data = testData.get(test);
				if (data instanceof TestCase) {
					run.enqueued(test);
					queue.push({ test, data });
				} else {
					if (data instanceof TestFile && !data.didResolve) {
						await data.updateFromDisk(testCtrl, test);
					}

					await discoverTests(gatherTestItems(test.children));
				}
			}
		};

		const runTestQueue = async () => {
			for (const { test, data } of queue) {
				run.appendOutput(`Running ${test.id}\r\n`);
				if (run.token.isCancellationRequested) {
					run.skipped(test);
				} else {
					run.started(test);
					await data.run(test, run);
				}

				//const lineNo = test.range!.start.line;

				run.appendOutput(`Completed ${test.id}\r\n`);
			}

			run.end();
		};

		discoverTests(request.include ?? gatherTestItems(testCtrl.items)).then(runTestQueue);
	};

	testCtrl.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runHandler, true, undefined);
	context.subscriptions.push(testCtrl);
	const initTasks: Promise<void>[] = [];

	initTasks.push(withSpinningStatus(context, async status => {
		await activateLanguageServer(context, status, conf);
	}));


	//testCtrl.items.add(file1);
	//testCtrl.items.add(file2);
	const from_ttcn3_suites = findTtcn3Suite(vscode.workspace.workspaceFolders);
	from_ttcn3_suites.forEach((v: string, k: string) => {
		outputChannel.append(`Detected a suite in workspace: ${v}\n`);
		const suite = testCtrl.createTestItem(k, k, undefined);
		const content = readTtcn3Suite(v);
		outputChannel.appendLine(`content from ttcn3_suites.json: ${JSON.stringify(content)}\n`);
		content.suites.forEach((v: TcSuite, idx: number, list: TcSuite[]) => {
			const sct = testCtrl.createTestItem(v.target, v.target, undefined);
			suite.children.add(sct);
			const modul = testCtrl.createTestItem("meinModul".concat(v.target), "meinModul", undefined);
			const tc1 = testCtrl.createTestItem("meinTC1_1".concat(v.target), "meinModul.meinTC1_1", undefined);
			sct.children.add(modul);
			modul.children.add(tc1);
		})
		testCtrl.items.add(suite);
	})


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
			return;
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

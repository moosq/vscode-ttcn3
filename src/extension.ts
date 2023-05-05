import fs = require('fs');
import path = require('path');
import * as child_process from "child_process";
import * as vscode from 'vscode';
import { ExtensionContext, OutputChannel, TestRunRequest, TestRunProfileKind } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, ExecuteCommandParams, ExecuteCommandRequest, DidChangeConfigurationParams, DidChangeConfigurationNotification, VersionedTextDocumentIdentifier } from 'vscode-languageclient/node';
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

let generationCounter = 0;

interface Ttcn3Test {
	filename: string
	line: number
	column: number
	id: string
	tags: string[]
}

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

async function getTestcaseList(outCh: vscode.OutputChannel, exe: string, pathToYml: string): Promise<Ttcn3Test[]> {
	let tcList: Ttcn3Test[] = [];
	const child = child_process.spawn(exe, ['list', pathToYml, '--json']);
	outCh.appendLine(`about to execute ${exe} list ${pathToYml} --json`);
	child.on("error", (err: Error) => {
		stderrBuf = stderrBuf.concat(`Execution of ${exe} finished with: ${err}`);
	})
	let stdoutBuf = "";
	let stderrBuf = "";
	child.stdout.setEncoding('utf8'); // for text chunks
	child.stderr.setEncoding('utf8'); // for text chunks
	child.stdout.on('data', (chunk) => {
		// data from standard output is here as buffers
		stdoutBuf = stdoutBuf.concat(chunk);
	});

	child.stderr.on('data', (chunk) => {
		// data from standard error is here as buffers
		stderrBuf = stderrBuf.concat(chunk);
	});

	const exitCode = new Promise<string>((resolve, reject) => {
		child.on('close', (code) => {
			if (code == 0) {
				outCh.appendLine(`on closing pipe: code=${code}. Calling resolve passing ${stdoutBuf.length} bytes`);
				resolve(stdoutBuf);
			}
			else {
				outCh.appendLine(`on closing pipe: code=${code}. Calling reject passing ${stderrBuf}`)
				reject(stderrBuf);
			}
		});
	});

	// attention: without await we are not stopping here!
	await exitCode.then((buf: string) => {
		if (buf.length > 0) {
			tcList = JSON.parse(buf);
			outCh.appendLine(`after JSON parsing: tcList len: ${tcList.length}`);
		}
		if (stderrBuf.length > 0) {
			outCh.appendLine(`stderr of ${exe}: ${stderrBuf}`);
		}
	}, (reason) => {
		outCh.appendLine(`exec promise rejected: ${reason}`);
	});

	return new Promise<Ttcn3Test[]>((resolve) => {
		resolve(tcList);
	})
}

class TestSession {
	constructor(
		private readonly name: string,
		private readonly runInst: vscode.TestRun
	) {
		this.testList = [];
	}

	getLabel() {
		return `this is test session ${this.name}`;
	}

	addTest(item: vscode.TestItem) {
		this.testList.push(item);
	}
	async run(): Promise<void> {
		const start = Date.now();

		await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000)); // simulating a random longer time for execution
		const exitVal = this.execute();
		const duration = Date.now() - start;
		this.testList.forEach(v => {
			this.runInst.appendOutput(`finished execution of ${v.id}`);
			this.runInst.passed(v, duration); // TODO: for the moment it shall always pass
		})

		/*	const message = vscode.TestMessage.diff(`Expected ${item.label}`, String(this.expected), String(actual));
			message.location = new vscode.Location(item.uri!, item.range!);
			options.failed(item, message, duration);*/

	}

	private execute() {
		return 0
	}
	private testList: vscode.TestItem[];
}

class TestCase {
	constructor(
		private readonly label: string
	) { }

	getLabel() {
		return `this is a test called ${this.label}`;
	}

	async run(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
		const start = Date.now();

		await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000)); // simulating a random longer time for execution
		const exitVal = this.execute();
		const duration = Date.now() - start;

		options.passed(item, duration); // TODO: for the moment it shall always pass

		/*	const message = vscode.TestMessage.diff(`Expected ${item.label}`, String(this.expected), String(actual));
			message.location = new vscode.Location(item.uri!, item.range!);
			options.failed(item, message, duration);*/

	}

	private execute() {
		return 0
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
		const data = new TestCase("12");
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
	testCtrl.resolveHandler = async test => {
		outputChannel.appendLine(`acquire tests from this point on: ${test?.id}, ${test?.label}`);
	}
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
		const testSession = new TestSession(request.profile!.label, run);
		const excludeTests: vscode.TestItem[] = [];
		var mixedExcludeList: vscode.TestItem[] = [];
		mixedExcludeList.concat(request.exclude ? request.exclude : []);
		for (let i = 0; i < mixedExcludeList!.length; i++) {
			if (mixedExcludeList![i].canResolveChildren) {
				mixedExcludeList![i].children.forEach(item => { mixedExcludeList!.push(item); })
			}
			else {
				excludeTests.push(mixedExcludeList[i]);
			}
		};
		outputChannel.appendLine(`param provided to startTestRun: ${request.profile!.label}`);
		const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
			// tests includes all the tests or parent tree nodes which are marked(UI) for a session
			// hidden tests (UI) are provided via request.exclude list
			const testsOnly: vscode.TestItem[] = [];
			for (const test of tests) {
				testsOnly.push(test);
			}
			for (const test of testsOnly) {
				outputChannel.appendLine(`param provided to discoverTests inside runHandler: ${test.label}, ${test.id}, excluding: ${request.exclude}`);
				if (excludeTests.includes(test)) {
					outputChannel.appendLine(`discoverTests: exclude from run: ${test.label}`);
					continue;
				}

				if (test.canResolveChildren === false) {
					// only real tests shall be marked as enqueued
					run.enqueued(test); // only an indication for the UI
					testSession.addTest(test);
					continue;
				}
				test.children.forEach(item => { testsOnly.push(item) });
			}
		};

		const runTestQueue = async () => {
			await testSession.run();
			/*for (const { test, data } of queue) {
				run.appendOutput(`Running ${test.id}\r\n`);
				if (run.token.isCancellationRequested) {
					run.skipped(test); // only an indication for the UI
				} else {
					run.started(test); // only an indication for the UI
					await data.run(test, run);
				}

				//const lineNo = test.range!.start.line;

				run.appendOutput(`Completed ${test.id}\r\n`);
			}*/
			run.appendOutput(`Completed session ${request.profile!.label}`);
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

	const from_ttcn3_suites = findTtcn3Suite(vscode.workspace.workspaceFolders);
	from_ttcn3_suites.forEach((v: string, k: string) => {
		outputChannel.append(`Detected a suite in workspace: ${v}\n`);
		const suite = testCtrl.createTestItem(k, k, undefined);
		const content = readTtcn3Suite(v);
		outputChannel.appendLine(`content from ttcn3_suites.json: ${JSON.stringify(content)}\n`);
		content.suites.forEach((v: TcSuite, idx: number, list: TcSuite[]) => {
			const sct = testCtrl.createTestItem(v.target, v.target, undefined);
			sct.canResolveChildren = true;
			suite.children.add(sct);
			suite.canResolveChildren = true;
			getTestcaseList(outputChannel, '/sdk/prefix_root_NATIVE-gcc/usr/bin/ntt', v.root_dir).then((list: Ttcn3Test[]) => {
				outputChannel.appendLine(`Detected ${list.length} tests from ${v.target}`);
				const file2Tests = new Map<string, string[]>();
				list.forEach((vtc: Ttcn3Test, idx: number, a: Ttcn3Test[]) => {
					if (file2Tests.has(vtc.filename)) {
						file2Tests.get(vtc.filename)!.push(vtc.id);
					} else {
						file2Tests.set(vtc.filename, [vtc.id]);
					}
				});
				file2Tests.forEach((v, k) => {
					const mod = testCtrl.createTestItem(k, k, undefined);
					sct.children.add(mod);
					v.forEach(tcName => {
						const tc = testCtrl.createTestItem(tcName.concat(k), tcName, undefined);
						mod.children.add(tc);
					})
					mod.canResolveChildren = true;
				});
			});
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

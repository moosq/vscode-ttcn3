import * as fs from 'fs';
import * as path from 'path';
import * as child_process from "child_process";
import * as vscode from 'vscode'
import * as tp from './testexecTaskProvider';
import { toJSONObject } from "vscode-languageclient/lib/common/configuration";
import { setTimeout } from 'timers';
import { tmpdir } from 'os';
import * as dgram from 'unix-dgram'

let generationCounter = 0;
type Ttcn3TestData = TestFile | TestCase | TestSuiteData | ModuleData;
export const testData = new WeakMap<vscode.TestItem, Ttcn3TestData>();

interface Labler {
	getLabel(): string;
}

interface K3sCtrlCmd {
	version: number,
	command: string
};
type K3sCtrlRequest = {
	version: number,
	test_name: string,
	instance: number
}

type K3sCtrlReply = {
	spec_version: number,
	test_name: string,
	log_directory: string,
	result: string,
	time: number,
	load: number,
	errors: string[],
	instance: number
}

type TcVerdict = {
	remainingReplies: number,
	reply: K3sCtrlReply
}
class K3sControlItf {
	private sock: dgram.Socket
	constructor(sockName: string, maxNoTests: number, runInst: vscode.TestRun) {
		let retries = 10;
		this.rInst = runInst;
		this.sockPath = sockName;

		// Generate a unique socket name in the temporary directory
		const uniqueSockName = path.join(tmpdir(), `from-testExec2vscode-${Date.now()}.sock`);

		this.maxNoTests = maxNoTests;
		try {
			this.sock = dgram.createSocket('unix_dgram');
		} catch (err) {
			this.rInst.appendOutput(`Failed to create socket: ${(err as Error).message}\r\n`);
			throw err; // Re-throw the error to handle it in the calling code
		}

		this.sock.on('error', (err: Error) => {
			this.rInst.appendOutput(`Socket error: ${err.message}\r\n`);
			// Handle the error, possibly retry binding or exit
		});
		this.rInst.appendOutput(`binding socket to ${this.sockPath}\r\n`);
		try {
			this.sock.bind(uniqueSockName);
		}
		catch (err) {
			this.rInst.appendOutput(`Failed to bind socket: ${(err as Error).message}\r\n`);
			throw err; // Re-throw the error to handle it in the calling code
		}
		finally {
			this.rInst.appendOutput(`Socket successfully bound to ${uniqueSockName}\r\n`);
		}
	}

	private sendWretry(message: string, retryCnt: number) {
		const retry = () => {
			if (!fs.existsSync(this.sockPath) && retryCnt > 0) {
				retryCnt--;
				this.rInst.appendOutput(`Retry send in 0.5 seconds (${retryCnt} left)...\r\n`);
				setTimeout(retry, 500);
			}
			else {
				this.sock.send(Buffer.from(message), 0, message.length, this.sockPath)
			}
		}
		retry()
	}

	decrementCounter(): Promise<TcVerdict> {
		this.rInst.appendOutput(`decrementCounter: create a promise\r\n`);
		return new Promise((resolve) => {
			this.sock.once('message', (message: Buffer, info: any) => {
				this.maxNoTests--;
				this.rInst.appendOutput(`Data received on socket. Still running tests:  ${this.maxNoTests}\r\n`);
				this.rInst.appendOutput(`received from k3s: ${message.toString()}\r\n`);
				const retVal: K3sCtrlReply = JSON.parse(message.toString())
				resolve({ remainingReplies: this.maxNoTests, reply: retVal });
			});
		});
	}
	shutdownK3s() {
		const payload: K3sCtrlCmd = { version: 1, command: "shutdown" }
		this.rInst.appendOutput("executing shutdownK3s\r\n");
		this.rInst.appendOutput(`about to send over ctrl.sock: ${JSON.stringify(payload)}\r\n`);
		this.sendWretry(`${JSON.stringify(payload)}\n`, 10)
		this.sock.close();
	}

	runTest(tcInst: string) {
		const payload: K3sCtrlRequest = { version: 1, test_name: tcInst, instance: 1 };
		this.rInst.appendOutput(`about to send over ctrl.sock: ${JSON.stringify(payload)}\r\n`);
		this.sendWretry(`${JSON.stringify(payload)}\n`, 10)
	}
	sockPath: string;
	maxNoTests: number;
	rInst: vscode.TestRun;
}
export class TestSuiteData implements Labler {
	constructor(
		readonly target: string,
		readonly build_dir: string
	) { }

	getLabel() {
		return `this is a TestSuiteData called ${this.target}`;
	}

	toString(): string {
		return `TestSuiteData { target: ${this.target}, build_dir: ${this.build_dir} }`;
	}
}

export class ModuleData implements Labler {
	constructor(
		private readonly file_name: string
	) { }

	getLabel() {
		return `this is a ModuleData called ${this.file_name}`;
	}
}
class TestCase implements Labler {
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

class TestFile implements Labler {
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
	getLabel(): string {
		return `this is TestFile data`
	}
}

type TcMapType = Map<string, vscode.TestItem>;
class TestSession implements Labler {
	constructor(
		private readonly name: string,
		private readonly buildDir: string,
		private readonly target: string,
		//private runInst: vscode.TestRun
	) {
		this.testMap = new Map<string, vscode.TestItem>();
		this.testList = [];
	}

	getLabel() {
		return `this is test session ${this.name}`;
	}

	addTest(item: vscode.TestItem) {
		this.testList.push(item);
		if (!this.testMap.has(item.label)) {
			this.testMap.set(item.label, item);
		}
	}
	async run(runInst: vscode.TestRun): Promise<void> {
		return this.executeTest(runInst);
	}

	private execute() {
		return 0
	}

	private async executeTest(runInst: vscode.TestRun): Promise<void> {
		let waitForK3s: Thenable<unknown>;
		let filt: vscode.TaskFilter = { type: tp.TestExecTaskProvider.TestExecType };
		let label: string = "";
		await vscode.tasks.fetchTasks(filt).then((cmdList: vscode.Task[]) => {
			cmdList.forEach((task: vscode.Task) => {
				runInst.appendOutput(`available tasks: ${task.name} from group. ${task.group?.id}, with type: ${task.definition.type}, source: ${task.source}, supplied target: ${this.target}, buildDir: ${this.buildDir}\r\n`);
				if (task.name == this.target) {
					if (task.definition.type == tp.TestExecTaskProvider.TestExecType) {
						label = `${tp.TestExecTaskProvider.TestExecType}: ${this.target}`;
					}
				}
			})
		});
		if (label !== "") {
			// NOTE: executeCommand is superior to scode.tasks.executeTask. It takes into account configurations from
			// tasks.json whereas the latter one supplied only config from taskProvider (at least in my case)
			const ctrlSock = path.join(this.buildDir, `${this.target}.ctrl.sock`);
			runInst.appendOutput(`the control socket is located inside: ${ctrlSock}\r\n`);
			// delete old ctrl.sock file
			if (fs.existsSync(ctrlSock)) {
				runInst.appendOutput(`${ctrlSock} already existing, deleting it...\r\n`);
				fs.unlinkSync(ctrlSock);
			}

			// execute the testcase task
			waitForK3s = vscode.commands.executeCommand("workbench.action.tasks.runTask", `${label}`);

			// watch for *.ctrl.sock to come alive
			/*		const fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.buildDir), `${this.target}.ctrl.sock`));
		
					const waitForK3sStartup = new Promise(resolve => fileWatcher.onDidCreate(resolve));
					runInst.appendOutput("starting test task\r\n");
		
					// execute the testcase task
					waitForK3s = vscode.commands.executeCommand("workbench.action.tasks.runTask", `${label}`);
					// wait for the creation of the communication socket
					try {
						await waitForK3sStartup;
						runInst.appendOutput("detected ctrl.sock\r\n");
					} catch (reason) {
						runInst.appendOutput(`rejected ctrl.sock: ${reason} \r\n`);
						return; // Exit if the socket creation failed
					} finally {
						fileWatcher.dispose();
					}*/

			runInst.appendOutput("try to connect to k3s...\r\n");
			const k3sConnect = new K3sControlItf(ctrlSock, this.testList.length, runInst);

			let allTcsExecuted: number = this.testList.length;

			for (var tc of this.testList) {
				runInst.appendOutput(`sending to k3s ${tc.label}.\r\n`);
				k3sConnect.runTest(tc.label)
			}
			while (allTcsExecuted > 0) {
				runInst.appendOutput("waiting for tcs to complete...\r\n");
				const verdict = await k3sConnect.decrementCounter();
				allTcsExecuted = verdict.remainingReplies;
				if (this.testMap.has(verdict.reply.test_name)) {
					const tcInst = this.testMap.get(verdict.reply.test_name)!;
					const timeInms = verdict.reply.time * 1000;
					switch (verdict.reply.result) {
						case "pass": runInst.passed(tcInst, timeInms);
							break;
						case "fail": runInst.failed(tcInst, new vscode.TestMessage(""), timeInms);
							break;
						case "error": runInst.errored(tcInst, new vscode.TestMessage(""), timeInms);
							break;
						case "skipped": runInst.skipped(tcInst);
							break;
						default: runInst.failed(tcInst, new vscode.TestMessage(verdict.reply.result), timeInms);
					}
				}
			}

			runInst.appendOutput("shutting down test task\r\n");
			k3sConnect.shutdownK3s();
			// wait for the task to exit
			await waitForK3s;
		}
		runInst.appendOutput("Finished execution of my own task\r\n");

		return new Promise<void>((resolve) => {
			resolve();
		})
	}

	private testList: vscode.TestItem[];
	private testMap: TcMapType;
}

function getBinaryDir(outCh: vscode.OutputChannel, tc: vscode.TestItem): string {
	for (let r: vscode.TestItem | undefined = tc; r != undefined; r = r.parent) {
		const data = testData.get(r)
		if (data instanceof TestSuiteData) {
			return data.build_dir;
		}
	}
	return "";
}

function getSuiteTarget(tc: vscode.TestItem): string {
	for (let r: vscode.TestItem | undefined = tc; r != undefined; r = r.parent) {
		const data = testData.get(r);
		if (data instanceof TestSuiteData) {
			return data.target;
		}
	}
	return "";
}

function gatherTestItems(collection: vscode.TestItemCollection) {
	const items: vscode.TestItem[] = [];
	collection.forEach(item => items.push(item));
	return items;
}

function expandExcludeTestList(request: vscode.TestRunRequest) {
	const excludeTests: vscode.TestItem[] = [];
	var mixedExcludeList: vscode.TestItem[] = [];
	mixedExcludeList.concat(request.exclude ? request.exclude : []);
	for (let i = 0; i < mixedExcludeList.length; i++) {
		if (mixedExcludeList![i].canResolveChildren) {
			mixedExcludeList![i].children.forEach(item => { mixedExcludeList!.push(item); });
		}
		else {
			excludeTests.push(mixedExcludeList[i]);
		}
	};
	return excludeTests;
}

export function startTestRun(request: vscode.TestRunRequest, testCtrl: vscode.TestController, cancellation: vscode.CancellationToken, outputChannel: vscode.OutputChannel) {
	const queue: { test: vscode.TestItem; data: TestCase }[] = [];
	const run = testCtrl.createTestRun(request);
	const testSessions: Map<string, TestSession> = new Map<string, TestSession>();
	const excludeTests = expandExcludeTestList(request);
	outputChannel.appendLine(`param provided to startTestRun: ${request.profile!.label}, exclude List: ${JSON.stringify(excludeTests)}`);
	const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
		// tests includes all the tests or parent tree nodes which are marked(UI) for a session
		// hidden tests (UI) are provided via request.exclude list
		const testsOnly: vscode.TestItem[] = [];
		for (const test of tests) {
			testsOnly.push(test);
		}
		// NOTE: testsOnly is evaluated before each iteration!
		for (const test of testsOnly) {
			//outputChannel.appendLine(`param provided to discoverTests inside runHandler: ${test.label}, ${test.id}, excluding: ${request.exclude}`);
			if (excludeTests.includes(test)) {
				outputChannel.appendLine(`discoverTests: exclude from run: ${test.label}`);
				continue;
			}

			if ((test.canResolveChildren === false) && (!cancellation.isCancellationRequested)) {
				// only real tests shall be marked as enqueued
				run.enqueued(test); // only an indication for the UI
				const binDir = getBinaryDir(outputChannel, test);
				const suiteTarget = getSuiteTarget(test);
				if (testSessions.get(suiteTarget) === undefined) {
					outputChannel.appendLine(`start new TestSession with target ${suiteTarget}, binDir: ${binDir}`);
					testSessions.set(suiteTarget, new TestSession(request.profile!.label, binDir, suiteTarget));
				}
				testSessions.get(suiteTarget)!.addTest(test);
				outputChannel.appendLine(`add test ${test.label} to testSession: ${suiteTarget}`);
				continue;
			}
			test.children.forEach(item => { testsOnly.push(item) });
		}
	};

	let testSessionFinished: Promise<void>[] = [];
	const runTestQueue = async () => {
		for (const testSession of testSessions) {
			outputChannel.appendLine(`run testSession: ${testSession[0]}, labeled ${testSession[1].getLabel()}`);
			testSessionFinished.push(testSession[1].run(run));
		};
		await Promise.all(testSessionFinished);
		run.appendOutput(`Completed session(s) ${request.profile!.label}`);
		run.end();
	};
	outputChannel.appendLine(`invoking discoverTests with: ${JSON.stringify(request.include)}, and testCtrl.items: ${JSON.stringify(gatherTestItems(testCtrl.items))}`);
	// request.include: selected tests, testCtrl.items: fallback: all tests
	discoverTests(request.include ?? gatherTestItems(testCtrl.items)).then(runTestQueue);
};


import * as fs from 'fs';
import * as path from 'path';
import * as child_process from "child_process";
import * as vscode from 'vscode'
import { UnixDgramSocket } from "unix-dgram-socket";
import { toJSONObject } from "vscode-languageclient/lib/common/configuration";
import { openStdin } from 'process';
import { fsExists } from './util/fsUtils';
import { setTimeout } from 'timers';

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
	constructor(sockName: string, maxNoTests: number, runInst: vscode.TestRun) {
		this.sock = new UnixDgramSocket();
		let retries = 10;
		this.rInst = runInst;
		this.sock.connect(sockName);
		this.sock.bind(sockName);
		this.sockPath = sockName;
		this.maxNoTests = maxNoTests;
	}

	private sendWretry(message: string, retryCnt: number) {
		const retry = () => {
			if (!this.sock.send(message) && retryCnt > 0) {
				retryCnt--;
				this.rInst.appendOutput(`Retry send in 0.5 seconds (${retryCnt} left)...\r\n`);
				setTimeout(retry, 500);
			}
		}
		retry();
	}

	instanciateReceiver(f: (message: Buffer, info: any) => void) {
		this.sock.on('message', f);
	}

	decrementCounter(): Promise<TcVerdict> {
		this.rInst.appendOutput(`decrementCounter: create a promise\r\n`);
		return new Promise((resolve) => {
			this.sock.once('message', (message: Buffer, info: any) => {
				this.maxNoTests--;
				this.rInst.appendOutput(`Data received on socket. Still running tests:  ${this.maxNoTests}\r\n`);
				this.rInst.appendOutput(`received from k3s: ${message.toString(UnixDgramSocket.payloadEncoding)}\r\n`);
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
	sock: UnixDgramSocket;
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
		await this.executeTest(runInst, '/home/ut/bin/mycmake');
	}

	private execute() {
		return 0
	}

	private async executeTest(runInst: vscode.TestRun, exe: string): Promise<void> {
		let waitForK3s: Thenable<unknown>;
		let filt: vscode.TaskFilter = { type: "exec_ttcn3" };
		let label: string = "";
		await vscode.tasks.fetchTasks(filt).then((cmdList: vscode.Task[]) => {
			cmdList.forEach((task: vscode.Task) => {
				runInst.appendOutput(`available tasks: ${task.name} from group. ${task.group?.id}, with type: ${task.definition.type}, source: ${task.source}, supplied target: ${this.target}, buildDir: ${this.buildDir}\r\n`);
				if (task.name == this.target) {
					if (task.definition.type == "exec_ttcn3") {
						label = `exec_ttcn3: ${this.target}`;
					}
				}
			})
		});
		if (label !== "") {
			// NOTE: executeCommand is superior to scode.tasks.executeTask. It takes into account configurations from
			// tasks.json whereas the latter one supplied only config from taskProvider (at least in my case)
			const ctrlSock = path.join(this.buildDir, 'ctrl.sock');

			// delete old ctrl.sock file
			if (fs.existsSync(ctrlSock)) {
				runInst.appendOutput(`${ctrlSock} already existing, deleting it...\r\n`);
				fs.unlinkSync(ctrlSock);
			}
			// watch for ctrl.sock to come alive
			const fileWatcher = vscode.workspace.createFileSystemWatcher(ctrlSock);

			const waitForK3sStartup = new Promise(resolve => fileWatcher.onDidCreate(resolve));
			runInst.appendOutput("starting test task\r\n");
			await new Promise(resolve => setTimeout(resolve, 5000)).then(() => runInst.appendOutput("starting task now\r\n"));
			runInst.appendOutput("really starting test task\r\n");
			waitForK3s = vscode.commands.executeCommand("workbench.action.tasks.runTask", `${label}`);
			await waitForK3sStartup.then(() => runInst.appendOutput("detected ctrl.sock\r\n"), (reason) => runInst.appendOutput(`rejected ctrl.sock: ${reason} \r\n`))
				.catch((error) => { runInst.appendOutput(`detected error on ctrl.sock: ${error}\r\n`) });
			fileWatcher.dispose();
			runInst.appendOutput("try to connect to k3s...\r\n");
			const k3sConnect = new K3sControlItf(path.join(this.buildDir, 'ctrl.sock'), this.testList.length, runInst);

			let allTcsExecuted: number = this.testList.length;

			for (var tc of this.testList) {
				k3sConnect.runTest(tc.label)
			}
			while (allTcsExecuted > 0) {
				runInst.appendOutput("waiting for tcs to complete...\r\n");
				const verdict = await k3sConnect.decrementCounter();
				allTcsExecuted = verdict.remainingReplies;
				if (this.testMap.has(verdict.reply.test_name)) {
					const tcInst = this.testMap.get(verdict.reply.test_name)!;
					switch (verdict.reply.result) {
						case "pass": runInst.passed(tcInst, verdict.reply.time);
							break;
						case "fail": runInst.failed(tcInst, new vscode.TestMessage(""), verdict.reply.time);
							break;
						case "error": runInst.errored(tcInst, new vscode.TestMessage(""), verdict.reply.time);
							break;
						case "skipped": runInst.skipped(tcInst);
							break;
						default: runInst.failed(tcInst, new vscode.TestMessage(verdict.reply.result), verdict.reply.time);
					}
				}
			}

			runInst.appendOutput("shutting down test task\r\n");
			k3sConnect.shutdownK3s();
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
	for (let i = 0; i < mixedExcludeList!.length; i++) {
		if (mixedExcludeList![i].canResolveChildren) {
			mixedExcludeList![i].children.forEach(item => { mixedExcludeList!.push(item); });
		}
		else {
			excludeTests.push(mixedExcludeList[i]);
		}
	};
	return excludeTests;
}

export function startTestRun(request: vscode.TestRunRequest, testCtrl: vscode.TestController, outputChannel: vscode.OutputChannel) {
	const queue: { test: vscode.TestItem; data: TestCase }[] = [];
	const run = testCtrl.createTestRun(request);
	const testSessions: Map<string, TestSession> = new Map<string, TestSession>();
	const excludeTests = expandExcludeTestList(request);
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
				const binDir = getBinaryDir(outputChannel, test);
				const suiteTarget = getSuiteTarget(test);
				if (testSessions.get(suiteTarget) === undefined) {
					outputChannel.appendLine(`start new TestSession with target ${suiteTarget}, binDir: ${binDir}`);
					testSessions.set(suiteTarget, new TestSession(request.profile!.label, binDir, suiteTarget));
				}
				testSessions.get(suiteTarget)!.addTest(test);
				continue;
			}
			test.children.forEach(item => { testsOnly.push(item) });
		}
	};

	const runTestQueue = async () => {
		for (const testSession of testSessions) {
			await testSession[1].run(run);
		};
		run.appendOutput(`Completed session ${request.profile!.label}`);
		run.end();
	};

	discoverTests(request.include ?? gatherTestItems(testCtrl.items)).then(runTestQueue);
};


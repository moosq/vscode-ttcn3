import * as child_process from "child_process";
import * as vscode from 'vscode'

let generationCounter = 0;
type Ttcn3TestData = TestFile | TestCase | TestSuiteData | ModuleData;
export const testData = new WeakMap<vscode.TestItem, Ttcn3TestData>();

interface Labler {
	getLabel(): string;
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

class TestSession implements Labler {
	constructor(
		private readonly name: string,
		private readonly buildDir: string,
		private readonly target: string,
		//private runInst: vscode.TestRun
	) {
		this.testList = [];
	}

	getLabel() {
		return `this is test session ${this.name}`;
	}

	addTest(item: vscode.TestItem) {
		this.testList.push(item);
	}
	async run(runInst: vscode.TestRun): Promise<void> {
		const start = Date.now();

		await executeTest(runInst, '/home/ut/bin/mycmake', this.buildDir, this.target, this.testList);
		const exitVal = this.execute();
		const duration = Date.now() - start;
		this.testList.forEach(v => {
			runInst.appendOutput(`finished execution of ${v.id}\r\n`);
			runInst.passed(v, duration); // TODO: for the moment it shall always pass
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

async function executeTest(runInst: vscode.TestRun, exe: string, buildDir: string, target: string, tcs: vscode.TestItem[]): Promise<void> {
	let testsRegex = "";
	const envForTest = process;
	tcs.forEach((tc, idx) => {
		if (idx > 0) {
			testsRegex += '|';
		}
		testsRegex += tc.label;
	})
	envForTest.env['SCT_TEST_PATTERNS'] = `"^(${testsRegex})$"`;

	const child = child_process.spawn(exe, ['--build', buildDir, '--target', target], { env: process.env });
	runInst.appendOutput(`about to execute ${exe} --build ${buildDir} --target ${target}\r\n`);
	child.on("error", (err: Error) => {
		stderrBuf = stderrBuf.concat(`Execution of ${exe} finished with: ${err}\r\n`);
	})
	let stdoutBuf = "";
	let stderrBuf = "";
	child.stdout.setEncoding('utf8'); // for text chunks
	child.stderr.setEncoding('utf8'); // for text chunks
	child.stdout.on('data', (chunk: string) => {
		// data from standard output is here as buffers
		chunk = chunk.replace(/\n/g, '\r\n');
		stdoutBuf = stdoutBuf.concat(chunk);
		runInst.appendOutput(chunk);
	});

	child.stderr.on('data', (chunk: string) => {
		// data from standard error is here as buffers
		chunk = chunk.replace(/\n/g, '\r\n');
		stderrBuf = stderrBuf.concat(chunk);
	});

	const exitCode = new Promise<number>((resolve, reject) => {
		child.on('close', (code, signal: NodeJS.Signals) => {
			if (code == 0 && signal == null) {
				runInst.appendOutput(`on closing pipe: code=${code}. Calling resolve passing ${stdoutBuf.length} bytes\r\n`);
				resolve(code);
			}
			else {
				runInst.appendOutput(`on closing pipe: code=${code}, signal=${signal}. Calling reject passing\r\n${stderrBuf}\r\n`)
				reject(code);
			}
		});
	});

	// attention: without await we are not stopping here!
	await exitCode.then((val: number) => {
		if (stderrBuf.length > 0) {
			//stderrBuf = stderrBuf.replace('\n', '\r\n');
			runInst.appendOutput(`stderr of ${exe}:\r\n${stderrBuf}\r\n`);
		}
	}, (val: number) => {
		runInst.appendOutput(`exec promise rejected: ${val}\r\n`);
		runInst.appendOutput(`retrieving test verdicts\r\n`);
	});
	runInst.appendOutput(`tests exit with stderr:\r\n${stderrBuf}\r\n`);
	return new Promise<void>((resolve) => {
		resolve();
	})
}